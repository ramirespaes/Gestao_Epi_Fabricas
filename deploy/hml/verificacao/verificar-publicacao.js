'use strict';

/**
 * Verificação pós-publicação (somente leitura, só GET). Confere, contra uma URL:
 *   estático: IDENTIFICACAO (versao.json = commit/rótulo/manifesto esperados),
 *             ARQUIVOS (SHA-256 de cada arquivo servido), CABECALHOS (CSP mínima,
 *             no-cache em html/js/css, nosniff) e ISOLAMENTO (arquivos de outro
 *             componente, dotfiles e .releases não são servidos);
 *   api:      SAUDE_API (/api/health responde ok).
 * Nunca lança por falha de rede: a falha vira uma verificação reprovada. Não segue
 * redirecionamentos, não envia credenciais e limita a concorrência.
 *
 * Uso: node verificar-publicacao.js --base-url <url> --tipo <estatico|api>
 *        [--release <dir> --componente <nome> [--isolamento-de <manifesto>]...] [--timeout-ms <n>]
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const CAMINHOS_SENSIVEIS = ['/.env', '/.git/config', '/.releases/', '/estado.json'];
const STATUS_DE_NEGACAO = new Set([403, 404, 410]);
const MAX_DETALHES = 5;

class ErroVerificacao extends Error {
  constructor(codigo, mensagem) {
    super(mensagem);
    this.name = 'ErroVerificacao';
    this.codigo = codigo;
  }
}
const entrada = (m) => new ErroVerificacao('VERIFICACAO_ENTRADA_INVALIDA', m);
const sha256 = (c) => crypto.createHash('sha256').update(c).digest('hex');

const HEX64 = /^[0-9a-f]{64}$/;
const CAMPOS_DA_VERSAO = ['commit', 'componente', 'manifestoSha256', 'rotulo'];

// A identificação esperada precisa ser completa e bem formada: um campo ausente nunca "bate" com outro ausente.
function validarVersaoEsperada(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw entrada('versaoEsperada é obrigatória para frontend estático');
  const ok = typeof v.componente === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(v.componente)
    && typeof v.rotulo === 'string' && /^hml-\d{8}T\d{6}-[0-9a-f]{7}(-retroativo)?$/.test(v.rotulo)
    && typeof v.commit === 'string' && /^[0-9a-f]{40}$/.test(v.commit)
    && typeof v.manifestoSha256 === 'string' && HEX64.test(v.manifestoSha256);
  if (!ok) throw entrada('versaoEsperada precisa trazer componente, rótulo, commit (40 hexadecimais) e manifestoSha256 (64 hexadecimais) válidos');
}

function diretivasDe(politica) {
  const mapa = new Map();
  for (const parte of politica.split(';')) {
    const [nome, ...tokens] = parte.trim().split(/\s+/);
    if (nome && !mapa.has(nome.toLowerCase())) mapa.set(nome.toLowerCase(), tokens);
  }
  return mapa;
}

const DIRETIVAS_DE_RECURSO = ['script-src', 'script-src-elem', 'style-src', 'style-src-elem', 'img-src', 'font-src', 'connect-src', 'frame-src', 'child-src', 'worker-src', 'media-src', 'manifest-src', 'prefetch-src'];
const PALAVRAS_SEGURAS = new Set(["'self'", "'none'", "'strict-dynamic'", "'report-sample'"]);
const HASH_OU_NONCE = /^'(?:(?:sha256|sha384|sha512)-[A-Za-z0-9+/=_-]+|nonce-[A-Za-z0-9+/=_-]+)'$/;
const ESQUEMA_SOLTO = /^[a-z][a-z0-9+.-]*:$/i;
const HOST_HTTPS = /^https:\/\/[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::\d{1,5})?$/;

/**
 * Política mínima aceita. Nas diretivas de recurso só valem 'self', 'none', hash, nonce e host https
 * explícito (sem curinga e sem caminho); esquema solto como https: ou ws: nunca; data: só em img-src.
 * 'unsafe-inline' só em style-src-attr, 'unsafe-hashes' só nos atributos, 'unsafe-eval' nunca.
 */
