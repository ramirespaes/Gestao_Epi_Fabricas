'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { abrirSchemaTemporario } = require('./helpers/schema-temporario');
const { calcularChecksum } = require('../../src/db/checksums');
const { executarComando, SAIDAS } = require('../../scripts/migrate-cli');

/**
 * Contrato dos comandos operacionais de migration.
 *
 * São três modos sobre o mesmo ponto de entrada: status, aplicar e baseline.
 * Todos operam em schema temporário exclusivo e nenhum toca em public, o que
 * é verificado por assinatura capturada antes e depois de todos os ensaios.
 *
 * O baseline é o modo perigoso, porque registra migrations sem executar o SQL
 * delas. Por isso ele exige confirmação explícita, não é autorizado apenas
 * porque o schema tem tabelas, e é recusado tanto em schema vazio quanto
 * quando já existe histórico registrado.
 *
 * As migrations usadas aqui são sintéticas, em diretório temporário com
 * manifesto próprio. Os arquivos reais 000 a 023 não são lidos nem tocados.
 */

const ALFA = 'CREATE TABLE alfa (id INTEGER PRIMARY KEY);\n';
const BETA = 'CREATE TABLE beta (id INTEGER PRIMARY KEY);\n';

const NOME_ALFA = '000_cria_alfa';
const NOME_BETA = '001_cria_beta';

const criarDiretorio = (arquivos, { manifesto = true, digests = null } = {}) => {
  const diretorio = fs.mkdtempSync(path.join(os.tmpdir(), 'gestao-epi-operacoes-'));
  for (const [nome, sql] of Object.entries(arquivos)) {
    fs.writeFileSync(path.join(diretorio, nome), sql);
  }
  if (manifesto) {
    const migrations = digests ?? Object.fromEntries(
      Object.entries(arquivos).map(([nome, sql]) => [nome, calcularChecksum(Buffer.from(sql))]),
    );
    fs.writeFileSync(
      path.join(diretorio, 'checksums.json'),
      `${JSON.stringify({ algoritmo: 'sha256', migrations }, null, 2)}\n`,
    );
  }
  return diretorio;
};

const removerDiretorio = (diretorio) => fs.rmSync(diretorio, { recursive: true, force: true });

const existe = async (cliente, objeto) => {
  const { rows } = await cliente.query('SELECT to_regclass($1) IS NOT NULL AS existe', [objeto]);
  return rows[0].existe;
};

const assinaturaPublic = async (cliente) => {
  const { rows } = await cliente.query(`
    SELECT
      (SELECT coalesce(string_agg(tablename, ',' ORDER BY tablename), '') FROM pg_tables WHERE schemaname = 'public') AS tabelas,
      (SELECT coalesce(string_agg(c.conname, ',' ORDER BY c.conname), '') FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'public') AS constraints,
      (SELECT coalesce(string_agg(p.proname, ',' ORDER BY p.proname), '') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public') AS funcoes
  `);
  return rows[0];
};

const contarPgmigrationsEmPublic = async (cliente) => {
  const { rows } = await cliente.query(
    "SELECT count(*)::int AS total FROM pg_tables WHERE schemaname = 'public' AND tablename = 'pgmigrations'",
  );
  return rows[0].total;
};

let publicAntes = null;
let pgmigrationsEmPublicAntes = null;

describe('linha de base do schema public', () => {
  let contexto;
  before(async () => { contexto = await abrirSchemaTemporario([]); });
  after(async () => { if (contexto) await contexto.encerrar(); });

  test('captura a assinatura de public antes dos ensaios operacionais', async () => {
    publicAntes = await assinaturaPublic(contexto.cliente);
    assert.match(publicAntes.tabelas, /empresas/);
    pgmigrationsEmPublicAntes = await contarPgmigrationsEmPublic(contexto.cliente);
  });
});

