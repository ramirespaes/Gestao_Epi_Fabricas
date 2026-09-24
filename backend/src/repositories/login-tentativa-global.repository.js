'use strict';

const { chaveCooldownTemFormatoValido } = require('../security/cooldown');

/**
 * Repositório de tentativas de login e cooldown do LOGIN GLOBAL do Portal
 * do Cliente (migration 036 — Autenticação Global, Pacote 4). Espelha
 * `login-tentativa-plataforma.repository.js` (030) ponto a ponto — mesma
 * forma, mesmo contrato — trocando administrador_id por identidade_id
 * (vínculo SIMPLES: identidade é global, não há "mesma empresa" a
 * proteger, então não há equivalente a `exigirVinculoValido` de 015).
 *
 * A chave de correlação é sempre `chave_cooldown`, calculada por
 * `src/security/cooldown.js` (`gerarChaveCooldownGlobal`, HMAC-SHA-256
 * sobre o rótulo 'IDENTIDADE_GLOBAL' e o e-mail normalizado). Este módulo
 * nunca recebe e-mail, senha, hash de senha, token ou cookie.
 *
 * RELÓGIO e ORDENAÇÃO POR id: idênticos a login-tentativa.repository.js —
 * `clock_timestamp()`, nunca `now()`; depende do advisory lock por chave
 * adquirido pelo serviço antes de qualquer chamada daqui.
 */

const FORMATO_MOTIVO = /^[A-Z_]{1,30}$/;
const MOTIVO_COOLDOWN_ATIVADO = 'COOLDOWN_ATIVADO';

function exigirChaveCooldown(chaveCooldown) {
  if (!chaveCooldownTemFormatoValido(chaveCooldown)) {
    throw new TypeError('chave de cooldown com formato inválido');
  }
}

function normalizarIdentidadeIdOpcional(valor) {
  if (valor === null || valor === undefined) {
    return null;
  }
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError('identificador de identidade inválido');
  }
  return valor;
}

function exigirMotivo(motivo) {
  if (typeof motivo !== 'string' || !FORMATO_MOTIVO.test(motivo)) {
    throw new TypeError('motivo inválido');
  }
}

function exigirData(valor, nomeCampo) {
  if (!(valor instanceof Date) || Number.isNaN(valor.getTime())) {
    throw new TypeError(`${nomeCampo} deve ser uma data válida`);
  }
}

/**
 * Registra uma tentativa de login global, bem-sucedida ou não.
 * Nunca grava cooldown_ate — isso é exclusivo de registrarAtivacaoCooldown.
 *
 *   sucesso = true  -> exige identidadeId, motivo deve ser nulo.
 *   sucesso = false -> exige motivo; identidadeId é opcional (e-mail
 *                       inexistente não identifica ninguém).
 *
 * @param {{query: Function}} executor
 * @param {{chaveCooldown: string, identidadeId?: number|null, sucesso: boolean,
 *          motivo?: string|null, ip?: string|null, dispositivo?: string|null}} dados
 * @returns {Promise<string>} identificador da tentativa, string decimal canônica
 */
async function registrarTentativa(executor, {
  chaveCooldown, identidadeId = null, sucesso, motivo = null, ip = null, dispositivo = null,
}) {
  exigirChaveCooldown(chaveCooldown);
  const identidadeIdNormalizado = normalizarIdentidadeIdOpcional(identidadeId);

  if (typeof sucesso !== 'boolean') {
    throw new TypeError('sucesso deve ser booleano');
  }

  let motivoFinal;
  if (sucesso) {
    if (motivo !== null && motivo !== undefined) {
      throw new TypeError('tentativa bem-sucedida não pode ter motivo');
    }
    if (identidadeIdNormalizado === null) {
      throw new TypeError('tentativa bem-sucedida exige identidade identificada');
    }
    motivoFinal = null;
  } else {
    exigirMotivo(motivo);
    if (motivo === MOTIVO_COOLDOWN_ATIVADO) {
      throw new TypeError('use registrarAtivacaoCooldown para o motivo COOLDOWN_ATIVADO');
    }
    motivoFinal = motivo;
  }

  const { rows } = await executor.query(
    `INSERT INTO login_tentativas_globais (chave_cooldown, identidade_id, sucesso, motivo, ip, dispositivo, criado_em)
     VALUES ($1, $2, $3, $4, $5, $6, clock_timestamp())
     RETURNING id`,
    [chaveCooldown, identidadeIdNormalizado, sucesso, motivoFinal, ip, dispositivo],
  );

  return rows[0].id;
}

