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
  'usuario_nome', 'usuario_email', 'usuario_perfil', 'usuario_identidade_id', 'empresa_nome', 'empresa_cnpj',
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
 * `sessaoGlobalId` (Pacote 4, migration 037): de qual sessão global esta
 * sessão empresarial nasceu — informado SÓ pelo serviço de seleção de
 * empresa. Ausente/null (login legado por CNPJ, chamadores anteriores ao
 * Pacote 4), a coluna nem entra no INSERT: assinatura e SQL de antes
 * permanecem idênticos para quem não a usa.
 *
 * @param {{query: Function}} executor
 * @param {{empresaId: number, usuarioId: number, tokenHash: string, expiraEm: Date,
 *          autenticadoVia?: string, ip?: string|null, dispositivo?: string|null,
 *          sessaoGlobalId?: string|null}} dados
 * @returns {Promise<string>} o identificador da sessão, como string decimal
 *   canônica — o mesmo formato devolvido pelo driver `pg` para a coluna
 *   BIGINT, preservado sem conversão para Number.
 */
async function criar(executor, {
  empresaId, usuarioId, tokenHash, expiraEm, autenticadoVia = 'SENHA', ip = null, dispositivo = null, sessaoGlobalId = null,
}) {
  exigirEmpresa(empresaId);
  exigirUsuario(usuarioId);
  exigirHash(tokenHash);
  if (!(expiraEm instanceof Date) || Number.isNaN(expiraEm.getTime())) {
    throw new TypeError('expira_em deve ser uma data válida');
  }
  if (typeof autenticadoVia !== 'string' || !FORMATO_AUTENTICADO_VIA.test(autenticadoVia)) {
    throw new TypeError('forma de autenticação inválida');
  }
  if (sessaoGlobalId !== null && (typeof sessaoGlobalId !== 'string' || !FORMATO_ID_SESSAO.test(sessaoGlobalId))) {
    throw new TypeError('identificador de sessão global inválido');
  }

  const { rows } = sessaoGlobalId === null
    ? await executor.query(
      `INSERT INTO sessoes (empresa_id, usuario_id, token_hash, expira_em, autenticado_via, ip, dispositivo, criado_em, ultimo_uso_em)
       VALUES ($1, $2, $3, $4, $5, $6, $7, clock_timestamp(), clock_timestamp())
       RETURNING id`,
      [empresaId, usuarioId, tokenHash, expiraEm, autenticadoVia, ip, dispositivo],
    )
    : await executor.query(
      `INSERT INTO sessoes (empresa_id, usuario_id, token_hash, expira_em, autenticado_via, ip, dispositivo, sessao_global_id, criado_em, ultimo_uso_em)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, clock_timestamp(), clock_timestamp())
       RETURNING id`,
      [empresaId, usuarioId, tokenHash, expiraEm, autenticadoVia, ip, dispositivo, sessaoGlobalId],
    );

  return rows[0].id;
}

