#!/usr/bin/env node
'use strict';

// E2-R: referências banco↔arquivos derivadas EXCLUSIVAMENTE do banco.dump (pg_restore lê o arquivo; nenhuma conexão com o banco).

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sha256Arquivo, verificarManifesto } = require('./manifesto.js');

const RE_HEX64 = /^[0-9a-f]{64}$/;
const RE_RUN_ID = /^\d{8}T\d{6}Z-[0-9a-f]{8}$/;
const RE_ID = /^[a-z][a-z0-9-]{0,31}$/;
const RE_TABELA = /^[a-z][a-z0-9_]{0,62}$/;
const RE_SEGMENTO = /^(?:[1-9][0-9]{0,14}|padrao)$/;
const RE_EMPRESA = /^[1-9][0-9]{0,14}$/;
const RE_CHAVE_FISC = /^([1-9][0-9]{0,14})\/pacote-([1-9][0-9]{0,14})\.zip$/;
const RE_CHAVE_SEGREDO = /senha|password|secret|token/i;
const RE_VALOR_SEGREDO = /PGPASSWORD|password\s*=|senha\s*=|secret\s*=|token\s*=/i;
const EXTENSAO = Object.freeze({ PNG: 'png', JPEG: 'jpg', WEBP: 'webp' });
const META = 'REFERENCIAS-META.json';
const SAIDAS = { E_CONFIG: 2, E_FONTE_INVALIDA: 2, E_BACKUP_BANCO_INVALIDO: 2, E_REFERENCIAS_ADULTERADAS: 2, E_REFERENCIAS_DE_OUTRO_DUMP: 2, E_FERRAMENTA_AUSENTE: 4 };

class ErroReferencias extends Error {
  constructor(codigo) {
    super(codigo);
    this.codigo = codigo;
    this.saida = SAIDAS[codigo] ?? 5;
  }
}
const invalida = () => new ErroReferencias('E_REFERENCIAS_INVALIDAS');
const ehObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function desescapar(campo) {
  if (campo === '\\N') return null;
  const simples = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };
  if (/\\$/.test(campo.replace(/\\\\/g, ''))) throw new ErroReferencias('E_COPY_INVALIDO');
  return campo.replace(/\\(?:([0-7]{1,3})|x([0-9A-Fa-f]{1,2})|([\s\S]))/g, (_, octal, hex, outro) => {
    if (octal !== undefined) return String.fromCharCode(parseInt(octal, 8) & 0xff);
    if (hex !== undefined) return String.fromCharCode(parseInt(hex, 16));
    return Object.hasOwn(simples, outro) ? simples[outro] : outro;
  });
}

function parseCopy(texto, tabela, esquema = 'public') {
  const linhas = texto.split('\n');
  const alvo = `${esquema}.${tabela}`;
  let achado = null;
  for (let i = 0; i < linhas.length; i += 1) {
    const m = /^COPY (\S+) \((.*)\) FROM stdin;$/.exec(linhas[i]);
    if (!m) continue;
    const colunas = m[2].split(', ').map((c) => c.replace(/^"(.*)"$/, '$1'));
    const nomeEsperado = m[1] === alvo;
    if (nomeEsperado && (achado || colunas.length === 0 || new Set(colunas).size !== colunas.length || colunas.some((c) => !/^[a-z_][a-z0-9_]*$/.test(c)))) throw new ErroReferencias('E_COPY_INVALIDO');
    const linhasDeDados = [];
    let fim = false;
    let j = i + 1;
    for (; j < linhas.length; j += 1) {
      if (linhas[j] === '\\.') { fim = true; break; }
      if (!nomeEsperado) continue;
      const campos = linhas[j].split('\t');
      if (campos.length !== colunas.length) throw new ErroReferencias('E_COPY_INVALIDO');
      const linha = {};
      colunas.forEach((c, k) => { linha[c] = desescapar(campos[k]); });
      linhasDeDados.push(linha);
    }
    if (!fim) throw new ErroReferencias('E_COPY_INVALIDO');
    if (nomeEsperado) achado = { colunas, linhas: linhasDeDados };
    i = j;
  }
  if (!achado) throw new ErroReferencias('E_TABELA_AUSENTE');
  return achado;
}

