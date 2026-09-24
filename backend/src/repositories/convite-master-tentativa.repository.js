'use strict';

const { chaveCooldownTemFormatoValido } = require('../security/cooldown');

/**
 * Repositório de tentativas de ACEITE de convite do MASTER e cooldown
 * (convite_master_tentativas, migration 034 — Pacote 3, adendo v2.1 §5
 * item 2). Espelho de login-tentativa-plataforma.repository.js (030) para
 * o terceiro contexto de autenticação; única diferença estrutural: o
 * vínculo opcional é `convite_id` (BIGINT, string decimal canônica no
 * driver) em vez de `administrador_id`.
 *
 * A chave de correlação é `chave_cooldown`, calculada por
 * `cooldown.gerarChaveCooldownConvite(token)`. Este módulo nunca recebe o
 * token, a senha, hash ou e-mail. Mesmas notas de RELÓGIO (`clock_timestamp()`)
 * e de ORDENAÇÃO POR id do repositório de login; depende do MESMO advisory
 * lock por chave, adquirido pelo serviço.
 */

const FORMATO_MOTIVO = /^[A-Z_]{1,30}$/;
const FORMATO_ID_CONVITE = /^[1-9][0-9]*$/;
const MOTIVO_COOLDOWN_ATIVADO = 'COOLDOWN_ATIVADO';

function exigirChaveCooldown(chaveCooldown) {
  if (!chaveCooldownTemFormatoValido(chaveCooldown)) {
    throw new TypeError('chave de cooldown com formato inválido');
  }
}

function normalizarConviteIdOpcional(valor) {
  if (valor === null || valor === undefined) {
    return null;
  }
  if (typeof valor !== 'string' || !FORMATO_ID_CONVITE.test(valor)) {
    throw new TypeError('identificador de convite inválido');
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

async function registrarTentativa(executor, {
  chaveCooldown, conviteId = null, sucesso, motivo = null, ip = null, dispositivo = null,
}) {
  exigirChaveCooldown(chaveCooldown);
  const conviteIdNormalizado = normalizarConviteIdOpcional(conviteId);
  if (typeof sucesso !== 'boolean') {
    throw new TypeError('sucesso deve ser booleano');
  }

  let motivoFinal;
  if (sucesso) {
    if (motivo !== null && motivo !== undefined) {
      throw new TypeError('tentativa bem-sucedida não pode ter motivo');
    }
    if (conviteIdNormalizado === null) {
      throw new TypeError('tentativa bem-sucedida exige convite identificado');
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
    `INSERT INTO convite_master_tentativas (chave_cooldown, convite_id, sucesso, motivo, ip, dispositivo, criado_em)
     VALUES ($1, $2, $3, $4, $5, $6, clock_timestamp())
     RETURNING id`,
    [chaveCooldown, conviteIdNormalizado, sucesso, motivoFinal, ip, dispositivo],
  );

  return rows[0].id;
}

async function registrarAtivacaoCooldown(executor, {
  chaveCooldown, cooldownAte, conviteId = null, ip = null, dispositivo = null,
}) {
  exigirChaveCooldown(chaveCooldown);
  const conviteIdNormalizado = normalizarConviteIdOpcional(conviteId);
  exigirData(cooldownAte, 'cooldownAte');

  const { rows } = await executor.query(
    `INSERT INTO convite_master_tentativas (chave_cooldown, convite_id, sucesso, motivo, cooldown_ate, ip, dispositivo, criado_em)
     VALUES ($1, $2, false, $3, $4, $5, $6, clock_timestamp())
     RETURNING id`,
    [chaveCooldown, conviteIdNormalizado, MOTIVO_COOLDOWN_ATIVADO, cooldownAte, ip, dispositivo],
  );

  return rows[0].id;
}

async function buscarCooldownVigente(executor, chaveCooldown) {
  exigirChaveCooldown(chaveCooldown);

  const { rows } = await executor.query(
    `SELECT cooldown_ate
       FROM convite_master_tentativas
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

async function contarFalhasRecentes(executor, chaveCooldown, desde) {
  exigirChaveCooldown(chaveCooldown);
  exigirData(desde, 'desde');

  const { rows } = await executor.query(
    `SELECT count(*)::int AS total
       FROM convite_master_tentativas
      WHERE chave_cooldown = $1
        AND cooldown_ate IS NULL
        AND NOT sucesso
        AND criado_em > $2::timestamptz
        AND id > COALESCE(
              (SELECT max(id) FROM convite_master_tentativas WHERE chave_cooldown = $1 AND sucesso),
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
