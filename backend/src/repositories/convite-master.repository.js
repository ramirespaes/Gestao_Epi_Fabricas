'use strict';

const { normalizarEmail } = require('../utils/normalizacao');

/**
 * Repositório de convites do MASTER (convites_master, migration 033 —
 * Pacote 3). Só o SHA-256 do token chega aqui; o token em claro é gerado e
 * lido exclusivamente pelo serviço. A SITUAÇÃO do convite é derivada de
 * timestamps na própria consulta (nunca uma coluna "status"):
 *   PENDENTE  aceito_em IS NULL AND cancelado_em IS NULL AND expira_em > now()
 *   ACEITO / CANCELADO / EXPIRADO — ver `situacaoDe`.
 *
 * Mesmo padrão dos demais repositórios: executor por parâmetro, validação
 * de formato via exigir*, nenhuma regra de negócio. Os UPDATEs de aceite e
 * cancelamento levam a condição de estado na própria cláusula WHERE e
 * devolvem `null` quando nada mudou — é isso que torna o uso único e a
 * exclusão mútua aceito/cancelado atômicos no banco, independentemente da
 * concorrência (uma segunda transação que passe pelo FOR UPDATE encontra
 * aceito_em já preenchido e afeta zero linhas).
 */

const FORMATO_HASH = /^[0-9a-f]{64}$/;
const FORMATO_ID = /^[1-9][0-9]*$/;

const SITUACAO = Object.freeze({ PENDENTE: 'PENDENTE', ACEITO: 'ACEITO', CANCELADO: 'CANCELADO', EXPIRADO: 'EXPIRADO' });

const PROJECAO = `id, empresa_id, email_convite, criado_por, criado_em, expira_em, cancelado_em, aceito_em,
  identidade_id, usuario_id, (expira_em > clock_timestamp()) AS vigente`;

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

/** convites_master.id é BIGINT IDENTITY: string decimal canônica, nunca Number. */
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
  criadoPor: linha.criado_por,
  criadoEm: linha.criado_em,
  expiraEm: linha.expira_em,
  canceladoEm: linha.cancelado_em,
  aceitoEm: linha.aceito_em,
  identidadeId: linha.identidade_id,
  usuarioId: linha.usuario_id,
  situacao: situacaoDe(linha),
});

/**
 * Cria o convite. `criado_em`/`expira_em`: `expira_em` chega calculado pelo
 * serviço a partir de clock_timestamp() (mesma disciplina de sessões).
 * @returns {Promise<object>} convite mapeado (sem token, sem hash)
 */
async function criar(executor, { empresaId, emailConvite, tokenHash, criadoPor, expiraEm }) {
  exigirEmpresa(empresaId);
  exigirEmailNormalizado(emailConvite);
  exigirHash(tokenHash);
  exigirIdInteiro(criadoPor, 'identificador de administrador');
  if (!(expiraEm instanceof Date) || Number.isNaN(expiraEm.getTime())) {
    throw new TypeError('expira_em deve ser uma data válida');
  }

  const { rows } = await executor.query(
    `INSERT INTO convites_master (empresa_id, email_convite, token_hash, criado_por, expira_em, criado_em)
     VALUES ($1, $2, $3, $4, $5, clock_timestamp())
     RETURNING ${PROJECAO}`,
    [empresaId, emailConvite, tokenHash, criadoPor, expiraEm],
  );

  return mapear(rows[0]);
}

/**
 * Convite PENDENTE (não aceito, não cancelado, não expirado) para este
 * e-mail nesta empresa, travado com FOR UPDATE — usado pelo serviço, dentro
 * da transação de criação, para serializar dois administradores tentando
 * convidar o mesmo e-mail ao mesmo tempo (o segundo espera o COMMIT do
 * primeiro e então o encontra).
 */
