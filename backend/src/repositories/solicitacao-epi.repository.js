'use strict';

const { lockDaChave, ESPACO_SOLICITACOES, CHAVE_FORMATO, HASH_FORMATO } = require('../utils/idempotencia');

/**
 * Cabeçalho da solicitação de EPI (solicitacoes_epi, migration 065). O
 * repositório só grava e lê: o resultado da decisão, quem pode decidir ou
 * cancelar e a conferência dos itens são do serviço; a coerência final é do
 * banco (CHECKs, gatilhos e conferência no COMMIT). Toda consulta filtra pela
 * empresa. A decisão e o cancelamento só atualizam solicitação PENDENTE e
 * devolvem null quando não havia o que atualizar.
 *
 * criada_em vem do DEFAULT da tabela; decidida_em e cancelada_em, do
 * clock_timestamp() do banco, nunca do cliente.
 */

const ORIGENS = Object.freeze(['USUARIO_INTERNO', 'AUTOATENDIMENTO']);
const STATUS_DE_DECISAO = Object.freeze(['APROVADA', 'APROVADA_PARCIAL', 'REPROVADA']);
const OBSERVACAO_MAXIMA = 500;
const JUSTIFICATIVA_MAXIMA = 500;

const COLUNAS = `id, empresa_id, numero, funcionario_id, ghe_id, origem_solicitacao, solicitante_usuario_id, status,
  quantidade_itens, observacao, chave_idempotencia, requisicao_hash, criada_em, decidida_por, decidida_em, cancelada_por,
  cancelada_em, justificativa_cancelamento, entregue_em`;

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError(`${nome} inválido`);
  }
}

function exigirChave(chave) {
  if (typeof chave !== 'string' || !CHAVE_FORMATO.test(chave)) {
    throw new TypeError('chave de idempotência inválida');
  }
}

// Conta caracteres, como char_length no banco, não unidades UTF-16.
function exigirTextoOpcional(valor, nome, maximo) {
  if (valor === null) return;
  if (typeof valor !== 'string' || valor.length === 0 || Array.from(valor).length > maximo) {
    throw new TypeError(`${nome} inválida`);
  }
}

const mapear = (l) => (l === undefined ? null : {
  id: l.id,
  empresaId: l.empresa_id,
  numero: l.numero,
  funcionarioId: l.funcionario_id,
  gheId: l.ghe_id,
  origemSolicitacao: l.origem_solicitacao,
  solicitanteUsuarioId: l.solicitante_usuario_id,
  status: l.status,
  quantidadeItens: l.quantidade_itens,
  observacao: l.observacao,
  chaveIdempotencia: l.chave_idempotencia,
  requisicaoHash: l.requisicao_hash,
  criadaEm: l.criada_em,
  decididaPor: l.decidida_por,
  decididaEm: l.decidida_em,
  canceladaPor: l.cancelada_por,
  canceladaEm: l.cancelada_em,
  justificativaCancelamento: l.justificativa_cancelamento,
  entregueEm: l.entregue_em,
});

/** Serializa, até o fim da transação, quem usa a mesma chave na mesma empresa (espaço das solicitações). */
async function travarChave(executor, empresaId, chave) {
  exigirId(empresaId, 'identificador de empresa');
  exigirChave(chave);
  await executor.query('SELECT pg_advisory_xact_lock($1::bigint)', [lockDaChave(ESPACO_SOLICITACOES, empresaId, chave)]);
}

async function buscarPorChave(executor, empresaId, chave) {
  exigirId(empresaId, 'identificador de empresa');
  exigirChave(chave);
  const { rows } = await executor.query(
    `SELECT ${COLUNAS} FROM solicitacoes_epi WHERE empresa_id = $1 AND chave_idempotencia = $2`,
    [empresaId, chave],
  );
  return mapear(rows[0]);
}

async function buscarPorId(executor, empresaId, id) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(id, 'identificador de solicitação');
  const { rows } = await executor.query(`SELECT ${COLUNAS} FROM solicitacoes_epi WHERE empresa_id = $1 AND id = $2`, [empresaId, id]);
  return mapear(rows[0]);
}