function avaliarCsp(politica) {
  if (typeof politica !== 'string' || politica.trim() === '') return ['CSP ausente'];
  const d = diretivasDe(politica);
  const problemas = [];
  const soNone = (nome) => {
    const t = d.get(nome);
    if (!t) problemas.push(`${nome} ausente`);
    else if (t.length !== 1 || t[0] !== "'none'") problemas.push(`${nome} precisa ser 'none'`);
  };
  soNone('object-src'); soNone('base-uri'); soNone('frame-ancestors');
  const padrao = d.get('default-src');
  if (!padrao) problemas.push('default-src ausente');
  else if (!padrao.every((t) => t === "'none'" || t === "'self'")) problemas.push("default-src precisa ser 'none' ou 'self'");
  const acao = d.get('form-action');
  if (!acao) problemas.push('form-action ausente');
  else if (!acao.every((t) => t === "'self'" || t === "'none'")) problemas.push("form-action precisa ser 'self' ou 'none'");
  if (!d.get('script-src')) problemas.push('script-src ausente');

  for (const nome of DIRETIVAS_DE_RECURSO) {
    for (const t of d.get(nome) || []) {
      if (t.startsWith("'")) {
        if (!PALAVRAS_SEGURAS.has(t) && !HASH_OU_NONCE.test(t)) problemas.push(`${nome}: palavra-chave não permitida ${t}`);
      } else if (ESQUEMA_SOLTO.test(t)) {
        if (!(nome === 'img-src' && t.toLowerCase() === 'data:')) problemas.push(`${nome}: esquema solto não permitido ${t}`);
      } else if (t.includes('*')) {
        problemas.push(`${nome}: curinga não permitido`);
      } else if (!HOST_HTTPS.test(t)) {
        problemas.push(`${nome}: origem precisa ser https://host[:porta] explícito, veio ${t}`);
      }
    }
  }
  for (const [nome, extras] of [['script-src-attr', []], ['style-src-attr', ["'unsafe-inline'"]]]) {
    for (const t of d.get(nome) || []) {
      if (t !== "'none'" && t !== "'unsafe-hashes'" && !HASH_OU_NONCE.test(t) && !extras.includes(t)) problemas.push(`${nome}: valor não permitido ${t}`);
    }
  }
  return problemas;
}

async function pool(itens, concorrencia, trabalho) {
  const resultados = new Array(itens.length);
  let proximo = 0;
  const operario = async () => {
    for (let i = proximo; i < itens.length; i = proximo) {
      proximo += 1;
      resultados[i] = await trabalho(itens[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concorrencia, itens.length) }, operario));
  return resultados;
}

function resumir(falhas, rotuloVazio) {
  const mostradas = falhas.slice(0, MAX_DETALHES).join('; ');
  return falhas.length > MAX_DETALHES ? `${mostradas} (+${falhas.length - MAX_DETALHES})` : (mostradas || rotuloVazio);
}

