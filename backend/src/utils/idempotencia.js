'use strict';

const crypto = require('node:crypto');

/**
 * Idempotência das escritas (estoque e entrega de EPI): chave UUID canônica,
 * hash SHA-256 da requisição lógica normalizada e advisory lock de 64 bits
 * por espaço, empresa e chave. Cada domínio tem o seu espaço: o mesmo UUID
 * pode existir uma vez no estoque e uma vez nas entregas.
 */

const CHAVE_FORMATO = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH_FORMATO = /^[0-9a-f]{64}$/;
const ESPACO_ESTOQUE = 'estoque_operacoes';
const ESPACO_ENTREGAS = 'entregas_epi';
const ESPACOS = Object.freeze([ESPACO_ESTOQUE, ESPACO_ENTREGAS]);

/** UUID em minúsculas, ou null quando não é um UUID. */
function chaveCanonica(chave) {
  const minuscula = typeof chave === 'string' ? chave.toLowerCase() : '';
  return CHAVE_FORMATO.test(minuscula) ? minuscula : null;
}

// Hash da requisição lógica, com os valores já normalizados: é ele que diz se
// uma chave repetida é a mesma operação ou outra. O corpo cru não entra.
function hashRequisicao(partes) {
  return crypto.createHash('sha256').update(JSON.stringify(partes)).digest('hex');
}

/** Lock de 64 bits (texto, para o bigint do PostgreSQL) por espaço, empresa e chave. */
function lockDaChave(espaco, empresaId, chave) {
  if (!ESPACOS.includes(espaco)) throw new TypeError('espaço de idempotência inválido');
  if (!Number.isInteger(empresaId) || empresaId <= 0) throw new TypeError('identificador de empresa inválido');
  if (typeof chave !== 'string' || !CHAVE_FORMATO.test(chave)) throw new TypeError('chave de idempotência inválida');
  return crypto.createHash('sha256').update(`${espaco}\n${empresaId}\n${chave}`).digest().readBigInt64BE(0).toString();
}

module.exports = {
  CHAVE_FORMATO, HASH_FORMATO, ESPACO_ESTOQUE, ESPACO_ENTREGAS, chaveCanonica, hashRequisicao, lockDaChave,
};
