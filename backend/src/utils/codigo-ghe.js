'use strict';

/**
 * Código do GHE (ex.: GHE-002): aparado, em maiúsculas, "GHE-" + 3 a 6 dígitos ASCII.
 * Fonte única da regra; o banco só confere a forma canônica (migration 083).
 * Classe [0-9] de propósito: \d não é usado, para recusar dígitos de outros alfabetos.
 */

const FORMATO = /^GHE-[0-9]{3,6}$/;

/** @returns {string|null} código canônico, ou null se a entrada não for um código válido */
function normalizarCodigoGhe(valor) {
  if (typeof valor !== 'string') {
    return null;
  }
  const canonico = valor.trim().toUpperCase();
  return FORMATO.test(canonico) ? canonico : null;
}

module.exports = { normalizarCodigoGhe };
