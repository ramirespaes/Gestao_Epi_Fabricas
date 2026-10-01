'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

/**
 * Trava do banco dos testes de integração: só gestao_epi_teste_local, por
 * allowlist. Nada aqui abre conexão real: os clientes são falsos e, sempre
 * que um nome recusado está no ambiente, host e porta apontam para lugar
 * nenhum, de modo que a falta da trava apareça como falha de conexão e nunca
 * como escrita em banco protegido.
 */

const RAIZ = path.join(__dirname, '..', '..');
const PRELOAD = path.join(RAIZ, 'test', 'integracao', 'exigir-banco-de-teste.js');
const PREFLIGHT = path.join(RAIZ, 'test', 'integracao', 'preflight-banco.js');
const banco = () => require('../integracao/helpers/banco-de-teste'); // eslint-disable-line global-require
const helper = () => require('../integracao/helpers/schema-temporario'); // eslint-disable-line global-require

const PERMITIDO = 'gestao_epi_teste_local';
const PROTEGIDOS = ['gestao_epi_homolog_local', 'gestao_epi_demo', 'gestao_epi_dev', 'gestao_epi_migrado', 'gestao_epi_revisao_e6_20260927'];
const ARBITRARIOS = [
  'postgres', 'gestao_epi', 'gestao_epi_ci', 'gestao_epi_teste', 'gestao_epi_teste_local2', 'x_gestao_epi_teste_local',
  'GESTAO_EPI_TESTE_LOCAL', ' gestao_epi_teste_local', 'gestao_epi_teste_local ', '',
];
const NAO_TEXTUAIS = [undefined, null, 42, ['gestao_epi_teste_local'], { nome: 'gestao_epi_teste_local' }];
const RECUSADO = (erro) => erro instanceof Error && erro.code === 'BANCO_DE_TESTE_RECUSADO' && erro.message.includes(PERMITIDO);

const SEM_ESCRITA = /CREATE|DROP|ALTER|INSERT|UPDATE|DELETE|TRUNCATE|SET\s+search_path/i;