const hex = (v) => { if (typeof v !== 'string' || !RE_HEX64.test(v)) throw invalida(); return v; };
const inteiro = (v) => {
  if (typeof v !== 'string' || !/^(0|[1-9][0-9]{0,15})$/.test(v)) throw invalida();
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw invalida();
  return n;
};
const ausente = (v) => v === null || v === undefined;

function chaveDeImagem({ segmento, sha256, variante, formato }) {
  if (typeof segmento !== 'string' || !RE_SEGMENTO.test(segmento)) throw invalida();
  hex(sha256);
  if (typeof formato !== 'string' || !Object.hasOwn(EXTENSAO, formato)) throw invalida();
  if (variante === 'mestre') return `${segmento}/${sha256}/mestre.${EXTENSAO[formato]}`;
  if ((variante === 'exibicao' || variante === 'miniatura') && formato === 'WEBP') return `${segmento}/${sha256}/${variante}.webp`;
  throw invalida();
}

function consolidar(refs) {
  const porChave = new Map();
  for (const r of refs) {
    const antes = porChave.get(r.chave);
    if (antes && (antes.sha256 !== r.sha256 || antes.tamanho_bytes !== r.tamanho_bytes)) throw new ErroReferencias('E_REFERENCIA_CONFLITANTE');
    if (!antes) porChave.set(r.chave, { sha256: r.sha256, tamanho_bytes: r.tamanho_bytes, chave: r.chave });
  }
  return [...porChave.values()].sort((a, b) => (a.chave < b.chave ? -1 : a.chave > b.chave ? 1 : 0));
}

function referenciasImagens({ padrao, empresa }) {
  const refs = [];
  for (const l of padrao) {
    const formato = l.formato;
    const sha256 = hex(l.sha256);
    const temExib = !ausente(l.sha256_exibicao);
    if (temExib !== !ausente(l.bytes_exibicao)) throw invalida();
    refs.push({ sha256, tamanho_bytes: inteiro(l.bytes_mestre), chave: chaveDeImagem({ segmento: 'padrao', sha256, variante: 'mestre', formato }) });
    if (temExib) refs.push({ sha256: hex(l.sha256_exibicao), tamanho_bytes: inteiro(l.bytes_exibicao), chave: chaveDeImagem({ segmento: 'padrao', sha256, variante: 'exibicao', formato: 'WEBP' }) });
    refs.push({ sha256: hex(l.sha256_miniatura), tamanho_bytes: inteiro(l.bytes_miniatura), chave: chaveDeImagem({ segmento: 'padrao', sha256, variante: 'miniatura', formato: 'WEBP' }) });
  }
  for (const l of empresa) {
    if (typeof l.empresa_id !== 'string' || !RE_EMPRESA.test(l.empresa_id) || (l.estado !== 'ATIVA' && l.estado !== 'INATIVA')) throw invalida();
    const segmento = l.empresa_id;
    const dir = hex(l.sha256);
    refs.push({ sha256: hex(l.sha256_mestre), tamanho_bytes: inteiro(l.bytes_mestre), chave: chaveDeImagem({ segmento, sha256: dir, variante: 'mestre', formato: l.formato }) });
    refs.push({ sha256: hex(l.sha256_exibicao), tamanho_bytes: inteiro(l.bytes_exibicao), chave: chaveDeImagem({ segmento, sha256: dir, variante: 'exibicao', formato: 'WEBP' }) });
    refs.push({ sha256: hex(l.sha256_miniatura), tamanho_bytes: inteiro(l.bytes_miniatura), chave: chaveDeImagem({ segmento, sha256: dir, variante: 'miniatura', formato: 'WEBP' }) });
  }
  return consolidar(refs);
}

function referenciasFiscalizacao(linhas) {
  const refs = [];
  for (const l of linhas) {
    if (l.status !== 'CONCLUIDO') continue;
    const m = typeof l.chave_armazenamento === 'string' ? RE_CHAVE_FISC.exec(l.chave_armazenamento) : null;
    if (!m || m[1] !== l.empresa_id) throw invalida();
    refs.push({ sha256: hex(l.sha256), tamanho_bytes: inteiro(l.tamanho_bytes), chave: l.chave_armazenamento });
  }
  return consolidar(refs);
}

