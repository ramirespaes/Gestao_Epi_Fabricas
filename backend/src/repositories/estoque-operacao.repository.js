'use strict';

const crypto = require('node:crypto');

/**
 * Escrita do estoque por lote. Eu só insiro lote e operação: os contadores do
 * lote mudam pelo trigger da migration 042 quando a operação entra, e nunca
 * por UPDATE daqui. Toda consulta filtra pela empresa.
 *
 * Quem chama abre a transação: o lote novo só é aceito no COMMIT se a sua
 * operação de entrada estiver na mesma transação.
 */

const CHAVE_FORMATO = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH_FORMATO = /^[0-9a-f]{64}$/;
const DATA_FORMATO = /^\d{4}-\d{2}-\d{2}$/;
const INTEGER_MAXIMO = 2147483647;
const TAMANHO_MAXIMO = 20;
const CA_NUMERO_MAXIMO = 20;

const COLUNAS_LOTE = `id, material_id, tamanho, ca_numero, to_char(ca_validade, 'YYYY-MM-DD') AS ca_validade, origem,
       quantidade_entrada, quantidade_baixada, quantidade_entregue, saldo`;
const COLUNAS_OPERACAO = 'id, tipo, lote_id, quantidade, motivo, justificativa, usuario_id, requisicao_hash, criado_em';

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError(`identificador de ${nome} inválido`);
  }
}

function exigirChave(chave) {
  if (typeof chave !== 'string' || !CHAVE_FORMATO.test(chave)) {
    throw new TypeError('chave de idempotência inválida');
  }
}

function exigirTexto(valor, maximo, mensagem) {
  if (typeof valor !== 'string' || valor.trim() !== valor || valor.length === 0 || Array.from(valor).length > maximo) {
    throw new TypeError(mensagem);
  }
}

function exigirOperacao({ empresaId, usuarioId, quantidade, chave, requisicaoHash }) {
  exigirId(empresaId, 'empresa');
  exigirId(usuarioId, 'usuário');
  if (!Number.isInteger(quantidade) || quantidade <= 0 || quantidade > INTEGER_MAXIMO) {
    throw new TypeError('quantidade inválida');
  }
  exigirChave(chave);
  if (typeof requisicaoHash !== 'string' || !HASH_FORMATO.test(requisicaoHash)) {
    throw new TypeError('hash da requisição inválido');
  }
}

function mapearLote(l) {
  return {
    loteId: l.id,
    materialId: l.material_id,
    tamanho: l.tamanho,
    caNumero: l.ca_numero,
    caValidade: l.ca_validade,
    origem: l.origem,
    quantidadeEntrada: l.quantidade_entrada,
    quantidadeBaixada: l.quantidade_baixada,
    quantidadeEntregue: l.quantidade_entregue,
    saldo: l.saldo,
  };
}

// O id é BIGINT: fica em texto, porque Number não guarda 64 bits com segurança.
function mapearOperacao(o) {
  return {
    id: String(o.id),
    tipo: o.tipo,
    loteId: o.lote_id,
    quantidade: o.quantidade,
    motivo: o.motivo,
    justificativa: o.justificativa,
    usuarioId: o.usuario_id,
    criadoEm: o.criado_em,
  };
}

// Lock de 64 bits por empresa e chave. Entrada e baixa usam o mesmo espaço,
// porque a chave vale uma vez só por empresa, qualquer que seja a operação.
function lockDaChave(empresaId, chave) {
  return crypto.createHash('sha256').update(`estoque_operacoes\n${empresaId}\n${chave}`).digest().readBigInt64BE(0).toString();
}

/** Serializa, até o fim da transação, quem usa a mesma chave na mesma empresa. */
async function travarChave(executor, empresaId, chave) {
  exigirId(empresaId, 'empresa');
  exigirChave(chave);
  await executor.query('SELECT pg_advisory_xact_lock($1::bigint)', [lockDaChave(empresaId, chave)]);
}