/**
 * Recupera o contexto autenticado a partir do hash do token, apenas se a
 * sessão for válida sob todos os critérios.
 *
 * IDENTIDADE GLOBAL (Pacote 4, adendo v2.1 §1.4 e §4.1): `LEFT JOIN
 * identidades` — LEFT, não INNER, porque `usuarios.identidade_id` é
 * nulável (vínculo do modelo anterior não tem identidade e não pode ser
 * derrubado por essa checagem). Duas consequências:
 *   - `usuario.email` passa a vir de `identidades.email` quando o vínculo
 *     tem identidade (a fonte de verdade do e-mail), e de `usuarios.email`
 *     só para o modelo anterior — COALESCE(i.email, u.email);
 *   - uma identidade INATIVA derruba, na próxima requisição, TODAS as
 *     sessões empresariais dela, em todas as empresas —
 *     `(u.identidade_id IS NULL OR i.ativo)` entra no filtro, junto de
 *     usuarios.ativo e empresas.ativo, nunca em código posterior.
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
            u.nome AS usuario_nome, COALESCE(i.email, u.email) AS usuario_email, u.perfil AS usuario_perfil,
            u.identidade_id AS usuario_identidade_id,
            COALESCE(i.senha_provisoria, false) AS senha_provisoria,
            EXISTS (SELECT 1 FROM usuario_ips_permitidos p WHERE p.empresa_id = u.empresa_id AND p.usuario_id = u.id) AS restricao_ip,
            e.nome AS empresa_nome, e.cnpj AS empresa_cnpj
       FROM sessoes s
       JOIN usuarios u ON u.empresa_id = s.empresa_id AND u.id = s.usuario_id
       JOIN empresas e ON e.id = s.empresa_id
       LEFT JOIN identidades i ON i.id = u.identidade_id
      WHERE s.token_hash = $1
        AND s.revogada_em IS NULL
        AND s.expira_em > now()
        AND s.ultimo_uso_em > now() - ($2 * INTERVAL '1 minute')
        AND u.ativo
        AND e.ativo
        AND (u.identidade_id IS NULL OR i.ativo)`,
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
      identidadeId: linha.usuario_identidade_id ?? null,
    },
    empresa: {
      id: linha.empresa_id,
      nome: linha.empresa_nome,
      cnpj: linha.empresa_cnpj,
    },
    // Troca obrigatória (074): decidida pelo middleware; fora de `usuario`, que chega às respostas.
    senhaProvisoria: linha.senha_provisoria === true,
    // Restrição por IP (077): o middleware só consulta a lista quando ela existe.
    restricaoIp: linha.restricao_ip === true,
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

/**
 * Revoga todas as sessões empresariais ainda ativas que NASCERAM da sessão
 * global indicada (sessoes.sessao_global_id, migration 037) — troca de
 * empresa e "sair completamente" (Pacote 4). Devolve quantas foram
 * atingidas. Sem filtro de empresa de propósito: a sessão global pertence
 * à pessoa, e suas sessões empresariais podem estar em empresas
 * diferentes; o identificador da sessão global vem sempre do cookie
 * validado no PostgreSQL, nunca do cliente.
 */
async function revogarDaSessaoGlobal(executor, sessaoGlobalId, motivo) {
  exigirSessao(sessaoGlobalId);
  exigirMotivo(motivo);

  const { rowCount } = await executor.query(
    `UPDATE sessoes SET revogada_em = now(), motivo_revogacao = $2
      WHERE sessao_global_id = $1 AND revogada_em IS NULL`,
    [sessaoGlobalId, motivo],
  );

  return rowCount;
}

/**
 * Igual a revogarDaSessaoGlobal, mas devolve cada sessão atingida com a
 * empresa, o usuário e se ela ainda valia no momento, pelo mesmo critério de
 * buscarValidaPorHash. A auditoria da troca de empresa só registra o
 * encerramento de um contexto que ainda valia; sessão já revogada não é
 * tocada nem devolvida. A FK composta de sessoes garante o usuário no JOIN.
 */
async function revogarDaSessaoGlobalComSituacao(executor, sessaoGlobalId, motivo, inatividadeMinutos) {
  exigirSessao(sessaoGlobalId);
  exigirMotivo(motivo);
  exigirInatividade(inatividadeMinutos);

  const { rows } = await executor.query(
    `UPDATE sessoes s SET revogada_em = now(), motivo_revogacao = $2
       FROM usuarios u
       JOIN empresas e ON e.id = u.empresa_id
       LEFT JOIN identidades i ON i.id = u.identidade_id
      WHERE s.sessao_global_id = $1
        AND s.revogada_em IS NULL
        AND u.empresa_id = s.empresa_id AND u.id = s.usuario_id
      RETURNING s.id, s.empresa_id, s.usuario_id,
        (s.expira_em > now()
          AND s.ultimo_uso_em > now() - ($3 * INTERVAL '1 minute')
          AND u.ativo
          AND e.ativo
          AND (u.identidade_id IS NULL OR i.ativo)) AS valida`,
    [sessaoGlobalId, motivo, inatividadeMinutos],
  );

  return rows.map((linha) => ({ sessaoId: linha.id, empresaId: linha.empresa_id, usuarioId: linha.usuario_id, valida: linha.valida === true }));
}