function serializarNdjson(refs) {
  for (const r of refs) {
    if (!ehObj(r) || !RE_HEX64.test(r.sha256 ?? '') || !Number.isSafeInteger(r.tamanho_bytes) || r.tamanho_bytes < 0 || typeof r.chave !== 'string' || r.chave === '') throw invalida();
  }
  const linhas = consolidar(refs).map((r) => JSON.stringify({ sha256: r.sha256, tamanho_bytes: r.tamanho_bytes, chave: r.chave }));
  return linhas.length === 0 ? '' : `${linhas.join('\n')}\n`;
}

const FONTES = Object.freeze({
  imagens: Object.freeze({
    tabelas: ['imagens_padrao', 'imagens_empresa'],
    gerar: (t) => ({ refs: referenciasImagens({ padrao: t.imagens_padrao, empresa: t.imagens_empresa }), usadas: { imagens_padrao: t.imagens_padrao.length, imagens_empresa: t.imagens_empresa.length } }),
  }),
  'fiscalizacao-pacotes': Object.freeze({
    tabelas: ['fiscalizacao_pacotes'],
    gerar: (t) => ({ refs: referenciasFiscalizacao(t.fiscalizacao_pacotes), usadas: { fiscalizacao_pacotes: t.fiscalizacao_pacotes.filter((l) => l.status === 'CONCLUIDO').length } }),
  }),
});

function extrairTabela({ pgRestore, dump, tabela, executar = spawnSync }) {
  if (!RE_TABELA.test(tabela)) throw new ErroReferencias('E_CONFIG');
  const r = executar(pgRestore, ['--data-only', '--schema=public', `--table=${tabela}`, '--file=-', dump], {
    encoding: 'utf8', env: { LANG: 'C', LC_ALL: 'C' }, maxBuffer: 512 * 1024 * 1024, timeout: 600000, shell: false,
  });
  if (r.error || r.status !== 0 || typeof r.stdout !== 'string') throw new ErroReferencias('E_EXTRACAO_FALHOU');
  return parseCopy(r.stdout, tabela);
}

function gerarReferenciasDoDump({ pgRestore, dump, fontes, executar }) {
  return fontes.map((id) => {
    const def = Object.hasOwn(FONTES, id) ? FONTES[id] : null;
    if (!def) throw new ErroReferencias('E_FONTE_INVALIDA');
    const tabelas = {};
    const lidas = {};
    for (const nome of def.tabelas) {
      const t = extrairTabela({ pgRestore, dump, tabela: nome, executar });
      tabelas[nome] = t.linhas;
      lidas[nome] = t.linhas.length;
    }
    const { refs, usadas } = def.gerar(tabelas);
    return { id, refs, tabelas: def.tabelas.map((nome) => ({ nome, linhas_lidas: lidas[nome], linhas_usadas: usadas[nome] })) };
  });
}

function temSegredo(obj) {
  if (typeof obj === 'string') return RE_VALOR_SEGREDO.test(obj);
  if (Array.isArray(obj)) return obj.some(temSegredo);
  if (ehObj(obj)) return Object.entries(obj).some(([k, v]) => RE_CHAVE_SEGREDO.test(k) || temSegredo(v));
  return false;
}

