'use strict';

const { normalizarEmail } = require('../utils/normalizacao');

/**
 * Repositório de convites de usuário (convites_usuario, migration 046).
 * Espelho de convite-master.repository.js: só o SHA-256 do token chega
 * aqui, a situação é derivada de timestamps e os UPDATEs de aceite e
 * cancelamento levam a condição de estado no WHERE (uso único no banco).
 *
 * Toda leitura administrativa filtra pela empresa recebida, que o serviço
 * tira da sessão. token_hash nunca sai deste módulo.
 */

const FORMATO_HASH = /^[0-9a-f]{64}$/;
const FORMATO_ID = /^[1-9][0-9]*$/;
const PERFIS = Object.freeze(['MASTER', 'ADMINISTRADOR', 'SUPERVISOR', 'USUARIO']);
const TAMANHO_MAXIMO_NOME = 150;
const JANELA_MAXIMA_HORAS = 168;

const SITUACAO = Object.freeze({ PENDENTE: 'PENDENTE', ACEITO: 'ACEITO', CANCELADO: 'CANCELADO', EXPIRADO: 'EXPIRADO' });

const PROJECAO = `c.id, c.empresa_id, c.email_convite, c.nome, c.perfil, c.criado_por, c.criado_em, c.expira_em,
  c.cancelado_em, c.aceito_em, c.identidade_id, c.usuario_id, (c.expira_em > clock_timestamp()) AS vigente`;

function exigirEmpresa(empresaId) {
  if (!Number.isInteger(empresaId) || empresaId <= 0) {
    throw new TypeError('identificador de empresa inválido');
  }
}

function exigirIdInteiro(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError(`${nome} inválido`);
  }
}

/** convites_usuario.id é BIGINT IDENTITY: string decimal canônica, nunca Number. */
function exigirIdConvite(id) {
  if (typeof id !== 'string' || !FORMATO_ID.test(id)) {
    throw new TypeError('identificador de convite inválido');
  }
}

function exigirHash(tokenHash) {
  if (typeof tokenHash !== 'string' || !FORMATO_HASH.test(tokenHash)) {
    throw new TypeError('token deve chegar como hash SHA-256 hexadecimal minúsculo');
  }
}

function exigirEmailNormalizado(email) {
  if (typeof email !== 'string' || normalizarEmail(email) !== email) {
    throw new TypeError('e-mail deve chegar normalizado');
  }
}

function situacaoDe(linha) {
  if (linha.aceito_em !== null) return SITUACAO.ACEITO;
  if (linha.cancelado_em !== null) return SITUACAO.CANCELADO;
  if (linha.vigente !== true) return SITUACAO.EXPIRADO;
  return SITUACAO.PENDENTE;
}

const mapear = (linha) => (linha === undefined ? null : {
  id: linha.id,
  empresaId: linha.empresa_id,
  emailConvite: linha.email_convite,
  nome: linha.nome,
  perfil: linha.perfil,
  criadoPor: linha.criado_por,
  criadoEm: linha.criado_em,
  expiraEm: linha.expira_em,
  canceladoEm: linha.cancelado_em,
  aceitoEm: linha.aceito_em,
  identidadeId: linha.identidade_id,
  usuarioId: linha.usuario_id,
  situacao: situacaoDe(linha),
});

async function criar(executor, {
  empresaId, emailConvite, nome, perfil, tokenHash, criadoPor, expiraEm,
}) {
  exigirEmpresa(empresaId);
  exigirEmailNormalizado(emailConvite);
  if (typeof nome !== 'string' || nome.trim().length === 0 || Array.from(nome).length > TAMANHO_MAXIMO_NOME) {
    throw new TypeError('nome inválido');
  }
  if (!PERFIS.includes(perfil)) {
    throw new TypeError('perfil inválido');
  }
  exigirHash(tokenHash);
  exigirIdInteiro(criadoPor, 'identificador de quem convida');
  if (!(expiraEm instanceof Date) || Number.isNaN(expiraEm.getTime())) {
    throw new TypeError('expira_em deve ser uma data válida');
  }

  const { rows } = await executor.query(
    `INSERT INTO convites_usuario AS c (empresa_id, email_convite, nome, perfil, token_hash, criado_por, expira_em, criado_em)
     VALUES ($1, $2, $3, $4, $5, $6, $7, clock_timestamp())
     RETURNING ${PROJECAO}`,
    [empresaId, emailConvite, nome, perfil, tokenHash, criadoPor, expiraEm],
  );
  return mapear(rows[0]);
}

/** Convite ainda PENDENTE para este e-mail nesta empresa, travado (FOR UPDATE). */
async function buscarPendentePorEmailParaAtualizacao(executor, empresaId, emailConvite) {
  exigirEmpresa(empresaId);
  exigirEmailNormalizado(emailConvite);
  const { rows } = await executor.query(
    `SELECT ${PROJECAO} FROM convites_usuario c
      WHERE c.empresa_id = $1 AND c.email_convite = $2
        AND c.aceito_em IS NULL AND c.cancelado_em IS NULL AND c.expira_em > clock_timestamp()
      ORDER BY c.id DESC LIMIT 1
      FOR UPDATE`,
    [empresaId, emailConvite],
  );
  return mapear(rows[0]);
}

async function buscarPorHash(executor, tokenHash) {
  exigirHash(tokenHash);
  const { rows } = await executor.query(`SELECT ${PROJECAO} FROM convites_usuario c WHERE c.token_hash = $1`, [tokenHash]);
  return mapear(rows[0]);
}

