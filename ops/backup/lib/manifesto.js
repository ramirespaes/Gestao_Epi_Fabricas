#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ESQUEMA = 1;
const RE_HEX64 = /^[0-9a-f]{64}$/;
const RE_RUN_ID = /^\d{8}T\d{6}Z-[0-9a-f]{8}$/;
const RE_CHAVE_SEGREDO = /senha|password|secret|token/i;
const RE_VALOR_SEGREDO = /PGPASSWORD|password\s*=|senha\s*=|secret\s*=|token\s*=/i;
const PENDENTE = Object.freeze(['arquivos', 'fingerprints', 'armazenamento-remoto']);

function sha256Arquivo(arquivo) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const fluxo = fs.createReadStream(arquivo);
    fluxo.on('error', reject);
    fluxo.on('data', (parte) => hash.update(parte));
    fluxo.on('end', () => resolve(hash.digest('hex')));
  });
}

function inspecionarMigrations(diretorio) {
  let nomes;
  try {
    nomes = fs.readdirSync(diretorio).filter((n) => /^\d{3}_.+\.sql$/.test(n)).sort();
  } catch {
    return null;
  }
  if (nomes.length === 0) return null;
  let checksumsSha256 = null;
  try {
    checksumsSha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(diretorio, 'checksums.json'))).digest('hex');
  } catch {
    checksumsSha256 = null;
  }
  return { ultima: nomes[nomes.length - 1], total: nomes.length, checksumsSha256 };
}

function contarEntradasToc(arquivo) {
  return fs.readFileSync(arquivo, 'utf8').split('\n').filter((l) => l.trim() !== '' && !l.startsWith(';')).length;
}

async function construirManifesto(d) {
  const m = d.migrations
    ? { ultima_migration: d.migrations.ultima, total_migrations: d.migrations.total, checksums_json_sha256: d.migrations.checksumsSha256 }
    : null;
  return {
    esquema: ESQUEMA,
    etapa: 'E1',
    escopo: 'BANCO',
    status: 'PARCIAL',
    run_id: d.runId,
    criado_em: d.criadoEm,
    host: d.host,
    banco: { nome: d.bancoNome, versao_pg_dump: d.versaoPgDump },
    dump: {
      arquivo: path.basename(d.dumpArquivo),
      formato: 'custom',
      tamanho_bytes: fs.statSync(d.dumpArquivo).size,
      sha256: await sha256Arquivo(d.dumpArquivo),
    },
    toc: {
      arquivo: path.basename(d.tocArquivo),
      entradas: contarEntradasToc(d.tocArquivo),
      sha256: await sha256Arquivo(d.tocArquivo),
    },
    aplicacao: m,
    pendente: [...PENDENTE],
  };
}

function variosValores(obj, achar) {
  if (typeof obj === 'string') return achar(obj);
  if (Array.isArray(obj)) return obj.some((v) => variosValores(v, achar));
  if (obj && typeof obj === 'object') return Object.values(obj).some((v) => variosValores(v, achar));
  return false;
}

function chavesComSegredo(obj) {
  if (Array.isArray(obj)) return obj.some(chavesComSegredo);
  if (obj && typeof obj === 'object') {
    return Object.entries(obj).some(([k, v]) => RE_CHAVE_SEGREDO.test(k) || chavesComSegredo(v));
  }
  return false;
}

function validarManifesto(m) {
  const erros = [];
  const ehObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!ehObj(m)) return { ok: false, erros: ['manifesto não é objeto'] };
  if (m.esquema !== ESQUEMA) erros.push('esquema');
  if (m.etapa !== 'E1') erros.push('etapa');
  if (m.escopo !== 'BANCO') erros.push('escopo');
  if (m.status !== 'PARCIAL') erros.push('status');
  if (typeof m.run_id !== 'string' || !RE_RUN_ID.test(m.run_id)) erros.push('run_id');
  if (typeof m.criado_em !== 'string' || Number.isNaN(Date.parse(m.criado_em))) erros.push('criado_em');
  if (typeof m.host !== 'string' || m.host === '') erros.push('host');
  if (!ehObj(m.banco) || typeof m.banco.nome !== 'string' || m.banco.nome === '' || typeof m.banco.versao_pg_dump !== 'string') erros.push('banco');
  if (!ehObj(m.dump) || m.dump.arquivo !== 'banco.dump' || m.dump.formato !== 'custom'
    || !Number.isInteger(m.dump.tamanho_bytes) || m.dump.tamanho_bytes < 0 || !RE_HEX64.test(m.dump.sha256 ?? '')) erros.push('dump');
  if (!ehObj(m.toc) || m.toc.arquivo !== 'toc.txt' || !Number.isInteger(m.toc.entradas) || !RE_HEX64.test(m.toc.sha256 ?? '')) erros.push('toc');
  if (m.aplicacao !== null && !ehObj(m.aplicacao)) erros.push('aplicacao');
  if (!Array.isArray(m.pendente)) erros.push('pendente');
  if (chavesComSegredo(m) || variosValores(m, (s) => RE_VALOR_SEGREDO.test(s))) erros.push('segredo');
  return { ok: erros.length === 0, erros };
}

