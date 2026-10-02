'use strict';

const { lockDoPar, parOrdenados } = require('../utils/lock-par-estoque');

/**
 * Trava do par (empresa, material, tamanho): advisory lock de transação,
 * mantido até o COMMIT ou o ROLLBACK. Quem confere ou consome o saldo livre
 * trava os pares envolvidos antes de ler a posição (ordem global: idempotência,
 * solicitação, trabalhador, materiais, pares, lotes, numeração).
 */

function exigirEmpresa(empresaId) {
  if (!Number.isInteger(empresaId) || empresaId <= 0) {
    throw new TypeError('identificador de empresa inválido');
  }
}

/**
 * Trava os pares, um de cada vez e na ordem canônica, e devolve os pares
 * travados (sem repetição, na ordem). Só dentro de transação. A validação de
 * todos vem antes da primeira trava.
 */
async function travarPares(executor, empresaId, pares) {
  exigirEmpresa(empresaId);
  const ordenados = parOrdenados(pares);
  for (const par of ordenados) {
    await executor.query('SELECT pg_advisory_xact_lock($1::bigint)', [lockDoPar(empresaId, par.materialId, par.tamanho)]);
  }
  return ordenados;
}

module.exports = { travarPares };
