#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sha256Arquivo, verificarManifesto } = require('./manifesto.js');

const RE_HEX64 = /^[0-9a-f]{64}$/;
const RE_ID = /^[a-z][a-z0-9-]{0,31}$/;
const RE_LIMITE_BYTES = /^[1-9][0-9]{0,14}$/;
const MAX_TENTATIVAS = 3;
const LIMITE_PADRAO_BYTES = 20 * 1024 ** 3;
const MARGEM_ESPACO = 16 * 1024 ** 2;
const TAMANHO_BLOCO = 1024 * 1024;

class ErroBackup extends Error {
  constructor(codigo, saida) {
    super(codigo);
    this.codigo = codigo;
    this.saida = saida;
  }
}

function listarArvore(raiz) {
  const entradas = [];
  const anomalias = [];
  let instavel = false;
  const percorrer = (dir, rel) => {
    let nomes;
    try {
      nomes = fs.readdirSync(dir).sort();
    } catch (e) {
      if (e.code === 'ENOENT') { instavel = true; return; }
      throw new ErroBackup('E_LEITURA_ORIGEM', 5);
    }
    for (const nome of nomes) {
      const abs = path.join(dir, nome);
      const r = rel ? `${rel}/${nome}` : nome;
      let st;
      try {
        st = fs.lstatSync(abs, { bigint: true });
      } catch (e) {
        if (e.code === 'ENOENT') { instavel = true; continue; }
        throw new ErroBackup('E_LEITURA_ORIGEM', 5);
      }
      if (st.isSymbolicLink()) anomalias.push({ rel: r, tipo: 'LINK_SIMBOLICO' });
      else if (st.isDirectory()) percorrer(abs, r);
      else if (st.isFile()) entradas.push({ rel: r, tamanho: Number(st.size), mtimeNs: st.mtimeNs.toString(), ino: st.ino.toString() });
      else anomalias.push({ rel: r, tipo: 'ESPECIAL' });
    }
  };
  percorrer(raiz, '');
  return { entradas, anomalias, instavel };
}

function fingerprint(listagem) {
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  for (const e of listagem.entradas) {
    hash.update(`${e.rel}\t${e.tamanho}\t${e.mtimeNs}\t${e.ino}\n`);
    bytes += e.tamanho;
  }
  for (const a of listagem.anomalias) hash.update(`!${a.rel}\t${a.tipo}\n`);
  return { arquivos: listagem.entradas.length, bytes, sha256: hash.digest('hex') };
}

function copiarArquivo(origem, destino) {
  let fd;
  try {
    fd = fs.openSync(origem, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  } catch (e) {
    if (e.code === 'ENOENT') return { ausente: true };
    throw new ErroBackup('E_LEITURA_ORIGEM', 5);
  }
  let st0;
  let saida;
  try {
    st0 = fs.fstatSync(fd, { bigint: true });
    if (!st0.isFile()) throw new ErroBackup('E_ANOMALIA_ORIGEM', 5);
    fs.mkdirSync(path.dirname(destino), { recursive: true, mode: 0o700 });
    saida = fs.openSync(destino, 'wx', 0o600);
  } catch (e) {
    fs.closeSync(fd);
    throw e;
  }
  const hash = crypto.createHash('sha256');
  const buf = Buffer.allocUnsafe(TAMANHO_BLOCO);
  let total = 0;
  let st1;
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
      fs.writeSync(saida, buf, 0, n);
      total += n;
    }
    fs.fsyncSync(saida);
    st1 = fs.fstatSync(fd, { bigint: true });
  } finally {
    fs.closeSync(saida);
    fs.closeSync(fd);
  }
  let atual = null;
  try { atual = fs.lstatSync(origem, { bigint: true }); } catch { atual = null; }
  const estavel = atual !== null && BigInt(total) === st0.size && st0.size === st1.size && st0.mtimeNs === st1.mtimeNs
    && st0.ino === atual.ino && atual.mtimeNs === st0.mtimeNs;
  return { sha256: hash.digest('hex'), tamanho: total, estavel };
}

