'use strict';

const crypto = require('node:crypto');

/**
 * TOTP de referência para os testes (RFC 6238, SHA1, 6 dígitos, 30 s),
 * escrito só com node:crypto: o código que o "aplicativo autenticador" do
 * teste digita não sai da mesma biblioteca que o servidor usa para validar.
 */

const ALFABETO_BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Decodifica a chave manual (base32 sem padding, com ou sem espaços). */
function segredoDaChaveManual(chaveManual) {
  let bits = '';
  for (const caractere of chaveManual.replace(/\s+/g, '')) {
    const valor = ALFABETO_BASE32.indexOf(caractere);
    if (valor === -1) throw new TypeError('chave manual fora do base32');
    bits += valor.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function stepDe(instanteMs) {
  return Math.floor(instanteMs / 30_000);
}

function codigoDoStep(segredo, step) {
  const contador = Buffer.alloc(8);
  contador.writeBigUInt64BE(BigInt(step));
  const hmac = crypto.createHmac('sha1', segredo).update(contador).digest();
  const deslocamento = hmac[hmac.length - 1] & 0x0f;
  const binario = hmac.readUInt32BE(deslocamento) & 0x7fffffff;
  return String(binario % 1_000_000).padStart(6, '0');
}

function codigoAgora(chaveManual, instanteMs = Date.now()) {
  return codigoDoStep(segredoDaChaveManual(chaveManual), stepDe(instanteMs));
}

module.exports = { segredoDaChaveManual, stepDe, codigoDoStep, codigoAgora };
