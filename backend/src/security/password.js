'use strict';

const crypto = require('node:crypto');
const argon2 = require('argon2');
const { authConfig } = require('../config/auth');

/**
 * Hash e verificação de senha com Argon2id.
 *
 * - Tipo fixo argon2id. memoryCost, timeCost, parallelism e hashLength vêm
 *   de authConfig.argon2 (configuração escolhida pelo projeto; ver auth.js).
 * - Salt aleatório de 16 bytes gerado pela biblioteca a cada hash.
 * - A saída é uma string PHC ('$argon2id$v=19$m=...,t=...,p=...$salt$hash'),
 *   único valor que vai para usuarios.senha_hash.
 * - Senha e hash são dados sensíveis: nada aqui loga, e nenhuma mensagem de
 *   erro inclui senha, hash ou trecho deles.
 * - Este módulo não aplica política de senha (ver password-policy.js) e não
 *   acessa banco, requisição ou sessão.
 *
 * NORMALIZAÇÃO UNICODE DA SENHA (decisão deliberada)
 * Antes de hash e de verificação a senha recebe SOMENTE senha.normalize('NFC'),
 * para que a mesma senha digitada em teclados/sistemas que emitem NFD ou NFC
 * produza os mesmos bytes. Nenhuma outra transformação é aplicada: sem trim,
 * sem alteração de maiúsculas/minúsculas, sem remoção de espaços, sem
 * NFKC/NFKD. Maiúsculas, minúsculas e espaços fazem parte da senha.
 * password-policy.js deve avaliar a mesma representação NFC.
 */

const OPCOES_ARGON2 = Object.freeze({
  type: argon2.argon2id,
  memoryCost: authConfig.argon2.memoryKib,
  timeCost: authConfig.argon2.timeCost,
  parallelism: authConfig.argon2.parallelism,
  hashLength: authConfig.argon2.hashLength,
});

const ARGON2_VERSAO = 19;
const ALEATORIO_FICTICIO_BYTES = 32;

/** Lançado quando o hash armazenado não é um Argon2id bem formado. */
class HashSenhaCorrompidoError extends Error {
  constructor(causa) {
    super('hash de senha armazenado não é um Argon2id válido', causa ? { cause: causa } : undefined);
    this.name = 'HashSenhaCorrompidoError';
  }
}

function prepararSenha(senha) {
  if (typeof senha !== 'string' || senha.length === 0) {
    throw new TypeError('senha deve ser uma string não vazia');
  }
  return senha.normalize('NFC');
}

function exigirStringHash(senhaHash) {
  if (typeof senhaHash !== 'string' || senhaHash.length === 0) {
    throw new TypeError('senhaHash deve ser uma string não vazia');
  }
}

/**
 * Parser estrito da string PHC. Devolve { m, t, p, tamanhoHash } para um
 * Argon2id versão 19 bem formado, ou null para qualquer outra coisa.
 * A ordem dos parâmetros m, t e p pode variar entre implementações.
 */
function analisarHashArgon2id(senhaHash) {
  const partes = senhaHash.split('$');
  if (partes.length !== 6 || partes[0] !== '' || partes[1] !== 'argon2id') {
    return null;
  }
  if (partes[2] !== `v=${ARGON2_VERSAO}`) {
    return null;
  }
  const params = {};
  for (const item of partes[3].split(',')) {
    const [nome, valor] = item.split('=');
    if (!/^[mtp]$/.test(nome) || !/^[1-9][0-9]*$/.test(valor) || nome in params) {
      return null;
    }
    params[nome] = Number(valor);
  }
  if (!('m' in params) || !('t' in params) || !('p' in params)) {
    return null;
  }
  const base64 = /^[A-Za-z0-9+/]+$/;
  if (!base64.test(partes[4]) || !base64.test(partes[5])) {
    return null;
  }
  return { ...params, tamanhoHash: Buffer.from(partes[5], 'base64').length };
}

async function gerarHashSenha(senha) {
  return argon2.hash(prepararSenha(senha), OPCOES_ARGON2);
}

