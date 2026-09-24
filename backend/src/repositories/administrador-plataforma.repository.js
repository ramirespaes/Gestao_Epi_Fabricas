'use strict';

/**
 * Repositório de administradores da plataforma (migration 027 —
 * Autenticação Global, Pacote 2).
 *
 * Mesmo padrão dos demais repositórios: executor por parâmetro (nunca o
 * pool global), validação de formato via exigir*, nenhuma regra de
 * negócio, SQL parametrizado. Sem `empresa_id` em lugar nenhum — um
 * administrador de plataforma não pertence a nenhuma empresa, de propósito
 * (ver comentário da migration 027).
 *
 * `senha_hash` só sai daqui em `buscarCredencialPorEmail` — a única leitura
 * que precisa dele para autenticar. Qualquer outra consulta futura que só
 * precise identificar o administrador (auditoria, listagem) não deve pedir
 * essa coluna, mesma disciplina de `usuario.repository.js`.
 */

const EMAIL_TAMANHO_MAXIMO = 150;

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError(`${nome} inválido`);
  }
}

function exigirEmail(email) {
  if (typeof email !== 'string' || email.length === 0 || email.length > EMAIL_TAMANHO_MAXIMO) {
    throw new TypeError('e-mail inválido');
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

/**
 * Cria um administrador de plataforma. `ativo` nasce `true` pelo DEFAULT
 * da migration 027 e não é parâmetro — não existe caminho para criar um
 * administrador já inativo.
 *
 * @param {{query: Function}} executor
 * @param {{email: string, senhaHash: string}} dados
 */
async function criar(executor, { email, senhaHash }) {
  exigirEmail(email);
  exigirSenhaHash(senhaHash);

  const { rows } = await executor.query(
    `INSERT INTO administradores_plataforma (email, senha_hash)
     VALUES ($1, $2)
     RETURNING id, email, ativo, criado_em, atualizado_em`,
    [email, senhaHash],
  );

  return mapear(rows[0]);
}

/**
 * Busca um administrador pelo e-mail (case-insensitive, mesmo índice da
 * migration 027), COM `senha_hash` — uso exclusivo do login.
 *
 * @returns {Promise<{id:number, email:string, senhaHash:string, ativo:boolean}|null>}
 */
async function buscarCredencialPorEmail(executor, email) {
  exigirEmail(email);

  const { rows } = await executor.query(
    'SELECT id, email, senha_hash, ativo FROM administradores_plataforma WHERE lower(email) = lower($1)',
    [email],
  );

  const linha = rows[0];
  return linha === undefined ? null : { id: linha.id, email: linha.email, senhaHash: linha.senha_hash, ativo: linha.ativo };
}

/** Busca um administrador pelo e-mail, SEM `senha_hash` — para checagens administrativas (ex.: idempotência do provisionamento). */
async function buscarPorEmail(executor, email) {
  exigirEmail(email);

  const { rows } = await executor.query(
    'SELECT id, email, ativo, criado_em, atualizado_em FROM administradores_plataforma WHERE lower(email) = lower($1)',
    [email],
  );

  return mapear(rows[0]);
}

async function buscarPorId(executor, id) {
  exigirId(id, 'identificador de administrador');

  const { rows } = await executor.query(
    'SELECT id, email, ativo, criado_em, atualizado_em FROM administradores_plataforma WHERE id = $1',
    [id],
  );

  return mapear(rows[0]);
}

module.exports = { criar, buscarCredencialPorEmail, buscarPorEmail, buscarPorId };
