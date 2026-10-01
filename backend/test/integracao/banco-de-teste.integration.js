'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { abrirSchemaTemporario, abrirPoolTemporario } = require('./helpers/schema-temporario');
const { BANCO_DE_TESTE, confirmarBancoDeTeste } = require('./helpers/banco-de-teste');

/**
 * Trava do banco de teste contra PostgreSQL real, sempre no banco permitido.
 * As recusas por nome protegido ficam em test/infra/banco-de-teste.test.js,
 * com conexões falsas: aqui nenhum banco protegido é sequer endereçado.
 */

const PREFLIGHT = path.join(__dirname, 'preflight-banco.js');
const schemaExiste = async (executor, schema) => (await executor.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [schema])).rowCount === 1;
const schemasDeTeste = async (executor) => (await executor.query("SELECT nspname FROM pg_namespace WHERE nspname LIKE 'test\\_migration\\_%' ORDER BY nspname")).rows.map((l) => l.nspname);

describe('banco de teste — PostgreSQL real', () => {
  test('o banco real da conexão, informado pelo próprio PostgreSQL, é o permitido', async () => {
    const contexto = await abrirSchemaTemporario([]);
    try {
      const { rows: [{ banco }] } = await contexto.cliente.query('SELECT current_database() AS banco');
      assert.equal(banco, 'gestao_epi_teste_local');
      assert.equal(BANCO_DE_TESTE, 'gestao_epi_teste_local');
      assert.equal(await confirmarBancoDeTeste(contexto.cliente), banco);
    } finally {
      await contexto.encerrar();
    }
  });

  test('caminho permitido com Client: o schema temporário é criado, isolado no search_path e removido', async () => {
    const observador = await abrirSchemaTemporario([]);
    try {
      const contexto = await abrirSchemaTemporario([]);
      assert.equal(await schemaExiste(observador.cliente, contexto.schema), true);
      const { rows: [{ search_path: caminho }] } = await contexto.cliente.query('SHOW search_path');
      assert.equal(caminho, contexto.schema);
      await contexto.encerrar();
      assert.equal(await schemaExiste(observador.cliente, contexto.schema), false);
    } finally {
      await observador.encerrar();
    }
  });

  test('caminho permitido com Pool: cada conexão está no banco permitido e no schema temporário; a limpeza remove o schema', async () => {
    const observador = await abrirSchemaTemporario([]);
    try {
      const contexto = await abrirPoolTemporario([]);
      const [a, b] = await Promise.all([contexto.pool.connect(), contexto.pool.connect()]);
      try {
        for (const conexao of [a, b]) {
          const { rows: [linha] } = await conexao.query("SELECT current_database() AS banco, current_setting('search_path') AS caminho");
          assert.deepEqual([linha.banco, linha.caminho], ['gestao_epi_teste_local', contexto.schema]);
        }
      } finally {
        a.release();
        b.release();
      }
      assert.equal(await schemaExiste(observador.cliente, contexto.schema), true);
      await contexto.encerrar();
      assert.equal(await schemaExiste(observador.cliente, contexto.schema), false);
    } finally {
      await observador.encerrar();
    }
  });

  test('nome diferente no ambiente é recusado antes de qualquer CREATE SCHEMA: nenhum schema novo aparece', async () => {
    const observador = await abrirSchemaTemporario([]);
    const original = process.env.DB_NAME;
    try {
      const antes = await schemasDeTeste(observador.cliente);
      // Banco que não existe: sem a trava, a tentativa terminaria em erro de conexão, nunca em escrita.
      process.env.DB_NAME = 'gestao_epi_banco_inexistente_para_teste';
      await assert.rejects(() => abrirSchemaTemporario([]), (erro) => erro.code === 'BANCO_DE_TESTE_RECUSADO');
      await assert.rejects(() => abrirPoolTemporario([]), (erro) => erro.code === 'BANCO_DE_TESTE_RECUSADO');
      process.env.DB_NAME = original;
      assert.deepEqual(await schemasDeTeste(observador.cliente), antes);
    } finally {
      process.env.DB_NAME = original;
      await observador.encerrar();
    }
  });

  test('preflight do comando oficial: confirma o banco real e termina com sucesso, só lendo', async () => {
    const observador = await abrirSchemaTemporario([]);
    try {
      const antes = await schemasDeTeste(observador.cliente);
      const r = spawnSync(process.execPath, [PREFLIGHT], { env: process.env, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /banco de teste confirmado: current_database\(\)=gestao_epi_teste_local/);
      assert.deepEqual(await schemasDeTeste(observador.cliente), antes);
    } finally {
      await observador.encerrar();
    }
  });
});
