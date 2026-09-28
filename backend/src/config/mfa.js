'use strict';

const { somenteDefinidas, congelarProfundo } = require('./ambiente');
const { obterLoginCooldownHmacSecret } = require('./auth');

/**
 * Chaves AES-256-GCM que protegem o secret TOTP dos administradores da
 * plataforma: MFA_TOTP_KEY_V<n> (64 hex = 32 bytes) por versão, e a
 * cifragem usa sempre MFA_TOTP_KEY_CURRENT_VERSION. Sem padrão e sem
 * fallback: configuração incompleta impede a subida.
 *
 * Guardo as chaves só na closure deste módulo. O objeto público tem apenas
 * as versões; obterChaveMfa devolve uma cópia da versão pedida, e só dela.
 */

const PREFIXO_CHAVE = 'MFA_TOTP_KEY_V';
const VARIAVEL_VERSAO_ATUAL = 'MFA_TOTP_KEY_CURRENT_VERSION';
const VERSAO_FORMATO = /^[1-9][0-9]{0,3}$/;
const CHAVE_FORMATO = /^[0-9a-fA-F]{64}$/;

// Regras fixas: nenhuma mensagem de erro inclui valor recebido.
const REGRAS = Object.freeze({
  OBRIGATORIA: 'obrigatória',
  VERSAO: 'deve ser um inteiro de 1 a 9999, sem zeros à esquerda',
  NOME_VERSAO: 'nome de versão inválido: use MFA_TOTP_KEY_V1 a MFA_TOTP_KEY_V9999',
  CHAVE: 'deve ter 64 caracteres hexadecimais (32 bytes)',
  CHAVE_ATUAL_AUSENTE: 'ausente: é a chave da versão atual',
  REPETIDA: 'repete a chave de outra versão',
  IGUAL_COOLDOWN: 'não pode ser igual a LOGIN_COOLDOWN_HMAC_SECRET',
});

class ErroChaveMfaIndisponivel extends Error {
  constructor() {
    super('chave MFA indisponível para a versão solicitada');
    this.name = 'ErroChaveMfaIndisponivel';
    this.codigo = 'MFA_CHAVE_INDISPONIVEL';
  }
}

function descartar(chaves) {
  for (const chave of chaves.values()) chave.fill(0);
}

function analisarConfigMfa(origem, { segredoCooldown }) {
  if (!Buffer.isBuffer(segredoCooldown)) {
    throw new TypeError('segredo do cooldown ausente');
  }
  const e = somenteDefinidas(origem);
  const problemas = [];
  const chaves = new Map();

  for (const [nome, valor] of Object.entries(e)) {
    if (!nome.startsWith(PREFIXO_CHAVE)) continue;
    const sufixo = nome.slice(PREFIXO_CHAVE.length);
    if (!VERSAO_FORMATO.test(sufixo)) {
      problemas.push(`${nome}: ${REGRAS.NOME_VERSAO}`);
    } else if (!CHAVE_FORMATO.test(valor)) {
      problemas.push(`${nome}: ${REGRAS.CHAVE}`);
    } else {
      chaves.set(Number(sufixo), Buffer.from(valor, 'hex'));
    }
  }

  const versoes = [...chaves.keys()].sort((a, b) => a - b);
  versoes.forEach((versao, i) => {
    const chave = chaves.get(versao);
    if (versoes.slice(0, i).some((anterior) => chaves.get(anterior).equals(chave))) {
      problemas.push(`${PREFIXO_CHAVE}${versao}: ${REGRAS.REPETIDA}`);
    }
    if (chave.equals(segredoCooldown)) {
      problemas.push(`${PREFIXO_CHAVE}${versao}: ${REGRAS.IGUAL_COOLDOWN}`);
    }
  });

  const textoVersaoAtual = e[VARIAVEL_VERSAO_ATUAL];
  let versaoAtual = null;
  if (textoVersaoAtual === undefined) {
    problemas.push(`${VARIAVEL_VERSAO_ATUAL}: ${REGRAS.OBRIGATORIA}`);
  } else if (!VERSAO_FORMATO.test(textoVersaoAtual)) {
    problemas.push(`${VARIAVEL_VERSAO_ATUAL}: ${REGRAS.VERSAO}`);
  } else {
    versaoAtual = Number(textoVersaoAtual);
    if (e[`${PREFIXO_CHAVE}${versaoAtual}`] === undefined) {
      problemas.push(`${PREFIXO_CHAVE}${versaoAtual}: ${REGRAS.CHAVE_ATUAL_AUSENTE}`);
    }
  }

  if (problemas.length > 0) {
    descartar(chaves);
    throw new Error(`Configuração MFA inválida:\n  - ${problemas.join('\n  - ')}`);
  }

  return {
    config: congelarProfundo({ chaveVersaoAtual: versaoAtual, versoesDisponiveis: versoes }),
    chaves,
  };
}

/**
 * Valida um ambiente arbitrário e devolve só a configuração pública. Existe
 * para testes; as chaves desse ambiente são zeradas e descartadas.
 */
function carregarConfigMfa(origem = process.env, { segredoCooldown } = {}) {
  const segredo = segredoCooldown ?? obterLoginCooldownHmacSecret();
  const { config, chaves } = analisarConfigMfa(origem, { segredoCooldown: segredo });
  descartar(chaves);
  return config;
}

// Carga única, na subida do processo.
const segredoCooldownNaCarga = obterLoginCooldownHmacSecret();
const carregado = analisarConfigMfa(process.env, { segredoCooldown: segredoCooldownNaCarga });
segredoCooldownNaCarga.fill(0);

const mfaConfig = carregado.config;
const chavesInternas = carregado.chaves;

/** Cópia defensiva da chave da versão pedida; versão sem chave falha fechado. */
function obterChaveMfa(versao) {
  const chave = Number.isInteger(versao) ? chavesInternas.get(versao) : undefined;
  if (chave === undefined) {
    throw new ErroChaveMfaIndisponivel();
  }
  return Buffer.from(chave);
}

module.exports = {
  mfaConfig,
  obterChaveMfa,
  carregarConfigMfa,
  ErroChaveMfaIndisponivel,
};