describe('status: somente leitura', () => {
  let contexto;
  let diretorio;
  before(async () => {
    contexto = await abrirSchemaTemporario([]);
    diretorio = criarDiretorio({ '000_cria_alfa.sql': ALFA, '001_cria_beta.sql': BETA });
  });
  after(async () => {
    if (diretorio) removerDiretorio(diretorio);
    if (contexto) await contexto.encerrar();
  });

  test('em schema vazio, relata tudo pendente e não cria a tabela de controle', async () => {
    const resultado = await executarComando({ modo: 'status', schema: contexto.schema, diretorio });

    assert.equal(resultado.saida, SAIDAS.DIVERGENCIA, 'pendências devem sinalizar saída própria');
    assert.equal(resultado.relatorio.controleExiste, false);
    assert.equal(resultado.relatorio.schemaTemObjetos, false);
    assert.deepEqual(resultado.relatorio.aplicadas, []);
    assert.deepEqual(resultado.relatorio.pendentes, [NOME_ALFA, NOME_BETA]);
    assert.deepEqual(resultado.relatorio.semArquivo, []);

    assert.equal(await existe(contexto.cliente, 'pgmigrations'), false, 'status não pode criar a tabela de controle');
    assert.equal(await existe(contexto.cliente, 'alfa'), false, 'status não pode aplicar nada');
  });

  test('depois de aplicar, relata tudo aplicado e nada pendente', async () => {
    await executarComando({ modo: 'aplicar', schema: contexto.schema, diretorio });

    const resultado = await executarComando({ modo: 'status', schema: contexto.schema, diretorio });

    assert.equal(resultado.saida, SAIDAS.OK);
    assert.equal(resultado.relatorio.controleExiste, true);
    assert.deepEqual(resultado.relatorio.aplicadas, [NOME_ALFA, NOME_BETA]);
    assert.deepEqual(resultado.relatorio.pendentes, []);
    assert.deepEqual(resultado.relatorio.semArquivo, []);
  });

  test('registro sem arquivo correspondente é distinguido das demais categorias', async () => {
    const parcial = criarDiretorio({ '000_cria_alfa.sql': ALFA });
    try {
      const resultado = await executarComando({ modo: 'status', schema: contexto.schema, diretorio: parcial });

      assert.deepEqual(resultado.relatorio.aplicadas, [NOME_ALFA]);
      assert.deepEqual(resultado.relatorio.pendentes, []);
      assert.deepEqual(resultado.relatorio.semArquivo, [NOME_BETA]);
      assert.equal(resultado.saida, SAIDAS.DIVERGENCIA);
    } finally {
      removerDiretorio(parcial);
    }
  });
});

describe('aplicar: verificação de checksum antes de qualquer efeito', () => {
  let contexto;
  let diretorio;
  before(async () => {
    contexto = await abrirSchemaTemporario([]);
    // Manifesto declarando um digest que não corresponde ao arquivo.
    diretorio = criarDiretorio(
      { '000_cria_alfa.sql': ALFA },
      { digests: { '000_cria_alfa.sql': calcularChecksum(Buffer.from('outro conteudo')) } },
    );
  });
  after(async () => {
    if (diretorio) removerDiretorio(diretorio);
    if (contexto) await contexto.encerrar();
  });

  test('checksum divergente bloqueia a aplicação antes de tocar no banco', async () => {
    const resultado = await executarComando({ modo: 'aplicar', schema: contexto.schema, diretorio });

    assert.equal(resultado.saida, SAIDAS.DIVERGENCIA);
    assert.equal(await existe(contexto.cliente, 'pgmigrations'), false, 'nem a tabela de controle deve surgir');
    assert.equal(await existe(contexto.cliente, 'alfa'), false);
  });
});

describe('aplicar: estrutura existente sem tabela de controle', () => {
  let contexto;
  let diretorio;
  before(async () => {
    contexto = await abrirSchemaTemporario([]);
    diretorio = criarDiretorio({ '000_cria_alfa.sql': ALFA });
    // Simula o estado de um banco migrado à mão, antes do controle existir.
    await contexto.cliente.query('CREATE TABLE legado (id INTEGER PRIMARY KEY)');
  });
  after(async () => {
    if (diretorio) removerDiretorio(diretorio);
    if (contexto) await contexto.encerrar();
  });

  test('a aplicação normal é bloqueada com código próprio', async () => {
    const resultado = await executarComando({ modo: 'aplicar', schema: contexto.schema, diretorio });

    assert.equal(resultado.saida, SAIDAS.ESTRUTURA_SEM_CONTROLE);
    assert.equal(await existe(contexto.cliente, 'pgmigrations'), false);
    assert.equal(await existe(contexto.cliente, 'alfa'), false);
  });
});

describe('aplicar: schema vazio e segunda execução', () => {
  let contexto;
  let diretorio;
  before(async () => {
    contexto = await abrirSchemaTemporario([]);
    diretorio = criarDiretorio({ '000_cria_alfa.sql': ALFA, '001_cria_beta.sql': BETA });
  });
  after(async () => {
    if (diretorio) removerDiretorio(diretorio);
    if (contexto) await contexto.encerrar();
  });

  test('schema vazio recebe as migrations normalmente', async () => {
    const resultado = await executarComando({ modo: 'aplicar', schema: contexto.schema, diretorio });

    assert.equal(resultado.saida, SAIDAS.OK);
    assert.deepEqual(resultado.aplicadas, [NOME_ALFA, NOME_BETA]);
    assert.equal(await existe(contexto.cliente, 'alfa'), true);
    assert.equal(await existe(contexto.cliente, 'beta'), true);
  });

  test('a segunda execução não reaplica migration alguma', async () => {
    const resultado = await executarComando({ modo: 'aplicar', schema: contexto.schema, diretorio });

    assert.equal(resultado.saida, SAIDAS.OK);
    assert.deepEqual(resultado.aplicadas, []);

    const status = await executarComando({ modo: 'status', schema: contexto.schema, diretorio });
    assert.deepEqual(status.relatorio.aplicadas, [NOME_ALFA, NOME_BETA]);
  });
});

