'use strict';

const crypto = require('node:crypto');
const { COMPROVACOES_POSTERIORES } = require('./backup-armazenamento-duravel-fichas.service');
const { MODOS, ACOES, AMBIENTES, BLOQUEIOS } = require('./backup-executor-politica.service');

/**
 * D-ORF-6, EXECUTOR OPERACIONAL: EVIDÊNCIA de cada execução, como uma linha NDJSON canônica (chaves ordenadas em todos os níveis) com SHA-256 próprio, no mesmo desenho da linha do
 * ensaio de DR. SÓ códigos fixos, números, instantes e identificadores de formato fechado: nunca caminho, URL, texto livre, mensagem de erro ou segredo. Função pura, sem I/O:
 * quem persiste a linha é uma porta do chamador (o destino do histórico depende da decisão D-F13).
 * O executor NUNCA declara armazenamento durável nem recuperabilidade em produção (campos fixos em falso, as pendências T2/T3 sempre listadas). `operacional` só é verdadeiro numa
 * OPERAÇÃO concluída com chaves E destino operacionais (hoje inexistente) e é recalculado na leitura.
 */

const ETAPAS = Object.freeze({
  BACKUP: Object.freeze(['COORDENACAO', 'PRODUCAO', 'DESTINO_LOCAL', 'CIFRA', 'INVENTARIO', 'PRE_VOO', 'ENVIO', 'CONSOLIDACAO', 'CONFIRMACAO', 'VERIFICACAO', 'REGISTRO_DOS_RECIBOS']),
  RESTAURACAO: Object.freeze(['COORDENACAO', 'DESTINO_LOCAL', 'RESTAURAR_CONTAINER', 'VERIFICAR_PACOTE', 'RESTAURAR_FONTES', 'AVALIAR_DR']),
  VERIFICACAO_DESTINO: Object.freeze(['VERIFICAR_DESTINO']),
});
const TIPOS = Object.freeze({ BACKUP: 'EXECUCAO_BACKUP', RESTAURACAO: 'EXECUCAO_RESTAURACAO', VERIFICACAO_DESTINO: 'EXECUCAO_VERIFICACAO_DESTINO' });
const ESTADOS = Object.freeze(['CONCLUIDO', 'BLOQUEADO', 'RECUSADO', 'FALHOU', 'INCERTO']);
const ORIGENS = Object.freeze(['OPERACIONAL', 'TESTE_CONTROLADO']);
const VERIFICACOES = Object.freeze(['CONFORME', 'DIVERGENTE', 'PENDENTE', 'NAO_APLICA']);
const LIMITE_DA_LINHA = 65536;

const ID_OPERACAO = /^[0-9a-f]{32}$/;
const CODIGO = /^[A-Z][A-Z0-9_]{2,39}$/;
const PENDENCIA = /^[A-Z][A-Z0-9_]{2,79}$/;
const CONJUNTO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const DESTINO = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CAMPOS_DA_LINHA = Object.freeze([
  'acao', 'ambiente', 'arquivos', 'bloqueios', 'bytes', 'codigo', 'comprovacoesPendentes', 'concluidoEm', 'conjuntoId', 'destinoId', 'duracaoMs', 'duravelmenteArmazenado', 'estado', 'etapas', 'falhouEm',
  'iniciadoEm', 'modo', 'operacaoId', 'operacional', 'origemDeChaves', 'origemDoDestino', 'recuperavelEmProducao', 'sha256', 'sha256Consolidado', 'sha256Manifesto', 'tipo', 'verificacaoIndependente', 'versao',
]);
const CAMPOS_DO_ENCERRAMENTO = Object.freeze(['estado', 'codigo', 'falhouEm', 'bloqueios', 'conjuntoId', 'sha256Manifesto', 'sha256Consolidado', 'arquivos', 'bytes', 'origemDeChaves', 'origemDoDestino', 'verificacaoIndependente', 'comprovacoesPendentes']);

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const invalida = () => Object.assign(new TypeError('evidência de execução inválida'), { code: 'EVIDENCIA_INVALIDA' });
const encerrada = () => Object.assign(new Error('evidência já encerrada'), { code: 'EVIDENCIA_ENCERRADA' });
const inteiro = (v) => Number.isSafeInteger(v) && v >= 0;
const nuloOu = (v, teste) => v === null || teste(v);
const congelar = (v) => {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); for (const f of Object.values(v)) congelar(f); }
  return v;
};
/** Chaves ordenadas em todos os níveis. */
function canonico(v) { return Array.isArray(v) ? v.map(canonico) : ehObjeto(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonico(v[k])])) : v; }
const hashDoCorpo = (corpo) => crypto.createHash('sha256').update(JSON.stringify(canonico(corpo))).digest('hex');
const calcularOperacional = (o) => o.modo === 'OPERACAO' && o.estado === 'CONCLUIDO' && o.origemDeChaves === 'OPERACIONAL' && o.origemDoDestino === 'OPERACIONAL';