async function copiarFonte({ id, raiz, tdir, tentativa, ganchos }) {
  const l0 = listarArvore(raiz);
  if (l0.anomalias.length > 0) throw new ErroBackup('E_ANOMALIA_ORIGEM', 5);
  const f0 = fingerprint(l0);
  const arquivos = [];
  let instavel = l0.instavel;
  for (const [indice, e] of l0.entradas.entries()) {
    const partes = e.rel.split('/');
    const destino = path.join(tdir, id, ...partes);
    const r = copiarArquivo(path.join(raiz, ...partes), destino);
    if (r.ausente) {
      instavel = true;
    } else {
      const hashCopia = await sha256Arquivo(destino);
      if (r.estavel && hashCopia !== r.sha256) throw new ErroBackup('E_COPIA_CORROMPIDA', 5);
      if (!r.estavel) instavel = true;
      arquivos.push({ caminho: e.rel, tamanho_bytes: r.tamanho, sha256: hashCopia });
    }
    if (ganchos && ganchos.aposArquivo) ganchos.aposArquivo({ tentativa, fonte: id, rel: e.rel, indice });
  }
  const l1 = listarArvore(raiz);
  if (l1.anomalias.length > 0) throw new ErroBackup('E_ANOMALIA_ORIGEM', 5);
  const f1 = fingerprint(l1);
  if (l1.instavel) instavel = true;
  return { id, f0, f1, arquivos, estavel: !instavel && f0.sha256 === f1.sha256 };
}

function espacoLivreDe(dir) {
  const s = fs.statfsSync(dir);
  return Number(s.bavail) * Number(s.bsize);
}

async function copiaControlada({ fontes, runDir, maxTentativas = MAX_TENTATIVAS, ganchos = null, espacoLivre = espacoLivreDe, limiteBytes = LIMITE_PADRAO_BYTES }) {
  if (!Number.isInteger(maxTentativas) || maxTentativas < 1 || maxTentativas > MAX_TENTATIVAS) throw new ErroBackup('E_CONFIG', 2);
  if (!Number.isSafeInteger(limiteBytes) || limiteBytes <= 0) throw new ErroBackup('E_CONFIG', 2);
  const totalOrigem = () => fontes.reduce((s, f) => s + fingerprint(listarArvore(f.raiz)).bytes, 0);
  const tentativas = [];
  let copiado = 0;
  let ultima = null;
  fs.mkdirSync(path.join(runDir, 'tentativas'), { recursive: true, mode: 0o700 });
  for (let n = 1; n <= maxTentativas; n += 1) {
    const total = totalOrigem();
    if (copiado + total > limiteBytes) throw new ErroBackup('E_LIMITE_EXCEDIDO', 5);
    if (espacoLivre(runDir) < total + MARGEM_ESPACO) throw new ErroBackup('E_ESPACO_INSUFICIENTE', 5);
    const tdir = path.join(runDir, 'tentativas', String(n));
    fs.mkdirSync(tdir, { mode: 0o700 });
    const porFonte = [];
    for (const f of fontes) porFonte.push(await copiarFonte({ id: f.id, raiz: f.raiz, tdir, tentativa: n, ganchos }));
    copiado += porFonte.reduce((s, f) => s + f.f1.bytes, 0);
    const estavel = porFonte.every((f) => f.estavel);
    ultima = { numero: n, diretorio: `tentativas/${n}`, estavel, fontes: porFonte };
    tentativas.push(ultima);
    if (estavel) break;
  }
  return {
    concorrencia: ultima.estavel ? 'SEM_ALTERACAO' : 'COM_ALTERACAO_CONCORRENTE',
    tentativas,
    escolhida: ultima.numero,
    fontes: ultima.fontes.map((f) => ({ id: f.id, arquivos: f.arquivos, f0: f.f0, f1: f.f1 })),
  };
}