/**
 * Registra a ativação do cooldown como linha própria — sucesso e motivo
 * são fixos e não podem ser sobrescritos pelo chamador.
 *
 * @param {{query: Function}} executor
 * @param {{chaveCooldown: string, cooldownAte: Date, identidadeId?: number|null,
 *          ip?: string|null, dispositivo?: string|null}} dados
 * @returns {Promise<string>} identificador da ativação, string decimal canônica
 */
async function registrarAtivacaoCooldown(executor, {
  chaveCooldown, cooldownAte, identidadeId = null, ip = null, dispositivo = null,
}) {
  exigirChaveCooldown(chaveCooldown);
  const identidadeIdNormalizado = normalizarIdentidadeIdOpcional(identidadeId);
  exigirData(cooldownAte, 'cooldownAte');

  const { rows } = await executor.query(
    `INSERT INTO login_tentativas_globais (chave_cooldown, identidade_id, sucesso, motivo, cooldown_ate, ip, dispositivo, criado_em)
     VALUES ($1, $2, false, $3, $4, $5, $6, clock_timestamp())
     RETURNING id`,
    [chaveCooldown, identidadeIdNormalizado, MOTIVO_COOLDOWN_ATIVADO, cooldownAte, ip, dispositivo],
  );

  return rows[0].id;
}

/**
 * Existe cooldown em vigor agora para esta chave? Mesma disciplina de
 * `clock_timestamp()` de login-tentativa.repository.js.
 *
 * @param {{query: Function}} executor
 * @param {string} chaveCooldown
 * @returns {Promise<{ativoAte: Date}|null>}
 */
async function buscarCooldownVigente(executor, chaveCooldown) {
  exigirChaveCooldown(chaveCooldown);

  const { rows } = await executor.query(
    `SELECT cooldown_ate
       FROM login_tentativas_globais
      WHERE chave_cooldown = $1
        AND cooldown_ate IS NOT NULL
        AND cooldown_ate > clock_timestamp()
      ORDER BY cooldown_ate DESC
      LIMIT 1`,
    [chaveCooldown],
  );

  const linha = rows[0];
  return linha === undefined ? null : { ativoAte: linha.cooldown_ate };
}

/**
 * Conta falhas reais (exclui ativações de cooldown) desde `desde`, sempre
 * desprezando o que aconteceu antes ou junto do último sucesso da mesma
 * chave — mesma regra e mesma ordenação por `id` de
 * login-tentativa.repository.js.
 *
 * @param {{query: Function}} executor
 * @param {string} chaveCooldown
 * @param {Date} desde
 * @returns {Promise<number>}
 */
async function contarFalhasRecentes(executor, chaveCooldown, desde) {
  exigirChaveCooldown(chaveCooldown);
  exigirData(desde, 'desde');

  const { rows } = await executor.query(
    `SELECT count(*)::int AS total
       FROM login_tentativas_globais
      WHERE chave_cooldown = $1
        AND cooldown_ate IS NULL
        AND NOT sucesso
        AND criado_em > $2::timestamptz
        AND id > COALESCE(
              (SELECT max(id) FROM login_tentativas_globais WHERE chave_cooldown = $1 AND sucesso),
              -1
            )`,
    [chaveCooldown, desde],
  );

  return rows[0].total;
}

module.exports = {
  MOTIVO_COOLDOWN_ATIVADO,
  registrarTentativa,
  registrarAtivacaoCooldown,
  buscarCooldownVigente,
  contarFalhasRecentes,
};