/**
 * true somente se senhaHash for um Argon2id PHC bem formado e a senha
 * conferir. Hash malformado, de outro tipo ou rejeitado pela biblioteca
 * lança HashSenhaCorrompidoError (problema de integridade, não do cliente).
 *
 * Hash Argon2id LEGADO com parâmetros diferentes dos atuais (inclusive
 * outro hashLength) é verificado normalmente; após sucesso, precisaRehash()
 * devolve true e o fluxo de login pode regravá-lo. O tamanho do digest não
 * é usado para detectar truncamento: um digest curto é indistinguível de um
 * hash legado válido, e nesse caso a biblioteca apenas devolve false.
 */
async function verificarSenha(senhaHash, senha) {
  exigirStringHash(senhaHash);
  const senhaPreparada = prepararSenha(senha);
  if (analisarHashArgon2id(senhaHash) === null) {
    throw new HashSenhaCorrompidoError();
  }
  try {
    return await argon2.verify(senhaHash, senhaPreparada);
  } catch (erro) {
    throw new HashSenhaCorrompidoError(erro);
  }
}

/**
 * true quando o hash deve ser regravado com os parâmetros atuais:
 * não é Argon2id v19, memória ou tempo ABAIXO da configuração, paralelismo
 * ou tamanho de hash DIFERENTES. Hashes com parâmetros iguais ou mais fortes
 * continuam válidos e não pedem rehash.
 */
function precisaRehash(senhaHash) {
  exigirStringHash(senhaHash);
  const atual = analisarHashArgon2id(senhaHash);
  if (atual === null) {
    return true;
  }
  return atual.m < OPCOES_ARGON2.memoryCost
    || atual.t < OPCOES_ARGON2.timeCost
    || atual.p !== OPCOES_ARGON2.parallelism
    || atual.tamanhoHash !== OPCOES_ARGON2.hashLength;
}

/**
 * HASH FICTÍCIO
 * Gerado UMA vez por processo a partir de 32 bytes aleatórios, com os mesmos
 * parâmetros do hash real, e reutilizado em todas as verificações contra
 * usuário/empresa inexistente. Vive só em memória, muda a cada reinício,
 * nunca é persistido nem logado. O bloco de login chama
 * prepararHashFicticio() na inicialização para pagar o custo fora de
 * requisição; se ninguém chamar, a primeira obtenção prepara e memoriza.
 *
 * Chamadas concorrentes compartilham a mesma Promise, portanto há no máximo
 * uma geração em andamento. Se a geração falhar, o estado interno é limpo
 * para que uma chamada posterior tente de novo; o módulo nunca fica preso a
 * uma Promise rejeitada.
 */
let hashFicticioPromise = null;

function iniciarGeracaoFicticia() {
  const aleatorio = crypto.randomBytes(ALEATORIO_FICTICIO_BYTES).toString('base64url');
  const geracao = argon2.hash(aleatorio, OPCOES_ARGON2).catch((erro) => {
    if (hashFicticioPromise === geracao) {
      hashFicticioPromise = null;
    }
    throw erro;
  });
  hashFicticioPromise = geracao;
  return geracao;
}

// Devolve sempre a MESMA promise compartilhada (nunca uma derivada
// descartável), para que uma falha de geração seja tratada por quem chamou
// e jamais vire rejeição não tratada.
function obterHashFicticio() {
  return hashFicticioPromise ?? iniciarGeracaoFicticia();
}

async function prepararHashFicticio() {
  await obterHashFicticio();
}

/**
 * Executa uma verificação Argon2id real contra o hash fictício e devolve
 * SEMPRE false. Usada quando não há usuário, para que o custo seja o mesmo
 * de verificarSenha() com usuário existente.
 */
async function verificarSenhaContraFicticio(senha) {
  const senhaPreparada = prepararSenha(senha);
  await argon2.verify(await obterHashFicticio(), senhaPreparada);
  return false;
}

module.exports = {
  HashSenhaCorrompidoError,
  gerarHashSenha,
  verificarSenha,
  verificarSenhaContraFicticio,
  precisaRehash,
  prepararHashFicticio,
  obterHashFicticio,
};