async function verificarPublicacao({ baseUrl, tipo, versaoEsperada, manifesto = {}, ausentes = [], fetchImpl = globalThis.fetch, concorrencia = 8, timeoutMs = 5000 } = {}) {
  let url;
  try { url = new URL(baseUrl); } catch { throw entrada('baseUrl inválida'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw entrada('baseUrl precisa ser http(s) sem credenciais');
  if (tipo !== 'estatico' && tipo !== 'api') throw entrada('tipo precisa ser estatico ou api');
  const base = url.origin;

  const pedir = async (caminho) => {
    try {
      const resposta = await fetchImpl(`${base}${caminho}`, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), credentials: 'omit' });
      return { status: resposta.status, headers: resposta.headers, corpo: Buffer.from(await resposta.arrayBuffer()) };
    } catch (falha) {
      return { erro: `${falha.name || 'Erro'}: ${falha.message}`.slice(0, 120) };
    }
  };
  const verificacoes = [];
  const registrar = (nome, falhas, detalheOk) => verificacoes.push({ nome, ok: falhas.length === 0, detalhe: falhas.length === 0 ? detalheOk : resumir(falhas) });

  if (tipo === 'api') {
    const r = await pedir('/api/health');
    let falha = r.erro;
    if (!falha) {
      let corpo = null;
      try { corpo = JSON.parse(r.corpo.toString('utf8')); } catch { /* corpo não JSON */ }
      if (r.status !== 200) falha = `HTTP ${r.status}`;
      else if (!corpo || corpo.status !== 'ok' || corpo.service !== 'gestao-epi-api') falha = 'corpo diferente do esperado';
    }
    registrar('SAUDE_API', falha ? [falha] : [], '/api/health respondeu ok');
    return { ok: verificacoes.every((v) => v.ok), verificacoes };
  }

  validarVersaoEsperada(versaoEsperada);
  if (!manifesto || typeof manifesto !== 'object' || Object.keys(manifesto).length === 0) throw entrada('manifesto vazio ou ausente: não há o que conferir');

  const versao = await pedir('/versao.json');
  const idFalhas = [];
  if (versao.erro) idFalhas.push(versao.erro);
  else if (versao.status !== 200) idFalhas.push(`/versao.json respondeu HTTP ${versao.status}`);
  else {
    let corpo;
    try { corpo = JSON.parse(versao.corpo.toString('utf8')); } catch { idFalhas.push('/versao.json não é JSON'); }
    if (corpo !== undefined) {
      if (corpo === null || typeof corpo !== 'object' || Array.isArray(corpo)) idFalhas.push('/versao.json não é um objeto');
      else {
        const chaves = Object.keys(corpo).sort();
        if (chaves.join(',') !== CAMPOS_DA_VERSAO.join(',')) idFalhas.push(`/versao.json precisa ter exatamente os campos ${CAMPOS_DA_VERSAO.join(', ')}`);
        for (const campo of CAMPOS_DA_VERSAO) if (typeof corpo[campo] !== 'string' || corpo[campo] !== versaoEsperada[campo]) idFalhas.push(`${campo} publicado difere do esperado`);
      }
    }
  }
  registrar('IDENTIFICACAO', idFalhas, `${versaoEsperada.rotulo} (${String(versaoEsperada.commit).slice(0, 7)})`);

  const arquivos = Object.keys(manifesto).sort();
  const respostas = await pool(arquivos, concorrencia, async (rel) => ({ rel, r: await pedir(`/${rel.split('/').map(encodeURIComponent).join('/')}`) }));
  const arqFalhas = [];
  for (const { rel, r } of respostas) {
    if (r.erro) arqFalhas.push(`${rel}: ${r.erro}`);
    else if (r.status !== 200) arqFalhas.push(`${rel}: HTTP ${r.status}`);
    else if (sha256(r.corpo) !== manifesto[rel]) arqFalhas.push(`${rel}: conteúdo diferente do manifesto`);
  }
  registrar('ARQUIVOS', arqFalhas, `${arquivos.length} arquivos conferidos por SHA-256`);

  const cabFalhas = [];
  const comResposta = respostas.filter(({ r }) => !r.erro && r.status === 200);
  if (comResposta.length === 0) cabFalhas.push('nenhuma resposta válida para conferir os cabeçalhos');
  for (const { rel, r } of comResposta) {
    if (String(r.headers.get('x-content-type-options') || '').toLowerCase() !== 'nosniff') cabFalhas.push(`${rel}: sem X-Content-Type-Options nosniff`);
    if (/\.(html|js|css)$/.test(rel) && !/no-cache/i.test(r.headers.get('cache-control') || '')) cabFalhas.push(`${rel}: sem Cache-Control no-cache`);
    if (/\.html$/.test(rel)) {
      const problemas = avaliarCsp(r.headers.get('content-security-policy'));
      if (problemas.length) cabFalhas.push(`${rel}: CSP ${problemas[0]}`);
    }
  }
  registrar('CABECALHOS', cabFalhas, 'CSP, no-cache e nosniff conferidos');

  const proibidos = [...new Set([...ausentes.map((a) => `/${a}`), ...CAMINHOS_SENSIVEIS])];
  const isoladas = await pool(proibidos, concorrencia, async (caminho) => ({ caminho, r: await pedir(caminho) }));
  const isoFalhas = isoladas.filter(({ r }) => r.erro || !STATUS_DE_NEGACAO.has(r.status)).map(({ caminho, r }) => `${caminho}: ${r.erro || `HTTP ${r.status}`}`);
  registrar('ISOLAMENTO', isoFalhas, `${proibidos.length} caminhos negados`);

  return { ok: verificacoes.every((v) => v.ok), verificacoes };
}

const invalido = (codigo, m) => new ErroVerificacao(codigo, m);

