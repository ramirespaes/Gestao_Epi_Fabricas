'use strict';

const { chaveCooldownTemFormatoValido } = require('../security/cooldown');

/**
 * Repositório de tentativas de login e cooldown do Painel Privado da
 * plataforma (migration 030 — correção final do Pacote 2, item 1).
 * Espelha `login-tentativa.repository.js` (015) ponto a ponto, com uma
 * única diferença estrutural: `administrador_id` é um vínculo SIMPLES
 * (não composto — não existe "mesma empresa" a proteger aqui), então não
 * há equivalente a `exigirVinculoValido`.
 *
 * A chave de correlação é sempre `chave_cooldown`, calculada por
 * `src/security/cooldown.js` (`gerarChaveCooldownPlataforma`, HMAC-SHA-256
 * sobre o rótulo 'PLATAFORMA' e o e-mail normalizado). Este módulo nunca
 * recebe e-mail, senha, hash de senha, token ou cookie.
 *
 * As mesmas notas de RELÓGIO e de ORDENAÇÃO POR id documentadas em
 * login-tentativa.repository.js se aplicam aqui, sem alteração: usa
 * `clock_timestamp()`, nunca `now()`; depende do MESMO advisory lock por
 * chave, adquirido pelo serviço antes de chamar qualquer função deste
 * módulo — este repositório não adquire lock algum.
 */

const FORMATO_MOTIVO = /^[A-Z_]{1,30}$/;
const MOTIVO_COOLDOWN_ATIVADO = 'COOLDOWN_ATIVADO';

function exigirChaveCooldown(chaveCooldown) {
  if (!chaveCooldownTemFormatoValido(chaveCooldown)) {
    throw new TypeError('chave de cooldown com formato inválido');
  }
}

function normalizarAdministradorIdOpcional(valor) {
  if (valor === null || valor === undefined) {
    return null;
  }
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError('identificador de administrador inválido');
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
 * Registra uma tentativa de login administrativo, bem-sucedida ou não.
 * Nunca grava cooldown_ate — isso é exclusivo de registrarAtivacaoCooldown.
 *
 *   sucesso = true  -> exige administradorId, motivo deve ser nulo.
 *   sucesso = false -> exige motivo; administradorId é opcional (e-mail
 *                       inexistente não identifica ninguém).
 *
 * @param {{query: Function}} executor
 * @param {{chaveCooldown: string, administradorId?: number|null, sucesso: boolean,
 *          motivo?: string|null, ip?: string|null, dispositivo?: string|null}} dados
 * @returns {Promise<string>} identificador da tentativa, string decimal canônica
 */
async function registrarTentativa(executor, {
  chaveCooldown, administradorId = null, sucesso, motivo = null, ip = null, dispositivo = null,
}) {
  exigirChaveCooldown(chaveCooldown);
  const administradorIdNormalizado = normalizarAdministradorIdOpcional(administradorId);

  if (typeof sucesso !== 'boolean') {
    throw new TypeError('sucesso deve ser booleano');
  }

  let motivoFinal;
  if (sucesso) {
    if (motivo !== null && motivo !== undefined) {
      throw new TypeError('tentativa bem-sucedida não pode ter motivo');
    }
    if (administradorIdNormalizado === null) {
      throw new TypeError('tentativa bem-sucedida exige administrador identificado');
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
    `INSERT INTO login_tentativas_plataforma (chave_cooldown, administrador_id, sucesso, motivo, ip, dispositivo, criado_em)
     VALUES ($1, $2, $3, $4, $5, $6, clock_timestamp())
     RETURNING id`,
    [chaveCooldown, administradorIdNormalizado, sucesso, motivoFinal, ip, dispositivo],
  );

  return rows[0].id;
}

/**
 * Registra a ativação do cooldown como linha própria — sucesso e motivo
 * são fixos e não podem ser sobrescritos pelo chamador.
 *
 * @param {{query: Function}} executor
 * @param {{chaveCooldown: string, cooldownAte: Date, administradorId?: number|null,
 *          ip?: string|null, dispositivo?: string|null}} dados
 * @returns {Promise<string>} identificador da ativação, string decimal canônica
 */
async function registrarAtivacaoCooldown(executor, {
  chaveCooldown, cooldownAte, administradorId = null, ip = null, dispositivo = null,
}) {
  exigirChaveCooldown(chaveCooldown);
  const administradorIdNormalizado = normalizarAdministradorIdOpcional(administradorId);
  exigirData(cooldownAte, 'cooldownAte');

  const { rows } = await executor.query(
    `INSERT INTO login_tentativas_plataforma (chave_cooldown, administrador_id, sucesso, motivo, cooldown_ate, ip, dispositivo, criado_em)
     VALUES ($1, $2, false, $3, $4, $5, $6, clock_timestamp())
     RETURNING id`,
    [chaveCooldown, administradorIdNormalizado, MOTIVO_COOLDOWN_ATIVADO, cooldownAte, ip, dispositivo],
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
       FROM login_tentativas_plataforma
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
       FROM login_tentativas_plataforma
      WHERE chave_cooldown = $1
        AND cooldown_ate IS NULL
        AND NOT sucesso
        AND criado_em > $2::timestamptz
        AND id > COALESCE(
              (SELECT max(id) FROM login_tentativas_plataforma WHERE chave_cooldown = $1 AND sucesso),
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
