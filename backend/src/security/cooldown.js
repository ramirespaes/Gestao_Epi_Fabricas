'use strict';

const crypto = require('node:crypto');
const { obterLoginCooldownHmacSecret } = require('../config/auth');
const { normalizarCnpj, normalizarEmail } = require('../utils/normalizacao');

/**
 * Chave opaca de cooldown (contrato da migration 015):
 *   HMAC-SHA-256(segredo, cnpj_normalizado || 0x0A || email_normalizado)
 * em hexadecimal minúsculo, 64 caracteres (CHECK ^[0-9a-f]{64}$).
 *
 * - CNPJ e e-mail são SEMPRE normalizados por utils/normalizacao antes do
 *   HMAC, então entrada bruta ou já normalizada produz a mesma chave. Este
 *   módulo não conhece o formato do CNPJ nem do e-mail.
 * - Exige apenas ESTRUTURA canônica do CNPJ (normalizarCnpj). Os dígitos
 *   verificadores NÃO são validados aqui, de propósito: um CNPJ
 *   estruturalmente válido com DV matematicamente inválido também gera uma
 *   chave determinística, para que o controle de tentativas se comporte de
 *   forma uniforme para identidades existentes e inexistentes.
 * - O separador 0x0A nunca ocorre nos valores normalizados (CNPJ é [0-9A-Z],
 *   e-mail é ASCII visível), o que torna a decomposição da mensagem única
 *   sem depender de largura fixa.
 * - O segredo vem só de obterLoginCooldownHmacSecret(); a cópia é zerada
 *   após o uso e nunca fica em variável de módulo.
 * - Senha, hash, token e cookie nunca participam da composição.
 * - Nada aqui loga, persiste, executa SQL ou toma lock. As mensagens de erro
 *   são fixas e nunca incluem CNPJ, e-mail, chave ou segredo.
 *
 * ADVISORY LOCK (CLAUDE.md, seção 20): o service de login serializa as
 * tentativas da mesma chave com
 *   SELECT pg_advisory_xact_lock($1::bigint)
 * usando derivarAdvisoryLock64(chave): os 8 primeiros bytes do digest lidos
 * como int64 big-endian com sinal, devolvidos em string decimal porque
 * Number só preserva 53 bits. O intervalo coincide com o bigint do
 * PostgreSQL (-2^63 .. 2^63-1).
 *
 * CORRELAÇÃO (CLAUDE.md, seção 24): idCorrelacaoCooldown(chave) devolve os
 * 16 primeiros caracteres hex, EXCLUSIVAMENTE para correlação interna de
 * logs técnicos. Não deve ir em resposta HTTP, não substitui a chave
 * completa em persistência e não serve para derivar advisory lock.
 */

const CHAVE_COOLDOWN_TAMANHO = 64;
const CHAVE_COOLDOWN_FORMATO = /^[0-9a-f]{64}$/;
const SEPARADOR = '\n';
const LOCK_BYTES = 8;
const CORRELACAO_HEX = 16;
// Rótulo de domínio do cooldown do Painel Privado (correção final do
// Pacote 2 — Autenticação Global): separa criptograficamente o espaço de
// chaves da plataforma do espaço de chaves do cliente, mesmo sob o MESMO
// segredo HMAC. Não é sigiloso — só evita que, em tese, uma chave de
// plataforma e uma chave de cliente pudessem colidir. Maiúsculo e sem
// caracteres possíveis num CNPJ normalizado (14 posições exatas) ou num
// e-mail normalizado (contém '@'), então as três mensagens de entrada
// (cliente, plataforma, qualquer outra futura) nunca podem ser confundidas
// por concatenação.
const ROTULO_PLATAFORMA = 'PLATAFORMA';
// Rótulo do terceiro contexto: aceite de convite do MASTER (Pacote 3,
// adendo v2.1 §5 item 2). Mesma razão do rótulo acima — espaço de chaves
// próprio, sob o mesmo segredo, sem colisão possível com os outros dois.
const ROTULO_CONVITE_MASTER = 'CONVITE_MASTER';
const TOKEN_CONVITE_FORMATO = /^[A-Za-z0-9_-]{43}$/;