/**
 * Revoga as sessões empresariais ainda não revogadas de todos os vínculos da
 * identidade, em qualquer empresa e de qualquer origem (seleção de empresa
 * ou login por CNPJ), e devolve quantas foram. Sem filtro de empresa de
 * propósito: a senha é da pessoa. `exceto` preserva só a sessão empresarial
 * da requisição que fez a troca de senha; o identificador vem do cookie
 * validado, nunca do cliente.
 */
async function revogarTodasDaIdentidade(executor, identidadeId, motivo, { exceto = null } = {}) {
  if (!Number.isInteger(identidadeId) || identidadeId <= 0) {
    throw new TypeError('identificador de identidade inválido');
  }
  exigirMotivo(motivo);
  if (exceto !== null) {
    exigirSessao(exceto);
  }

  const { rowCount } = await executor.query(
    `UPDATE sessoes s SET revogada_em = now(), motivo_revogacao = $2
       FROM usuarios u
      WHERE u.empresa_id = s.empresa_id AND u.id = s.usuario_id
        AND u.identidade_id = $1
        AND s.revogada_em IS NULL
        AND ($3::bigint IS NULL OR s.id <> $3::bigint)`,
    [identidadeId, motivo, exceto],
  );

  return rowCount;
}

/**
 * Identificador da sessão empresarial que o cookie apresentado identifica,
 * só se ela for válida pelos mesmos critérios de buscarValidaPorHash, for de
 * um vínculo desta identidade e tiver nascido desta sessão global
 * (sessoes.sessao_global_id, migration 037). Cookie presente não basta: a
 * validade da empresarial não depende da global, e preservar uma que nasceu
 * de outra deixaria viva uma sessão cuja global foi revogada.
 *
 * @returns {Promise<string|null>} o id, como string decimal canônica
 */
async function buscarIdDaAtualDaSessaoGlobal(executor, {
  tokenHash, sessaoGlobalId, identidadeId, inatividadeMinutos,
}) {
  exigirHash(tokenHash);
  exigirSessao(sessaoGlobalId);
  if (!Number.isInteger(identidadeId) || identidadeId <= 0) {
    throw new TypeError('identificador de identidade inválido');
  }
  exigirInatividade(inatividadeMinutos);

  const { rows } = await executor.query(
    `SELECT s.id
       FROM sessoes s
       JOIN usuarios u ON u.empresa_id = s.empresa_id AND u.id = s.usuario_id
       JOIN empresas e ON e.id = s.empresa_id
       JOIN identidades i ON i.id = u.identidade_id
      WHERE s.token_hash = $1
        AND s.sessao_global_id = $2::bigint
        AND u.identidade_id = $3
        AND s.revogada_em IS NULL
        AND s.expira_em > now()
        AND s.ultimo_uso_em > now() - ($4 * INTERVAL '1 minute')
        AND u.ativo
        AND e.ativo
        AND i.ativo`,
    [tokenHash, sessaoGlobalId, identidadeId, inatividadeMinutos],
  );

  return rows.length === 0 ? null : rows[0].id;
}

module.exports = {
  criar,
  buscarValidaPorHash,
  registrarUso,
  revogar,
  revogarDoUsuario,
  revogarDaSessaoGlobal,
  revogarDaSessaoGlobalComSituacao,
  revogarTodasDaIdentidade,
  buscarIdDaAtualDaSessaoGlobal,
  CAMPOS_SESSAO,
};
