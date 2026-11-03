'use strict';

/**
 * Pacote do PAINEL PRIVADO por allowlist explícita e independente.
 *
 * O Painel é servido em origem própria, com allowlist de CORS disjunta da do
 * cliente, por isso tem empacotador próprio: este módulo não reutiliza o do
 * cliente, e uma mudança em um nunca altera o outro.
 *
 * Só entra no pacote o que está em publicacao/allowlist-painel.json, e a
 * allowlist só pode conter arquivos de painel-privado/ ou um dos
 * COMPARTILHADOS_PERMITIDOS fixados aqui. Acrescentar outro compartilhado é
 * mudança de código, revisada como qualquer alteração de segurança.
 *
 * Fail-closed, nesta ordem, ANTES de escrever qualquer arquivo:
 *   1. cada entrada é um caminho relativo canônico, sem duplicata, de um
 *      arquivo regular dentro de frontend/ (link simbólico é recusado);
 *   2. NUNCA_PUBLICAR: tudo fora de painel-privado/ e do conjunto
 *      compartilhado é recusado mesmo listado;
 *   3. nenhuma página carrega script externo (sem exceção), nem folha,
 *      imagem, fonte, @import ou url() externos; <base>, <iframe>, <object>,
 *      <embed> e a forma anômala <script/ são recusados;
 *   4. todo recurso local carregado por página ou folha, e todo link de
 *      navegação para .html, está na allowlist;
 *   5. arquivos com hash fixado (HASHES_FIXOS) têm o SHA-256 esperado;
 *   6. a saída não existe ou está vazia, e fica fora do código-fonte.
 * Depois da cópia, o pacote é verificado contra a allowlist e o manifesto
 * SHA-256; qualquer divergência apaga só o que este módulo escreveu.
 *
 * Uso: node publicacao/empacotar-painel.js --saida <diretório vazio fora de frontend/>
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.resolve(__dirname, '..');
const ARQUIVO_ALLOWLIST = path.join(__dirname, 'allowlist-painel.json');
const PREFIXO_PROPRIO = 'painel-privado/';
const COMPARTILHADOS_PERMITIDOS = Object.freeze([
  'favicon.svg',
  'js/api-http.js',
  'js/senha-ciclo.js',
  'vendor/LICENSE-qrcode-generator.txt',
  'vendor/qrcode-generator-2.0.4.js',
]);
// Mesmo valor registrado em vendor/README.md.
const HASHES_FIXOS = Object.freeze({
  'vendor/qrcode-generator-2.0.4.js': '79ec86f82856005b1c887905cfccfcfbec3821ca61c7fd5a952faa5f778f791c',
});
const COM_ESQUEMA = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
const TAGS_PERIGOSAS = /<(?:base|iframe|object|embed)\b|<script\//i;

class ErroPublicacao extends Error {
  constructor(codigo, mensagem) {
    super(mensagem);
    this.name = 'ErroPublicacao';
    this.codigo = codigo;
  }
}

function lerAllowlist(arquivo = ARQUIVO_ALLOWLIST) {
  const dados = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
  if (!dados || !Array.isArray(dados.arquivos)) {
    throw new ErroPublicacao('ENTRADA_INVALIDA', 'allowlist do Painel sem a lista "arquivos"');
  }
  return dados.arquivos.slice();
}

function absoluto(raiz, relativo) {
  return path.join(raiz, ...relativo.split('/'));
}

function dentroDe(pai, caminho) {
  return caminho === pai || caminho.startsWith(pai + path.sep);
}

function caminhoReal(abs) {
  const pendentes = [];
  let atual = abs;
  while (!fs.existsSync(atual)) {
    pendentes.unshift(path.basename(atual));
    atual = path.dirname(atual);
  }
  return path.join(fs.realpathSync(atual), ...pendentes);
}

function sha256(abs) {
  return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
}

function permitidoNoPainel(entrada) {
  return entrada.startsWith(PREFIXO_PROPRIO) || COMPARTILHADOS_PERMITIDOS.includes(entrada);
}

function validarEntradas(arquivos, raiz) {
  if (!Array.isArray(arquivos) || arquivos.length === 0) {
    throw new ErroPublicacao('ENTRADA_INVALIDA', 'allowlist vazia');
  }
  const raizReal = fs.realpathSync(raiz);
  const vistos = new Set();
  for (const entrada of arquivos) {
    if (typeof entrada !== 'string' || entrada === '' || entrada.startsWith('/') || entrada.includes('\\')
      || path.posix.normalize(entrada) !== entrada || entrada.split('/').includes('..')) {
      throw new ErroPublicacao('ENTRADA_INVALIDA', `entrada não canônica: ${JSON.stringify(entrada)}`);
    }
    if (vistos.has(entrada)) throw new ErroPublicacao('ENTRADA_INVALIDA', `entrada duplicada: ${entrada}`);
    vistos.add(entrada);
    const abs = absoluto(raiz, entrada);
    let info;
    try {
      info = fs.lstatSync(abs);
    } catch {
      throw new ErroPublicacao('ARQUIVO_AUSENTE', `arquivo inexistente: ${entrada}`);
    }
    if (!info.isFile() || !dentroDe(raizReal, fs.realpathSync(abs))) {
      throw new ErroPublicacao('ENTRADA_INVALIDA', `não é arquivo regular dentro do frontend: ${entrada}`);
    }
    if (!permitidoNoPainel(entrada)) {
      throw new ErroPublicacao('NUNCA_PUBLICAR', `${entrada} nunca entra no pacote do Painel Privado`);
    }
  }
}

function valoresDoAtributo(html, tag, atributo) {
  const re = new RegExp(`<${tag}\\b[^>]*?\\s${atributo}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'gi');
  return [...html.matchAll(re)].map((m) => m[1] ?? m[2] ?? m[3]);
}

function referenciasDeCss(css) {
  const urls = [...css.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi)].map((m) => m[2]);
  const imports = [...css.matchAll(/@import\s+(?!url\()["']([^"']+)["']/gi)].map((m) => m[1]);
  return [...urls, ...imports];
}

function linksDeNavegacao(html) {
  return [...html.matchAll(/<a\b[^>]*?\shref\s*=\s*["']([^"'#?]+\.html)(?:[?#][^"']*)?["']/gi)].map((m) => m[1]);
}

// Referência local -> caminho relativo à raiz do pacote (null se vazia; lança se externa).
function resolverLocal(origem, referencia, codigoExterno) {
  const semSufixo = referencia.trim().split(/[?#]/)[0];
  if (!semSufixo) return null;
  if (COM_ESQUEMA.test(semSufixo)) {
    throw new ErroPublicacao(codigoExterno, `${origem} carrega recurso de fora do pacote: ${referencia.trim()}`);
  }
  let decodificada = semSufixo;
  try { decodificada = decodeURI(semSufixo); } catch { /* mantém como veio */ }
  return decodificada.startsWith('/')
    ? path.posix.normalize(decodificada.slice(1))
    : path.posix.normalize(path.posix.join(path.posix.dirname(origem), decodificada));
}

