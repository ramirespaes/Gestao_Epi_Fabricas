'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Client, Pool } = require('pg');

/**
 * Schema temporário para testes de migration em PostgreSQL real.
 *
 * Cada execução cria um schema exclusivo (nome gerado internamente, só com
 * [a-z0-9_], validado antes de entrar no SQL), aplica ali o subconjunto
 * mínimo de migrations e o remove com DROP SCHEMA CASCADE no final, inclusive
 * em caso de falha. O schema `public` do banco de desenvolvimento nunca é
 * lido nem escrito: o search_path aponta apenas para o schema temporário.
 *
 * Conexão exclusivamente pelas variáveis já existentes do projeto
 * (DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD). A senha nunca é impressa.
 */

const NOME_SEGURO = /^[a-z][a-z0-9_]{1,62}$/;
const DIRETORIO_MIGRATIONS = path.join(__dirname, '..', '..', '..', 'migrations');

function nomeDeSchema() {
  return `test_migration_${crypto.randomBytes(6).toString('hex')}`;
}

function conteudoDaMigration(prefixo) {
  const arquivos = fs.readdirSync(DIRETORIO_MIGRATIONS).filter((nome) => nome.startsWith(`${prefixo}_`) && nome.endsWith('.sql'));
  if (arquivos.length !== 1) {
    throw new Error(`esperado exatamente um arquivo de migration com prefixo ${prefixo}, encontrados ${arquivos.length}`);
  }
  return fs.readFileSync(path.join(DIRETORIO_MIGRATIONS, arquivos[0]), 'utf8');
}

function migrationExiste(prefixo) {
  return fs.readdirSync(DIRETORIO_MIGRATIONS).some((nome) => nome.startsWith(`${prefixo}_`) && nome.endsWith('.sql'));
}

/**
 * Abre conexão, cria o schema temporário e aplica as migrations indicadas na
 * ordem recebida. Devolve o cliente já com search_path no schema e a função
 * de limpeza.
 */
async function abrirSchemaTemporario(prefixosDeMigration) {
  const schema = nomeDeSchema();
  if (!NOME_SEGURO.test(schema)) {
    throw new Error('nome de schema gerado é inválido');
  }
  const cliente = new Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    connectionTimeoutMillis: 8000,
  });
  await cliente.connect();

  const encerrar = async () => {
    try {
      await cliente.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await cliente.end();
    }
  };

  try {
    await cliente.query(`CREATE SCHEMA ${schema}`);
    await cliente.query(`SET search_path TO ${schema}`);
    for (const prefixo of prefixosDeMigration) {
      await cliente.query(conteudoDaMigration(prefixo));
    }
  } catch (erro) {
    await encerrar();
    throw erro;
  }

  return { cliente, schema, encerrar };
}

/** Executa um INSERT e devolve 'ok' ou o SQLSTATE do erro. */
async function inserirEmpresa(cliente, cnpj, nome = 'Empresa Teste') {
  try {
    await cliente.query('INSERT INTO empresas (nome, cnpj) VALUES ($1, $2)', [nome, cnpj]);
    return 'ok';
  } catch (erro) {
    return erro.code;
  }
}

/**
 * Igual a abrirSchemaTemporario, mas devolve também um Pool real (não um
 * Client único), necessário para testes de concorrência onde duas conexões
 * distintas precisam disputar o mesmo advisory lock ao mesmo tempo — um
 * Client único não permite duas transações sobrepostas.
 *
 * O search_path é fixado via `options: '-c search_path=<schema>'` no
 * construtor do Pool: é um parâmetro de conexão aplicado pelo PostgreSQL a
 * CADA conexão física que o Pool abrir, não só à primeira, diferente de rodar
 * `SET search_path` manualmente depois de cada connect().
 *
 * encerrar() fecha o Pool inteiro (pool.end(), aguardando todas as conexões
 * em uso) antes de remover o schema pelo cliente administrativo herdado de
 * abrirSchemaTemporario — nessa ordem, nenhuma conexão do pool pode estar
 * ativa quando o DROP SCHEMA roda. Se a criação do próprio Pool falhar, a
 * conexão administrativa e o schema já criados são limpos antes de propagar
 * o erro.
 */
async function abrirPoolTemporario(prefixosDeMigration) {
  const base = await abrirSchemaTemporario(prefixosDeMigration);

  let pool;
  try {
    pool = new Pool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      options: `-c search_path=${base.schema}`,
      connectionTimeoutMillis: 8000,
    });
    // Falha cedo, antes de devolver ao chamador, se a configuração do Pool
    // estiver incorreta (credenciais, host, etc.).
    await pool.query('SELECT 1');
  } catch (erro) {
    if (pool) {
      await pool.end();
    }
    await base.encerrar();
    throw erro;
  }

  const encerrar = async () => {
    try {
      await pool.end();
    } finally {
      await base.encerrar();
    }
  };

  return { pool, schema: base.schema, encerrar };
}

/**
 * Aguarda deterministicamente até que o backend PostgreSQL de PID `pid`
 * apareça bloqueado esperando um lock (wait_event_type = 'Lock') em
 * pg_stat_activity. Usado para confirmar, antes de prosseguir num teste de
 * concorrência, que uma segunda conexão já está de fato esperando um
 * advisory lock detido por outra — coordenação explícita sobre um fato
 * observável no próprio banco, não uma espera arbitrária torcendo pelo
 * tempo certo. O intervalo entre verificações é curto (10ms) porque a
 * condição normalmente já é verdadeira em poucos milissegundos.
 */
async function aguardarEsperaPeloLock(clienteAdmin, pid, { tentativas = 200, intervaloMs = 10 } = {}) {
  for (let i = 0; i < tentativas; i += 1) {
    const { rows } = await clienteAdmin.query(
      'SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1',
      [pid],
    );
    if (rows[0]?.wait_event_type === 'Lock') {
      return;
    }
    await new Promise((resolve) => { setTimeout(resolve, intervaloMs); });
  }
  throw new Error('conexão não chegou a aguardar o advisory lock dentro do tempo esperado');
}

module.exports = {
  abrirSchemaTemporario,
  abrirPoolTemporario,
  aguardarEsperaPeloLock,
  inserirEmpresa,
  migrationExiste,
  conteudoDaMigration,
};
