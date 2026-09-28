'use strict';

const validacao = require('./validacao-mfa');

/**
 * Liberações de cadastro do MFA (migration 053). Só o hash do código passa
 * por aqui. O banco garante no máximo uma liberação aberta por
 * administrador; o consumo é condicional e respeita o prazo pelo relógio do
 * banco. Uma aberta vencida continua aberta até ser revogada.
 */

const ORIGENS = new Set(['CLI_LIBERACAO', 'CLI_CRIACAO', 'CLI_RESET']);

const COLUNAS = 'id, origem, criado_em, expira_em, (expira_em > clock_timestamp()) AS vigente';

function paraLiberacao(linha) {
  return { id: linha.id, origem: linha.origem, criadoEm: linha.criado_em, expiraEm: linha.expira_em, vigente: linha.vigente };
}

function exigirCodigoHash(codigoHash) {
  validacao.exigirHash(codigoHash, 'código de liberação');
}

async function criar(executor, { administradorId, codigoHash, origem, validadeMinutos }) {
  validacao.exigirAdministrador(administradorId);
  exigirCodigoHash(codigoHash);
  if (!ORIGENS.has(origem)) {
    throw new TypeError('origem de liberação desconhecida');
  }
  validacao.exigirMinutos(validadeMinutos);

  const { rows } = await executor.query(
    `WITH agora AS (SELECT clock_timestamp() AS t)
     INSERT INTO liberacoes_cadastro_mfa_plataforma (administrador_id, codigo_hash, origem, criado_em, expira_em)
     VALUES ($1, $2, $3, (SELECT t FROM agora), (SELECT t FROM agora) + ($4 * INTERVAL '1 minute'))
     RETURNING id, criado_em, expira_em`,
    [administradorId, codigoHash, origem, validadeMinutos],
  );
  return { id: rows[0].id, criadoEm: rows[0].criado_em, expiraEm: rows[0].expira_em };
}

/** A aberta do administrador, vencida ou não. */
async function buscarAberta(executor, administradorId, opcoes) {
  validacao.exigirAdministrador(administradorId);
  const travar = validacao.travarPedido(opcoes);

  const { rows } = await executor.query(
    `SELECT ${COLUNAS}
       FROM liberacoes_cadastro_mfa_plataforma
      WHERE administrador_id = $1 AND consumida_em IS NULL AND revogada_em IS NULL${travar ? '\n      FOR UPDATE' : ''}`,
    [administradorId],
  );
  return rows[0] === undefined ? null : paraLiberacao(rows[0]);
}

async function buscarValidaPorHash(executor, { administradorId, codigoHash }, opcoes) {
  validacao.exigirAdministrador(administradorId);
  exigirCodigoHash(codigoHash);
  const travar = validacao.travarPedido(opcoes);

  const { rows } = await executor.query(
    `SELECT ${COLUNAS}
       FROM liberacoes_cadastro_mfa_plataforma
      WHERE administrador_id = $1 AND codigo_hash = $2
        AND consumida_em IS NULL AND revogada_em IS NULL
        AND expira_em > clock_timestamp()${travar ? '\n      FOR UPDATE' : ''}`,
    [administradorId, codigoHash],
  );
  return rows[0] === undefined ? null : paraLiberacao(rows[0]);
}

/** Id da liberação consumida, ou null: já usada, revogada, vencida ou de outro administrador. */
async function consumir(executor, { administradorId, codigoHash }) {
  validacao.exigirAdministrador(administradorId);
  exigirCodigoHash(codigoHash);

  const { rows } = await executor.query(
    `UPDATE liberacoes_cadastro_mfa_plataforma
        SET consumida_em = clock_timestamp()
      WHERE administrador_id = $1 AND codigo_hash = $2
        AND consumida_em IS NULL AND revogada_em IS NULL
        AND expira_em > clock_timestamp()
      RETURNING id`,
    [administradorId, codigoHash],
  );
  return rows[0] === undefined ? null : rows[0].id;
}

async function revogarAberta(executor, { administradorId, motivo }) {
  validacao.exigirAdministrador(administradorId);
  validacao.exigirMotivo(motivo);

  const { rowCount } = await executor.query(
    `UPDATE liberacoes_cadastro_mfa_plataforma
        SET revogada_em = clock_timestamp(), motivo_revogacao = $2
      WHERE administrador_id = $1 AND consumida_em IS NULL AND revogada_em IS NULL`,
    [administradorId, motivo],
  );
  return rowCount > 0;
}

module.exports = { criar, buscarAberta, buscarValidaPorHash, consumir, revogarAberta };
