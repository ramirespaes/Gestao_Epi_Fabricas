'use strict';

const crypto = require('node:crypto');

/**
 * Trava lógica da biblioteca de imagens de uma empresa: advisory lock de 64 bits num espaço próprio, separado das travas de estoque e de
 * idempotência. Serializa quem confere a deduplicação por SHA-256 e a cota (dois envios do mesmo arquivo, ou duas disputas pela última vaga,
 * nunca passam juntos). Mesmo desenho de lock-par-estoque.js: texto do inteiro de 64 bits, derivado de um espaço nomeado e da empresa.
 */

const ESPACO_BIBLIOTECA_IMAGENS = 'imagens_biblioteca';

function lockDaBiblioteca(empresaId) {
  if (!Number.isInteger(empresaId) || empresaId <= 0) throw new TypeError('identificador de empresa inválido');
  return crypto.createHash('sha256').update(`${ESPACO_BIBLIOTECA_IMAGENS}\n${empresaId}`).digest().readBigInt64BE(0).toString();
}

module.exports = { ESPACO_BIBLIOTECA_IMAGENS, lockDaBiblioteca };
