'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { sha256Arquivo } = require('./manifesto.js');

const RE_HEX64 = /^[0-9a-f]{64}$/;
const RE_RUN_ID = /^\d{8}T\d{6}Z-[0-9a-f]{8}$/;
const RE_ID = /^[a-z][a-z0-9-]{0,31}$/;
const RE_DIRETORIO = /^tentativas\/[1-3]\/[a-z][a-z0-9-]{0,31}$/;
const RE_CHAVE_SEGREDO = /senha|password|secret|token/i;
const RE_VALOR_SEGREDO = /PGPASSWORD|password\s*=|senha\s*=|secret\s*=|token\s*=/i;
const NOME = 'MANIFEST-ARQUIVOS.json';
const BLOQUEIOS = ['ALTERACAO_CONCORRENTE', 'REFERENCIAS_NAO_VERIFICADAS', 'REFERENCIAS_FALTANTES', 'REFERENCIAS_DIVERGENTES', 'REFERENCIAS_NAO_VINCULADAS'];
const VINCULOS = ['VINCULADO_AO_DUMP', 'NAO_VINCULADO', 'SEM_REFERENCIAS'];
const ESQUEMA = 2;

const ehObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function caminhoSeguro(c) {
  return typeof c === 'string' && c !== '' && !c.startsWith('/') && !c.includes('\\') && c.split('/').every((p) => p !== '' && p !== '.' && p !== '..');
}

function construirManifestoArquivos(d) {
  const { copia } = d;
  const vinculos = d.vinculos || {};
  const fontes = copia.fontes.map((f) => {
    const ref = d.referencias[f.id];
    const vinc = ref ? vinculos[f.id] : undefined;
    if (vinc && vinc.dumpSha256 !== d.banco.dumpSha256) throw new Error('E_VINCULO_INCOERENTE');
    let vinculo = 'SEM_REFERENCIAS';
    let origem = null;
    if (ref && vinc) {
      vinculo = 'VINCULADO_AO_DUMP';
      origem = { dump_sha256: vinc.dumpSha256, referencias_sha256: vinc.referenciasSha256, meta_sha256: vinc.metaSha256, refs_run_id: vinc.refsRunId };
    } else if (ref) {
      vinculo = 'NAO_VINCULADO';
    }
    return {
      id: f.id,
      diretorio: `tentativas/${copia.escolhida}/${f.id}`,
      total_arquivos: f.arquivos.length,
      total_bytes: f.arquivos.reduce((s, a) => s + a.tamanho_bytes, 0),
      f0: f.f0,
      f1: f.f1,
      referencias: ref
        ? { status: ref.status, vinculo, origem, total: ref.total, faltantes_total: ref.faltantes_total, divergentes_total: ref.divergentes_total, orfaos_total: ref.orfaos_total, faltantes: ref.faltantes, divergentes: ref.divergentes }
        : { status: 'NAO_VERIFICADO', vinculo, origem, total: 0, faltantes_total: 0, divergentes_total: 0, orfaos_total: 0, faltantes: [], divergentes: [] },
      arquivos: f.arquivos.map((a) => ({ caminho: a.caminho, tamanho_bytes: a.tamanho_bytes, sha256: a.sha256 })),
    };
  });
  const bloqueios = [];
  if (copia.concorrencia !== 'SEM_ALTERACAO') bloqueios.push('ALTERACAO_CONCORRENTE');
  if (fontes.some((f) => f.referencias.status === 'NAO_VERIFICADO')) bloqueios.push('REFERENCIAS_NAO_VERIFICADAS');
  if (fontes.some((f) => f.referencias.faltantes_total > 0)) bloqueios.push('REFERENCIAS_FALTANTES');
  if (fontes.some((f) => f.referencias.divergentes_total > 0)) bloqueios.push('REFERENCIAS_DIVERGENTES');
  if (fontes.some((f) => f.referencias.vinculo === 'NAO_VINCULADO')) bloqueios.push('REFERENCIAS_NAO_VINCULADAS');
  let refs = 'VERIFICADO_COMPLETO';
  if (fontes.some((f) => f.referencias.status === 'COM_PROBLEMAS')) refs = 'COM_PROBLEMAS';
  else if (fontes.some((f) => f.referencias.status === 'NAO_VERIFICADO')) refs = 'NAO_VERIFICADO';
  let vinculo = 'VINCULADO_AO_DUMP';
  if (fontes.some((f) => f.referencias.vinculo === 'NAO_VINCULADO')) vinculo = 'NAO_VINCULADO';
  else if (fontes.some((f) => f.referencias.vinculo === 'SEM_REFERENCIAS')) vinculo = 'SEM_REFERENCIAS';
  const pendente = ['armazenamento-remoto'];
  if (refs === 'NAO_VERIFICADO') pendente.push('referencias-do-banco');
  if (vinculo === 'NAO_VINCULADO') pendente.push('vinculo-das-referencias');
  return {
    esquema: ESQUEMA,
    etapa: 'E2',
    escopo: 'ARQUIVOS',
    run_id: d.runId,
    criado_em: d.criadoEm,
    inicio_copia: d.inicioCopia,
    fim_copia: d.fimCopia,
    host: d.host,
    banco: { run_id: d.banco.runId, manifest_sha256: d.banco.manifestSha256, dump_sha256: d.banco.dumpSha256, criado_em: d.banco.criadoEm },
    tentativas: copia.tentativas.map((t) => ({
      numero: t.numero,
      diretorio: t.diretorio,
      estavel: t.estavel,
      fontes: t.fontes.map((f) => ({ id: f.id, estavel: f.estavel, f0: f.f0, f1: f.f1 })),
    })),
    escolhida: copia.escolhida,
    fontes,
    consistencia: { concorrencia: copia.concorrencia, referencias: refs, vinculo, publicavel: bloqueios.length === 0, bloqueios },
    pendente,
  };
}

