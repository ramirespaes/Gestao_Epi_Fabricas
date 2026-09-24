'use strict';

/**
 * Repositório de sessões do Painel Privado da plataforma (migration 028 —
 * Autenticação Global, Pacote 2). Mesmo contrato de segurança de
 * `sessao.repository.js` (013): só o SHA-256 do token chega aqui; as
 * condições de validade (revogação, expiração absoluta, inatividade,
 * `administrador.ativo`) ficam TODAS na cláusula da consulta, nunca em
 * código que examina o resultado depois.
 *
 * Sem `empresa_id`/`usuario_id`: uma sessão de plataforma não carrega
 * contexto empresarial nenhum — ver migration 028.
 */

const FORMATO_HASH = /^[0-9a-f]{64}$/;
const FORMATO_MOTIVO = /^[A-Z_]{1,30}$/;
const FORMATO_ID_SESSAO = /^[1-9][0-9]*$/;

function exigirAdministrador(administradorId) {
  if (!Number.isInteger(administradorId) || administradorId <= 0) {
    throw new TypeError('identificador de administrador inválido');
  }
}

function exigirSessao(sessaoId) {
  if (typeof sessaoId !== 'string' || !FORMATO_ID_SESSAO.test(sessaoId)) {
    throw new TypeError('identificador de sessão inválido');
  }
}

function exigirHash(tokenHash) {
  if (typeof tokenHash !== 'string' || !FORMATO_HASH.test(tokenHash)) {
    throw new TypeError('token deve chegar como hash SHA-256 hexadecimal minúsculo');
  }
}

function exigirMotivo(motivo) {
  if (typeof motivo !== 'string' || !FORMATO_MOTIVO.test(motivo)) {
    throw new TypeError('motivo de revogação inválido');
  }
}

function exigirInatividade(minutos) {
  if (!Number.isInteger(minutos) || minutos <= 0) {
    throw new TypeError('janela de inatividade inválida');
  }
}

/**
 * Cria a sessão e devolve o identificador gerado (string decimal canônica,
 * mesmo contrato de sessao.repository.criar — BIGINT IDENTITY, nunca
 * convertido para Number).
 *
 * `criado_em`/`ultimo_uso_em` usam `clock_timestamp()`, não o `DEFAULT
 * now()` da migration — mesma razão de sessao.repository.js: a criação
 * pode acontecer depois de uma verificação Argon2id, de duração variável.
 */
async function criar(executor, { administradorId, tokenHash, expiraEm, ip = null, dispositivo = null }) {
  exigirAdministrador(administradorId);
  exigirHash(tokenHash);
  if (!(expiraEm instanceof Date) || Number.isNaN(expiraEm.getTime())) {
    throw new TypeError('expira_em deve ser uma data válida');
  }

  const { rows } = await executor.query(
    `INSERT INTO sessoes_plataforma (administrador_id, token_hash, expira_em, ip, dispositivo, criado_em, ultimo_uso_em)
     VALUES ($1, $2, $3, $4, $5, clock_timestamp(), clock_timestamp())
     RETURNING id`,
    [administradorId, tokenHash, expiraEm, ip, dispositivo],
  );

  return rows[0].id;
}

/**
 * Recupera o contexto autenticado a partir do hash do token, só se a sessão
 * for válida sob todos os critérios — inclusive `administrador.ativo`:
 * inativar um administrador derruba, na próxima leitura, todas as sessões
 * dele, sem precisar revogá-las uma a uma.
 */
async function buscarValidaPorHash(executor, tokenHash, inatividadeMinutos) {
  exigirHash(tokenHash);
  exigirInatividade(inatividadeMinutos);

  const { rows } = await executor.query(
    `SELECT s.id, s.criado_em, s.expira_em, s.ultimo_uso_em,
            a.id AS administrador_id, a.email AS administrador_email
       FROM sessoes_plataforma s
       JOIN administradores_plataforma a ON a.id = s.administrador_id
      WHERE s.token_hash = $1
        AND s.revogada_em IS NULL
        AND s.expira_em > now()
        AND s.ultimo_uso_em > now() - ($2 * INTERVAL '1 minute')
        AND a.ativo`,
    [tokenHash, inatividadeMinutos],
  );

  const linha = rows[0];
  if (linha === undefined) {
    return null;
  }

  return {
    sessao: { id: linha.id, criadoEm: linha.criado_em, expiraEm: linha.expira_em, ultimoUsoEm: linha.ultimo_uso_em },
    administrador: { id: linha.administrador_id, email: linha.administrador_email },
  };
}

/** Mesma semântica de sessao.repository.registrarUso: `false` para sessão inexistente OU já vencida por qualquer critério. */
async function registrarUso(executor, sessaoId, inatividadeMinutos) {
  exigirSessao(sessaoId);
  exigirInatividade(inatividadeMinutos);

  const { rowCount } = await executor.query(
    `UPDATE sessoes_plataforma
        SET ultimo_uso_em = now()
      WHERE id = $1
        AND revogada_em IS NULL
        AND expira_em > now()
        AND ultimo_uso_em > now() - ($2 * INTERVAL '1 minute')`,
    [sessaoId, inatividadeMinutos],
  );

  return rowCount > 0;
}

/** Sem filtro de empresa (não existe, aqui): o próprio `id` da sessão já é o identificador completo. */
async function revogar(executor, sessaoId, motivo) {
  exigirSessao(sessaoId);
  exigirMotivo(motivo);

  const { rowCount } = await executor.query(
    'UPDATE sessoes_plataforma SET revogada_em = now(), motivo_revogacao = $2 WHERE id = $1 AND revogada_em IS NULL',
    [sessaoId, motivo],
  );

  return rowCount > 0;
}

module.exports = { criar, buscarValidaPorHash, registrarUso, revogar };
