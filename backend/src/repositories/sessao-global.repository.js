'use strict';

/**
 * Repositório de sessões GLOBAIS (sessoes_globais, migration 035 —
 * Autenticação Global, Pacote 4).
 *
 * Espelha `sessao-plataforma.repository.js` ponto a ponto, trocando
 * administrador_id por identidade_id. Mesma disciplina de
 * `sessao.repository.js`: só o SHA-256 do token chega aqui (formato da
 * constraint: 64 hex minúsculos); as condições de validade ficam DENTRO da
 * consulta (revogação, expiração absoluta, inatividade, identidades.ativo),
 * nunca em código que examina a linha depois.
 *
 * SEM empresa_id/usuario_id em lugar nenhum: uma sessão global identifica a
 * PESSOA, não um vínculo. O contexto empresarial é sempre `sessoes` (013),
 * criado pelo serviço de seleção de empresa depois de revalidar o vínculo.
 *
 * O executor chega por parâmetro; o pool nunca é importado.
 */

const FORMATO_HASH = /^[0-9a-f]{64}$/;
const FORMATO_MOTIVO = /^[A-Z_]{1,30}$/;
// BIGINT IDENTITY: o driver devolve string decimal; mesmo contrato de
// sessao.repository.js (nunca converter para Number).
const FORMATO_ID_SESSAO = /^[1-9][0-9]*$/;

function exigirIdentidade(identidadeId) {
  if (!Number.isInteger(identidadeId) || identidadeId <= 0) {
    throw new TypeError('identificador de identidade inválido');
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
 * Cria a sessão global e devolve o identificador (string decimal canônica).
 * `criado_em`/`ultimo_uso_em` usam `clock_timestamp()` — a criação acontece
 * depois de uma verificação Argon2id de duração variável (mesma razão de
 * sessao.repository.js).
 */
async function criar(executor, { identidadeId, tokenHash, expiraEm, ip = null, dispositivo = null }) {
  exigirIdentidade(identidadeId);
  exigirHash(tokenHash);
  if (!(expiraEm instanceof Date) || Number.isNaN(expiraEm.getTime())) {
    throw new TypeError('expira_em deve ser uma data válida');
  }

  const { rows } = await executor.query(
    `INSERT INTO sessoes_globais (identidade_id, token_hash, expira_em, ip, dispositivo, criado_em, ultimo_uso_em)
     VALUES ($1, $2, $3, $4, $5, clock_timestamp(), clock_timestamp())
     RETURNING id`,
    [identidadeId, tokenHash, expiraEm, ip, dispositivo],
  );

  return rows[0].id;
}

/**
 * Recupera a identidade autenticada a partir do hash do token, só se a
 * sessão for válida sob todos os critérios — inclusive `identidades.ativo`:
 * inativar a identidade derruba, na próxima leitura, todas as sessões
 * globais dela (e o trigger da migration 035 ainda as marca revogadas).
 *
 * @returns {Promise<{sessao: {id: string, criadoEm: Date, expiraEm: Date, ultimoUsoEm: Date},
 *          identidade: {id: number, email: string}}|null>}
 */
async function buscarValidaPorHash(executor, tokenHash, inatividadeMinutos) {
  exigirHash(tokenHash);
  exigirInatividade(inatividadeMinutos);

  const { rows } = await executor.query(
    `SELECT s.id, s.criado_em, s.expira_em, s.ultimo_uso_em,
            i.id AS identidade_id, i.email AS identidade_email
       FROM sessoes_globais s
       JOIN identidades i ON i.id = s.identidade_id
      WHERE s.token_hash = $1
        AND s.revogada_em IS NULL
        AND s.expira_em > now()
        AND s.ultimo_uso_em > now() - ($2 * INTERVAL '1 minute')
        AND i.ativo`,
    [tokenHash, inatividadeMinutos],
  );

  const linha = rows[0];
  if (linha === undefined) {
    return null;
  }

  return {
    sessao: { id: linha.id, criadoEm: linha.criado_em, expiraEm: linha.expira_em, ultimoUsoEm: linha.ultimo_uso_em },
    identidade: { id: linha.identidade_id, email: linha.identidade_email },
  };
}

/** Mesma semântica de sessao.repository.registrarUso: `false` para sessão inexistente OU já vencida. */
async function registrarUso(executor, sessaoId, inatividadeMinutos) {
  exigirSessao(sessaoId);
  exigirInatividade(inatividadeMinutos);

  const { rowCount } = await executor.query(
    `UPDATE sessoes_globais
        SET ultimo_uso_em = now()
      WHERE id = $1
        AND revogada_em IS NULL
        AND expira_em > now()
        AND ultimo_uso_em > now() - ($2 * INTERVAL '1 minute')`,
    [sessaoId, inatividadeMinutos],
  );

  return rowCount > 0;
}

/**
 * Trava (FOR UPDATE) a linha da sessão global, só se ela ainda estiver
 * válida (não revogada, não expirada) — usada DENTRO da transação de
 * seleção/troca de empresa para SERIALIZAR seleções concorrentes do mesmo
 * login global (duas abas clicando ao mesmo tempo) e para não criar sessão
 * empresarial a partir de uma global revogada entre o middleware e a
 * transação. Devolve true/false; nunca lança por sessão inválida.
 */
async function bloquearValida(executor, sessaoId) {
  exigirSessao(sessaoId);

  const { rows } = await executor.query(
    `SELECT id FROM sessoes_globais
      WHERE id = $1 AND revogada_em IS NULL AND expira_em > now()
      FOR UPDATE`,
    [sessaoId],
  );

  return rows.length === 1;
}

/** O próprio `id` já é o identificador completo (não há empresa aqui). */
async function revogar(executor, sessaoId, motivo) {
  exigirSessao(sessaoId);
  exigirMotivo(motivo);

  const { rowCount } = await executor.query(
    'UPDATE sessoes_globais SET revogada_em = now(), motivo_revogacao = $2 WHERE id = $1 AND revogada_em IS NULL',
    [sessaoId, motivo],
  );

  return rowCount > 0;
}

module.exports = { criar, buscarValidaPorHash, registrarUso, bloquearValida, revogar };