function temSegredo(obj) {
  if (typeof obj === 'string') return RE_VALOR_SEGREDO.test(obj);
  if (Array.isArray(obj)) return obj.some(temSegredo);
  if (ehObj(obj)) return Object.entries(obj).some(([k, v]) => RE_CHAVE_SEGREDO.test(k) || temSegredo(v));
  return false;
}

function validarFingerprint(f) {
  return ehObj(f) && Number.isInteger(f.arquivos) && Number.isInteger(f.bytes) && RE_HEX64.test(f.sha256 ?? '');
}

function validarManifestoArquivos(m) {
  const erros = [];
  if (!ehObj(m)) return { ok: false, erros: ['manifesto não é objeto'] };
  if (m.esquema !== ESQUEMA) erros.push('esquema');
  if (m.etapa !== 'E2') erros.push('etapa');
  if (m.escopo !== 'ARQUIVOS') erros.push('escopo');
  if (typeof m.run_id !== 'string' || !RE_RUN_ID.test(m.run_id)) erros.push('run_id');
  for (const c of ['criado_em', 'inicio_copia', 'fim_copia']) if (typeof m[c] !== 'string' || Number.isNaN(Date.parse(m[c]))) erros.push(c);
  if (typeof m.host !== 'string' || m.host === '') erros.push('host');
  if (!ehObj(m.banco) || !RE_RUN_ID.test(m.banco.run_id ?? '') || !RE_HEX64.test(m.banco.manifest_sha256 ?? '') || !RE_HEX64.test(m.banco.dump_sha256 ?? '') || Number.isNaN(Date.parse(m.banco.criado_em))) erros.push('banco');
  if (!Array.isArray(m.tentativas) || m.tentativas.length < 1 || m.tentativas.length > 3) erros.push('tentativas');
  if (!Number.isInteger(m.escolhida) || m.escolhida < 1 || m.escolhida > 3) erros.push('escolhida');
  if (!Array.isArray(m.fontes) || m.fontes.length < 1) erros.push('fontes');
  else {
    for (const f of m.fontes) {
      if (!ehObj(f) || !RE_ID.test(f.id ?? '') || !RE_DIRETORIO.test(f.diretorio ?? '') || f.diretorio !== `tentativas/${m.escolhida}/${f.id}`) { erros.push('fonte'); continue; }
      if (!validarFingerprint(f.f0) || !validarFingerprint(f.f1)) erros.push('fingerprint');
      if (!ehObj(f.referencias) || !['NAO_VERIFICADO', 'VERIFICADO_COMPLETO', 'COM_PROBLEMAS'].includes(f.referencias.status)) erros.push('referencias');
      else if (!VINCULOS.includes(f.referencias.vinculo)) erros.push('vinculo');
      else if (f.referencias.vinculo === 'VINCULADO_AO_DUMP') {
        const o = f.referencias.origem;
        if (!ehObj(o) || !RE_HEX64.test(o.dump_sha256 ?? '') || !RE_HEX64.test(o.referencias_sha256 ?? '') || !RE_HEX64.test(o.meta_sha256 ?? '')
          || !RE_RUN_ID.test(o.refs_run_id ?? '') || (ehObj(m.banco) && o.dump_sha256 !== m.banco.dump_sha256)) erros.push('vinculo');
      } else if (f.referencias.origem !== null) erros.push('vinculo');
      if (!Array.isArray(f.arquivos) || f.total_arquivos !== f.arquivos.length) erros.push('arquivos');
      else {
        for (const a of f.arquivos) {
          if (!ehObj(a) || !caminhoSeguro(a.caminho) || !Number.isInteger(a.tamanho_bytes) || a.tamanho_bytes < 0 || !RE_HEX64.test(a.sha256 ?? '')) { erros.push('arquivo'); break; }
        }
      }
    }
  }
  const c = m.consistencia;
  if (!ehObj(c) || !Array.isArray(c.bloqueios) || c.bloqueios.some((b) => !BLOQUEIOS.includes(b)) || typeof c.publicavel !== 'boolean' || !VINCULOS.includes(c.vinculo)) erros.push('consistencia');
  else {
    if (c.publicavel !== (c.bloqueios.length === 0)) erros.push('publicavel_inconsistente');
    if (c.publicavel) {
      if (c.concorrencia !== 'SEM_ALTERACAO' || c.referencias !== 'VERIFICADO_COMPLETO' || c.vinculo !== 'VINCULADO_AO_DUMP') erros.push('publicavel_sem_prova');
      if (Array.isArray(m.fontes) && m.fontes.some((f) => ehObj(f) && ehObj(f.referencias)
        && (f.referencias.status !== 'VERIFICADO_COMPLETO' || f.referencias.vinculo !== 'VINCULADO_AO_DUMP'))) erros.push('publicavel_sem_prova');
    }
  }
  if (!Array.isArray(m.pendente)) erros.push('pendente');
  if (temSegredo(m)) erros.push('segredo');
  return { ok: erros.length === 0, erros };
}