async function buscarPendentePorEmailParaAtualizacao(executor, empresaId, emailConvite) {
  exigirEmpresa(empresaId);
  exigirEmailNormalizado(emailConvite);

  const { rows } = await executor.query(
    `SELECT ${PROJECAO} FROM convites_master
      WHERE empresa_id = $1 AND lower(email_convite) = $2
        AND aceito_em IS NULL AND cancelado_em IS NULL AND expira_em > clock_timestamp()
      ORDER BY id DESC LIMIT 1
      FOR UPDATE`,
    [empresaId, emailConvite],
  );

  return mapear(rows[0]);
}

/** Pelo hash do token, SEM condição de estado (o serviço decide o desfecho por `situacao`), travado com FOR UPDATE. */
async function buscarPorHashParaAtualizacao(executor, tokenHash) {
  exigirHash(tokenHash);
  const { rows } = await executor.query(
    `SELECT ${PROJECAO} FROM convites_master WHERE token_hash = $1 FOR UPDATE`,
    [tokenHash],
  );
  return mapear(rows[0]);
}

/** Pelo hash do token, somente leitura (tela de aceite antes do envio do formulário). */
async function buscarPorHash(executor, tokenHash) {
  exigirHash(tokenHash);
  const { rows } = await executor.query(`SELECT ${PROJECAO} FROM convites_master WHERE token_hash = $1`, [tokenHash]);
  return mapear(rows[0]);
}

async function buscarPorId(executor, empresaId, id) {
  exigirEmpresa(empresaId);
  exigirIdConvite(id);
  const { rows } = await executor.query(
    `SELECT ${PROJECAO} FROM convites_master WHERE empresa_id = $1 AND id = $2`,
    [empresaId, id],
  );
  return mapear(rows[0]);
}

async function listarPorEmpresa(executor, empresaId) {
  exigirEmpresa(empresaId);
  const { rows } = await executor.query(
    `SELECT ${PROJECAO} FROM convites_master WHERE empresa_id = $1 ORDER BY id DESC`,
    [empresaId],
  );
  return rows.map((linha) => mapear(linha));
}

/**
 * Marca o aceite. A condição de estado na cláusula WHERE é a garantia de
 * USO ÚNICO no próprio banco: só um convite ainda pendente vira aceito.
 * `identidade_id`/`usuario_id` nascem junto (chk_convites_master_aceite_coerente).
 * @returns {Promise<object|null>} convite aceito, ou null se nada mudou
 */
async function marcarAceito(executor, id, { identidadeId, usuarioId }) {
  exigirIdConvite(id);
  exigirIdInteiro(identidadeId, 'identificador de identidade');
  exigirIdInteiro(usuarioId, 'identificador de usuário');

  const { rows } = await executor.query(
    `UPDATE convites_master
        SET aceito_em = clock_timestamp(), identidade_id = $2, usuario_id = $3
      WHERE id = $1 AND aceito_em IS NULL AND cancelado_em IS NULL AND expira_em > clock_timestamp()
      RETURNING ${PROJECAO}`,
    [id, identidadeId, usuarioId],
  );
  return mapear(rows[0]);
}

/** Cancela um convite ainda não aceito nem cancelado. @returns convite cancelado ou null se nada mudou. */
async function cancelar(executor, empresaId, id) {
  exigirEmpresa(empresaId);
  exigirIdConvite(id);
  const { rows } = await executor.query(
    `UPDATE convites_master
        SET cancelado_em = clock_timestamp()
      WHERE empresa_id = $1 AND id = $2 AND aceito_em IS NULL AND cancelado_em IS NULL
      RETURNING ${PROJECAO}`,
    [empresaId, id],
  );
  return mapear(rows[0]);
}

module.exports = {
  SITUACAO,
  criar,
  buscarPendentePorEmailParaAtualizacao,
  buscarPorHashParaAtualizacao,
  buscarPorHash,
  buscarPorId,
  listarPorEmpresa,
  marcarAceito,
  cancelar,
};
