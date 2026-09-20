'use strict';

/**
 * Repositório de sessões.
 *
 * A sessão é a fonte da identidade autenticada. Tudo que o restante do
 * sistema sabe sobre quem está pedindo sai daqui, nunca de um identificador
 * enviado pelo navegador.
 *
 * Só o SHA-256 do token chega a este módulo. O token em claro existe apenas
 * no instante da emissão, na camada acima, e jamais é persistido, consultado
 * ou registrado. O formato exigido é o mesmo da constraint da migration 013:
 * 64 caracteres hexadecimais minúsculos.
 *
 * As condições de validade ficam dentro da consulta, e não em código que
 * examina o resultado depois. Revogação, expiração absoluta, inatividade e
 * situação do usuário e da empresa entram todas na cláusula de filtro, de
 * modo que uma sessão inválida simplesmente não é encontrada. Isso evita a
 * classe de defeito em que alguém obtém a linha e esquece de conferir um dos
 * critérios.
 *
 * A junção com usuarios usa o par (empresa_id, id), o mesmo da chave
 * estrangeira composta fk_sessoes_usuario_mesma_empresa. O banco já impede
 * que uma sessão aponte para usuário de outra empresa, e a consulta repete a
 * condição para que a leitura também não dependa apenas dessa garantia.
 *
 * Geração de token, emissão de cookie e resposta HTTP não pertencem aqui.
 */

const FORMATO_HASH = /^[0-9a-f]{64}$/;
// Cada formato espelha o CHECK e o VARCHAR da própria coluna em 013_create_sessoes.sql:
// autenticado_via é VARCHAR(20) com CHECK de formato; motivo_revogacao é VARCHAR(30).
const FORMATO_AUTENTICADO_VIA = /^[A-Z_]{1,20}$/;
const FORMATO_MOTIVO = /^[A-Z_]{1,30}$/;

// sessoes.id é BIGINT GENERATED ALWAYS AS IDENTITY. O driver `pg` devolve
// colunas int8 como string, não como number, justamente para não truncar
// valores acima de Number.MAX_SAFE_INTEGER. O repositório adota essa mesma
// representação como contrato público: aceita e devolve o identificador de
// sessão como string decimal canônica (sem sinal, sem zero à esquerda,
// coerente com o menor valor possível da IDENTITY, que começa em 1) e nunca
// converte para Number, o que poderia perder precisão silenciosamente.
const FORMATO_ID_SESSAO = /^[1-9][0-9]*$/;

const CAMPOS_SESSAO = Object.freeze([
  'usuario_nome', 'usuario_email', 'usuario_perfil', 'empresa_nome', 'empresa_cnpj',
]);

function exigirEmpresa(empresaId) {
  if (!Number.isInteger(empresaId) || empresaId <= 0) {
    throw new TypeError('identificador de empresa inválido');
  }
}

function exigirUsuario(usuarioId) {
  if (!Number.isInteger(usuarioId) || usuarioId <= 0) {
    throw new TypeError('identificador de usuário inválido');
  }
}

function exigirSessao(sessaoId) {
  if (typeof sessaoId !== 'string' || !FORMATO_ID_SESSAO.test(sessaoId)) {
    throw new TypeError('identificador de sessão inválido');
  }
}

/**
 * Recusa qualquer coisa que não seja o digest. Um token em claro tem 43
 * caracteres em base64url e não passa por aqui, o que impede que ele chegue
 * ao banco por engano.
 */
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
 * Cria a sessão e devolve o identificador gerado.
 *
 * O vínculo com a empresa não é informativo: a chave estrangeira composta
 * recusa a inserção se o usuário pertencer a outra contratante.
 *
 * `criado_em` e `ultimo_uso_em` usam `clock_timestamp()` explicitamente, em
 * vez do `DEFAULT now()` da migration 013: `now()` representa o início da
 * transação, e a chamada a `criar()` pode acontecer bem depois disso —
 * depois de esperar um advisory lock e de uma verificação Argon2id, ambos
 * de duração variável (ver `src/repositories/login-tentativa.repository.js`,
 * nota de RELÓGIO). `clock_timestamp()` reflete o instante real da própria
 * inserção, para que `ultimo_uso_em` represente de fato o início do uso da
 * sessão, não um instante anterior congelado pela transação. `expira_em`
 * continua vindo do chamador (parâmetro `expiraEm`), que deve calculá-lo a
 * partir de um `clock_timestamp()` obtido próximo deste chamado, pelo mesmo
 * motivo.
 *
 * @param {{query: Function}} executor
 * @param {{empresaId: number, usuarioId: number, tokenHash: string, expiraEm: Date,
 *          autenticadoVia?: string, ip?: string|null, dispositivo?: string|null}} dados
 * @returns {Promise<string>} o identificador da sessão, como string decimal
 *   canônica — o mesmo formato devolvido pelo driver `pg` para a coluna
 *   BIGINT, preservado sem conversão para Number.
 */
