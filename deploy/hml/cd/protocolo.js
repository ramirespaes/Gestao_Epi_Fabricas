'use strict';
const fs = require('node:fs');
const path = require('node:path');
const N = require('../instalador/nucleo');
const COMPONENTES = ['portal', 'painel'];
// Escopo da publicação: o pedido v1 (fluxo atual de Portal e Painel) é sempre frontend; o pedido v2 declara o escopo.
// Quem valida declara o escopo que espera (padrão: frontend), então uma autorização de um escopo nunca vale para o outro.
const ESCOPOS = ['frontend', 'backend'];
const escopoValido = e => typeof e === 'string' && ESCOPOS.includes(e);
const CHAVES_PEDIDO_V1 = 'blobSha256,commit,criadoEm,expiraEm,id,permitirAnterior,releaseSha256,repositorio,rotulo,versao';
const CHAVES_PEDIDO_V2 = 'blobSha256,commit,criadoEm,escopo,expiraEm,id,permitirAnterior,releaseSha256,repositorio,rotulo,versao';
const CHAVES_RELEASE_BACKEND = 'atual,backend,commit,geradoEm,rotulo';
const CHAVES_SECAO_BACKEND = 'arquivos,contratos,lockfileSha256,manifestoSha256,migrations,node';
const REPO = 'ramirespaes/Gestao_Epi_Fabricas';
const ID = /^[1-9][0-9]{0,19}-[1-9][0-9]{0,5}$/;
const MAX = 64 * 1024 * 1024;
const recusar = codigo => { throw Object.assign(new Error(codigo), { codigo }); };
const exigir = (ok, codigo) => { if (!ok) recusar(codigo); };
const json = b => { exigir(b.length <= MAX, 'TAMANHO'); return JSON.parse(b.toString('utf8')); };
function arquivos(dir, prefixo = '') {
  const encontrados = [];
  for (const nome of fs.readdirSync(dir).sort()) {
    exigir(/^[A-Za-z0-9_.-]+$/.test(nome) && !nome.startsWith('.'), 'NOME_INVALIDO');
    const abs = path.join(dir, nome), st = fs.lstatSync(abs), rel = prefixo + nome;
    exigir(!st.isSymbolicLink() && (st.isFile() || st.isDirectory()), 'TIPO_INVALIDO');
    if (st.isDirectory()) encontrados.push(...arquivos(abs, rel + '/'));
    else { exigir(st.nlink === 1 && st.size <= MAX, 'ARQUIVO_INVALIDO'); encontrados.push(rel); }
    exigir(encontrados.length <= 5000, 'QUANTIDADE');
  }
  return encontrados;
}
// Release do backend (empacotar-backend.js): só `backend`, o manifesto e o release.json, com a identidade aprovada.
// A integridade dos arquivos é a do próprio empacotador (manifesto, contagem e hashes), reutilizada sem duplicar regra.
function conferirReleaseBackend({ dir, commit, rotulo, releaseSha256 }) {
  exigir(N.SHA_COMPLETO.test(commit || '') && N.ROTULO.test(rotulo || '') && N.HEX64.test(releaseSha256 || ''), 'IDENTIDADE_INVALIDA');
  exigir(fs.lstatSync(dir).isDirectory() && !fs.lstatSync(dir).isSymbolicLink(), 'TIPO_INVALIDO');
  exigir(fs.readdirSync(dir).sort().join(',') === 'backend,manifesto-backend.sha256,release.json', 'ESCOPO_INVALIDO');
  arquivos(dir);
  const bruto = fs.readFileSync(path.join(dir, 'release.json'));
  exigir(N.sha256(bruto) === releaseSha256, 'HASH_RELEASE');
  const release = json(bruto);
  const objeto = o => o !== null && typeof o === 'object' && !Array.isArray(o);
  exigir(objeto(release) && Object.keys(release).sort().join(',') === CHAVES_RELEASE_BACKEND, 'ESCOPO_INVALIDO');
  exigir(objeto(release.backend) && Object.keys(release.backend).sort().join(',') === CHAVES_SECAO_BACKEND, 'ESCOPO_INVALIDO');
  exigir(release.commit === commit && release.rotulo === rotulo && rotulo.includes('-' + commit.slice(0, 7)), 'COMMIT_DIVERGENTE');
  exigir(release.atual === true && !rotulo.endsWith('-retroativo'), 'RETROATIVO_BLOQUEADO');
  const { verificarReleaseBackend } = require('../empacotar-backend');
  try { verificarReleaseBackend(dir); } catch (falha) { throw Object.assign(new Error(falha.message), { codigo: falha.codigo || 'RELEASE_DIVERGENTE' }); }
  return { release };
}
function conferirRelease({ dir, commit, rotulo, releaseSha256, escopo = 'frontend' }) {
  exigir(escopoValido(escopo), 'IDENTIDADE_INVALIDA');
  if (escopo === 'backend') return conferirReleaseBackend({ dir, commit, rotulo, releaseSha256 });
  exigir(N.SHA_COMPLETO.test(commit || '') && N.ROTULO.test(rotulo || '') && N.HEX64.test(releaseSha256 || ''), 'IDENTIDADE_INVALIDA');
  exigir(fs.lstatSync(dir).isDirectory() && !fs.lstatSync(dir).isSymbolicLink(), 'TIPO_INVALIDO');
  exigir(fs.readdirSync(dir).sort().join(',') === 'manifesto-painel.sha256,manifesto-portal.sha256,painel,portal,release.json', 'ESCOPO_INVALIDO');
  arquivos(dir);
  const bruto = fs.readFileSync(path.join(dir, 'release.json'));
  exigir(N.sha256(bruto) === releaseSha256, 'HASH_RELEASE');
  const release = json(bruto);
  exigir(Object.keys(release).sort().join(',') === 'atual,commit,geradoEm,painel,portal,rotulo', 'ESCOPO_INVALIDO');
  exigir(release.commit === commit && release.rotulo === rotulo && rotulo.includes('-' + commit.slice(0, 7)), 'COMMIT_DIVERGENTE');
  const componentes = {};
  for (const c of COMPONENTES) componentes[c] = N.lerRelease(dir, c, { tipo: 'estatico' }, { releaseSha256Esperado: releaseSha256 });
  return { release, componentes };
}
function empacotar(dir, identidade) {
  conferirRelease({ dir, ...identidade });
  const conteudo = arquivos(dir).map(nome => [nome, fs.readFileSync(path.join(dir, nome)).toString('base64')]);
  const b = Buffer.from(JSON.stringify(conteudo));
  exigir(b.length <= MAX, 'TAMANHO');
  return b;
}
function extrair(b, dir) {
  const pares = json(b);
  exigir(Array.isArray(pares) && pares.length > 0 && pares.length <= 5000, 'PACOTE_INVALIDO');
  const vistos = new Set();
  for (const par of pares) {
    exigir(Array.isArray(par) && par.length === 2, 'PACOTE_INVALIDO');
    const [nome, texto] = par;
    exigir(typeof nome === 'string' && nome.length <= 256 && nome.split('/').every(s => /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(s)) && !vistos.has(nome), 'CAMINHO_INVALIDO');
    exigir(typeof texto === 'string' && Buffer.from(texto, 'base64').toString('base64') === texto, 'BASE64_INVALIDO');
    vistos.add(nome);
  }
  exigir(!fs.existsSync(dir), 'DESTINO_EXISTENTE');
  fs.mkdirSync(dir, { mode: 0o700 });
  for (const [nome, texto] of pares) {
    const abs = path.join(dir, nome);
    fs.mkdirSync(path.dirname(abs), { recursive: true, mode: 0o700 });
    fs.writeFileSync(abs, Buffer.from(texto, 'base64'), { flag: 'wx', mode: 0o600 });
  }
}
const escopoDoPedido = p => (p.versao === 1 ? 'frontend' : p.escopo);
function validarEstruturaPedido(p) {
  exigir(p !== null && typeof p === 'object' && !Array.isArray(p), 'PEDIDO_INVALIDO');
  const chaves = Object.keys(p).sort().join(',');
  exigir((p.versao === 1 && chaves === CHAVES_PEDIDO_V1) || (p.versao === 2 && chaves === CHAVES_PEDIDO_V2 && escopoValido(p.escopo)), 'PEDIDO_INVALIDO');
  exigir(p.repositorio === REPO && ID.test(p.id) && N.SHA_COMPLETO.test(p.commit) && N.ROTULO.test(p.rotulo) && N.HEX64.test(p.releaseSha256) && N.HEX64.test(p.blobSha256) && typeof p.permitirAnterior === 'boolean', 'PEDIDO_INVALIDO');
  return p;
}
function validarPedido(p, agora = Date.now(), { escopo = 'frontend' } = {}) {
  exigir(escopoValido(escopo), 'ESCOPO_INVALIDO');
  validarEstruturaPedido(p);
  exigir(escopoDoPedido(p) === escopo, 'ESCOPO_DIVERGENTE');
  const criado = Date.parse(p.criadoEm), expira = Date.parse(p.expiraEm);
  exigir(Number.isFinite(criado) && Number.isFinite(expira) && criado <= agora + 30000 && expira > agora && expira > criado && expira - criado <= 15 * 60000, 'PEDIDO_EXPIRADO');
  exigir(!p.rotulo.endsWith('-retroativo') || p.permitirAnterior, 'RETROATIVO_BLOQUEADO');
  exigir(escopo !== 'backend' || (!p.permitirAnterior && !p.rotulo.endsWith('-retroativo')), 'RETROATIVO_BLOQUEADO');
  return p;
}
function validarRecibo(r, p) {
  exigir(r && r.id === p.id && r.commit === p.commit && r.releaseSha256 === p.releaseSha256 && ['SUCESSO', 'RECUSADO', 'FALHOU', 'CRITICO'].includes(r.estado), 'RECIBO_INVALIDO');
  // O recibo repete o escopo do pedido v2; para o pedido v1 (frontend) o recibo não tem escopo, como sempre foi.
  exigir(r.escopo === (p.versao === 2 ? p.escopo : undefined), 'RECIBO_INVALIDO');
  exigir(r.estado === 'SUCESSO' && r.verificado === true, 'DEPLOY_NAO_APROVADO');
  return r;
}
function validarDestino(e) {
  exigir(/^[0-9]{12}$/.test(e.HML_CONTA || '') && /^[a-z]{2}-[a-z]+-[1-9]$/.test(e.HML_REGIAO || '') && /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(e.HML_BUCKET || ''), 'DESTINO_INVALIDO');
  exigir(typeof e.HML_ROLE === 'string' && new RegExp(`^arn:aws:iam::${e.HML_CONTA}:role/[A-Za-z0-9_+=,.@/-]+$`).test(e.HML_ROLE), 'ROLE_INVALIDA');
}
module.exports = { COMPONENTES, ESCOPOS, escopoDoPedido, REPO, ID, MAX, exigir, json, arquivos, conferirRelease, empacotar, extrair, validarEstruturaPedido, validarPedido, validarRecibo, validarDestino };
