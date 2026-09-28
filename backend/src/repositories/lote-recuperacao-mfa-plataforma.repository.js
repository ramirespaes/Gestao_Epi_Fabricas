'use strict';

const validacao = require('./validacao-mfa');

/**
 * Lotes de recovery codes (migration 050). O banco garante um único lote
 * ATIVO por administrador; regenerar é revogar o atual e criar outro na
 * mesma transação, na ordem que o serviço decide.
 */

async function criar(executor, administradorId) {
  validacao.exigirAdministrador(administradorId);

  const { rows } = await executor.query(
    `INSERT INTO lotes_recuperacao_mfa_plataforma (administrador_id, estado, criado_em)
     VALUES ($1, 'ATIVO', clock_timestamp())
     RETURNING id, criado_em`,
    [administradorId],
  );
  return { id: rows[0].id, criadoEm: rows[0].criado_em };
}

async function buscarAtivo(executor, administradorId, opcoes) {
  validacao.exigirAdministrador(administradorId);
  const travar = validacao.travarPedido(opcoes);

  const { rows } = await executor.query(
    `SELECT id, criado_em
       FROM lotes_recuperacao_mfa_plataforma
      WHERE administrador_id = $1 AND estado = 'ATIVO'${travar ? '\n      FOR UPDATE' : ''}`,
    [administradorId],
  );
  return rows[0] === undefined ? null : { id: rows[0].id, criadoEm: rows[0].criado_em };
}

/** Revogar o lote invalida de uma vez todos os códigos que restavam nele. */
async function revogarAtivo(executor, { administradorId, motivo }) {
  validacao.exigirAdministrador(administradorId);
  validacao.exigirMotivo(motivo);

  const { rowCount } = await executor.query(
    `UPDATE lotes_recuperacao_mfa_plataforma
        SET estado = 'REVOGADO', revogado_em = clock_timestamp(), motivo_revogacao = $2
      WHERE administrador_id = $1 AND estado = 'ATIVO'`,
    [administradorId, motivo],
  );
  return rowCount > 0;
}

module.exports = { criar, buscarAtivo, revogarAtivo };