function parseReferencias(texto) {
  const refs = [];
  const invalida = () => new ErroBackup('E_REFERENCIAS_INVALIDAS', 2);
  for (const linha of texto.split('\n')) {
    if (linha.trim() === '') continue;
    let o;
    try { o = JSON.parse(linha); } catch { throw invalida(); }
    if (o === null || typeof o !== 'object' || Array.isArray(o)) throw invalida();
    if (Object.keys(o).some((k) => !['sha256', 'tamanho_bytes', 'chave'].includes(k))) throw invalida();
    if (typeof o.sha256 !== 'string' || !RE_HEX64.test(o.sha256)) throw invalida();
    if (o.tamanho_bytes !== undefined && (!Number.isInteger(o.tamanho_bytes) || o.tamanho_bytes < 0)) throw invalida();
    if (o.chave !== undefined && (typeof o.chave !== 'string' || o.chave === '' || o.chave.startsWith('/') || o.chave.includes('\\') || o.chave.split('/').some((p) => p === '..' || p === '' || p === '.'))) throw invalida();
    refs.push(o);
  }
  return refs;
}

function verificarReferencias(arquivos, referencias) {
  const porHash = new Map();
  const porCaminho = new Map();
  for (const a of arquivos) {
    porCaminho.set(a.caminho, a);
    if (!porHash.has(a.sha256)) porHash.set(a.sha256, []);
    porHash.get(a.sha256).push(a);
  }
  const faltantes = [];
  const divergentes = [];
  const referenciados = new Set();
  for (const r of referencias) {
    if (r.chave !== undefined) {
      const f = porCaminho.get(r.chave);
      if (!f) faltantes.push({ sha256: r.sha256, chave: r.chave });
      else if (f.sha256 !== r.sha256 || (r.tamanho_bytes !== undefined && f.tamanho_bytes !== r.tamanho_bytes)) divergentes.push({ sha256: r.sha256, chave: r.chave });
      else referenciados.add(f.caminho);
    } else {
      const candidatos = (porHash.get(r.sha256) || []).filter((f) => r.tamanho_bytes === undefined || f.tamanho_bytes === r.tamanho_bytes);
      if (candidatos.length > 0) candidatos.forEach((f) => referenciados.add(f.caminho));
      else if ((porHash.get(r.sha256) || []).length > 0) divergentes.push({ sha256: r.sha256 });
      else faltantes.push({ sha256: r.sha256 });
    }
  }
  return {
    status: faltantes.length === 0 && divergentes.length === 0 ? 'VERIFICADO_COMPLETO' : 'COM_PROBLEMAS',
    total: referencias.length,
    faltantes_total: faltantes.length,
    divergentes_total: divergentes.length,
    orfaos_total: arquivos.filter((a) => !referenciados.has(a.caminho)).length,
    faltantes: faltantes.slice(0, 50),
    divergentes: divergentes.slice(0, 50),
  };
}

function lerOpcoes(argv) {
  const o = { fonte: [], referencias: [] };
  const unicas = ['run-id', 'host', 'banco-exec', 'tentativas', 'banco-idade-max-s', 'limite-bytes', 'referencias-dir'];
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    if (!k.startsWith('--') || i + 1 >= argv.length) throw new ErroBackup('E_CONFIG', 2);
    const nome = k.slice(2);
    if (nome === 'fonte' || nome === 'referencias') o[nome].push(argv[i + 1]);
    else if (unicas.includes(nome) && o[nome] === undefined) o[nome] = argv[i + 1];
    else throw new ErroBackup('E_CONFIG', 2);
  }
  return o;
}

function dentroDe(base, alvo) {
  const r = path.relative(base, alvo);
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
}