function conexaoFalsa(bancoReal) {
  const consultas = [];
  return {
    consultas,
    conectou: 0,
    encerrou: 0,
    async connect() { this.conectou += 1; },
    async end() { this.encerrou += 1; },
    async query(texto) {
      consultas.push(texto);
      if (/current_database\(\)/.test(texto)) return { rows: bancoReal === undefined ? [] : [{ banco: bancoReal }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
}

const VARIAVEIS = ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'];
let ambienteOriginal;

function apontarParaLugarNenhum(nome) {
  process.env.DB_HOST = '127.0.0.1';
  process.env.DB_PORT = '1';
  process.env.DB_USER = 'ninguem';
  process.env.DB_PASSWORD = '';
  if (nome === undefined) delete process.env.DB_NAME;
  else process.env.DB_NAME = nome;
}

beforeEach(() => {
  ambienteOriginal = Object.fromEntries(VARIAVEIS.map((v) => [v, process.env[v]]));
});

afterEach(() => {
  for (const v of VARIAVEIS) {
    if (ambienteOriginal[v] === undefined) delete process.env[v];
    else process.env[v] = ambienteOriginal[v];
  }
});

describe('banco de teste — nome permitido (allowlist de um nome só)', () => {
  test('o único nome aceito é gestao_epi_teste_local', () => {
    assert.equal(banco().BANCO_DE_TESTE, PERMITIDO);
    assert.doesNotThrow(() => banco().exigirNomeDoBancoDeTeste(PERMITIDO));
  });

  test('todos os bancos protegidos são recusados', () => {
    for (const nome of PROTEGIDOS) assert.throws(() => banco().exigirNomeDoBancoDeTeste(nome), RECUSADO, nome);
  });

  test('nome arbitrário, parecido, com espaço, em outra caixa, vazio ou não textual também é recusado', () => {
    for (const nome of [...ARBITRARIOS, ...NAO_TEXTUAIS]) assert.throws(() => banco().exigirNomeDoBancoDeTeste(nome), RECUSADO, JSON.stringify(nome));
  });

  test('a configuração de conexão só existe para o nome permitido e nunca carrega outro nome', () => {
    for (const nome of [...PROTEGIDOS, ...ARBITRARIOS, undefined]) {
      apontarParaLugarNenhum(nome);
      assert.throws(() => banco().configuracaoDoBancoDeTeste(), RECUSADO, JSON.stringify(nome));
    }
    apontarParaLugarNenhum(PERMITIDO);
    const configuracao = banco().configuracaoDoBancoDeTeste();
    assert.equal(configuracao.database, PERMITIDO);
    assert.deepEqual([configuracao.host, configuracao.port, configuracao.user], ['127.0.0.1', 1, 'ninguem']);
  });
});

describe('banco de teste — confirmação pelo próprio PostgreSQL', () => {
  test('current_database() igual ao permitido é aceito, com uma única consulta de leitura', async () => {
    const conexao = conexaoFalsa(PERMITIDO);
    assert.equal(await banco().confirmarBancoDeTeste(conexao), PERMITIDO);
    assert.equal(conexao.consultas.length, 1);
    assert.match(conexao.consultas[0], /^SELECT current_database\(\)/);
  });

  test('qualquer outro banco real é recusado, protegido ou não; resposta vazia também', async () => {
    for (const real of [...PROTEGIDOS, ...ARBITRARIOS, undefined, null]) {
      const conexao = conexaoFalsa(real);
      await assert.rejects(() => banco().confirmarBancoDeTeste(conexao), RECUSADO, JSON.stringify(real));
      assert.equal(conexao.consultas.length, 1);
      assert.doesNotMatch(conexao.consultas[0], SEM_ESCRITA);
    }
  });
});

describe('schema-temporario — abrirSchemaTemporario não prossegue fora do banco de teste', () => {
  test('nome recusado no ambiente: falha antes de criar o cliente, de conectar e de qualquer CREATE SCHEMA', async () => {
    for (const nome of [...PROTEGIDOS, ...ARBITRARIOS, undefined]) {
      apontarParaLugarNenhum(nome);
      const conexao = conexaoFalsa(nome);
      let criados = 0;
      await assert.rejects(
        () => helper().abrirSchemaTemporario([], { criarCliente: () => { criados += 1; return conexao; } }),
        RECUSADO, JSON.stringify(nome),
      );
      assert.deepEqual([criados, conexao.conectou, conexao.consultas.length], [0, 0, 0], JSON.stringify(nome));
    }
  });

  test('nome certo no ambiente, mas o PostgreSQL responde outro banco: só a leitura de current_database() acontece e a conexão é encerrada', async () => {
    for (const real of [...PROTEGIDOS, 'postgres', undefined]) {
      apontarParaLugarNenhum(PERMITIDO);
      const conexao = conexaoFalsa(real);
      await assert.rejects(() => helper().abrirSchemaTemporario([], { criarCliente: () => conexao }), RECUSADO, JSON.stringify(real));
      assert.equal(conexao.consultas.length, 1, 'nenhuma consulta além da confirmação');
      assert.match(conexao.consultas[0], /^SELECT current_database\(\)/);
      for (const consulta of conexao.consultas) assert.doesNotMatch(consulta, SEM_ESCRITA);
      assert.equal(conexao.encerrou, 1, 'conexão encerrada sem DROP SCHEMA');
    }
  });

  test('caminho permitido: a confirmação vem antes do CREATE SCHEMA e a limpeza remove o schema', async () => {
    apontarParaLugarNenhum(PERMITIDO);
    const conexao = conexaoFalsa(PERMITIDO);
    let configuracaoRecebida;
    const contexto = await helper().abrirSchemaTemporario([], { criarCliente: (configuracao) => { configuracaoRecebida = configuracao; return conexao; } });
    assert.equal(configuracaoRecebida.database, PERMITIDO);
    assert.match(contexto.schema, /^test_migration_[0-9a-f]{12}$/);
    assert.equal(conexao.consultas.length, 3);
    assert.match(conexao.consultas[0], /^SELECT current_database\(\)/);
    assert.equal(conexao.consultas[1], `CREATE SCHEMA ${contexto.schema}`);
    assert.equal(conexao.consultas[2], `SET search_path TO ${contexto.schema}`);

    await contexto.encerrar();
    assert.equal(conexao.consultas[3], `DROP SCHEMA IF EXISTS ${contexto.schema} CASCADE`);
    assert.equal(conexao.encerrou, 1);
  });
});

describe('schema-temporario — abrirPoolTemporario não prossegue fora do banco de teste', () => {
  test('nome recusado no ambiente: nem cliente nem pool chegam a ser criados', async () => {
    for (const nome of [...PROTEGIDOS, 'postgres', undefined]) {
      apontarParaLugarNenhum(nome);
      let criados = 0;
      const fabrica = () => { criados += 1; return conexaoFalsa(nome); };
      await assert.rejects(() => helper().abrirPoolTemporario([], { criarCliente: fabrica, criarPool: fabrica }), RECUSADO, JSON.stringify(nome));
      assert.equal(criados, 0, JSON.stringify(nome));
    }
  });

  test('pool que cai em outro banco: recusado na confirmação, sem escrita pelo pool; pool encerrado e schema administrativo limpo', async () => {
    apontarParaLugarNenhum(PERMITIDO);
    const administrativa = conexaoFalsa(PERMITIDO);
    const pool = conexaoFalsa('gestao_epi_homolog_local');
    let configuracaoDoPool;
    await assert.rejects(
      () => helper().abrirPoolTemporario([], { criarCliente: () => administrativa, criarPool: (configuracao) => { configuracaoDoPool = configuracao; return pool; } }),
      RECUSADO,
    );
    assert.equal(configuracaoDoPool.database, PERMITIDO);
    assert.equal(pool.consultas.length, 1);
    assert.match(pool.consultas[0], /^SELECT current_database\(\)/);
    assert.equal(pool.encerrou, 1);
    assert.match(administrativa.consultas.at(-1), /^DROP SCHEMA IF EXISTS test_migration_[0-9a-f]{12} CASCADE$/);
    assert.equal(administrativa.encerrou, 1);
  });

  test('caminho permitido: o pool confirma o banco antes de ser devolvido e usa o search_path do schema temporário', async () => {
    apontarParaLugarNenhum(PERMITIDO);
    const administrativa = conexaoFalsa(PERMITIDO);
    const pool = conexaoFalsa(PERMITIDO);
    let configuracaoDoPool;
    const contexto = await helper().abrirPoolTemporario([], { criarCliente: () => administrativa, criarPool: (configuracao) => { configuracaoDoPool = configuracao; return pool; } });
    assert.equal(contexto.pool, pool);
    assert.equal(configuracaoDoPool.database, PERMITIDO);
    assert.equal(configuracaoDoPool.options, `-c search_path=${contexto.schema}`);
    assert.match(pool.consultas[0], /^SELECT current_database\(\)/);

    await contexto.encerrar();
    assert.equal(pool.encerrou, 1);
    assert.equal(administrativa.consultas.at(-1), `DROP SCHEMA IF EXISTS ${contexto.schema} CASCADE`);
  });
});

describe('comando oficial de integração — preflight geral', () => {
  const pacote = () => require('../../package.json'); // eslint-disable-line global-require
  const ambienteDoFilho = (nome) => {
    const ambiente = { PATH: process.env.PATH, DB_HOST: '127.0.0.1', DB_PORT: '1', DB_USER: 'ninguem', DB_PASSWORD: '' };
    if (nome !== undefined) ambiente.DB_NAME = nome;
    return ambiente;
  };

  test('npm run test:integracao carrega a trava em cada processo e roda o preflight antes', () => {
    const { scripts } = pacote();
    assert.match(scripts['test:integracao'], /--require dotenv\/config .*--require \.\/test\/integracao\/exigir-banco-de-teste\.js .*--test /);
    assert.match(scripts['pretest:integracao'], /^node --require dotenv\/config test\/integracao\/preflight-banco\.js$/);
  });

  test('trava por processo: nome recusado encerra com erro antes de carregar qualquer teste; o permitido prossegue', () => {
    for (const nome of [...PROTEGIDOS, 'postgres', '', undefined]) {
      const r = spawnSync(process.execPath, ['--require', PRELOAD, '--eval', "process.stdout.write('prosseguiu')"], { env: ambienteDoFilho(nome), encoding: 'utf8' });
      assert.notEqual(r.status, 0, JSON.stringify(nome));
      assert.equal(r.stdout.includes('prosseguiu'), false, JSON.stringify(nome));
      assert.match(r.stderr, /banco recusado para testes de integração/);
    }
    const ok = spawnSync(process.execPath, ['--require', PRELOAD, '--eval', "process.stdout.write('prosseguiu')"], { env: ambienteDoFilho(PERMITIDO), encoding: 'utf8' });
    assert.deepEqual([ok.status, ok.stdout], [0, 'prosseguiu']);
  });

  test('preflight: nome recusado falha pelo nome, sem tentar conexão', () => {
    for (const nome of [...PROTEGIDOS, 'postgres', undefined]) {
      const r = spawnSync(process.execPath, [PREFLIGHT], { env: ambienteDoFilho(nome), encoding: 'utf8' });
      assert.notEqual(r.status, 0, JSON.stringify(nome));
      assert.match(r.stderr, /banco recusado para testes de integração/);
      assert.doesNotMatch(r.stderr, /ECONNREFUSED/, 'recusa anterior a qualquer conexão');
      assert.doesNotMatch(r.stdout, /confirmado/);
    }
  });

  test('preflight: nome permitido sem resposta do PostgreSQL também falha fechado, sem confirmar nada', () => {
    const r = spawnSync(process.execPath, [PREFLIGHT], { env: ambienteDoFilho(PERMITIDO), encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /não foi possível confirmar o banco de teste/);
    assert.doesNotMatch(r.stdout, /confirmado/);
  });
});
