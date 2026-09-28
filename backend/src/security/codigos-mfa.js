'use strict';

const crypto = require('node:crypto');

/**
 * Códigos de uso humano do MFA: recovery codes e códigos de liberação de
 * cadastro. 80 bits aleatórios em 16 símbolos Crockford Base32, exibidos
 * como XXXX-XXXX-XXXX-XXXX.
 *
 * Só o hash vai ao banco: SHA-256 com domínio, formato e administrador no
 * texto. O mesmo código nunca vale em outro domínio nem para outra conta.
 */

const ALFABETO = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const BYTES = 10;
const CANONICO = /^[0-9A-HJKMNP-TV-Z]{16}$/;
const ALIASES = Object.freeze({ O: '0', I: '1', L: '1' });
const DOMINIOS = new Set(['recuperacao', 'liberacao']);
const FORMATO_HASH = 1;
const ADMINISTRADOR_ID_MAXIMO = 2147483647;
const ENTRADA_MAXIMA = 64;

function codificar(bytes) {
  let saida = '';
  let acumulado = 0;
  let bits = 0;
  for (const byte of bytes) {
    acumulado = (acumulado << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      saida += ALFABETO[(acumulado >> (bits - 5)) & 31];
      bits -= 5;
    }
    acumulado &= (1 << bits) - 1;
  }
  return saida;
}

function gerarCodigo() {
  const bytes = crypto.randomBytes(BYTES);
  return codificar(bytes).match(/.{4}/g).join('-');
}

/** Forma canônica de 16 símbolos, ou null se a entrada não for um código. */
function normalizarCodigo(entrada) {
  if (typeof entrada !== 'string' || entrada.length > ENTRADA_MAXIMA) {
    return null;
  }
  const limpo = entrada.replace(/[ \t-]/g, '');
  // Só ASCII antes de subir a caixa: evito letras de outros alfabetos que
  // viram I ou S em maiúscula.
  if (!/^[0-9A-Za-z]+$/.test(limpo)) {
    return null;
  }
  const canonico = limpo.toUpperCase().replace(/[OIL]/g, (c) => ALIASES[c]);
  return CANONICO.test(canonico) ? canonico : null;
}

function hashCodigo({ dominio, administradorId, codigo }) {
  if (!DOMINIOS.has(dominio)) {
    throw new TypeError('domínio de código MFA desconhecido');
  }
  if (!Number.isInteger(administradorId) || administradorId <= 0 || administradorId > ADMINISTRADOR_ID_MAXIMO) {
    throw new TypeError('identificador de administrador inválido');
  }
  if (typeof codigo !== 'string' || !CANONICO.test(codigo)) {
    throw new TypeError('código MFA deve chegar normalizado');
  }
  return crypto
    .createHash('sha256')
    .update(`safework|mfa|${dominio}|f${FORMATO_HASH}|a${administradorId}|${codigo}`, 'utf8')
    .digest('hex');
}

const hashCodigoRecuperacao = ({ administradorId, codigo }) => hashCodigo({ dominio: 'recuperacao', administradorId, codigo });
const hashCodigoLiberacao = ({ administradorId, codigo }) => hashCodigo({ dominio: 'liberacao', administradorId, codigo });

module.exports = {
  gerarCodigo,
  normalizarCodigo,
  hashCodigo,
  hashCodigoRecuperacao,
  hashCodigoLiberacao,
};