async function criar(executor, { empresaId, usuarioId, tokenHash, expiraEm, autenticadoVia = 'SENHA', ip = null, dispositivo = null }) {
  exigirEmpresa(empresaId);
  exigirUsuario(usuarioId);
  exigirHash(tokenHash);
  if (!(expiraEm instanceof Date) || Number.isNaN(expiraEm.getTime())) {
    throw new TypeError('expira_em deve ser uma data válida');
  }
  if (typeof autenticadoVia !== 'string' || !FORMATO_AUTENTICADO_VIA.test(autenticadoVia)) {
    throw new TypeError('forma de autenticação inválida');
  }

  const { rows } = await executor.query(
    `INSERT INTO sessoes (empresa_id, usuario_id, token_hash, expira_em, autenticado_via, ip, dispositivo, criado_em, ultimo_uso_em)
     VALUES ($1, $2, $3, $4, $5, $6, $7, clock_timestamp(), clock_timestamp())
     RETURNING id`,
    [empresaId, usuarioId, tokenHash, expiraEm, autenticadoVia, ip, dispositivo],
  );

  return rows[0].id;
}

/**
 * Recupera o contexto autenticado a partir do hash do token, apenas se a
 * sessão for válida sob todos os critérios.
 *
 * @param {{query: Function}} executor
 * @param {string} tokenHash
 * @param {number} inatividadeMinutos
 * @returns {Promise<{sessao: {id: string, criadoEm: Date, expiraEm: Date, ultimoUsoEm: Date},
 *          usuario: object, empresa: object}|null>} `sessao.id` chega como
 *   string decimal canônica, no mesmo formato exigido por `registrarUso` e
 *   `revogar` — não é convertido para Number.
 */
async function buscarValidaPorHash(executor, tokenHash, inatividadeMinutos) {
  exigirHash(tokenHash);
  exigirInatividade(inatividadeMinutos);

  const { rows } = await executor.query(
    `SELECT s.id, s.empresa_id, s.usuario_id, s.criado_em, s.expira_em, s.ultimo_uso_em,
            u.nome AS usuario_nome, u.email AS usuario_email, u.perfil AS usuario_perfil,
            e.nome AS empresa_nome, e.cnpj AS empresa_cnpj
       FROM sessoes s
       JOIN usuarios u ON u.empresa_id = s.empresa_id AND u.id = s.usuario_id
       JOIN empresas e ON e.id = s.empresa_id
      WHERE s.token_hash = $1
        AND s.revogada_em IS NULL
        AND s.expira_em > now()
        AND s.ultimo_uso_em > now() - ($2 * INTERVAL '1 minute')
        AND u.ativo
        AND e.ativo`,
    [tokenHash, inatividadeMinutos],
  );

  const linha = rows[0];
  if (linha === undefined) {
    return null;
  }

  return {
    sessao: {
      id: linha.id,
      criadoEm: linha.criado_em,
      expiraEm: linha.expira_em,
      ultimoUsoEm: linha.ultimo_uso_em,
    },
    usuario: {
      id: linha.usuario_id,
      nome: linha.usuario_nome,
      email: linha.usuario_email,
      perfil: linha.usuario_perfil,
    },
    empresa: {
      id: linha.empresa_id,
      nome: linha.empresa_nome,
      cnpj: linha.empresa_cnpj,
    },
  };
}

/**
 * Marca uso da sessão, sob os mesmos critérios de validade aplicados pela
 * leitura em `buscarValidaPorHash`: revogação, expiração absoluta e
 * inatividade entram na cláusula do UPDATE, não em código que decide depois
 * se deveria ter atualizado. Uma sessão revogada, expirada ou já vencida
 * por inatividade não tem `ultimo_uso_em` renovado por esta função, mesmo
 * que seja chamada isoladamente, sem uma leitura prévia bem-sucedida.
 *
 * Devolve `false` tanto para "sessão inexistente" quanto para "sessão
 * existe mas está vencida" — a distinção não importa aqui. O serviço de
 * autenticação deve tratar esse `false` como falha de validação da sessão.
 *
 * @param {{query: Function}} executor
 * @param {string} sessaoId identificador de sessão, string decimal canônica
 * @param {number} inatividadeMinutos
 * @returns {Promise<boolean>}
 */
async function registrarUso(executor, sessaoId, inatividadeMinutos) {
  exigirSessao(sessaoId);
  exigirInatividade(inatividadeMinutos);

  const { rowCount } = await executor.query(
    `UPDATE sessoes
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
 * Revoga uma sessão da empresa. O filtro de empresa não é redundante: sem
 * ele, conhecer um identificador bastaria para derrubar a sessão de outra
 * contratante.
 */
async function revogar(executor, empresaId, sessaoId, motivo) {
  exigirEmpresa(empresaId);
  exigirSessao(sessaoId);
  exigirMotivo(motivo);

  const { rowCount } = await executor.query(
    `UPDATE sessoes SET revogada_em = now(), motivo_revogacao = $3
      WHERE empresa_id = $1 AND id = $2 AND revogada_em IS NULL`,
    [empresaId, sessaoId, motivo],
  );

  return rowCount > 0;
}

/**
 * Revoga todas as sessões ativas de um usuário dentro da empresa, e devolve
 * quantas foram atingidas. Usada em logout global e em troca de senha.
 */
async function revogarDoUsuario(executor, empresaId, usuarioId, motivo) {
  exigirEmpresa(empresaId);
  exigirUsuario(usuarioId);
  exigirMotivo(motivo);

  const { rowCount } = await executor.query(
    `UPDATE sessoes SET revogada_em = now(), motivo_revogacao = $3
      WHERE empresa_id = $1 AND usuario_id = $2 AND revogada_em IS NULL`,
    [empresaId, usuarioId, motivo],
  );

  return rowCount;
}

module.exports = {
  criar,
  buscarValidaPorHash,
  registrarUso,
  revogar,
  revogarDoUsuario,
  CAMPOS_SESSAO,
};