function etapaValida(e, acao) {
  return ehObjeto(e) && Object.keys(e).sort().join() === 'codigo,duracaoMs,id,ok' && ETAPAS[acao].includes(e.id) && typeof e.ok === 'boolean' && inteiro(e.duracaoMs)
    && (e.ok ? e.codigo === null : typeof e.codigo === 'string' && CODIGO.test(e.codigo));
}
/** Forma e coerência de uma linha completa (a mesma regra vale na criação e na leitura). */
function linhaValida(o) {
  if (!ehObjeto(o) || Object.keys(o).sort().join() !== CAMPOS_DA_LINHA.join()) return false;
  if (!ACOES.includes(o.acao) || o.tipo !== TIPOS[o.acao] || o.versao !== 1 || !MODOS.includes(o.modo) || !AMBIENTES.includes(o.ambiente) || !ESTADOS.includes(o.estado)) return false;
  if (typeof o.operacaoId !== 'string' || !ID_OPERACAO.test(o.operacaoId) || typeof o.destinoId !== 'string' || !DESTINO.test(o.destinoId)) return false;
  if (typeof o.iniciadoEm !== 'string' || !ISO.test(o.iniciadoEm) || typeof o.concluidoEm !== 'string' || !ISO.test(o.concluidoEm) || !inteiro(o.duracaoMs)) return false;
  if (!nuloOu(o.codigo, (v) => typeof v === 'string' && CODIGO.test(v)) || !nuloOu(o.falhouEm, (v) => v === 'GATE' || ETAPAS[o.acao].includes(v))) return false;
  if (!Array.isArray(o.bloqueios) || !o.bloqueios.every((b) => BLOQUEIOS.includes(b)) || new Set(o.bloqueios).size !== o.bloqueios.length) return false;
  if (!Array.isArray(o.etapas) || !o.etapas.every((e) => etapaValida(e, o.acao))) return false;
  if (!nuloOu(o.conjuntoId, (v) => typeof v === 'string' && CONJUNTO.test(v)) || !nuloOu(o.sha256Manifesto, (v) => typeof v === 'string' && SHA256.test(v)) || !nuloOu(o.sha256Consolidado, (v) => typeof v === 'string' && SHA256.test(v))) return false;
  if (!nuloOu(o.arquivos, inteiro) || !nuloOu(o.bytes, inteiro) || !nuloOu(o.origemDeChaves, (v) => ORIGENS.includes(v)) || !nuloOu(o.origemDoDestino, (v) => ORIGENS.includes(v))) return false;
  if (!VERIFICACOES.includes(o.verificacaoIndependente) || !Array.isArray(o.comprovacoesPendentes) || !o.comprovacoesPendentes.every((p) => typeof p === 'string' && PENDENCIA.test(p))) return false;
  if (o.duravelmenteArmazenado !== false || o.recuperavelEmProducao !== false || o.operacional !== calcularOperacional(o) || typeof o.sha256 !== 'string' || !SHA256.test(o.sha256)) return false;
  if (o.estado === 'CONCLUIDO') return o.codigo === null && o.falhouEm === null && o.bloqueios.length === 0 && o.etapas.length >= 1 && o.etapas.every((e) => e.ok);
  if (o.estado === 'BLOQUEADO') return o.falhouEm === 'GATE' && o.bloqueios.length >= 1 && o.etapas.length === 0 && o.codigo !== null && o.bloqueios.includes(o.codigo);
  const ultima = o.etapas.at(-1);
  return o.codigo !== null && o.bloqueios.length === 0 && ultima !== undefined && !ultima.ok && o.falhouEm === ultima.id && o.etapas.slice(0, -1).every((e) => e.ok);
}

