'use strict';

const crypto = require('node:crypto');
const { todasAsMigrations, erroDe } = require('./entrega-epi');

/**
 * Fixtures dos testes de recuperação de senha (Bloco 11): identidade global,
 * administrador da plataforma e pedidos de redefinição gravados direto no
 * banco. Nenhum token em claro existe aqui: só o SHA-256 em hexadecimal.
 */

const HASH_SENHA_FICTICIO = '$argon2id$v=19$m=65536,t=3,p=1$c2FsLWZpY3RpY2lvLWRlLXRlc3Rl$aGFzaC1maWN0aWNpby1kZS10ZXN0ZS1zZW0tdmFsb3I';
const VIOLACAO_NAO_NULO = '23502';
const VIOLACAO_FK = '23503';
const VIOLACAO_UNIQUE = '23505';
const VIOLACAO_CHECK = '23514';
const RECUSA_DO_TRIGGER = 'P0001';

const hashDeToken = () => crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex');

async function criarIdentidade(executor, email) {
  const { rows } = await executor.query('INSERT INTO identidades (email, senha_hash) VALUES ($1, $2) RETURNING id', [email, HASH_SENHA_FICTICIO]);
  return rows[0].id;
}

async function criarAdministrador(executor, email) {
  const { rows } = await executor.query(
    'INSERT INTO administradores_plataforma (email, senha_hash) VALUES ($1, $2) RETURNING id', [email, HASH_SENHA_FICTICIO],
  );
  return rows[0].id;
}

/**
 * Insere um pedido de redefinição. `tabela` e `coluna` vêm só de constantes
 * dos testes ('redefinicoes_senha' / 'identidade_id' e o par da plataforma).
 * `criadoHaMinutos` desloca criado_em para o passado; `validadeMinutos` é
 * contada a partir de criado_em.
 */
async function inserirPedido(executor, { tabela, coluna }, contaId, { tokenHash = hashDeToken(), criadoHaMinutos = 0, validadeMinutos = 60, extra = {} } = {}) {
  const colunas = [coluna, 'token_hash', 'criado_em', 'expira_em', ...Object.keys(extra)];
  const valores = [contaId, tokenHash, criadoHaMinutos, validadeMinutos, ...Object.values(extra)];
  const marcadores = [
    '$1', '$2',
    "now() - make_interval(mins => $3::int)",
    "now() - make_interval(mins => $3::int) + make_interval(mins => $4::int)",
    ...Object.keys(extra).map((_, i) => `$${i + 5}`),
  ];
  const { rows } = await executor.query(
    `INSERT INTO ${tabela} (${colunas.join(', ')}) VALUES (${marcadores.join(', ')}) RETURNING *`, valores,
  );
  return rows[0];
}

const constraintsDe = async (executor, schema, tabela) => (await executor.query(
  `SELECT conname FROM pg_constraint
    WHERE connamespace = $1::regnamespace AND conrelid = ($1 || '.' || $2)::regclass
    ORDER BY conname`,
  [schema, tabela],
)).rows.map((r) => r.conname);

const indicesDe = async (executor, schema, tabela) => (await executor.query(
  'SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 ORDER BY indexname', [schema, tabela],
)).rows.map((r) => r.indexname);

const gatilhosDe = async (executor, schema, tabela) => (await executor.query(
  `SELECT tgname FROM pg_trigger
    WHERE tgrelid = ($1 || '.' || $2)::regclass AND NOT tgisinternal
    ORDER BY tgname`,
  [schema, tabela],
)).rows.map((r) => r.tgname);

const colunasDe = async (executor, schema, tabela) => (await executor.query(
  'SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position', [schema, tabela],
)).rows.map((r) => r.column_name);

const tabelaExiste = async (executor, tabela) => (await executor.query('SELECT to_regclass($1) IS NOT NULL AS existe', [tabela])).rows[0].existe;

module.exports = {
  HASH_SENHA_FICTICIO,
  VIOLACAO_NAO_NULO,
  VIOLACAO_FK,
  VIOLACAO_UNIQUE,
  VIOLACAO_CHECK,
  RECUSA_DO_TRIGGER,
  todasAsMigrations,
  erroDe,
  hashDeToken,
  criarIdentidade,
  criarAdministrador,
  inserirPedido,
  constraintsDe,
  indicesDe,
  gatilhosDe,
  colunasDe,
  tabelaExiste,
};