async function gravarManifesto(diretorio, manifesto) {
  const v = validarManifesto(manifesto);
  if (!v.ok) throw new Error(`E_MANIFESTO_INVALIDO:${v.erros.join(',')}`);
  const arq = path.join(diretorio, 'MANIFEST.json');
  fs.writeFileSync(arq, `${JSON.stringify(manifesto, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(arq, 0o600);
  const hash = await sha256Arquivo(arq);
  fs.writeFileSync(`${arq}.sha256`, `${hash}  MANIFEST.json\n`, { mode: 0o600 });
  fs.chmodSync(`${arq}.sha256`, 0o600);
}

async function verificarManifesto(diretorio) {
  const erros = [];
  const arq = path.join(diretorio, 'MANIFEST.json');
  let manifesto;
  try {
    const registrado = fs.readFileSync(`${arq}.sha256`, 'utf8').trim().split(/\s+/)[0];
    if (registrado !== (await sha256Arquivo(arq))) erros.push('MANIFEST.json não confere com o .sha256');
    manifesto = JSON.parse(fs.readFileSync(arq, 'utf8'));
  } catch {
    return { ok: false, erros: [...erros, 'manifesto ilegível ou ausente'] };
  }
  const v = validarManifesto(manifesto);
  if (!v.ok) return { ok: false, erros: [...erros, ...v.erros.map((e) => `campo inválido: ${e}`)] };
  for (const [rotulo, item] of [['dump', manifesto.dump], ['toc', manifesto.toc]]) {
    const caminho = path.join(diretorio, item.arquivo);
    try {
      if (rotulo === 'dump' && fs.statSync(caminho).size !== item.tamanho_bytes) erros.push('dump: tamanho diferente');
      if ((await sha256Arquivo(caminho)) !== item.sha256) erros.push(`${rotulo}: SHA-256 diferente`);
    } catch {
      erros.push(`${rotulo}: arquivo ausente`);
    }
  }
  return { ok: erros.length === 0, erros };
}

function lerOpcoes(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || i + 1 >= argv.length) return null;
    o[argv[i].slice(2)] = argv[i + 1];
  }
  return o;
}

async function principal(argv) {
  const [cmd, diretorio, ...resto] = argv;
  if (cmd === 'verificar' && diretorio && resto.length === 0) {
    const r = await verificarManifesto(diretorio);
    process.stdout.write(`${JSON.stringify(r)}\n`);
    return r.ok ? 0 : 1;
  }
  if (cmd === 'gerar' && diretorio) {
    const o = lerOpcoes(resto);
    if (!o || !o['run-id'] || !o.banco || !o['versao-pg-dump']) return 2;
    try {
      const manifesto = await construirManifesto({
        runId: o['run-id'],
        criadoEm: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        host: o.host || os.hostname(),
        bancoNome: o.banco,
        versaoPgDump: o['versao-pg-dump'],
        dumpArquivo: path.join(diretorio, 'banco.dump'),
        tocArquivo: path.join(diretorio, 'toc.txt'),
        migrations: o['repo-raiz'] ? inspecionarMigrations(path.join(o['repo-raiz'], 'backend', 'migrations')) : null,
      });
      await gravarManifesto(diretorio, manifesto);
      process.stdout.write(`${JSON.stringify({ status: 'OK', run_id: manifesto.run_id })}\n`);
      return 0;
    } catch (e) {
      process.stderr.write(`E_MANIFESTO ${String(e.message).split(':')[0]}\n`);
      return 1;
    }
  }
  return 2;
}

module.exports = { sha256Arquivo, inspecionarMigrations, construirManifesto, validarManifesto, gravarManifesto, verificarManifesto };

if (require.main === module) {
  principal(process.argv.slice(2)).then((c) => { process.exitCode = c; });
}