/** Operação já registrada com a chave, com o hash da requisição que a criou. */
async function buscarPorChave(executor, empresaId, chave) {
  exigirId(empresaId, 'empresa');
  exigirChave(chave);
  const { rows } = await executor.query(
    `SELECT ${COLUNAS_OPERACAO} FROM estoque_operacoes WHERE empresa_id = $1 AND chave_idempotencia = $2`,
    [empresaId, chave],
  );
  return rows[0] ? { ...mapearOperacao(rows[0]), requisicaoHash: rows[0].requisicao_hash } : null;
}

async function buscarLote(executor, empresaId, loteId) {
  exigirId(empresaId, 'empresa');
  exigirId(loteId, 'lote');
  const { rows } = await executor.query(`SELECT ${COLUNAS_LOTE} FROM estoque_lotes WHERE empresa_id = $1 AND id = $2`, [empresaId, loteId]);
  return rows[0] ? mapearLote(rows[0]) : null;
}

/** Trava o lote para decidir a baixa sobre o saldo atual; baixas simultâneas esperam. */
async function buscarLoteParaBaixa(executor, empresaId, loteId) {
  exigirId(empresaId, 'empresa');
  exigirId(loteId, 'lote');
  const { rows } = await executor.query(
    `SELECT ${COLUNAS_LOTE} FROM estoque_lotes WHERE empresa_id = $1 AND id = $2 FOR UPDATE`,
    [empresaId, loteId],
  );
  return rows[0] ? mapearLote(rows[0]) : null;
}

/** Cria o lote ENTRADA e a sua operação. CA e validade são obrigatórios; o tamanho pode ser null. */
async function registrarEntrada(executor, dados) {
  const {
    empresaId, materialId, usuarioId, tamanho, quantidade, caNumero, caValidade, chave, requisicaoHash,
  } = dados;
  exigirOperacao(dados);
  exigirId(materialId, 'material');
  if (tamanho !== null) exigirTexto(tamanho, TAMANHO_MAXIMO, 'tamanho inválido');
  exigirTexto(caNumero, CA_NUMERO_MAXIMO, 'número do CA inválido');
  if (typeof caValidade !== 'string' || !DATA_FORMATO.test(caValidade)) {
    throw new TypeError('validade do CA inválida');
  }

  const lote = await executor.query(
    `INSERT INTO estoque_lotes (empresa_id, material_id, tamanho, ca_numero, ca_validade, origem, quantidade_entrada)
     VALUES ($1, $2, $3, $4, $5, 'ENTRADA', $6)
     RETURNING ${COLUNAS_LOTE}`,
    [empresaId, materialId, tamanho, caNumero, caValidade, quantidade],
  );
  const operacao = await executor.query(
    `INSERT INTO estoque_operacoes (empresa_id, lote_id, tipo, quantidade, usuario_id, chave_idempotencia, requisicao_hash)
     VALUES ($1, $2, 'ENTRADA', $3, $4, $5, $6)
     RETURNING ${COLUNAS_OPERACAO}`,
    [empresaId, lote.rows[0].id, quantidade, usuarioId, chave, requisicaoHash],
  );
  return { operacao: mapearOperacao(operacao.rows[0]), lote: mapearLote(lote.rows[0]) };
}

/** Grava a BAIXA; o trigger soma a quantidade baixada do lote. */
async function registrarBaixa(executor, dados) {
  const {
    empresaId, loteId, usuarioId, quantidade, motivo, justificativa = null, chave, requisicaoHash,
  } = dados;
  exigirOperacao(dados);
  exigirId(loteId, 'lote');

  const { rows } = await executor.query(
    `INSERT INTO estoque_operacoes (empresa_id, lote_id, tipo, quantidade, motivo, justificativa, usuario_id, chave_idempotencia, requisicao_hash)
     VALUES ($1, $2, 'BAIXA', $3, $4, $5, $6, $7, $8)
     RETURNING ${COLUNAS_OPERACAO}`,
    [empresaId, loteId, quantidade, motivo, justificativa, usuarioId, chave, requisicaoHash],
  );
  return mapearOperacao(rows[0]);
}

module.exports = {
  travarChave,
  buscarPorChave,
  buscarLote,
  buscarLoteParaBaixa,
  registrarEntrada,
  registrarBaixa,
};
