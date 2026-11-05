'use strict';

const crypto = require('node:crypto');
const { MARCADOR, AMBIENTES } = require('./backup-armazenamento-duravel-fichas.service');

/**
 * D-ORF-6, R-D45 (D-F4): RECIBO DE GRAVAÇÃO DURÁVEL e DOCUMENTO CONSOLIDADO do conjunto. O recibo registra o que o enviador viu a gravação devolver:
 * `{ versao, destinoId, ambiente, bucket, chave, versaoId, sha256, bytes, gravadoEm }`. O que importa para a restauração é a VERSÃO EXPLÍCITA (`versaoId`): ler
 * "a versão atual" de um nome nunca é aceito, porque um objeto novo forjado sob o mesmo nome seria a versão atual. O consolidado é um JSON canônico (chaves em
 * ordem, sem espaços, recibos por chave) cujo SHA-256 deve ser guardado FORA do host e no diário local; ele não se autentica sozinho. Módulo PURO: não lê nem grava arquivo.
 * Um recibo prova só o que o executor viu; a prova independente é do verificador (credencial própria, fora do host).
 */

const VERSAO = 1;
const LIMITE_OBJETO_BYTES = 5 * 1024 ** 3;
const LIMITE_RECIBOS = 400000;
const LIMITE_CONSOLIDADO_BYTES = 128 * 1024 * 1024;
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CONJUNTO_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const SEGMENTO = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const VERSAO_ID = /^[A-Za-z0-9._+-]{1,1024}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DATA = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const CHAVES_DO_RECIBO = Object.freeze(['versao', 'destinoId', 'ambiente', 'bucket', 'chave', 'versaoId', 'sha256', 'bytes', 'gravadoEm']);
const CHAVES_DO_CONSOLIDADO = Object.freeze(['versao', 'destinoId', 'ambiente', 'conjuntoId', 'recibos']);

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const chavesExatas = (o, esperadas) => {
  const proprias = Reflect.ownKeys(o);
  return proprias.length === esperadas.length && proprias.every((k) => typeof k === 'string' && esperadas.includes(k));
};
const recusa = (motivo) => Object.freeze({ ok: false, motivo });

function canonico(v) {
  if (Array.isArray(v)) return v.map(canonico);
  if (ehObjeto(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonico(v[k])]));
  return v;
}
const bytesCanonicos = (valor) => Buffer.from(JSON.stringify(canonico(valor)), 'utf8');

/** `null` se o recibo é válido; senão `'RECIBO_FORMATO'`. A chave começa pelo marcador do ambiente e só tem segmentos simples (sem `.`, `..` ou vazio). */
function validarRecibo(r) {
  if (!ehObjeto(r) || !chavesExatas(r, CHAVES_DO_RECIBO) || r.versao !== VERSAO || typeof r.destinoId !== 'string' || !ID.test(r.destinoId) || !AMBIENTES.includes(r.ambiente)) return 'RECIBO_FORMATO';
  if (typeof r.bucket !== 'string' || !BUCKET.test(r.bucket) || typeof r.chave !== 'string' || r.chave.length > 300) return 'RECIBO_FORMATO';
  const segmentos = r.chave.split('/');
  if (segmentos.length < 3 || segmentos[0] !== MARCADOR[r.ambiente] || !segmentos.slice(1).every((s) => SEGMENTO.test(s))) return 'RECIBO_FORMATO';
  if (typeof r.versaoId !== 'string' || !VERSAO_ID.test(r.versaoId) || r.versaoId === 'null' || typeof r.sha256 !== 'string' || !SHA256.test(r.sha256)) return 'RECIBO_FORMATO';
  if (!Number.isSafeInteger(r.bytes) || r.bytes < 0 || r.bytes > LIMITE_OBJETO_BYTES || typeof r.gravadoEm !== 'string' || !DATA.test(r.gravadoEm) || Number.isNaN(Date.parse(r.gravadoEm))) return 'RECIBO_FORMATO';
  return null;
}

/** Consolida os recibos de UM conjunto (todos do mesmo destino, ambiente e bucket, dentro de `<marcador>/<conjuntoId>/`, com o `envelope.json`). */
function consolidarRecibos(entrada) {
  if (!ehObjeto(entrada) || !chavesExatas(entrada, ['destinoId', 'ambiente', 'conjuntoId', 'recibos'])) return recusa('ENTRADA_INVALIDA');
  const { destinoId, ambiente, conjuntoId, recibos } = entrada;
  if (typeof destinoId !== 'string' || !ID.test(destinoId) || !AMBIENTES.includes(ambiente) || typeof conjuntoId !== 'string' || !CONJUNTO_ID.test(conjuntoId) || !Array.isArray(recibos) || recibos.length > LIMITE_RECIBOS) return recusa('ENTRADA_INVALIDA');
  const prefixo = `${MARCADOR[ambiente]}/${conjuntoId}/`;
  const bucket = recibos.length > 0 && ehObjeto(recibos[0]) ? recibos[0].bucket : undefined;
  const chaves = new Set();
  for (const r of recibos) {
    if (!ehObjeto(r)) return recusa('RECIBO_FORMATO');
    if (r.destinoId !== destinoId || r.ambiente !== ambiente || r.bucket !== bucket) return recusa('RECIBO_DE_OUTRO_DESTINO');
    if (validarRecibo(r) !== null) return recusa('RECIBO_FORMATO');
    if (chaves.has(r.chave)) return recusa('CHAVE_REPETIDA');
    if (!r.chave.startsWith(prefixo)) return recusa('CHAVE_FORA_DO_CONJUNTO');
    chaves.add(r.chave);
  }
  if (!chaves.has(`${prefixo}envelope.json`)) return recusa('ENVELOPE_AUSENTE');
  const ordenados = recibos.map((r) => Object.freeze({ ...r })).sort((a, b) => (a.chave < b.chave ? -1 : a.chave > b.chave ? 1 : 0));
  const consolidado = Object.freeze({ versao: VERSAO, destinoId, ambiente, conjuntoId, recibos: Object.freeze(ordenados) });
  const bytes = bytesCanonicos(consolidado);
  return Object.freeze({ ok: true, bytes, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), consolidado });
}

/** Lê o documento consolidado: JSON válido, forma exata, recibos coerentes e BYTES CANÔNICOS (qualquer reformatação é recusada). */
function lerConsolidado(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > LIMITE_CONSOLIDADO_BYTES) return recusa('CONSOLIDADO_FORMATO');
  let objeto;
  try { objeto = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)); } catch { return recusa('CONSOLIDADO_FORMATO'); }
  if (!ehObjeto(objeto) || !chavesExatas(objeto, CHAVES_DO_CONSOLIDADO) || objeto.versao !== VERSAO) return recusa('CONSOLIDADO_FORMATO');
  const r = consolidarRecibos({ destinoId: objeto.destinoId, ambiente: objeto.ambiente, conjuntoId: objeto.conjuntoId, recibos: objeto.recibos });
  if (!r.ok) return recusa('CONSOLIDADO_FORMATO');
  if (!r.bytes.equals(Buffer.from(bytes))) return recusa('CONSOLIDADO_NAO_CANONICO');
  return Object.freeze({ ok: true, consolidado: r.consolidado, sha256: r.sha256 });
}

module.exports = { validarRecibo, consolidarRecibos, lerConsolidado, bytesCanonicos, LIMITE_OBJETO_BYTES, VERSAO };