function prepararFontes(opcoes, runDir) {
  if (opcoes.fonte.length === 0) throw new ErroBackup('E_CONFIG', 2);
  const ids = new Set();
  const destinoReal = fs.realpathSync(runDir);
  const fontes = opcoes.fonte.map((par) => {
    const i = par.indexOf('=');
    if (i < 1) throw new ErroBackup('E_FONTE_INVALIDA', 2);
    const id = par.slice(0, i);
    const raiz = par.slice(i + 1);
    if (!RE_ID.test(id) || ids.has(id) || !path.isAbsolute(raiz)) throw new ErroBackup('E_FONTE_INVALIDA', 2);
    ids.add(id);
    let st;
    try { st = fs.lstatSync(raiz); } catch { throw new ErroBackup('E_FONTE_INVALIDA', 2); }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new ErroBackup('E_FONTE_INVALIDA', 2);
    const real = fs.realpathSync(raiz);
    if (dentroDe(real, destinoReal) || dentroDe(destinoReal, real)) throw new ErroBackup('E_FONTE_INVALIDA', 2);
    return { id, raiz: real };
  });
  return fontes;
}

function lerReferencias(opcoes, fontes) {
  const mapa = {};
  for (const par of opcoes.referencias) {
    const i = par.indexOf('=');
    const id = par.slice(0, i);
    if (i < 1 || !fontes.some((f) => f.id === id) || mapa[id] !== undefined) throw new ErroBackup('E_REFERENCIAS_INVALIDAS', 2);
    let texto;
    try { texto = fs.readFileSync(par.slice(i + 1), 'utf8'); } catch { throw new ErroBackup('E_REFERENCIAS_INVALIDAS', 2); }
    mapa[id] = parseReferencias(texto);
  }
  return mapa;
}

async function exigirBancoPrimeiro(opcoes, agora) {
  if (!opcoes['banco-exec']) throw new ErroBackup('E_SEM_BACKUP_BANCO', 2);
  const dir = opcoes['banco-exec'];
  const v = await verificarManifesto(dir);
  if (!v.ok) throw new ErroBackup('E_BACKUP_BANCO_INVALIDO', 2);
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'MANIFEST.json'), 'utf8'));
  if (path.basename(dir) !== m.run_id) throw new ErroBackup('E_BACKUP_BANCO_INVALIDO', 2);
  const criado = Date.parse(m.criado_em);
  const idadeMax = Number(opcoes['banco-idade-max-s'] ?? 3600);
  if (!Number.isFinite(idadeMax) || idadeMax <= 0) throw new ErroBackup('E_CONFIG', 2);
  if (agora - criado < -5000 || agora - criado > idadeMax * 1000) throw new ErroBackup('E_BACKUP_BANCO_FORA_DA_JANELA', 2);
  const sha = fs.readFileSync(path.join(dir, 'MANIFEST.json.sha256'), 'utf8').trim().split(/\s+/)[0];
  return { runId: m.run_id, manifestSha256: sha, dumpSha256: m.dump.sha256, criadoEm: m.criado_em };
}

// Referências geradas do dump (E2-R): só valem se o pacote íntegro foi gerado do MESMO dump da execução de banco usada aqui.
async function carregarPacoteDeReferencias(opcoes, fontes, banco, avulsas) {
  if (!opcoes['referencias-dir']) return { refs: {}, vinculos: {} };
  const { verificarPacoteReferencias } = require('./referencias.js');
  const pacote = await verificarPacoteReferencias(opcoes['referencias-dir'], { runId: banco.runId, dumpSha256: banco.dumpSha256, manifestSha256: banco.manifestSha256 }, parseReferencias);
  const refs = {};
  const vinculos = {};
  for (const [id, f] of Object.entries(pacote.fontes)) {
    if (!fontes.some((x) => x.id === id)) continue;
    if (avulsas[id] !== undefined) throw new ErroBackup('E_REFERENCIAS_INVALIDAS', 2);
    refs[id] = f.refs;
    vinculos[id] = { dumpSha256: f.origem.dump_sha256, referenciasSha256: f.origem.referencias_sha256, metaSha256: f.origem.meta_sha256, refsRunId: f.origem.refs_run_id };
  }
  return { refs, vinculos };
}

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