/**
 * Lê e trava a solicitação para decidir ou cancelar. FOR NO KEY UPDATE
 * serializa decisão e cancelamento sem bloquear a FK de quem a referencia
 * (itens, entrega). Só dentro de transação.
 */
async function travarPorId(executor, empresaId, id) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(id, 'identificador de solicitação');
  const { rows } = await executor.query(
    `SELECT ${COLUNAS} FROM solicitacoes_epi WHERE empresa_id = $1 AND id = $2 FOR NO KEY UPDATE`,
    [empresaId, id],
  );
  return mapear(rows[0]);
}

/** Grava o cabeçalho PENDENTE. Os itens entram na mesma transação, e o banco confere a contagem no COMMIT. */
async function criar(executor, {
  empresaId, numero, funcionarioId, gheId = null, origemSolicitacao, solicitanteUsuarioId = null, quantidadeItens,
  observacao = null, chave, requisicaoHash,
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(numero, 'número');
  exigirId(funcionarioId, 'identificador de funcionário');
  if (gheId !== null) exigirId(gheId, 'identificador de GHE');
  if (!ORIGENS.includes(origemSolicitacao)) throw new TypeError('origem da solicitação inválida');
  if (origemSolicitacao === 'USUARIO_INTERNO') {
    exigirId(solicitanteUsuarioId, 'identificador de solicitante');
  } else if (solicitanteUsuarioId !== null) {
    throw new TypeError('autoatendimento não tem solicitante interno');
  }
  exigirId(quantidadeItens, 'quantidade de itens');
  exigirTextoOpcional(observacao, 'observação', OBSERVACAO_MAXIMA);
  exigirChave(chave);
  if (typeof requisicaoHash !== 'string' || !HASH_FORMATO.test(requisicaoHash)) throw new TypeError('hash da requisição inválido');

  const { rows } = await executor.query(
    `INSERT INTO solicitacoes_epi
       (empresa_id, numero, funcionario_id, ghe_id, origem_solicitacao, solicitante_usuario_id, quantidade_itens, observacao,
        chave_idempotencia, requisicao_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING ${COLUNAS}`,
    [empresaId, numero, funcionarioId, gheId, origemSolicitacao, solicitanteUsuarioId, quantidadeItens, observacao, chave, requisicaoHash],
  );
  return mapear(rows[0]);
}

/**
 * Registra o resultado da decisão numa solicitação PENDENTE. O resultado vem
 * do serviço; o banco confere no COMMIT que bate com a decisão dos itens.
 * Devolve null quando a solicitação não está PENDENTE ou não é da empresa.
 */
async function registrarDecisao(executor, empresaId, id, { status, decididaPor }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(id, 'identificador de solicitação');
  if (!STATUS_DE_DECISAO.includes(status)) throw new TypeError('status de decisão inválido');
  exigirId(decididaPor, 'identificador de decisor');
  const { rows } = await executor.query(
    `UPDATE solicitacoes_epi
        SET status = $3, decidida_por = $4, decidida_em = clock_timestamp()
      WHERE empresa_id = $1 AND id = $2 AND status = 'PENDENTE'
      RETURNING ${COLUNAS}`,
    [empresaId, id, status, decididaPor],
  );
  return mapear(rows[0]);
}

/** Cancela uma solicitação PENDENTE; null quando ela não está PENDENTE ou não é da empresa. */
async function cancelar(executor, empresaId, id, { canceladaPor, justificativa = null }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(id, 'identificador de solicitação');
  exigirId(canceladaPor, 'autor do cancelamento');
  exigirTextoOpcional(justificativa, 'justificativa do cancelamento', JUSTIFICATIVA_MAXIMA);
  const { rows } = await executor.query(
    `UPDATE solicitacoes_epi
        SET status = 'CANCELADA', cancelada_por = $3, cancelada_em = clock_timestamp(), justificativa_cancelamento = $4
      WHERE empresa_id = $1 AND id = $2 AND status = 'PENDENTE'
      RETURNING ${COLUNAS}`,
    [empresaId, id, canceladaPor, justificativa],
  );
  return mapear(rows[0]);
}

module.exports = {
  ORIGENS, STATUS_DE_DECISAO, travarChave, buscarPorChave, buscarPorId, travarPorId, criar, registrarDecisao, cancelar,
};
