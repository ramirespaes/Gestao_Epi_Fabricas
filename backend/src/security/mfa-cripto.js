'use strict';

const crypto = require('node:crypto');
const { mfaConfig, obterChaveMfa } = require('../config/mfa');

/**
 * Proteção em repouso do secret TOTP: AES-256-GCM com nonce aleatório de
 * 96 bits, tag de 128 bits e AAD que amarra o ciphertext ao administrador,
 * ao fator e às versões de formato e de chave. Formato 1: secret bruto de 20
 * bytes, guardado como ciphertext (20 bytes) seguido da tag (16 bytes).
 *
 * Toda falha (chave ausente, envelope fora do formato, tag inválida) vira
 * ErroCriptografiaMfa, sem detalhe no texto. Quem chama nunca pode tratá-la
 * como "MFA não configurado".
 */

const ALGORITMO = 'aes-256-gcm';
const FORMATO_VERSAO_ATUAL = 1;
const CHAVE_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const SEGREDO_BYTES = 20;
const VERSAO_MAXIMA = 9999;
const ADMINISTRADOR_ID_MAXIMO = 2147483647;
// Só a forma canônica (minúsculas, RFC 4122): uma representação por fator.
const UUID_CANONICO = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const MOTIVOS = Object.freeze({
  CHAVE_INDISPONIVEL: 'CHAVE_INDISPONIVEL',
  ENVELOPE_INVALIDO: 'ENVELOPE_INVALIDO',
  AUTENTICACAO_FALHOU: 'AUTENTICACAO_FALHOU',
});

class ErroCriptografiaMfa extends Error {
  constructor(motivo) {
    super('falha na proteção criptográfica do fator MFA');
    this.name = 'ErroCriptografiaMfa';
    this.codigo = 'MFA_CRIPTOGRAFIA_INDISPONIVEL';
    this.motivo = motivo;
  }
}

const versaoValida = (v) => Number.isInteger(v) && v >= 1 && v <= VERSAO_MAXIMA;

function montarAad({ formatoVersao, chaveVersao, administradorId, fatorUid }) {
  if (!versaoValida(formatoVersao) || !versaoValida(chaveVersao)) {
    throw new TypeError('versão de formato ou de chave inválida');
  }
  if (!Number.isInteger(administradorId) || administradorId <= 0 || administradorId > ADMINISTRADOR_ID_MAXIMO) {
    throw new TypeError('identificador de administrador inválido');
  }
  if (typeof fatorUid !== 'string' || !UUID_CANONICO.test(fatorUid)) {
    throw new TypeError('identificador de fator inválido');
  }
  // Cada campo tem prefixo fixo e alfabeto sem '|': a junção não é ambígua.
  return Buffer.from(`safework|mfa|totp-segredo|f${formatoVersao}|k${chaveVersao}|a${administradorId}|u${fatorUid}`, 'ascii');
}

function criarCriptografiaMfa({ obterChave, versaoAtual }) {
  if (typeof obterChave !== 'function') {
    throw new TypeError('obterChave ausente');
  }
  if (!versaoValida(versaoAtual)) {
    throw new TypeError('versão atual de chave inválida');
  }

  // Peço só a versão indicada; qualquer falha aqui é chave indisponível.
  function chaveDaVersao(versao) {
    let chave;
    try {
      chave = obterChave(versao);
    } catch {
      throw new ErroCriptografiaMfa(MOTIVOS.CHAVE_INDISPONIVEL);
    }
    if (!Buffer.isBuffer(chave) || chave.length !== CHAVE_BYTES) {
      if (Buffer.isBuffer(chave)) chave.fill(0);
      throw new ErroCriptografiaMfa(MOTIVOS.CHAVE_INDISPONIVEL);
    }
    return chave;
  }

  // Confere, sem cifrar nada, que a chave da versão atual está utilizável:
  // quem vai cifrar chama antes de abrir transação.
  function garantirChaveAtual() {
    chaveDaVersao(versaoAtual).fill(0);
  }

  function cifrarSegredoTotp({ segredo, administradorId, fatorUid }) {
    if (!Buffer.isBuffer(segredo) || segredo.length !== SEGREDO_BYTES) {
      throw new TypeError('secret TOTP deve ter 20 bytes');
    }
    const aad = montarAad({ formatoVersao: FORMATO_VERSAO_ATUAL, chaveVersao: versaoAtual, administradorId, fatorUid });
    const chave = chaveDaVersao(versaoAtual);
    try {
      const nonce = crypto.randomBytes(NONCE_BYTES);
      const cifra = crypto.createCipheriv(ALGORITMO, chave, nonce, { authTagLength: TAG_BYTES });
      cifra.setAAD(aad);
      const cifrado = Buffer.concat([cifra.update(segredo), cifra.final()]);
      return {
        formatoVersao: FORMATO_VERSAO_ATUAL,
        chaveVersao: versaoAtual,
        nonce,
        segredoCifrado: Buffer.concat([cifrado, cifra.getAuthTag()]),
      };
    } finally {
      chave.fill(0);
    }
  }

  function decifrarSegredoTotp({ administradorId, fatorUid, formatoVersao, chaveVersao, nonce, segredoCifrado }) {
    // Envelope fora do formato 1 é recusado antes de qualquer chave.
    if (formatoVersao !== FORMATO_VERSAO_ATUAL || !versaoValida(chaveVersao)
      || !Buffer.isBuffer(nonce) || nonce.length !== NONCE_BYTES
      || !Buffer.isBuffer(segredoCifrado) || segredoCifrado.length !== SEGREDO_BYTES + TAG_BYTES) {
      throw new ErroCriptografiaMfa(MOTIVOS.ENVELOPE_INVALIDO);
    }
    const aad = montarAad({ formatoVersao, chaveVersao, administradorId, fatorUid });
    const chave = chaveDaVersao(chaveVersao);
    try {
      const decifra = crypto.createDecipheriv(ALGORITMO, chave, nonce, { authTagLength: TAG_BYTES });
      decifra.setAAD(aad);
      decifra.setAuthTag(segredoCifrado.subarray(SEGREDO_BYTES));
      return Buffer.concat([decifra.update(segredoCifrado.subarray(0, SEGREDO_BYTES)), decifra.final()]);
    } catch {
      throw new ErroCriptografiaMfa(MOTIVOS.AUTENTICACAO_FALHOU);
    } finally {
      chave.fill(0);
    }
  }

  return { garantirChaveAtual, cifrarSegredoTotp, decifrarSegredoTotp };
}

const padrao = criarCriptografiaMfa({ obterChave: obterChaveMfa, versaoAtual: mfaConfig.chaveVersaoAtual });

module.exports = {
  criarCriptografiaMfa,
  garantirChaveAtual: padrao.garantirChaveAtual,
  cifrarSegredoTotp: padrao.cifrarSegredoTotp,
  decifrarSegredoTotp: padrao.decifrarSegredoTotp,
  montarAad,
  ErroCriptografiaMfa,
  MOTIVOS,
  FORMATO_VERSAO_ATUAL,
};