function validarMeta(m) {
  if (!ehObj(m) || m.esquema !== 1 || m.etapa !== 'E2R' || !RE_RUN_ID.test(m.refs_run_id ?? '') || Number.isNaN(Date.parse(m.gerado_em)) || typeof m.host !== 'string' || m.host === '') return false;
  if (!ehObj(m.dump) || !RE_RUN_ID.test(m.dump.run_id ?? '') || m.dump.arquivo !== 'banco.dump' || !RE_HEX64.test(m.dump.sha256 ?? '') || !RE_HEX64.test(m.dump.manifest_sha256 ?? '')) return false;
  if (!ehObj(m.pg_restore) || typeof m.pg_restore.versao !== 'string' || m.pg_restore.versao === '') return false;
  if (!Array.isArray(m.fontes)) return false;
  const ids = new Set();
  for (const f of m.fontes) {
    if (!ehObj(f) || !RE_ID.test(f.id ?? '') || ids.has(f.id) || f.arquivo !== `refs-${f.id}.ndjson` || !Number.isInteger(f.total) || f.total < 0 || !RE_HEX64.test(f.sha256 ?? '') || !Array.isArray(f.tabelas)) return false;
    ids.add(f.id);
    for (const t of f.tabelas) if (!ehObj(t) || !RE_TABELA.test(t.nome ?? '') || !Number.isInteger(t.linhas_lidas) || !Number.isInteger(t.linhas_usadas)) return false;
  }
  return !temSegredo(m);
}

