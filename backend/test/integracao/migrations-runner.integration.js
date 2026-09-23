'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { abrirSchemaTemporario } = require('./helpers/schema-temporario');
const { aplicarMigrations } = require('../../scripts/migrate');

/**
 * Contrato do adaptador do node-pg-migrate.
 *
 * Toda execução acontece em schema temporário exclusivo, com o schema de
 * trabalho e o schema da tabela de controle apontando para o mesmo lugar. O
 * schema public nunca é lido nem escrito, e isso é verificado por assinatura
 * capturada antes e depois de todos os ensaios.
 *
 * Os cenários que precisam de migration inválida ou de ordem artificial usam
 * diretório temporário com migrations sintéticas. Os arquivos reais 000 a 023
 * nunca são modificados: eles só são lidos, no cenário de aplicação completa.
 */

const DIRETORIO_REAL = path.join(__dirname, '..', '..', 'migrations');
const TOTAL_MIGRATIONS_REAIS = 25;

const criarDiretorio = (arquivos) => {
  const diretorio = fs.mkdtempSync(path.join(os.tmpdir(), 'gestao-epi-migrations-'));
  for (const [nome, sql] of Object.entries(arquivos)) {
    fs.writeFileSync(path.join(diretorio, nome), sql);
  }
  return diretorio;
};

const removerDiretorio = (diretorio) => fs.rmSync(diretorio, { recursive: true, force: true });

const ALFA = 'CREATE TABLE alfa (id INTEGER PRIMARY KEY);\n';
const BETA = 'CREATE TABLE beta (id INTEGER PRIMARY KEY);\n';
const GAMA = 'CREATE TABLE gama (id INTEGER PRIMARY KEY);\n';
const INVALIDA = 'CREATE TABLE isso nao e sql valido (;\n';

const nomesRegistrados = async (cliente) => {
  const { rows } = await cliente.query('SELECT name FROM pgmigrations ORDER BY id');
  return rows.map((linha) => linha.name);
};

const existe = async (cliente, objeto) => {
  const { rows } = await cliente.query('SELECT to_regclass($1) IS NOT NULL AS existe', [objeto]);
  return rows[0].existe;
};

