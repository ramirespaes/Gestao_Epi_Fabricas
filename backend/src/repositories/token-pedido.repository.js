'use strict';

const { lockDaChave, ESPACO_SOLICITACOES, CHAVE_FORMATO } = require('../utils/idempotencia');
const sqlCatalogo = require('./sql/catalogo-token');

/**
 * Acessos do pedido do Atendimento Token (Etapa F) que as peças da 12G-6 e da Etapa D não oferecem: o atendimento em QUALQUER estado (aberto ou
 * encerrado), a tabela lateral `solicitacoes_autoatendimento` (086), a tentativa de trava da chave e a leitura de autorização do catálogo (Etapa E).
 * Sempre por empresa; o hash do token chega aqui já calculado (o token em claro não entra). Executor por parâmetro; nenhuma regra de negócio.
 */

const HASH = /^[0-9a-f]{64}$/;

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) throw new TypeError(`${nome} inválido`);
}

const AUTORIZADO = sqlCatalogo.autorizadoNoCatalogo({ material: 'm', ghe: '$2' });
const TAMANHOS = sqlCatalogo.tamanhosDoMaterial({ material: 'm' });

/** O atendimento deste tablet com este token, aberto ou não (sem trava). Serve para ligar o pedido ao atendimento original. */
async function buscarAtendimentoPorToken(executor, { empresaId, dispositivoId, tokenHash }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(dispositivoId, 'identificador de dispositivo');
  if (typeof tokenHash !== 'string' || !HASH.test(tokenHash)) throw new TypeError('hash inválido');
  const { rows } = await executor.query(
    `SELECT id, funcionario_id, encerrado_em, motivo_encerramento
       FROM token_atendimentos
      WHERE token_hash = $1 AND empresa_id = $2 AND dispositivo_id = $3`,
    [tokenHash, empresaId, dispositivoId],
  );
  return rows[0] === undefined ? null : {
    id: rows[0].id, funcionarioId: rows[0].funcionario_id, encerradoEm: rows[0].encerrado_em, motivoEncerramento: rows[0].motivo_encerramento,
  };
}

/** A que atendimento o pedido pertence (lateral 086); null se a solicitação não é de autoatendimento. */
async function buscarAtendimentoDoPedido(executor, { empresaId, solicitacaoId }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(solicitacaoId, 'identificador de solicitação');
  const { rows } = await executor.query(
    'SELECT atendimento_id, dispositivo_id FROM solicitacoes_autoatendimento WHERE empresa_id = $1 AND solicitacao_id = $2',
    [empresaId, solicitacaoId],
  );
  return rows[0] === undefined ? null : { atendimentoId: rows[0].atendimento_id, dispositivoId: rows[0].dispositivo_id };
}

/** Liga o pedido ao tablet e ao atendimento, copiando a localização do tablet na data do pedido (a tabela é imutável). */
async function inserirLateral(executor, { empresaId, solicitacaoId, dispositivoId, atendimentoId }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(solicitacaoId, 'identificador de solicitação');
  exigirId(dispositivoId, 'identificador de dispositivo');
  await executor.query(
    `INSERT INTO solicitacoes_autoatendimento (solicitacao_id, empresa_id, dispositivo_id, atendimento_id, unidade, setor, local_instalacao)
     SELECT $1, d.empresa_id, d.id, $4, d.unidade, d.setor, d.local_instalacao
       FROM token_dispositivos d WHERE d.empresa_id = $2 AND d.id = $3`,
    [solicitacaoId, empresaId, dispositivoId, atendimentoId],
  );
}

/**
 * Encerra o atendimento ABERTO pelo pedido enviado (motivo da 086 que o repositório da Etapa D não escreve). false se já estava encerrado:
 * o chamador está sob o lock do atendimento, então isso é erro de programação, nunca um desfecho de negócio.
 */
async function encerrarComPedido(executor, { id }) {
  exigirId(Number(id), 'identificador de atendimento');
  const { rowCount } = await executor.query(
    "UPDATE token_atendimentos SET encerrado_em = clock_timestamp(), motivo_encerramento = 'PEDIDO_ENVIADO' WHERE id = $1 AND encerrado_em IS NULL",
    [id],
  );
  return rowCount === 1;
}

/** Tenta a MESMA trava da chave da 12G sem esperar: false quando uma finalização com esta chave está em curso. */
async function tentarTravarChave(executor, empresaId, chave) {
  exigirId(empresaId, 'identificador de empresa');
  if (typeof chave !== 'string' || !CHAVE_FORMATO.test(chave)) throw new TypeError('chave de idempotência inválida');
  const { rows } = await executor.query('SELECT pg_try_advisory_xact_lock($1::bigint) AS travou', [lockDaChave(ESPACO_SOLICITACOES, empresaId, chave)]);
  return rows[0].travou === true;
}

/** O GHE existe, é da empresa e está ativo. */
async function gheAtivo(executor, empresaId, gheId) {
  exigirId(empresaId, 'identificador de empresa');
  if (gheId === null) return false;
  exigirId(gheId, 'identificador de GHE');
  const { rows } = await executor.query('SELECT ativo FROM grupos_homogeneos_exposicao WHERE empresa_id = $1 AND id = $2', [empresaId, gheId]);
  return rows[0]?.ativo === true;
}

/**
 * Dos materiais pedidos, os que o catálogo da Etapa E autorizaria AGORA para o GHE (mesma regra e mesma expressão de tamanhos): ativos,
 * classificados, autorizados direto ou por tipo ativo. Devolve exige_tamanho e a lista de tamanhos cadastrados. Nenhum dado de estoque.
 */
async function lerAutorizados(executor, { empresaId, gheId, materialIds }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(gheId, 'identificador de GHE');
  const { rows } = await executor.query(
    `SELECT m.id, m.exige_tamanho, ${TAMANHOS} AS tamanhos
       FROM materiais m
      WHERE m.empresa_id = $1 AND m.id = ANY($3::int[]) AND m.ativo AND m.exige_tamanho IS NOT NULL AND ${AUTORIZADO}`,
    [empresaId, gheId, materialIds],
  );
  return rows;
}

module.exports = {
  buscarAtendimentoPorToken, buscarAtendimentoDoPedido, inserirLateral, encerrarComPedido, tentarTravarChave, gheAtivo, lerAutorizados,
};
