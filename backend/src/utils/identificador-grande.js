'use strict';

/**
 * Identificadores BIGINT (imagens). O driver os entrega como texto e o JSON da API os serializa como texto decimal, para nunca perder precisão:
 * dentro da aplicação e nos contratos serializáveis o id é sempre uma string decimal canônica (sem zeros à esquerda, de 1 a 9223372036854775807).
 * Na ENTRADA aceita-se também um número inteiro seguro positivo (convenção dos ids INTEGER), normalizado para a mesma string.
 */

const DECIMAL_CANONICO = /^[1-9][0-9]{0,18}$/;
const MAXIMO_BIGINT = 9223372036854775807n;

/** String decimal canônica, ou null quando o valor não é um id válido. */
function normalizarIdGrande(valor) {
  let texto;
  if (typeof valor === 'number') {
    if (!Number.isSafeInteger(valor) || valor <= 0) return null;
    texto = String(valor);
  } else if (typeof valor === 'string') {
    texto = valor;
  } else {
    return null;
  }
  if (!DECIMAL_CANONICO.test(texto)) return null;
  return BigInt(texto) <= MAXIMO_BIGINT ? texto : null;
}

/** Como `normalizarIdGrande`, mas valor inválido é erro de programação (TypeError). */
function exigirIdGrande(valor, nome) {
  const id = normalizarIdGrande(valor);
  if (id === null) throw new TypeError(`${nome} inválido`);
  return id;
}

module.exports = { normalizarIdGrande, exigirIdGrande };
