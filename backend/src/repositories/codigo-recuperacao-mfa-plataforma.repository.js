'use strict';

const validacao = require('./validacao-mfa');

/**
 * Recovery codes (migration 051). Só hashes passam por aqui: nenhuma função
 * recebe o código em claro. Um código é utilizável só com o lote ATIVO e
 * ainda não consumido, e o consumo é um UPDATE condicional nessas duas
 * condições, com um único vencedor. A trava do administrador, que serializa
 * consumo e revogação do lote, é de quem chama.
 */

// Mesmo "f1" do texto do hash em security/codigos-mfa.js.
const FORMATO_HASH_ATUAL = 1;
const MAXIMO_POR_LOTE = 20;

const JUNCAO_LOTE = `JOIN lotes_recuperacao_mfa_plataforma l
         ON l.id = c.lote_id AND l.administrador_id = c.administrador_id`;

function exigirCodigoHash(codigoHash) {
  validacao.exigirHash(codigoHash, 'código de recuperação');
}

/**
 * Grava os hashes num único INSERT, só se o lote for deste administrador e
 * estiver ATIVO. Devolve quantos entraram: quem chama confere se foram todos.
 */
async function inserirHashes(executor, { administradorId, loteId, hashes }) {
  validacao.exigirAdministrador(administradorId);
  validacao.exigirId(loteId, 'lote');
  if (!Array.isArray(hashes) || hashes.length === 0 || hashes.length > MAXIMO_POR_LOTE) {
    throw new TypeError('lista de códigos de recuperação inválida');
  }
  hashes.forEach(exigirCodigoHash);
  if (new Set(hashes).size !== hashes.length) {
    throw new TypeError('lista de códigos de recuperação com repetição');
  }

  const { rowCount } = await executor.query(
    `INSERT INTO codigos_recuperacao_mfa_plataforma (lote_id, administrador_id, codigo_hash, formato_versao, criado_em)
     SELECT l.id, l.administrador_id, h.codigo_hash, $4::smallint, clock_timestamp()
       FROM lotes_recuperacao_mfa_plataforma l
      CROSS JOIN unnest($3::text[]) AS h(codigo_hash)
      WHERE l.id = $1 AND l.administrador_id = $2 AND l.estado = 'ATIVO'`,
    [loteId, administradorId, hashes, FORMATO_HASH_ATUAL],
  );
  return rowCount;
}

async function buscarUtilizavelPorHash(executor, { administradorId, codigoHash }, opcoes) {
  validacao.exigirAdministrador(administradorId);
  exigirCodigoHash(codigoHash);
  const travar = validacao.travarPedido(opcoes);

  const { rows } = await executor.query(
    `SELECT c.id, c.lote_id
       FROM codigos_recuperacao_mfa_plataforma c
       ${JUNCAO_LOTE}
      WHERE c.administrador_id = $1 AND c.codigo_hash = $2
        AND c.consumido_em IS NULL AND l.estado = 'ATIVO'${travar ? '\n      FOR UPDATE OF c' : ''}`,
    [administradorId, codigoHash],
  );
  return rows[0] === undefined ? null : { id: rows[0].id, loteId: rows[0].lote_id };
}

/** Consome o código. null = já consumido, lote revogado ou código inexistente. */
async function consumir(executor, { administradorId, codigoHash }) {
  validacao.exigirAdministrador(administradorId);
  exigirCodigoHash(codigoHash);

  const { rows } = await executor.query(
    `UPDATE codigos_recuperacao_mfa_plataforma c
        SET consumido_em = clock_timestamp()
       FROM lotes_recuperacao_mfa_plataforma l
      WHERE c.administrador_id = $1 AND c.codigo_hash = $2 AND c.consumido_em IS NULL
        AND l.id = c.lote_id AND l.administrador_id = c.administrador_id AND l.estado = 'ATIVO'
      RETURNING c.id, c.lote_id`,
    [administradorId, codigoHash],
  );
  return rows[0] === undefined ? null : { id: rows[0].id, loteId: rows[0].lote_id };
}

async function contarRestantes(executor, administradorId) {
  validacao.exigirAdministrador(administradorId);

  const { rows } = await executor.query(
    `SELECT count(*)::int AS restantes
       FROM codigos_recuperacao_mfa_plataforma c
       ${JUNCAO_LOTE}
      WHERE l.administrador_id = $1 AND l.estado = 'ATIVO' AND c.consumido_em IS NULL`,
    [administradorId],
  );
  return rows[0].restantes;
}

module.exports = { inserirHashes, buscarUtilizavelPorHash, consumir, contarRestantes };
