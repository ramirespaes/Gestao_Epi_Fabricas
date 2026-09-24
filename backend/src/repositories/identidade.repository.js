'use strict';

const { normalizarEmail } = require('../utils/normalizacao');

/**
 * Repositório de identidades globais (identidades, migration 025) —
 * primeiro código do projeto a ESCREVER nessa tabela (Pacote 3, aceite de
 * convite do MASTER). Até aqui a tabela existia só estruturalmente.
 *
 * Mesmo padrão de administrador-plataforma.repository.js e
 * usuario.repository.js: executor por parâmetro, validação de formato via
 * exigir*, nenhuma regra de negócio, SQL parametrizado, e-mail já
 * normalizado pela camada acima. `senha_hash` só sai por
 * `buscarCredencialPorEmail` — a única leitura que precisa dela (prova de
 * titularidade no aceite de convite; futuro login global do Pacote 4).
 *
 * SEM empresa_id em lugar nenhum: identidade é global por definição
 * (migration 025). O vínculo com empresas é `usuarios.identidade_id`, que
 * pertence ao repositório de usuários.
 */

const EMAIL_TAMANHO_MAXIMO = 150;

function exigirId(valor) {
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError('identificador de identidade inválido');
  }
}

function exigirEmailNormalizado(email) {
  if (typeof email !== 'string' || email.length === 0 || email.length > EMAIL_TAMANHO_MAXIMO || normalizarEmail(email) !== email) {
    throw new TypeError('e-mail deve chegar normalizado');
  }
}

function exigirSenhaHash(senhaHash) {
  if (typeof senhaHash !== 'string' || senhaHash.length === 0) {
    throw new TypeError('hash de senha inválido');
  }
}

const mapear = (linha) => (linha === undefined ? null : {
  id: linha.id,
  email: linha.email,
  ativo: linha.ativo,
  criadoEm: linha.criado_em,
  atualizadoEm: linha.atualizado_em,
});

/** Cria uma identidade. `ativo` nasce true pelo DEFAULT da migration 025 e não é parâmetro. */
async function criar(executor, { email, senhaHash }) {
  exigirEmailNormalizado(email);
  exigirSenhaHash(senhaHash);

  const { rows } = await executor.query(
    `INSERT INTO identidades (email, senha_hash)
     VALUES ($1, $2)
     RETURNING id, email, ativo, criado_em, atualizado_em`,
    [email, senhaHash],
  );

  return mapear(rows[0]);
}

/** Busca pelo e-mail (case-insensitive, índice uq_identidades_email_lower), SEM senha_hash. */
async function buscarPorEmail(executor, email) {
  exigirEmailNormalizado(email);

  const { rows } = await executor.query(
    'SELECT id, email, ativo, criado_em, atualizado_em FROM identidades WHERE lower(email) = lower($1)',
    [email],
  );

  return mapear(rows[0]);
}

/**
 * Única função que traz o hash da senha. Uso exclusivo de quem precisa
 * VERIFICAR a senha (aceite de convite com identidade existente; login
 * global do Pacote 4). Nunca serializar o resultado.
 *
 * @returns {Promise<{id:number, email:string, senhaHash:string, ativo:boolean}|null>}
 */
async function buscarCredencialPorEmail(executor, email) {
  exigirEmailNormalizado(email);

  const { rows } = await executor.query(
    'SELECT id, email, senha_hash, ativo FROM identidades WHERE lower(email) = lower($1)',
    [email],
  );

  const linha = rows[0];
  return linha === undefined ? null : { id: linha.id, email: linha.email, senhaHash: linha.senha_hash, ativo: linha.ativo };
}

async function buscarPorId(executor, id) {
  exigirId(id);

  const { rows } = await executor.query(
    'SELECT id, email, ativo, criado_em, atualizado_em FROM identidades WHERE id = $1',
    [id],
  );

  return mapear(rows[0]);
}

module.exports = { criar, buscarPorEmail, buscarCredencialPorEmail, buscarPorId };
