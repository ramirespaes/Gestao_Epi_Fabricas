'use strict';

const crypto = require('node:crypto');

/**
 * Token opaco de sessão (contrato da migration 013).
 *
 * - 32 bytes de crypto.randomBytes (256 bits de entropia), serializados em
 *   base64url sem padding: exatamente 43 caracteres em [A-Za-z0-9_-], que
 *   cabem em cookie e cabeçalho sem escape.
 * - O banco recebe apenas SHA-256(token) em hexadecimal minúsculo, 64
 *   caracteres, em sessoes.token_hash (CHAR(64), UNIQUE, CHECK ^[0-9a-f]{64}$).
 *   O token em claro existe só no cookie e na memória da requisição que o
 *   gerou ou recebeu; nunca em banco, log, auditoria ou mensagem de erro.
 * - Sem salt e sem HMAC: a entrada já é aleatória de 256 bits, e a busca de
 *   sessão é por igualdade do hash no índice único. Por isso também não há
 *   comparação em memória neste módulo e timingSafeEqual não se aplica aqui.
 *
 * FORMATO CANÔNICO
 * 32 bytes ocupam 256 bits; 43 caracteres base64url carregam 258. Os 2 bits
 * finais do último caractere devem ser zero, senão quatro textos distintos
 * decodificariam para os mesmos bytes. A validação exige regex, decodificação
 * em exatamente 32 bytes e reencode idêntico ao texto recebido, de modo que
 * cada token tenha uma única representação aceita.
 *
 * Este módulo não emite cookie, não cria sessão, não acessa banco e não loga.
 */

const TOKEN_BYTES = 32;
const TOKEN_TAMANHO = 43;
const TOKEN_HASH_TAMANHO = 64;
const TOKEN_FORMATO = /^[A-Za-z0-9_-]{43}$/;

function gerarTokenSessao() {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

/** true somente para string no formato canônico. Nunca lança. */
function tokenSessaoTemFormatoValido(token) {
  if (typeof token !== 'string' || !TOKEN_FORMATO.test(token)) {
    return false;
  }
  const bytes = Buffer.from(token, 'base64url');
  return bytes.length === TOKEN_BYTES && bytes.toString('base64url') === token;
}

/**
 * SHA-256 hex minúsculo (64 chars), único valor que vai ao banco.
 * Aceita somente token canônico; qualquer outra entrada lança TypeError com
 * mensagem fixa, antes de calcular o hash. O middleware deve chamar
 * tokenSessaoTemFormatoValido() antes e tratar formato inválido como
 * ausência de sessão, sem chegar ao banco.
 */
function hashTokenSessao(token) {
  if (!tokenSessaoTemFormatoValido(token)) {
    throw new TypeError('token de sessão com formato inválido');
  }
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

module.exports = {
  TOKEN_BYTES,
  TOKEN_TAMANHO,
  TOKEN_HASH_TAMANHO,
  gerarTokenSessao,
  tokenSessaoTemFormatoValido,
  hashTokenSessao,
};