function validarConteudo(arquivos, raiz) {
  const permitidos = new Set(arquivos);
  for (const entrada of arquivos) {
    const extensao = path.extname(entrada).toLowerCase();
    if (extensao !== '.html' && extensao !== '.css') continue;
    const texto = fs.readFileSync(absoluto(raiz, entrada), 'utf8');
    const carregados = [];
    const links = [];
    if (extensao === '.html') {
      const html = texto.replace(/<!--[\s\S]*?-->/g, '');
      const perigosa = html.match(TAGS_PERIGOSAS);
      if (perigosa) throw new ErroPublicacao('HTML_PERIGOSO', `${entrada} usa ${perigosa[0]}, recusado no pacote do Painel`);
      for (const src of valoresDoAtributo(html, 'script', 'src')) {
        if (COM_ESQUEMA.test(src.trim())) throw new ErroPublicacao('SCRIPT_EXTERNO', `${entrada} carrega script de fora do pacote: ${src}`);
        carregados.push(src);
      }
      carregados.push(...valoresDoAtributo(html, 'link', 'href'), ...valoresDoAtributo(html, 'img', 'src'));
      for (const estilo of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) carregados.push(...referenciasDeCss(estilo[1]));
      links.push(...linksDeNavegacao(html));
    } else {
      carregados.push(...referenciasDeCss(texto));
    }
    for (const referencia of carregados) {
      const alvo = resolverLocal(entrada, referencia, 'RECURSO_EXTERNO');
      if (alvo !== null && !permitidos.has(alvo)) {
        throw new ErroPublicacao('RECURSO_FORA_DA_ALLOWLIST', `${entrada} carrega ${referencia}, que não está na allowlist`);
      }
    }
    for (const link of links) {
      if (COM_ESQUEMA.test(link.trim())) continue;
      const alvo = resolverLocal(entrada, link, 'LINK_FORA_DO_PACOTE');
      if (alvo !== null && !permitidos.has(alvo)) {
        throw new ErroPublicacao('LINK_FORA_DO_PACOTE', `${entrada} leva a ${link}, que não está no pacote`);
      }
    }
  }
}

