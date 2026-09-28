'use strict';

const validacao = require('./validacao-mfa');

/**
 * Fatores MFA da plataforma (migration 049). Só primitivas de persistência:
 * travas, ordem das operações e decisões de fluxo são do serviço.
 *
 * O secret chega aqui sempre cifrado, no envelope de security/mfa-cripto.js.
 * Mudança de estado é sempre UPDATE condicional com o administrador na
 * cláusula; revogar apaga nonce e ciphertext na mesma instrução. Prazos e
 * instantes vêm do relógio do banco (clock_timestamp()).
 */

const UUID_CANONICO = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NONCE_BYTES = 12;
const SEGREDO_CIFRADO_BYTES = 36;
const VERSAO_MAXIMA = 9999;

const COLUNAS = `id, fator_uid, administrador_id, tipo, estado, totp_formato_versao, totp_chave_versao,
       totp_nonce, totp_segredo_cifrado, totp_ultimo_step_aceito, criado_em, pendente_expira_em,
       (estado = 'PENDENTE' AND pendente_expira_em > clock_timestamp()) AS pendente_vigente, ativado_em`;

const versaoValida = (v) => Number.isInteger(v) && v >= 1 && v <= VERSAO_MAXIMA;

function exigirFatorUid(fatorUid) {
  if (typeof fatorUid !== 'string' || !UUID_CANONICO.test(fatorUid)) {
    throw new TypeError('identificador de fator inválido');
  }
}

function exigirEnvelope(envelope) {
  if (envelope === null || typeof envelope !== 'object') {
    throw new TypeError('envelope cifrado ausente');
  }
  const { formatoVersao, chaveVersao, nonce, segredoCifrado } = envelope;
  if (!versaoValida(formatoVersao) || !versaoValida(chaveVersao)) {
    throw new TypeError('versão de formato ou de chave inválida');
  }
  if (!Buffer.isBuffer(nonce) || nonce.length !== NONCE_BYTES) {
    throw new TypeError('nonce fora do formato');
  }
  if (!Buffer.isBuffer(segredoCifrado) || segredoCifrado.length !== SEGREDO_CIFRADO_BYTES) {
    throw new TypeError('secret cifrado fora do formato');
  }
}

function exigirStep(step) {
  if (!Number.isSafeInteger(step) || step < 0) {
    throw new TypeError('step TOTP inválido');
  }
}

function paraFator(linha) {
  return {
    id: linha.id,
    fatorUid: linha.fator_uid,
    administradorId: linha.administrador_id,
    tipo: linha.tipo,
    estado: linha.estado,
    formatoVersao: linha.totp_formato_versao,
    chaveVersao: linha.totp_chave_versao,
    nonce: linha.totp_nonce,
    segredoCifrado: linha.totp_segredo_cifrado,
    // BIGINT chega como texto; o repositório só grava inteiros seguros.
    ultimoStepAceito: linha.totp_ultimo_step_aceito === null ? null : Number(linha.totp_ultimo_step_aceito),
    criadoEm: linha.criado_em,
    pendenteExpiraEm: linha.pendente_expira_em,
    pendenteVigente: linha.pendente_vigente,
    ativadoEm: linha.ativado_em,
  };
}

/**
 * Cria o fator TOTP PENDENTE. criado_em e o prazo saem do mesmo instante do
 * banco. Se já houver PENDENTE para o administrador, o índice único recusa
 * (23505): revogar o anterior é decisão de quem chama.
 */
async function criarPendenteTotp(executor, { administradorId, fatorUid, envelope, validadeMinutos }) {
  validacao.exigirAdministrador(administradorId);
  exigirFatorUid(fatorUid);
  exigirEnvelope(envelope);
  validacao.exigirMinutos(validadeMinutos);

  const { rows } = await executor.query(
    `WITH agora AS (SELECT clock_timestamp() AS t)
     INSERT INTO fatores_mfa_plataforma
       (administrador_id, fator_uid, tipo, estado, totp_formato_versao, totp_chave_versao, totp_nonce,
        totp_segredo_cifrado, totp_algoritmo, totp_digitos, totp_periodo, criado_em, pendente_expira_em)
     VALUES ($1, $2, 'TOTP', 'PENDENTE', $3, $4, $5, $6, 'SHA1', 6, 30,
             (SELECT t FROM agora), (SELECT t FROM agora) + ($7 * INTERVAL '1 minute'))
     RETURNING id, fator_uid, criado_em, pendente_expira_em`,
    [administradorId, fatorUid, envelope.formatoVersao, envelope.chaveVersao, envelope.nonce, envelope.segredoCifrado, validadeMinutos],
  );

  const linha = rows[0];
  return { id: linha.id, fatorUid: linha.fator_uid, criadoEm: linha.criado_em, pendenteExpiraEm: linha.pendente_expira_em };
}