async function buscarPorHashParaAtualizacao(executor, tokenHash) {
  exigirHash(tokenHash);
  const { rows } = await executor.query(`SELECT ${PROJECAO} FROM convites_usuario c WHERE c.token_hash = $1 FOR UPDATE`, [tokenHash]);
  return mapear(rows[0]);
}

/** Pelo id, filtrada pela empresa, sem travar: o reenvio precisa do e-mail antes de tomar a trava consultiva do par. */
async function buscarPorId(executor, empresaId, id) {
  exigirEmpresa(empresaId);
  exigirIdConvite(id);
  const { rows } = await executor.query(
    `SELECT ${PROJECAO} FROM convites_usuario c WHERE c.empresa_id = $1 AND c.id = $2`,
    [empresaId, id],
  );
  return mapear(rows[0]);
}

async function buscarPorIdParaAtualizacao(executor, empresaId, id) {
  exigirEmpresa(empresaId);
  exigirIdConvite(id);
  const { rows } = await executor.query(
    `SELECT ${PROJECAO} FROM convites_usuario c WHERE c.empresa_id = $1 AND c.id = $2 FOR UPDATE`,
    [empresaId, id],
  );
  return mapear(rows[0]);
}

/**
 * Convites já criados para o par (empresa, e-mail) nas últimas `janelaHoras`,
 * de qualquer situação, com o relógio do banco. Base do teto de envios.
 * @returns {Promise<{total: number, primeiroEm: Date|null, ultimoEm: Date|null, agora: Date}>}
 */
async function resumirEnvios(executor, empresaId, emailConvite, janelaHoras) {
  exigirEmpresa(empresaId);
  exigirEmailNormalizado(emailConvite);
  if (!Number.isInteger(janelaHoras) || janelaHoras < 1 || janelaHoras > JANELA_MAXIMA_HORAS) {
    throw new TypeError('janela de envios inválida');
  }
  const { rows } = await executor.query(
    `SELECT count(*)::int AS total, min(c.criado_em) AS primeiro_em, max(c.criado_em) AS ultimo_em, clock_timestamp() AS agora
       FROM convites_usuario c
      WHERE c.empresa_id = $1 AND c.email_convite = $2
        AND c.criado_em > clock_timestamp() - make_interval(hours => $3)`,
    [empresaId, emailConvite, janelaHoras],
  );
  const linha = rows[0];
  return {
    total: linha.total, primeiroEm: linha.primeiro_em, ultimoEm: linha.ultimo_em, agora: linha.agora,
  };
}

/**
 * Convites ainda não resolvidos (pendentes e expirados sem cancelamento)
 * da empresa, mais recentes primeiro, com o nome de quem convidou (JOIN
 * na mesma empresa). Usa o índice parcial dos pendentes da 046.
 * @returns {Promise<{convites: Array<object>, total: number}>}
 */
async function listarEmAberto(executor, empresaId, { pagina = 1, limite = 20 } = {}) {
  exigirEmpresa(empresaId);
  if (!Number.isInteger(pagina) || pagina <= 0 || !Number.isInteger(limite) || limite <= 0) {
    throw new TypeError('paginação inválida');
  }
  const filtro = 'WHERE c.empresa_id = $1 AND c.aceito_em IS NULL AND c.cancelado_em IS NULL';
  const { rows: contagem } = await executor.query(`SELECT count(*)::int AS total FROM convites_usuario c ${filtro}`, [empresaId]);
  const { rows } = await executor.query(
    `SELECT ${PROJECAO}, u.nome AS criado_por_nome
       FROM convites_usuario c
       LEFT JOIN usuarios u ON u.empresa_id = c.empresa_id AND u.id = c.criado_por
      ${filtro}
      ORDER BY c.id DESC
      LIMIT $2 OFFSET $3`,
    [empresaId, limite, (pagina - 1) * limite],
  );
  return {
    convites: rows.map((linha) => ({ ...mapear(linha), criadoPorNome: linha.criado_por_nome })),
    total: contagem[0].total,
  };
}

/** Marca o aceite só se o convite ainda estiver pendente. @returns convite aceito ou null */
async function marcarAceito(executor, id, { identidadeId, usuarioId }) {
  exigirIdConvite(id);
  exigirIdInteiro(identidadeId, 'identificador de identidade');
  exigirIdInteiro(usuarioId, 'identificador de usuário');
  const { rows } = await executor.query(
    `UPDATE convites_usuario AS c
        SET aceito_em = clock_timestamp(), identidade_id = $2, usuario_id = $3
      WHERE c.id = $1 AND c.aceito_em IS NULL AND c.cancelado_em IS NULL AND c.expira_em > clock_timestamp()
      RETURNING ${PROJECAO}`,
    [id, identidadeId, usuarioId],
  );
  return mapear(rows[0]);
}

/** Cancela um convite da empresa ainda não aceito nem cancelado. @returns convite cancelado ou null */
async function cancelar(executor, empresaId, id) {
  exigirEmpresa(empresaId);
  exigirIdConvite(id);
  const { rows } = await executor.query(
    `UPDATE convites_usuario AS c
        SET cancelado_em = clock_timestamp()
      WHERE c.empresa_id = $1 AND c.id = $2 AND c.aceito_em IS NULL AND c.cancelado_em IS NULL
      RETURNING ${PROJECAO}`,
    [empresaId, id],
  );
  return mapear(rows[0]);
}

module.exports = {
  SITUACAO,
  criar,
  buscarPendentePorEmailParaAtualizacao,
  buscarPorHash,
  buscarPorHashParaAtualizacao,
  buscarPorId,
  buscarPorIdParaAtualizacao,
  resumirEnvios,
  listarEmAberto,
  marcarAceito,
  cancelar,
};
