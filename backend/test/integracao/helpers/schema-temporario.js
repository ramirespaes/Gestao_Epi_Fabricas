'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

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

module.exports = { abrirSchemaTemporario, inserirEmpresa, migrationExiste, conteudoDaMigration };