async function gravarPacoteReferencias({ diretorio, refsRunId, geradoEm, host, banco, versaoPgRestore, fontes }) {
  const ids = new Set();
  const itens = fontes.map((f) => {
    if (typeof f.id !== 'string' || !RE_ID.test(f.id) || ids.has(f.id)) throw invalida();
    ids.add(f.id);
    return { id: f.id, tabelas: f.tabelas, ndjson: serializarNdjson(f.refs) };
  });
  const meta = {
    esquema: 1,
    etapa: 'E2R',
    refs_run_id: refsRunId,
    gerado_em: geradoEm,
    host,
    dump: { run_id: banco.runId, arquivo: 'banco.dump', sha256: banco.dumpSha256, manifest_sha256: banco.manifestSha256 },
    pg_restore: { versao: versaoPgRestore },
    fontes: [],
  };
  const hash = (texto) => crypto.createHash('sha256').update(texto).digest('hex');
  for (const i of itens) {
    meta.fontes.push({ id: i.id, arquivo: `refs-${i.id}.ndjson`, total: i.ndjson === '' ? 0 : i.ndjson.trimEnd().split('\n').length, sha256: hash(i.ndjson), tabelas: i.tabelas });
  }
  if (!validarMeta(meta)) throw invalida();
  for (const i of itens) fs.writeFileSync(path.join(diretorio, `refs-${i.id}.ndjson`), i.ndjson, { mode: 0o600, flag: 'wx' });
  const arq = path.join(diretorio, META);
  fs.writeFileSync(arq, `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(`${arq}.sha256`, `${await sha256Arquivo(arq)}  ${META}\n`, { mode: 0o600, flag: 'wx' });
  return meta;
}

async function verificarPacoteReferencias(diretorio, esperado, parseReferencias) {
  const adulterada = () => new ErroReferencias('E_REFERENCIAS_ADULTERADAS');
  const arq = path.join(diretorio, META);
  let meta;
  let metaSha;
  try {
    metaSha = await sha256Arquivo(arq);
    if (fs.readFileSync(`${arq}.sha256`, 'utf8').trim().split(/\s+/)[0] !== metaSha) throw adulterada();
    meta = JSON.parse(fs.readFileSync(arq, 'utf8'));
  } catch {
    throw adulterada();
  }
  if (!validarMeta(meta)) throw adulterada();
  if (esperado && (meta.dump.run_id !== esperado.runId || meta.dump.sha256 !== esperado.dumpSha256
    || (esperado.manifestSha256 !== undefined && meta.dump.manifest_sha256 !== esperado.manifestSha256))) throw new ErroReferencias('E_REFERENCIAS_DE_OUTRO_DUMP');
  const fontes = {};
  for (const f of meta.fontes) {
    const caminho = path.join(diretorio, f.arquivo);
    let texto;
    let refs;
    try {
      if ((await sha256Arquivo(caminho)) !== f.sha256) throw adulterada();
      texto = fs.readFileSync(caminho, 'utf8');
      refs = parseReferencias(texto);
      if (refs.length !== f.total || serializarNdjson(refs) !== texto) throw adulterada();
    } catch {
      throw adulterada();
    }
    fontes[f.id] = { refs, origem: { dump_sha256: meta.dump.sha256, referencias_sha256: f.sha256, meta_sha256: metaSha, refs_run_id: meta.refs_run_id } };
  }
  return { meta, fontes };
}

async function lerBancoE1(dir) {
  const v = await verificarManifesto(dir);
  if (!v.ok) throw new ErroReferencias('E_BACKUP_BANCO_INVALIDO');
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'MANIFEST.json'), 'utf8'));
  if (path.basename(path.resolve(dir)) !== m.run_id) throw new ErroReferencias('E_BACKUP_BANCO_INVALIDO');
  const manifestSha256 = fs.readFileSync(path.join(dir, 'MANIFEST.json.sha256'), 'utf8').trim().split(/\s+/)[0];
  return { runId: m.run_id, dumpSha256: m.dump.sha256, manifestSha256, dump: path.join(dir, 'banco.dump') };
}

function lerOpcoes(argv) {
  const o = { fonte: [] };
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    if (!k.startsWith('--') || i + 1 >= argv.length) throw new ErroReferencias('E_CONFIG');
    const nome = k.slice(2);
    if (nome === 'fonte') o.fonte.push(argv[i + 1]);
    else if (['run-id', 'banco-exec', 'pg-restore', 'hospedeiro'].includes(nome) && o[nome] === undefined) o[nome] = argv[i + 1];
    else throw new ErroReferencias('E_CONFIG');
  }
  return o;
}

async function comandoGerar(diretorio, argv) {
  const o = lerOpcoes(argv);
  if (!o['run-id'] || !RE_RUN_ID.test(o['run-id']) || !o['banco-exec'] || !o['pg-restore'] || o.fonte.length === 0) throw new ErroReferencias('E_CONFIG');
  if (new Set(o.fonte).size !== o.fonte.length || o.fonte.some((f) => !Object.hasOwn(FONTES, f))) throw new ErroReferencias('E_FONTE_INVALIDA');
  const banco = await lerBancoE1(o['banco-exec']);
  const versao = spawnSync(o['pg-restore'], ['--version'], { encoding: 'utf8', env: { LANG: 'C' }, shell: false });
  if (versao.error || versao.status !== 0) throw new ErroReferencias('E_FERRAMENTA_AUSENTE');
  const fontes = gerarReferenciasDoDump({ pgRestore: o['pg-restore'], dump: banco.dump, fontes: o.fonte });
  const meta = await gravarPacoteReferencias({
    diretorio,
    refsRunId: o['run-id'],
    geradoEm: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    host: o.hospedeiro || os.hostname(),
    banco: { runId: banco.runId, dumpSha256: banco.dumpSha256, manifestSha256: banco.manifestSha256 },
    versaoPgRestore: versao.stdout.split('\n')[0],
    fontes,
  });
  process.stdout.write(`${JSON.stringify({ status: 'OK', run_id: meta.refs_run_id, fontes: meta.fontes.map((f) => ({ id: f.id, total: f.total })) })}\n`);
  return 0;
}

async function comandoVerificar(diretorio, argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (argv[i] !== '--banco-exec' || i + 1 >= argv.length || o.banco !== undefined) throw new ErroReferencias('E_CONFIG');
    o.banco = argv[i + 1];
  }
  const esperado = o.banco ? await lerBancoE1(o.banco) : null;
  const { parseReferencias } = require('./arquivos.js');
  const r = await verificarPacoteReferencias(diretorio, esperado, parseReferencias);
  process.stdout.write(`${JSON.stringify({ ok: true, fontes: Object.keys(r.fontes) })}\n`);
  return 0;
}

async function principal(argv) {
  const [cmd, dir, ...resto] = argv;
  try {
    if (cmd === 'gerar' && dir) return await comandoGerar(dir, resto);
    if (cmd === 'verificar' && dir) return await comandoVerificar(dir, resto);
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

module.exports = {
  ErroReferencias, parseCopy, chaveDeImagem, referenciasImagens, referenciasFiscalizacao, serializarNdjson,
  extrairTabela, gerarReferenciasDoDump, gravarPacoteReferencias, verificarPacoteReferencias, lerBancoE1,
};

if (require.main === module) {
  principal(process.argv.slice(2)).then((c) => { process.exitCode = c; });
}
