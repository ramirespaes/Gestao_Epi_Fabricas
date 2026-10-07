'use strict';

/**
 * Pacote público do frontend do CLIENTE por allowlist explícita (segurança
 * S1 da auditoria do Bloco 9).
 *
 * Só entra no pacote o que está em publicacao/allowlist.json. As páginas
 * legadas do protótipo (SheetJS por CDN, login e sessão simulados)
 * continuam no repositório, mas nunca são publicadas: qualquer script que
 * rode na origem do frontend age na API com a sessão real, porque essa
 * origem está na allowlist de CORS com credenciais.
 *
 * Fail-closed, nesta ordem, ANTES de escrever qualquer arquivo:
 *   1. cada entrada é um caminho relativo canônico, sem duplicata, de um
 *      arquivo regular dentro de frontend/ (link simbólico é recusado);
 *   2. NUNCA_PUBLICAR: os scripts do protótipo e o Painel Privado (outra
 *      origem, com allowlist de CORS disjunta) são recusados mesmo listados;
 *   3. nenhuma página publicada carrega script de fora do pacote, salvo a
 *      exceção exata de SCRIPTS_EXTERNOS_PERMITIDOS (página e URL literais:
 *      o Turnstile oficial no login e na recuperação de senha do Portal);
 *   4. todo recurso carregado por página ou folha de estilo publicada
 *      (script, link, img, url()) também está na allowlist;
 *   5. a saída não existe ou está vazia, e fica fora do código-fonte.
 * Depois da cópia, o pacote é verificado: exatamente os arquivos da
 * allowlist, nem um a mais, nem um a menos.
 *
 * Uso: node publicacao/empacotar.js --saida <diretório vazio fora de frontend/>
 */

const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.resolve(__dirname, '..');
const ARQUIVO_ALLOWLIST = path.join(__dirname, 'allowlist.json');
const NUNCA_PUBLICAR = ['js/main.js', 'js/db-api.js', 'js/inspecao-visual.js', 'painel-privado/'];
const COM_ESQUEMA = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
// Única exceção: o script oficial do Turnstile, só no login e na recuperação de
// senha do Portal. Comparação literal da página e da URL; nada de prefixo,
// domínio ou padrão.
const TURNSTILE_OFICIAL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const SCRIPTS_EXTERNOS_PERMITIDOS = new Map([
  ['portal/index.html', [TURNSTILE_OFICIAL]],
  ['portal/recuperar-senha.html', [TURNSTILE_OFICIAL]],
]);

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
    throw new ErroPublicacao('ENTRADA_INVALIDA', 'allowlist sem a lista "arquivos"');
  }
  return dados.arquivos.slice();
}

function absoluto(raiz, relativo) {
  return path.join(raiz, ...relativo.split('/'));
}

function dentroDe(pai, caminho) {
  return caminho === pai || caminho.startsWith(pai + path.sep);
}

// Caminho real mesmo que o destino ainda não exista (resolve o ancestral existente).
function caminhoReal(abs) {
  const pendentes = [];
  let atual = abs;
  while (!fs.existsSync(atual)) {
    pendentes.unshift(path.basename(atual));
    atual = path.dirname(atual);
  }
  return path.join(fs.realpathSync(atual), ...pendentes);
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
    if (NUNCA_PUBLICAR.some((p) => (p.endsWith('/') ? entrada.startsWith(p) : entrada === p))) {
      throw new ErroPublicacao('NUNCA_PUBLICAR', `${entrada} nunca entra no pacote do cliente`);
    }
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
  }
}

function valoresDoAtributo(html, tag, atributo) {
  const re = new RegExp(`<${tag}\\b[^>]*?\\s${atributo}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'gi');
  return [...html.matchAll(re)].map((m) => m[1] ?? m[2] ?? m[3]);
}

function urlsDeCss(css) {
  return [...css.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi)].map((m) => m[2]);
}

// Referência local -> caminho relativo à raiz do pacote (null se externa ou vazia).
function resolverLocal(origem, referencia) {
  const semSufixo = referencia.trim().split(/[?#]/)[0];
  if (!semSufixo || COM_ESQUEMA.test(semSufixo)) return null;
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
    let carregados;
    if (extensao === '.html') {
      const html = texto.replace(/<!--[\s\S]*?-->/g, '');
      const scripts = valoresDoAtributo(html, 'script', 'src');
      const permitidos = SCRIPTS_EXTERNOS_PERMITIDOS.get(entrada) || [];
      const externo = scripts.find((s) => COM_ESQUEMA.test(s.trim()) && !permitidos.includes(s));
      if (externo) {
        throw new ErroPublicacao('SCRIPT_EXTERNO', `${entrada} carrega script de fora do pacote: ${externo}`);
      }
      const estilos = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].flatMap((m) => urlsDeCss(m[1]));
      carregados = [...scripts, ...valoresDoAtributo(html, 'link', 'href'), ...valoresDoAtributo(html, 'img', 'src'), ...estilos];
    } else {
      carregados = urlsDeCss(texto);
    }
    for (const referencia of carregados) {
      const alvo = resolverLocal(entrada, referencia);
      if (alvo !== null && !permitidos.has(alvo)) {
        throw new ErroPublicacao('RECURSO_FORA_DA_ALLOWLIST', `${entrada} carrega ${referencia}, que não está na allowlist`);
      }
    }
  }
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

/** Confirma que o diretório contém exatamente os arquivos da allowlist. */
function verificarPacote(dir, arquivos = lerAllowlist()) {
  const presentes = new Set(listarPacote(dir));
  const esperados = new Set(arquivos);
  const aMais = [...presentes].filter((f) => !esperados.has(f)).sort();
  const aMenos = [...esperados].filter((f) => !presentes.has(f)).sort();
  if (aMais.length || aMenos.length) {
    throw new ErroPublicacao('PACOTE_DIVERGENTE',
      `pacote diferente da allowlist — a mais: [${aMais.join(', ')}]; a menos: [${aMenos.join(', ')}]`);
  }
}

function empacotar({ saida, arquivos = lerAllowlist(), raiz = RAIZ } = {}) {
  validarEntradas(arquivos, raiz);
  validarConteudo(arquivos, raiz);
  const destino = validarSaida(saida, raiz);

  fs.mkdirSync(destino, { recursive: true });
  for (const entrada of arquivos) {
    const alvo = absoluto(destino, entrada);
    fs.mkdirSync(path.dirname(alvo), { recursive: true });
    fs.copyFileSync(absoluto(raiz, entrada), alvo, fs.constants.COPYFILE_EXCL);
  }
  verificarPacote(destino, arquivos);
  return { saida: destino, arquivos: [...arquivos].sort() };
}

if (require.main === module) {
  const argumentos = process.argv.slice(2);
  const saida = argumentos.length === 2 && argumentos[0] === '--saida' ? argumentos[1] : null;
  try {
    const resultado = empacotar({ saida });
    console.log(`Pacote do cliente gerado em ${resultado.saida}: ${resultado.arquivos.length} arquivos da allowlist.`);
  } catch (erro) {
    console.error(`Publicação recusada (${erro.codigo || 'ERRO'}): ${erro.message}`);
    process.exitCode = 1;
  }
}

module.exports = { empacotar, verificarPacote, lerAllowlist, ErroPublicacao, NUNCA_PUBLICAR };