describe('baseline: exige confirmação explícita', () => {
  let contexto;
  let diretorio;
  before(async () => {
    contexto = await abrirSchemaTemporario([]);
    diretorio = criarDiretorio({ '000_cria_alfa.sql': ALFA });
    await contexto.cliente.query(ALFA);
  });
  after(async () => {
    if (diretorio) removerDiretorio(diretorio);
    if (contexto) await contexto.encerrar();
  });

  test('sem confirmação, o baseline é recusado mesmo com estrutura presente', async () => {
    const resultado = await executarComando({ modo: 'baseline', schema: contexto.schema, diretorio });

    assert.equal(resultado.saida, SAIDAS.BASELINE_NAO_CONFIRMADO);
    assert.equal(await existe(contexto.cliente, 'pgmigrations'), false, 'nada deve ser registrado sem confirmação');
  });

  test('a presença de tabelas não autoriza sozinha: só a confirmação autoriza', async () => {
    assert.equal(await existe(contexto.cliente, 'alfa'), true, 'a estrutura já existe neste schema');

    const recusado = await executarComando({ modo: 'baseline', schema: contexto.schema, diretorio, confirmado: false });
    assert.equal(recusado.saida, SAIDAS.BASELINE_NAO_CONFIRMADO);

    const aceito = await executarComando({ modo: 'baseline', schema: contexto.schema, diretorio, confirmado: true });
    assert.equal(aceito.saida, SAIDAS.OK);
    assert.deepEqual(aceito.registradas, [NOME_ALFA]);
  });

  test('o baseline registra sem executar o SQL', async () => {
    const status = await executarComando({ modo: 'status', schema: contexto.schema, diretorio });

    assert.deepEqual(status.relatorio.aplicadas, [NOME_ALFA]);
    assert.deepEqual(status.relatorio.pendentes, []);
    assert.equal(await existe(contexto.cliente, 'alfa'), true, 'a tabela pré-existente continua de pé');
  });
});

describe('baseline: recusas por estado do schema', () => {
  let vazio;
  let comHistorico;
  let diretorio;
  before(async () => {
    vazio = await abrirSchemaTemporario([]);
    comHistorico = await abrirSchemaTemporario([]);
    diretorio = criarDiretorio({ '000_cria_alfa.sql': ALFA });
  });
  after(async () => {
    if (diretorio) removerDiretorio(diretorio);
    if (vazio) await vazio.encerrar();
    if (comHistorico) await comHistorico.encerrar();
  });

  test('schema vazio não pode receber baseline', async () => {
    const resultado = await executarComando({ modo: 'baseline', schema: vazio.schema, diretorio, confirmado: true });

    assert.equal(resultado.saida, SAIDAS.BASELINE_INDEVIDO);
    assert.equal(await existe(vazio.cliente, 'pgmigrations'), false);
  });

  test('schema com histórico já registrado não pode receber baseline', async () => {
    await executarComando({ modo: 'aplicar', schema: comHistorico.schema, diretorio });
    assert.equal(await existe(comHistorico.cliente, 'pgmigrations'), true);

    const resultado = await executarComando({
      modo: 'baseline', schema: comHistorico.schema, diretorio, confirmado: true,
    });

    assert.equal(resultado.saida, SAIDAS.BASELINE_INDEVIDO);
    const status = await executarComando({ modo: 'status', schema: comHistorico.schema, diretorio });
    assert.deepEqual(status.relatorio.aplicadas, [NOME_ALFA], 'o histórico existente não pode ser duplicado');
  });
});

describe('isolamento do schema public', () => {
  let contexto;
  before(async () => { contexto = await abrirSchemaTemporario([]); });
  after(async () => { if (contexto) await contexto.encerrar(); });

  test('public permanece inalterado depois de todos os ensaios operacionais', async () => {
    assert.notEqual(publicAntes, null);
    assert.deepEqual(await assinaturaPublic(contexto.cliente), publicAntes);
  });

  // A tabela de controle pode existir legitimamente em public, porque o banco
  // de desenvolvimento passou a ser gerido pelo runner. O que os ensaios não
  // podem fazer é criá-la ou removê-la de lá, então o contrato é a ausência de
  // mudança, e não a ausência da tabela.
  test('os ensaios não criam nem removem pgmigrations em public', async () => {
    assert.notEqual(pgmigrationsEmPublicAntes, null, 'a linha de base precisa ter sido capturada');
    assert.equal(await contarPgmigrationsEmPublic(contexto.cliente), pgmigrationsEmPublicAntes);
  });
});