function parseLimiteBytes(valor) {
  if (valor === undefined) return LIMITE_PADRAO_BYTES;
  if (!RE_LIMITE_BYTES.test(valor)) throw new ErroBackup('E_CONFIG', 2);
  return Number(valor);
}

async function comandoCopiar(runDir, argv) {
  const { construirManifestoArquivos, gravarManifestoArquivos } = require('./manifesto-arquivos.js');
  const opcoes = lerOpcoes(argv);
  if (!opcoes['run-id']) throw new ErroBackup('E_CONFIG', 2);
  const limiteBytes = parseLimiteBytes(opcoes['limite-bytes']);
  const fontes = prepararFontes(opcoes, runDir);
  const avulsas = lerReferencias(opcoes, fontes);
  const banco = await exigirBancoPrimeiro(opcoes, Date.now());
  const vinculadas = await carregarPacoteDeReferencias(opcoes, fontes, banco, avulsas);
  const refs = { ...avulsas, ...vinculadas.refs };
  const tentativas = opcoes.tentativas === undefined ? MAX_TENTATIVAS : Number(opcoes.tentativas);
  const inicio = Date.now();
  const copia = await copiaControlada({ fontes, runDir, maxTentativas: tentativas, limiteBytes });
  const fim = Date.now();
  const referencias = {};
  for (const f of copia.fontes) if (refs[f.id] !== undefined) referencias[f.id] = verificarReferencias(f.arquivos, refs[f.id]);
  const manifesto = construirManifestoArquivos({
    runId: opcoes['run-id'],
    criadoEm: iso(Date.now()),
    inicioCopia: iso(inicio),
    fimCopia: iso(fim),
    host: opcoes.host || os.hostname(),
    banco,
    copia,
    referencias,
    vinculos: vinculadas.vinculos,
  });
  await gravarManifestoArquivos(runDir, manifesto);
  process.stdout.write(`${JSON.stringify({ status: manifesto.consistencia.publicavel ? 'OK' : 'NAO_PUBLICAVEL', run_id: manifesto.run_id, bloqueios: manifesto.consistencia.bloqueios })}\n`);
  if (manifesto.consistencia.concorrencia !== 'SEM_ALTERACAO') return 11;
  if (manifesto.consistencia.referencias === 'COM_PROBLEMAS') return 12;
  if (manifesto.consistencia.referencias === 'NAO_VERIFICADO') return 10;
  if (manifesto.consistencia.vinculo !== 'VINCULADO_AO_DUMP') return 10;
  return 0;
}

async function principal(argv) {
  const [cmd, dir, ...resto] = argv;
  try {
    if (cmd === 'copiar' && dir) return await comandoCopiar(dir, resto);
    if (cmd === 'verificar' && dir && resto.length === 0) {
      const { verificarManifestoArquivos } = require('./manifesto-arquivos.js');
      const r = await verificarManifestoArquivos(dir);
      process.stdout.write(`${JSON.stringify(r)}\n`);
      return r.ok ? 0 : 1;
    }
    return 2;
  } catch (e) {
    if (e && typeof e.codigo === 'string' && Number.isInteger(e.saida)) {
      process.stderr.write(`ERRO ${e.codigo}\n`);
      return e.saida;
    }
    process.stderr.write('ERRO E_INESPERADO\n');
    return 5;
  }
}

module.exports = { ErroBackup, listarArvore, fingerprint, copiaControlada, parseReferencias, verificarReferencias };

if (require.main === module) {
  principal(process.argv.slice(2)).then((c) => { process.exitCode = c; });
}