function gerarChaveCooldown(cnpj, email) {
  const cnpjNormalizado = normalizarCnpj(cnpj);
  if (cnpjNormalizado === null) {
    throw new TypeError('cnpj não normalizável');
  }
  const emailNormalizado = normalizarEmail(email);
  if (emailNormalizado === null) {
    throw new TypeError('e-mail não normalizável');
  }

  const segredo = obterLoginCooldownHmacSecret();
  try {
    return crypto
      .createHmac('sha256', segredo)
      .update(cnpjNormalizado, 'utf8')
      .update(SEPARADOR, 'utf8')
      .update(emailNormalizado, 'utf8')
      .digest('hex');
  } finally {
    segredo.fill(0);
  }
}

/**
 * Chave opaca de cooldown do Painel Privado da plataforma (correção final
 * do Pacote 2, migration 030): mesma construção HMAC-SHA-256, mas sem
 * CNPJ — o login administrativo não depende de empresa alguma. A mensagem
 * é ROTULO_PLATAFORMA || 0x0A || email_normalizado, para que a chave de um
 * administrador nunca coincida com a de nenhum usuário empresarial, mesmo
 * que o mesmo endereço de e-mail exista nos dois contextos.
 */
function gerarChaveCooldownPlataforma(email) {
  const emailNormalizado = normalizarEmail(email);
  if (emailNormalizado === null) {
    throw new TypeError('e-mail não normalizável');
  }

  const segredo = obterLoginCooldownHmacSecret();
  try {
    return crypto
      .createHmac('sha256', segredo)
      .update(ROTULO_PLATAFORMA, 'utf8')
      .update(SEPARADOR, 'utf8')
      .update(emailNormalizado, 'utf8')
      .digest('hex');
  } finally {
    segredo.fill(0);
  }
}

/**
 * Chave opaca de cooldown do ACEITE DE CONVITE do MASTER (Pacote 3,
 * migration 034): HMAC-SHA-256 sobre ROTULO_CONVITE_MASTER || 0x0A || o
 * TOKEN do convite em claro. Derivada do token, não de CNPJ+e-mail (adendo
 * v2.1 §5 item 2): não há CNPJ nessa tela, e é exatamente o token que um
 * atacante teria em mãos — cada link recebe seu próprio contador de
 * tentativas. O token em claro nunca é persistido: só este HMAC (que não é
 * reversível sem o segredo) chega à tabela convite_master_tentativas.
 *
 * Exige o formato canônico do token (43 caracteres base64url, mesmo
 * contrato de src/security/token.js): qualquer outra coisa é TypeError fixo,
 * sem o valor — um "token" malformado nem chega a ganhar chave.
 */
function gerarChaveCooldownConvite(tokenConvite) {
  if (typeof tokenConvite !== 'string' || !TOKEN_CONVITE_FORMATO.test(tokenConvite)) {
    throw new TypeError('token de convite com formato inválido');
  }

  const segredo = obterLoginCooldownHmacSecret();
  try {
    return crypto
      .createHmac('sha256', segredo)
      .update(ROTULO_CONVITE_MASTER, 'utf8')
      .update(SEPARADOR, 'utf8')
      .update(tokenConvite, 'utf8')
      .digest('hex');
  } finally {
    segredo.fill(0);
  }
}

/** true somente para string de 64 hex minúsculos. Nunca lança. */
function chaveCooldownTemFormatoValido(chave) {
  return typeof chave === 'string' && CHAVE_COOLDOWN_FORMATO.test(chave);
}

function exigirChave(chave) {
  if (!chaveCooldownTemFormatoValido(chave)) {
    throw new TypeError('chave de cooldown com formato inválido');
  }
}

/** Primeiros 8 bytes do digest como int64 com sinal, em string decimal. */
function derivarAdvisoryLock64(chave) {
  exigirChave(chave);
  return Buffer.from(chave.slice(0, LOCK_BYTES * 2), 'hex').readBigInt64BE(0).toString();
}

/**
 * Primeiros 16 hex da chave. SOMENTE para correlação interna de logs
 * técnicos: nunca em resposta HTTP, nunca no lugar da chave completa em
 * persistência, nunca como base de advisory lock.
 */
function idCorrelacaoCooldown(chave) {
  exigirChave(chave);
  return chave.slice(0, CORRELACAO_HEX);
}

module.exports = {
  CHAVE_COOLDOWN_TAMANHO,
  gerarChaveCooldown,
  gerarChaveCooldownPlataforma,
  gerarChaveCooldownConvite,
  chaveCooldownTemFormatoValido,
  derivarAdvisoryLock64,
  idCorrelacaoCooldown,
};
