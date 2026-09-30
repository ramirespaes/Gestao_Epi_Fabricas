'use strict';

/**
 * Contador da numeração das fichas de EPI (fichas_epi_numeracao, migration
 * 058): uma linha por empresa, que nasce em 1 e só avança de um em um. O
 * incremento acontece na transação da ficha: a linha fica travada até o
 * COMMIT, e o ROLLBACK desfaz o número, sem lacuna.
 */

function exigirEmpresa(empresaId) {
  if (!Number.isInteger(empresaId) || empresaId <= 0) {
    throw new TypeError('identificador de empresa inválido');
  }
}

/** Reserva o próximo número da empresa (1 na primeira vez). Só dentro de transação. */
async function proximoNumero(executor, empresaId) {
  exigirEmpresa(empresaId);
  const { rows } = await executor.query(
    `INSERT INTO fichas_epi_numeracao (empresa_id, ultimo_numero) VALUES ($1, 1)
     ON CONFLICT (empresa_id) DO UPDATE SET ultimo_numero = fichas_epi_numeracao.ultimo_numero + 1
     RETURNING ultimo_numero`,
    [empresaId],
  );
  return rows[0].ultimo_numero;
}

module.exports = { proximoNumero };