async function buscarUm(executor, condicao, valores, travar) {
  const { rows } = await executor.query(
    `SELECT ${COLUNAS}
       FROM fatores_mfa_plataforma
      WHERE ${condicao}${travar ? '\n      FOR UPDATE' : ''}`,
    valores,
  );
  return rows[0] === undefined ? null : paraFator(rows[0]);
}

async function buscarTotpAtivo(executor, administradorId, opcoes) {
  validacao.exigirAdministrador(administradorId);
  const travar = validacao.travarPedido(opcoes);
  return buscarUm(executor, "administrador_id = $1 AND tipo = 'TOTP' AND estado = 'ATIVO'", [administradorId], travar);
}

/** O PENDENTE, vencido ou não: pendenteVigente diz se o prazo ainda vale. */
async function buscarTotpPendente(executor, administradorId, opcoes) {
  validacao.exigirAdministrador(administradorId);
  const travar = validacao.travarPedido(opcoes);
  return buscarUm(executor, "administrador_id = $1 AND tipo = 'TOTP' AND estado = 'PENDENTE'", [administradorId], travar);
}

async function buscarPorId(executor, { administradorId, fatorId }, opcoes) {
  validacao.exigirAdministrador(administradorId);
  validacao.exigirId(fatorId, 'fator');
  const travar = validacao.travarPedido(opcoes);
  return buscarUm(executor, 'id = $1 AND administrador_id = $2', [fatorId, administradorId], travar);
}

/**
 * PENDENTE dentro do prazo vira ATIVO, já com o step do código que o
 * confirmou. Havendo outro ATIVO, o índice único recusa (23505): a ordem
 * "revoga o antigo, ativa o novo" é de quem chama.
 */
async function ativarTotp(executor, { administradorId, fatorId, step }) {
  validacao.exigirAdministrador(administradorId);
  validacao.exigirId(fatorId, 'fator');
  exigirStep(step);

  const { rowCount } = await executor.query(
    `UPDATE fatores_mfa_plataforma
        SET estado = 'ATIVO', ativado_em = clock_timestamp(), totp_ultimo_step_aceito = $3
      WHERE id = $1 AND administrador_id = $2 AND tipo = 'TOTP' AND estado = 'PENDENTE'
        AND pendente_expira_em > clock_timestamp()`,
    [fatorId, administradorId, step],
  );
  return rowCount === 1;
}

/** Anti-replay: só avança para um step maior. false = replay ou fator não ATIVO. */
async function registrarStepAceito(executor, { administradorId, fatorId, step }) {
  validacao.exigirAdministrador(administradorId);
  validacao.exigirId(fatorId, 'fator');
  exigirStep(step);

  const { rowCount } = await executor.query(
    `UPDATE fatores_mfa_plataforma
        SET totp_ultimo_step_aceito = $3
      WHERE id = $1 AND administrador_id = $2 AND tipo = 'TOTP' AND estado = 'ATIVO'
        AND (totp_ultimo_step_aceito IS NULL OR totp_ultimo_step_aceito < $3)`,
    [fatorId, administradorId, step],
  );
  return rowCount === 1;
}

async function revogar(executor, { administradorId, fatorId, motivo }) {
  validacao.exigirAdministrador(administradorId);
  validacao.exigirId(fatorId, 'fator');
  validacao.exigirMotivo(motivo);

  const { rowCount } = await executor.query(
    `UPDATE fatores_mfa_plataforma
        SET estado = 'REVOGADO', revogado_em = clock_timestamp(), motivo_revogacao = $3,
            totp_nonce = NULL, totp_segredo_cifrado = NULL
      WHERE id = $1 AND administrador_id = $2 AND estado IN ('PENDENTE', 'ATIVO')`,
    [fatorId, administradorId, motivo],
  );
  return rowCount === 1;
}

async function revogarPendenteTotp(executor, { administradorId, motivo }) {
  validacao.exigirAdministrador(administradorId);
  validacao.exigirMotivo(motivo);

  const { rowCount } = await executor.query(
    `UPDATE fatores_mfa_plataforma
        SET estado = 'REVOGADO', revogado_em = clock_timestamp(), motivo_revogacao = $2,
            totp_nonce = NULL, totp_segredo_cifrado = NULL
      WHERE administrador_id = $1 AND tipo = 'TOTP' AND estado = 'PENDENTE'`,
    [administradorId, motivo],
  );
  return rowCount;
}

module.exports = {
  criarPendenteTotp,
  buscarTotpAtivo,
  buscarTotpPendente,
  buscarPorId,
  ativarTotp,
  registrarStepAceito,
  revogar,
  revogarPendenteTotp,
};