// Manifesto estrito: cada linha é "<sha256 minúsculo>␣␣<caminho relativo seguro>", sem linha vazia no meio, sem
// caminho absoluto, com traversal, barra invertida, segmento vazio ou "." e sem duplicidade.
function interpretarManifesto(texto, origem) {
  const falha = (m) => invalido('MANIFESTO_INVALIDO', `${origem}: ${m}`);
  if (typeof texto !== 'string' || texto === '') throw falha('vazio');
  const linhas = texto.split('\n');
  if (linhas.at(-1) === '') linhas.pop();
  const manifesto = Object.create(null);
  linhas.forEach((linha, i) => {
    const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(linha);
    if (!m) throw falha(`linha ${i + 1} fora do formato "<sha256 minúsculo>  <caminho>"`);
    const rel = m[2];
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f\\]/.test(rel) || rel.startsWith('/') || path.posix.normalize(rel) !== rel || rel.split('/').some((s) => s === '' || s === '.' || s === '..')) throw falha(`linha ${i + 1}: caminho inseguro`);
    if (rel in manifesto) throw falha(`linha ${i + 1}: caminho duplicado (${rel})`);
    manifesto[rel] = m[1];
  });
  if (Object.keys(manifesto).length === 0) throw falha('sem nenhum arquivo');
  return manifesto;
}

// Lê o manifesto do componente e o confere contra o release.json: hash do arquivo, contagem e conteúdo das linhas.
function lerManifestoDoRelease(arquivo, secao) {
  const texto = fs.readFileSync(arquivo, 'utf8');
  if (sha256(texto) !== secao.manifestoSha256) throw invalido('MANIFESTO_INVALIDO', 'o manifesto não confere com o SHA-256 declarado no release.json');
  const manifesto = interpretarManifesto(texto, path.basename(arquivo));
  if (Object.keys(manifesto).length !== secao.arquivos) throw invalido('MANIFESTO_INVALIDO', `o manifesto lista ${Object.keys(manifesto).length} arquivo(s), mas o release.json declara ${secao.arquivos}`);
  return manifesto;
}
const lerManifestoSoFormato = (arquivo) => interpretarManifesto(fs.readFileSync(arquivo, 'utf8'), path.basename(arquivo));

function lerArgumentos(argv) {
  const v = { isolamentoDe: [] };
  for (let i = 0; i < argv.length; i += 2) {
    const nome = argv[i];
    if (!['--base-url', '--tipo', '--release', '--componente', '--isolamento-de', '--timeout-ms'].includes(nome) || argv[i + 1] === undefined) throw entrada(`argumento inválido: ${nome}`);
    if (nome === '--isolamento-de') v.isolamentoDe.push(argv[i + 1]);
    else v[nome.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[i + 1];
  }
  if (!v.baseUrl || !v.tipo) throw entrada('--base-url e --tipo são obrigatórios');
  return v;
}

async function principal(argv) {
  const v = lerArgumentos(argv);
  const opcoes = { baseUrl: v.baseUrl, tipo: v.tipo };
  if (v.timeoutMs) opcoes.timeoutMs = Number(v.timeoutMs);
  if (v.tipo === 'estatico') {
    if (!v.release || !v.componente) throw entrada('--release e --componente são obrigatórios para estático');
    let release;
    try { release = JSON.parse(fs.readFileSync(path.join(v.release, 'release.json'), 'utf8')); } catch { throw invalido('RELEASE_INVALIDA', 'release.json ausente ou ilegível'); }
    if (release === null || typeof release !== 'object' || Array.isArray(release)) throw invalido('RELEASE_INVALIDA', 'release.json fora do formato esperado');
    const secao = release[v.componente];
    if (!secao || typeof secao !== 'object' || !Number.isInteger(secao.arquivos) || secao.arquivos < 1 || typeof secao.manifestoSha256 !== 'string' || !HEX64.test(secao.manifestoSha256)) throw invalido('RELEASE_INVALIDA', `release sem a seção ${v.componente} válida`);
    opcoes.versaoEsperada = { componente: v.componente, rotulo: release.rotulo, commit: release.commit, manifestoSha256: secao.manifestoSha256 };
    validarVersaoEsperada(opcoes.versaoEsperada);
    opcoes.manifesto = lerManifestoDoRelease(path.join(v.release, `manifesto-${v.componente}.sha256`), secao);
    const proprios = new Set(Object.keys(opcoes.manifesto));
    opcoes.ausentes = [...new Set(v.isolamentoDe.flatMap((m) => Object.keys(lerManifestoSoFormato(m))))].filter((rel) => !proprios.has(rel)).sort();
  }
  return verificarPublicacao(opcoes);
}

if (require.main === module) {
  principal(process.argv.slice(2)).then((resultado) => {
    process.stdout.write(`${JSON.stringify(resultado)}\n`);
    process.exitCode = resultado.ok ? 0 : 1;
  }, (falha) => {
    console.error(`Verificação recusada (${falha.codigo || 'ERRO'}): ${falha.message}`);
    process.exitCode = 1;
  });
}

module.exports = { verificarPublicacao, avaliarCsp, ErroVerificacao };