async function gravarManifestoArquivos(diretorio, manifesto) {
  const v = validarManifestoArquivos(manifesto);
  if (!v.ok) throw new Error(`E_MANIFESTO_INVALIDO:${v.erros.join(',')}`);
  const arq = path.join(diretorio, NOME);
  fs.writeFileSync(arq, `${JSON.stringify(manifesto, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(arq, 0o600);
  fs.writeFileSync(`${arq}.sha256`, `${await sha256Arquivo(arq)}  ${NOME}\n`, { mode: 0o600 });
  fs.chmodSync(`${arq}.sha256`, 0o600);
}

function listarRegulares(raiz) {
  const out = [];
  const ir = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) out.push({ rel: r, especial: true });
      else if (e.isDirectory()) ir(path.join(d, e.name), r);
      else if (e.isFile()) out.push({ rel: r, especial: false });
      else out.push({ rel: r, especial: true });
    }
  };
  ir(raiz, '');
  return out;
}

async function verificarManifestoArquivos(diretorio) {
  const erros = [];
  const arq = path.join(diretorio, NOME);
  let m;
  try {
    const registrado = fs.readFileSync(`${arq}.sha256`, 'utf8').trim().split(/\s+/)[0];
    if (registrado !== (await sha256Arquivo(arq))) erros.push('manifesto não confere com o .sha256');
    m = JSON.parse(fs.readFileSync(arq, 'utf8'));
  } catch {
    return { ok: false, erros: [...erros, 'manifesto ilegível ou ausente'] };
  }
  const v = validarManifestoArquivos(m);
  if (!v.ok) return { ok: false, erros: [...erros, ...v.erros.map((e) => `campo inválido: ${e}`)] };
  for (const f of m.fontes) {
    const base = path.join(diretorio, ...f.diretorio.split('/'));
    let reais;
    try { reais = listarRegulares(base); } catch { erros.push(`${f.id}: diretório ausente`); continue; }
    const esperados = new Set(f.arquivos.map((a) => a.caminho));
    for (const r of reais) {
      if (r.especial) erros.push(`${f.id}: item especial ${r.rel}`);
      else if (!esperados.has(r.rel)) erros.push(`${f.id}: arquivo não listado ${r.rel}`);
    }
    for (const a of f.arquivos) {
      const caminho = path.join(base, ...a.caminho.split('/'));
      try {
        if (fs.statSync(caminho).size !== a.tamanho_bytes) erros.push(`${f.id}: tamanho diferente ${a.caminho}`);
        if ((await sha256Arquivo(caminho)) !== a.sha256) erros.push(`${f.id}: SHA-256 diferente ${a.caminho}`);
      } catch {
        erros.push(`${f.id}: arquivo ausente ${a.caminho}`);
      }
    }
  }
  return { ok: erros.length === 0, erros };
}

module.exports = { construirManifestoArquivos, validarManifestoArquivos, gravarManifestoArquivos, verificarManifestoArquivos };
