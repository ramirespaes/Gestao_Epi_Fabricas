'use strict';

/**
 * CPFs fictícios com dígitos verificadores válidos, para fixtures: a base de
 * nove dígitos vem do número informado (1, 2, 3…), então a sequência nunca
 * repete e nunca gera os onze dígitos iguais que a regra recusa.
 */
function digito(digitos, pesoInicial) {
  let soma = 0;
  for (let i = 0; i < digitos.length; i += 1) {
    soma += Number(digitos[i]) * (pesoInicial - i);
  }
  const resto = (soma * 10) % 11;
  return resto === 10 ? 0 : resto;
}

function cpfFicticio(numero) {
  if (!Number.isInteger(numero) || numero < 1 || numero > 999_999_999) {
    throw new TypeError('número inválido');
  }
  const base = String(numero).padStart(9, '0');
  const dv1 = digito(base, 10);
  const dv2 = digito(base + dv1, 11);
  return `${base}${dv1}${dv2}`;
}

/** O mesmo CPF com a máscara 000.000.000-00. */
function comMascara(cpf) {
  return `${cpf.slice(0, 3)}.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9)}`;
}

module.exports = { cpfFicticio, comMascara };
