'use strict';

const crypto = require('node:crypto');
const OTPAuth = require('otpauth');

/**
 * Único ponto da aplicação que conhece a biblioteca otpauth. TOTP do RFC
 * 6238 com parâmetros fixos: SHA1, 6 dígitos, 30 s e janela de ±1 step.
 *
 * validarCodigo não guarda estado nem consulta relógio: o instante vem de
 * quem chama, e o anti-replay (step > ultimo_step_aceito) é da persistência.
 * Nenhum objeto da biblioteca sai deste módulo.
 */

const PARAMETROS = Object.freeze({
  algoritmo: 'SHA1',
  digitos: 6,
  periodoSegundos: 30,
  janela: 1,
  emissor: 'SafeWork',
  segredoBytes: 20,
});

const CODIGO_FORMATO = /^[0-9]{6}$/;
const CARACTERE_CONTROLE = /\p{Cc}/u;

function exigirSegredo(segredo) {
  if (!Buffer.isBuffer(segredo) || segredo.length !== PARAMETROS.segredoBytes) {
    throw new TypeError('secret TOTP deve ter 20 bytes');
  }
}

// Entrego à biblioteca uma cópia com ArrayBuffer próprio: o Buffer recebido
// pode ser uma fatia de um pool compartilhado.
function segredoDaBiblioteca(segredo) {
  return new OTPAuth.Secret({ buffer: new Uint8Array(segredo).buffer });
}

function gerarSegredo() {
  return crypto.randomBytes(PARAMETROS.segredoBytes);
}

function montarUriCadastro({ segredo, email }) {
  exigirSegredo(segredo);
  if (typeof email !== 'string' || email.trim() === '' || CARACTERE_CONTROLE.test(email)) {
    throw new TypeError('e-mail do rótulo inválido');
  }
  const totp = new OTPAuth.TOTP({
    issuer: PARAMETROS.emissor,
    label: email,
    algorithm: PARAMETROS.algoritmo,
    digits: PARAMETROS.digitos,
    period: PARAMETROS.periodoSegundos,
    secret: segredoDaBiblioteca(segredo),
  });
  return totp.toString();
}

/** Base32 (RFC 4648, sem padding) em grupos de 4 para digitação manual. */
function chaveManual(segredo) {
  exigirSegredo(segredo);
  return segredoDaBiblioteca(segredo).base32.match(/.{1,4}/g).join(' ');
}

/**
 * @returns {{step: number} | null} o step do código aceito, ou null.
 */
function validarCodigo({ segredo, codigo, instanteMs }) {
  exigirSegredo(segredo);
  // Sem instante explícito a biblioteca usaria Date.now(); aqui isso é erro.
  if (!Number.isSafeInteger(instanteMs) || instanteMs < 0) {
    throw new TypeError('instante obrigatório, em milissegundos inteiros');
  }
  if (typeof codigo !== 'string' || !CODIGO_FORMATO.test(codigo)) {
    return null;
  }
  const delta = OTPAuth.TOTP.validate({
    token: codigo,
    secret: segredoDaBiblioteca(segredo),
    algorithm: PARAMETROS.algoritmo,
    digits: PARAMETROS.digitos,
    period: PARAMETROS.periodoSegundos,
    timestamp: instanteMs,
    window: PARAMETROS.janela,
  });
  if (delta === null) {
    return null;
  }
  return { step: OTPAuth.TOTP.counter({ period: PARAMETROS.periodoSegundos, timestamp: instanteMs }) + delta };
}

module.exports = {
  PARAMETROS,
  gerarSegredo,
  montarUriCadastro,
  chaveManual,
  validarCodigo,
};