function criarEvidencia(opcoes) {
  if (!ehObjeto(opcoes) || !Reflect.ownKeys(opcoes).every((k) => ['modo', 'acao', 'ambiente', 'destinoId', 'relogio', 'operacaoId'].includes(k))) throw invalida();
  const { modo, acao, ambiente, destinoId, relogio } = opcoes;
  if (!MODOS.includes(modo) || !ACOES.includes(acao) || !AMBIENTES.includes(ambiente) || typeof destinoId !== 'string' || !DESTINO.test(destinoId) || typeof relogio !== 'function') throw invalida();
  const operacaoId = opcoes.operacaoId === undefined ? crypto.randomBytes(16).toString('hex') : opcoes.operacaoId;
  if (typeof operacaoId !== 'string' || !ID_OPERACAO.test(operacaoId)) throw invalida();
  const agora = () => { const t = relogio(); if (!Number.isSafeInteger(t) || t < 0) throw invalida(); return t; };
  const inicio = agora();
  let marco = inicio;
  let indice = -1;
  let fechada = false;
  const etapas = [];

  function etapa(id, ok, codigo = null) {
    if (fechada) throw encerrada();
    const posicao = ETAPAS[acao].indexOf(id);
    if (posicao <= indice || typeof ok !== 'boolean' || (ok && codigo !== null) || (!ok && !(typeof codigo === 'string' && CODIGO.test(codigo))) || etapas.some((e) => !e.ok)) throw invalida();
    const t = agora();
    if (t < marco) throw invalida();
    etapas.push(Object.freeze({ codigo: ok ? null : codigo, duracaoMs: t - marco, id, ok }));
    marco = t;
    indice = posicao;
  }

  function encerrar(campos) {
    if (fechada) throw encerrada();
    if (!ehObjeto(campos) || !Reflect.ownKeys(campos).every((k) => CAMPOS_DO_ENCERRAMENTO.includes(k))) throw invalida();
    const pega = (k, padrao = null) => (campos[k] === undefined ? padrao : campos[k]);
    const fim = agora();
    if (fim < marco) throw invalida();
    const pendentes = pega('comprovacoesPendentes', []);
    const bloqueados = pega('bloqueios', []);
    if (!Array.isArray(pendentes) || !Array.isArray(bloqueados)) throw invalida();
    const corpo = {
      acao, ambiente, arquivos: pega('arquivos'), bloqueios: [...bloqueados], bytes: pega('bytes'), codigo: pega('codigo'), comprovacoesPendentes: [...new Set([...COMPROVACOES_POSTERIORES, ...pendentes])],
      concluidoEm: new Date(fim).toISOString(), conjuntoId: pega('conjuntoId'), destinoId, duracaoMs: fim - inicio, duravelmenteArmazenado: false, estado: pega('estado'), etapas: etapas.map((e) => ({ ...e })),
      falhouEm: pega('falhouEm'), iniciadoEm: new Date(inicio).toISOString(), modo, operacaoId, operacional: false, origemDeChaves: pega('origemDeChaves'), origemDoDestino: pega('origemDoDestino'),
      recuperavelEmProducao: false, sha256Consolidado: pega('sha256Consolidado'), sha256Manifesto: pega('sha256Manifesto'), tipo: TIPOS[acao], verificacaoIndependente: pega('verificacaoIndependente', 'NAO_APLICA'), versao: 1,
    };
    corpo.operacional = calcularOperacional(corpo);
    const sha256 = hashDoCorpo(corpo);
    const completa = canonico({ ...corpo, sha256 });
    if (!linhaValida(completa)) throw invalida();
    fechada = true;
    const evidencia = congelar(completa);
    return Object.freeze({ evidencia, linha: `${JSON.stringify(evidencia)}\n`, sha256 });
  }

  return Object.freeze({ etapa, encerrar });
}

/** Lê e confere uma linha (uma por vez, com quebra de linha). Motivos fixos: FORMA_INVALIDA, LINHA_GRANDE, JSON_INVALIDO, HASH_DIVERGENTE. */
function lerLinhaDeEvidencia(texto) {
  const recusa = (motivo) => ({ ok: false, motivo });
  if (typeof texto !== 'string') return recusa('FORMA_INVALIDA');
  if (texto.length > LIMITE_DA_LINHA) return recusa('LINHA_GRANDE');
  if (!texto.endsWith('\n') || texto.indexOf('\n') !== texto.length - 1) return recusa('FORMA_INVALIDA');
  let objeto;
  try { objeto = JSON.parse(texto); } catch { return recusa('JSON_INVALIDO'); }
  if (!linhaValida(objeto)) return recusa('FORMA_INVALIDA');
  const { sha256, ...corpo } = objeto;
  if (hashDoCorpo(corpo) !== sha256) return recusa('HASH_DIVERGENTE');
  if (`${JSON.stringify(canonico(objeto))}\n` !== texto) return recusa('FORMA_INVALIDA');
  return { ok: true, evidencia: congelar(objeto) };
}

module.exports = { criarEvidencia, lerLinhaDeEvidencia, ETAPAS, TIPOS, ESTADOS, ORIGENS, VERIFICACOES };