function gerarManifesto(arquivos, raiz) {
  const manifesto = {};
  for (const entrada of [...arquivos].sort()) {
    const hash = sha256(absoluto(raiz, entrada));
    if (HASHES_FIXOS[entrada] && HASHES_FIXOS[entrada] !== hash) {
      throw new ErroPublicacao('INTEGRIDADE_DIVERGENTE', `${entrada} tem SHA-256 diferente do fixado`);
    }
    manifesto[entrada] = hash;
  }
  return manifesto;
}

function validarSaida(saida, raiz) {
  if (typeof saida !== 'string' || saida.trim() === '') {
    throw new ErroPublicacao('SAIDA_INVALIDA', 'informe o diretório de saída (--saida)');
  }
  const abs = path.resolve(saida);
  if (dentroDe(fs.realpathSync(raiz), caminhoReal(abs))) {
    throw new ErroPublicacao('SAIDA_INVALIDA', 'a saída não pode ficar dentro do código-fonte do frontend');
  }
  if (fs.existsSync(abs)) {
    const info = fs.lstatSync(abs);
    if (!info.isDirectory() || fs.readdirSync(abs).length > 0) {
      throw new ErroPublicacao('SAIDA_INVALIDA', `a saída precisa ser um diretório novo ou vazio: ${abs}`);
    }
  }
  return abs;
}

function listarPacote(dir, base = dir) {
  return fs.readdirSync(dir).flatMap((nome) => {
    const abs = path.join(dir, nome);
    const info = fs.lstatSync(abs);
    if (info.isDirectory()) return listarPacote(abs, base);
    if (!info.isFile()) {
      throw new ErroPublicacao('PACOTE_DIVERGENTE', `item que não é arquivo regular no pacote: ${path.relative(base, abs)}`);
    }
    return [path.relative(base, abs).split(path.sep).join('/')];
  });
}

/** Confirma que o diretório contém exatamente os arquivos da allowlist e, se dado, os hashes do manifesto. */
function verificarPacote(dir, { arquivos = lerAllowlist(), manifesto = null } = {}) {
  const presentes = new Set(listarPacote(dir));
  const esperados = new Set(arquivos);
  const aMais = [...presentes].filter((f) => !esperados.has(f)).sort();
  const aMenos = [...esperados].filter((f) => !presentes.has(f)).sort();
  if (aMais.length || aMenos.length) {
    throw new ErroPublicacao('PACOTE_DIVERGENTE',
      `pacote diferente da allowlist — a mais: [${aMais.join(', ')}]; a menos: [${aMenos.join(', ')}]`);
  }
  if (manifesto) {
    for (const entrada of esperados) {
      if (manifesto[entrada] !== sha256(absoluto(dir, entrada))) {
        throw new ErroPublicacao('PACOTE_DIVERGENTE', `conteúdo diferente do manifesto: ${entrada}`);
      }
    }
  }
}

// Apaga só o que este módulo escreveu: o destino era novo ou vazio ao começar.
function desfazer(destino, criouDestino) {
  try {
    if (criouDestino) fs.rmSync(destino, { recursive: true, force: true });
    else for (const nome of fs.readdirSync(destino)) fs.rmSync(path.join(destino, nome), { recursive: true, force: true });
  } catch { /* a recusa original prevalece */ }
}

function empacotar({ saida, arquivos = lerAllowlist(), raiz = RAIZ } = {}) {
  validarEntradas(arquivos, raiz);
  validarConteudo(arquivos, raiz);
  const manifesto = gerarManifesto(arquivos, raiz);
  const destino = validarSaida(saida, raiz);

  const criouDestino = !fs.existsSync(destino);
  try {
    fs.mkdirSync(destino, { recursive: true });
    for (const entrada of arquivos) {
      const alvo = absoluto(destino, entrada);
      fs.mkdirSync(path.dirname(alvo), { recursive: true });
      fs.copyFileSync(absoluto(raiz, entrada), alvo, fs.constants.COPYFILE_EXCL);
    }
    verificarPacote(destino, { arquivos, manifesto });
  } catch (erro) {
    desfazer(destino, criouDestino);
    throw erro;
  }
  return { saida: destino, arquivos: [...arquivos].sort(), manifesto };
}

if (require.main === module) {
  const argumentos = process.argv.slice(2);
  const saida = argumentos.length === 2 && argumentos[0] === '--saida' ? argumentos[1] : null;
  try {
    const resultado = empacotar({ saida });
    console.log(`Pacote do Painel Privado gerado em ${resultado.saida}: ${resultado.arquivos.length} arquivos da allowlist.`);
  } catch (erro) {
    console.error(`Publicação recusada (${erro.codigo || 'ERRO'}): ${erro.message}`);
    process.exitCode = 1;
  }
}

module.exports = { empacotar, verificarPacote, lerAllowlist, ErroPublicacao, COMPARTILHADOS_PERMITIDOS, HASHES_FIXOS };
