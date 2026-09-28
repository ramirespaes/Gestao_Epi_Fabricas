'use strict';

/**
 * Validações de entrada comuns aos repositórios do MFA da plataforma.
 * Entrada fora do contrato é erro de programação: TypeError antes de
 * qualquer consulta, e a mensagem nunca carrega o valor recebido.
 */

const ADMINISTRADOR_ID_MAXIMO = 2147483647;
const FORMATO_ID = /^[1-9][0-9]{0,18}$/;
const FORMATO_HASH = /^[0-9a-f]{64}$/;
const FORMATO_MOTIVO = /^[A-Z_]{1,30}$/;
const MINUTOS_MAXIMOS = 1440;

function exigirAdministrador(administradorId) {
  if (!Number.isInteger(administradorId) || administradorId <= 0 || administradorId > ADMINISTRADOR_ID_MAXIMO) {
    throw new TypeError('identificador de administrador inválido');
  }
}

/** Identificadores BIGINT chegam como texto decimal canônico, como o pg os devolve. */
function exigirId(valor, nome) {
  if (typeof valor !== 'string' || !FORMATO_ID.test(valor)) {
    throw new TypeError(`identificador de ${nome} inválido`);
  }
}

function exigirIdOpcional(valor, nome) {
  if (valor !== null) {
    exigirId(valor, nome);
  }
}

function exigirHash(valor, nome) {
  if (typeof valor !== 'string' || !FORMATO_HASH.test(valor)) {
    throw new TypeError(`${nome} deve chegar como SHA-256 hexadecimal minúsculo`);
  }
}

function exigirMotivo(motivo) {
  if (typeof motivo !== 'string' || !FORMATO_MOTIVO.test(motivo)) {
    throw new TypeError('motivo fora do formato aceito');
  }
}

function exigirMinutos(minutos) {
  if (!Number.isInteger(minutos) || minutos < 1 || minutos > MINUTOS_MAXIMOS) {
    throw new TypeError('validade em minutos inválida');
  }
}

function travarPedido(opcoes = {}) {
  const { travar = false } = opcoes;
  if (typeof travar !== 'boolean') {
    throw new TypeError('opção travar deve ser booleana');
  }
  return travar;
}

module.exports = {
  exigirAdministrador,
  exigirId,
  exigirIdOpcional,
  exigirHash,
  exigirMotivo,
  exigirMinutos,
  travarPedido,
};