/** Assinatura do schema public, para provar que nenhum ensaio o tocou. */
const assinaturaPublic = async (cliente) => {
  const { rows } = await cliente.query(`
    SELECT
      (SELECT coalesce(string_agg(tablename, ','    ORDER BY tablename), '') FROM pg_tables WHERE schemaname = 'public') AS tabelas,
      (SELECT coalesce(string_agg(c.conname, ','    ORDER BY c.conname), '') FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'public') AS constraints,
      (SELECT coalesce(string_agg(p.proname, ','    ORDER BY p.proname), '') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public') AS funcoes,
      (SELECT coalesce(string_agg(indexname, ','    ORDER BY indexname), '') FROM pg_indexes WHERE schemaname = 'public') AS indices
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

  test('captura a assinatura de public antes de qualquer ensaio', async () => {
    publicAntes = await assinaturaPublic(contexto.cliente);
    assert.notEqual(publicAntes, null);
    assert.match(publicAntes.tabelas, /empresas/, 'a linha de base deve enxergar o public real');
    pgmigrationsEmPublicAntes = await contarPgmigrationsEmPublic(contexto.cliente);
  });
});

describe('aplicação das migrations reais em schema vazio', () => {
  let contexto;
  before(async () => { contexto = await abrirSchemaTemporario([]); });
  after(async () => { if (contexto) await contexto.encerrar(); });

  test('cria a tabela pgmigrations dentro do schema temporário', async () => {
    assert.equal(await existe(contexto.cliente, 'pgmigrations'), false, 'não deve existir antes');

    await aplicarMigrations({ schema: contexto.schema, diretorio: DIRETORIO_REAL });

    assert.equal(await existe(contexto.cliente, 'pgmigrations'), true);
    // Filtrada pelo schema do ensaio: a mesma tabela pode existir em outros
    // schemas do banco, inclusive em public, sem que isso diga nada sobre este
    // teste.
    const { rows } = await contexto.cliente.query(
      "SELECT table_schema FROM information_schema.tables WHERE table_name = 'pgmigrations' AND table_schema = $1",
      [contexto.schema],
    );
    assert.deepEqual(rows.map((linha) => linha.table_schema), [contexto.schema]);
  });

  test('aplica e registra as 25 migrations em ordem crescente', async () => {
    const registradas = await nomesRegistrados(contexto.cliente);

    assert.equal(registradas.length, TOTAL_MIGRATIONS_REAIS);
    const esperadas = fs.readdirSync(DIRETORIO_REAL)
      .filter((nome) => nome.endsWith('.sql'))
      .sort()
      .map((nome) => path.basename(nome, '.sql'));
    assert.deepEqual(registradas, esperadas);
  });

  test('a estrutura das migrations existe no schema temporário', async () => {
    assert.equal(await existe(contexto.cliente, 'empresas'), true);
    assert.equal(await existe(contexto.cliente, 'sessoes'), true);
    assert.equal(await existe(contexto.cliente, 'login_tentativas'), true);
  });

  test('a segunda execução não reaplica nem registra migration alguma', async () => {
    const aplicadas = await aplicarMigrations({ schema: contexto.schema, diretorio: DIRETORIO_REAL });

    assert.deepEqual(aplicadas, [], 'nada deve ser aplicado na segunda execução');
    assert.equal((await nomesRegistrados(contexto.cliente)).length, TOTAL_MIGRATIONS_REAIS);
  });
});

describe('falha de migration: rollback do lote', () => {
  let contexto;
  let diretorio;
  before(async () => {
    contexto = await abrirSchemaTemporario([]);
    diretorio = criarDiretorio({
      '000_cria_alfa.sql': ALFA,
      '001_invalida.sql': INVALIDA,
      '002_cria_gama.sql': GAMA,
    });
  });
  after(async () => {
    if (diretorio) removerDiretorio(diretorio);
    if (contexto) await contexto.encerrar();
  });

  test('a migration inválida faz o lote inteiro ser revertido', async () => {
    await assert.rejects(() => aplicarMigrations({ schema: contexto.schema, diretorio }));

    assert.equal(await existe(contexto.cliente, 'alfa'), false, 'a migration anterior deve ser revertida');
    assert.equal(await nomesRegistrados(contexto.cliente).then((n) => n.length), 0, 'nada deve ficar registrado');
  });

  test('as migrations posteriores à falha não são aplicadas', async () => {
    assert.equal(await existe(contexto.cliente, 'gama'), false);
  });
});

describe('checkOrder recusa migration fora de ordem', () => {
  let contexto;
  let diretorio;
  before(async () => {
    contexto = await abrirSchemaTemporario([]);
    diretorio = criarDiretorio({ '000_cria_alfa.sql': ALFA, '002_cria_gama.sql': GAMA });
  });
  after(async () => {
    if (diretorio) removerDiretorio(diretorio);
    if (contexto) await contexto.encerrar();
  });

  test('uma pendente que precede uma já aplicada é recusada', async () => {
    await aplicarMigrations({ schema: contexto.schema, diretorio });
    assert.deepEqual(await nomesRegistrados(contexto.cliente), ['000_cria_alfa', '002_cria_gama']);

    fs.writeFileSync(path.join(diretorio, '001_cria_beta.sql'), BETA);

    await assert.rejects(
      () => aplicarMigrations({ schema: contexto.schema, diretorio }),
      /preceding|ordem|order/i,
    );
    assert.equal(await existe(contexto.cliente, 'beta'), false);
  });
});

describe('concorrência: advisory lock', () => {
  let contexto;
  let diretorio;
  before(async () => {
    contexto = await abrirSchemaTemporario([]);
    diretorio = criarDiretorio({ '000_cria_alfa.sql': ALFA });
  });
  after(async () => {
    if (diretorio) removerDiretorio(diretorio);
    if (contexto) await contexto.encerrar();
  });

  test('com o cadeado já tomado, a execução falha em vez de esperar', async () => {
    const { PG_MIGRATE_LOCK_ID } = await import('node-pg-migrate');
    await contexto.cliente.query(`SELECT pg_advisory_lock(${PG_MIGRATE_LOCK_ID})`);

    try {
      await assert.rejects(() => aplicarMigrations({ schema: contexto.schema, diretorio }));
      assert.equal(await existe(contexto.cliente, 'alfa'), false, 'nada deve ser aplicado sem o cadeado');
    } finally {
      await contexto.cliente.query(`SELECT pg_advisory_unlock(${PG_MIGRATE_LOCK_ID})`);
    }
  });

  test('liberado o cadeado, a mesma execução passa', async () => {
    const aplicadas = await aplicarMigrations({ schema: contexto.schema, diretorio });

    assert.equal(aplicadas.length, 1);
    assert.equal(await existe(contexto.cliente, 'alfa'), true);
  });
});

describe('baseline: registro sem execução', () => {
  let contexto;
  before(async () => { contexto = await abrirSchemaTemporario([]); });
  after(async () => { if (contexto) await contexto.encerrar(); });

  test('o baseline registra as 25 sem executar o SQL', async () => {
    // Estrutura já aplicada, e depois a tabela de controle é descartada para
    // simular um banco anterior ao runner. Se o baseline executasse o SQL, o
    // primeiro CREATE TABLE falharia porque o objeto já existe.
    await aplicarMigrations({ schema: contexto.schema, diretorio: DIRETORIO_REAL });
    await contexto.cliente.query('DROP TABLE pgmigrations');
    assert.equal(await existe(contexto.cliente, 'empresas'), true);

    await aplicarMigrations({ schema: contexto.schema, diretorio: DIRETORIO_REAL, baseline: true });

    assert.equal((await nomesRegistrados(contexto.cliente)).length, TOTAL_MIGRATIONS_REAIS);
    assert.equal(await existe(contexto.cliente, 'empresas'), true);
  });

  test('a execução seguinte ao baseline não reaplica nada', async () => {
    const aplicadas = await aplicarMigrations({ schema: contexto.schema, diretorio: DIRETORIO_REAL });

    assert.deepEqual(aplicadas, []);
    assert.equal((await nomesRegistrados(contexto.cliente)).length, TOTAL_MIGRATIONS_REAIS);
  });
});

describe('preflight de nomes: arquivo .sql inválido não pode ser ignorado', () => {
  let contexto;
  let diretorio;
  before(async () => {
    contexto = await abrirSchemaTemporario([]);
    // SQL válido, nome inválido: quatro dígitos no prefixo. Ignorar em
    // silêncio seria pior do que falhar, porque a migration simplesmente não
    // seria aplicada e ninguém ficaria sabendo.
    diretorio = criarDiretorio({ '0017_quatro_digitos.sql': ALFA });
  });
  after(async () => {
    if (diretorio) removerDiretorio(diretorio);
    if (contexto) await contexto.encerrar();
  });

  test('prefixo de quatro dígitos é recusado com erro explícito', async () => {
    await assert.rejects(
      () => aplicarMigrations({ schema: contexto.schema, diretorio }),
      /0017_quatro_digitos\.sql/,
    );

    assert.equal(await existe(contexto.cliente, 'alfa'), false, 'nada deve ser aplicado');
    assert.equal(
      await existe(contexto.cliente, 'pgmigrations'),
      false,
      'a recusa deve acontecer antes de qualquer efeito no banco',
    );
  });
});

describe('validação de parâmetros: baseline deve ser booleano', () => {
  let contexto;
  let diretorio;
  before(async () => {
    contexto = await abrirSchemaTemporario([]);
    diretorio = criarDiretorio({ '000_cria_alfa.sql': ALFA });
  });
  after(async () => {
    if (diretorio) removerDiretorio(diretorio);
    if (contexto) await contexto.encerrar();
  });

  test("baseline com a string 'true' é recusado por tipo, sem efeito no banco", async () => {
    // baseline liga o registro sem execução, então um valor apenas truthy não
    // pode ser aceito: registraria as migrations como aplicadas sem que o SQL
    // rodasse, e o banco ficaria permanentemente sem a estrutura.
    await assert.rejects(
      () => aplicarMigrations({ schema: contexto.schema, diretorio, baseline: 'true' }),
      /baseline/i,
    );

    assert.equal(await existe(contexto.cliente, 'alfa'), false, 'nada deve ser aplicado');
    assert.equal(
      await existe(contexto.cliente, 'pgmigrations'),
      false,
      'a recusa deve acontecer antes de qualquer efeito no banco',
    );
  });
});

describe('isolamento do schema public', () => {
  let contexto;
  before(async () => { contexto = await abrirSchemaTemporario([]); });
  after(async () => { if (contexto) await contexto.encerrar(); });

  test('public permanece inalterado depois de todos os ensaios', async () => {
    assert.notEqual(publicAntes, null, 'a linha de base precisa ter sido capturada');
    const publicDepois = await assinaturaPublic(contexto.cliente);

    assert.deepEqual(publicDepois, publicAntes);
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
