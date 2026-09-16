'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { abrirSchemaTemporario, inserirEmpresa, migrationExiste, conteudoDaMigration } = require('./helpers/schema-temporario');
const { normalizarCnpj } = require('../../src/utils/normalizacao');

const VIOLACAO_CHECK = '23514';
const VIOLACAO_UNIQUE = '23505';
const VALOR_LONGO_DEMAIS = '22001';

const NUMERICO = '12345678000195';
const ALFANUMERICO = '00000000E08G12';
const SO_LETRAS = 'ABCDEFGHIJKL00';

describe('estado anterior: migrations 000 + 001 (documenta o defeito)', () => {
  let contexto;
  before(async () => { contexto = await abrirSchemaTemporario(['000', '001']); });
  after(async () => { if (contexto) await contexto.encerrar(); });

  test('CNPJ numérico tradicional é aceito', async () => {
    assert.equal(await inserirEmpresa(contexto.cliente, NUMERICO), 'ok');
  });

  test('CNPJ alfanumérico é rejeitado pela constraint antiga', async () => {
    assert.equal(await inserirEmpresa(contexto.cliente, ALFANUMERICO), VIOLACAO_CHECK);
    assert.equal(await inserirEmpresa(contexto.cliente, SO_LETRAS), VIOLACAO_CHECK);
  });

  test('a constraint vigente ainda é a numérica da migration 001', async () => {
    const { rows } = await contexto.cliente.query(
      "SELECT pg_get_constraintdef(oid) AS definicao FROM pg_constraint WHERE conrelid = (quote_ident($1) || '.empresas')::regclass AND conname = 'chk_empresas_cnpj_formato'",
      [contexto.schema],
    );
    assert.equal(rows.length, 1);
    assert.match(rows[0].definicao, /\^\[0-9\]\{14\}\$/);
  });
});

describe('estado corrigido: migrations 000 + 001 + 016', () => {
  let contexto;
  before(async () => { contexto = await abrirSchemaTemporario(['000', '001', '016']); });
  after(async () => { if (contexto) await contexto.encerrar(); });

  test('aceita CNPJ numérico, alfanumérico e com doze letras', async () => {
    assert.equal(await inserirEmpresa(contexto.cliente, NUMERICO, 'Numerica'), 'ok');
    assert.equal(await inserirEmpresa(contexto.cliente, ALFANUMERICO, 'Alfanumerica'), 'ok');
    assert.equal(await inserirEmpresa(contexto.cliente, SO_LETRAS, 'Letras'), 'ok');
  });

  test('rejeita minúsculas, letra nos dígitos verificadores e símbolos', async () => {
    const rejeitados = ['00000000e08g12', '00000000E08GA2', '00000000E08G1A', '12.345.678/001', '12345678-0019'];
    for (const cnpj of rejeitados) {
      assert.equal(await inserirEmpresa(contexto.cliente, cnpj), VIOLACAO_CHECK, cnpj);
    }
  });

  test('rejeita comprimento diferente de 14', async () => {
    assert.equal(await inserirEmpresa(contexto.cliente, '1234567800019'), VIOLACAO_CHECK, '13 caracteres');
    const quinze = await inserirEmpresa(contexto.cliente, '123456780001951');
    assert.ok([VIOLACAO_CHECK, VALOR_LONGO_DEMAIS].includes(quinze), `15 caracteres: esperado 23514 ou 22001, recebido ${quinze}`);
  });

  test('UNIQUE continua impedindo CNPJ alfanumérico duplicado', async () => {
    assert.equal(await inserirEmpresa(contexto.cliente, '00000000E08G99', 'Primeira'), 'ok');
    assert.equal(await inserirEmpresa(contexto.cliente, '00000000E08G99', 'Segunda'), VIOLACAO_UNIQUE);
  });

  test('a constraint passou a aceitar o formato alfanumérico', async () => {
    const { rows } = await contexto.cliente.query(
      "SELECT pg_get_constraintdef(oid) AS definicao FROM pg_constraint WHERE conrelid = (quote_ident($1) || '.empresas')::regclass AND conname = 'chk_empresas_cnpj_formato'",
      [contexto.schema],
    );
    assert.equal(rows.length, 1, 'a constraint deve continuar existindo com o mesmo nome');
    assert.match(rows[0].definicao, /\[0-9A-Z\]\{12\}/);
  });

  test('a coluna, a UNIQUE e a chave primária permanecem intactas', async () => {
    const coluna = await contexto.cliente.query(
      'SELECT data_type, character_maximum_length, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3',
      [contexto.schema, 'empresas', 'cnpj'],
    );
    assert.deepEqual(coluna.rows[0], { data_type: 'character varying', character_maximum_length: 14, is_nullable: 'NO' });
    const constraints = await contexto.cliente.query(
      "SELECT conname FROM pg_constraint WHERE conrelid = (quote_ident($1) || '.empresas')::regclass ORDER BY conname",
      [contexto.schema],
    );
    const nomes = constraints.rows.map((linha) => linha.conname);
    assert.ok(nomes.includes('uq_empresas_cnpj'), 'uq_empresas_cnpj preservada');
    assert.ok(nomes.includes('empresas_pkey'), 'chave primária preservada');
  });
});

describe('consistência entre a aplicação e o banco corrigido', () => {
  let contexto;
  before(async () => { contexto = await abrirSchemaTemporario(['000', '001', '016']); });
  after(async () => { if (contexto) await contexto.encerrar(); });

  test('toda saída de normalizarCnpj é aceita pelo banco', async () => {
    const entradas = ['12.345.678/0001-95', '12345678000195', '00.000.000/E08G-12', '00000000e08g12', 'AB.CDE.FGH/IJKL-00', '  12345678000195  '];
    const vistos = new Set();
    for (const entrada of entradas) {
      const normalizado = normalizarCnpj(entrada);
      assert.notEqual(normalizado, null, `normalizarCnpj deveria aceitar ${entrada}`);
      if (vistos.has(normalizado)) {
        continue;
      }
      vistos.add(normalizado);
      assert.equal(await inserirEmpresa(contexto.cliente, normalizado, `Empresa ${vistos.size}`), 'ok', `banco deveria aceitar ${entrada}`);
    }
  });

  // Valor próprio, e não ALFANUMERICO: o teste anterior já gravou a forma
  // normalizada dele neste mesmo schema, e a UNIQUE recusaria a repetição
  // antes de o CHECK ser exercitado.
  test('lowercase: a aplicação normaliza para uppercase válido, mas o banco recusa o valor bruto', async () => {
    const bruto = '00000000e08g99';
    const maiusculas = '00000000E08G99';
    const normalizado = normalizarCnpj(bruto);
    assert.equal(normalizado, maiusculas, 'normalizarCnpj deve converter para maiúsculas, não rejeitar');
    assert.equal(await inserirEmpresa(contexto.cliente, bruto, 'Bruto minúsculo'), VIOLACAO_CHECK, 'banco recusa lowercase');
    assert.equal(await inserirEmpresa(contexto.cliente, normalizado, 'Normalizado'), 'ok', 'banco aceita o valor já normalizado');
  });

  test('formato realmente inválido: a aplicação rejeita e o banco também recusa o valor bruto', async () => {
    for (const invalido of ['00000000E08GA2', '1234567800019']) {
      assert.equal(normalizarCnpj(invalido), null, `normalizarCnpj deve rejeitar ${invalido}`);
      assert.equal(await inserirEmpresa(contexto.cliente, invalido), VIOLACAO_CHECK, invalido);
    }
  });
});

describe('proteção complementar sem banco: expressão declarada na migration 016', () => {
  test('a migration 016 existe e declara o formato alfanumérico', () => {
    assert.equal(migrationExiste('016'), true, 'migrations/016_*.sql deve existir');
    const sql = conteudoDaMigration('016');
    assert.match(sql, /ALTER TABLE empresas/i);
    assert.match(sql, /DROP CONSTRAINT chk_empresas_cnpj_formato/i);
    assert.match(sql, /\[0-9A-Z\]\{12\}\[0-9\]\{2\}/);
  });
});

describe('transição de um banco já populado', () => {
  const PREEXISTENTE = '98765432000110';

  test('a linha antiga sobrevive à migration e a constraint passa a ser alfanumérica', async () => {
    const contexto = await abrirSchemaTemporario(['000', '001']);
    try {
      assert.equal(await inserirEmpresa(contexto.cliente, PREEXISTENTE, 'Empresa Preexistente'), 'ok');

      const antes = await contexto.cliente.query('SELECT cnpj FROM empresas WHERE cnpj = $1', [PREEXISTENTE]);
      assert.equal(antes.rows.length, 1, 'a linha deve existir antes da migration');

      // Falha aqui aborta o teste com o erro real do PostgreSQL: executar sem
      // lançar já é a confirmação de que a migration roda sobre dados vivos.
      await contexto.cliente.query(conteudoDaMigration('016'));

      const depois = await contexto.cliente.query('SELECT cnpj FROM empresas WHERE cnpj = $1', [PREEXISTENTE]);
      assert.equal(depois.rows.length, 1, 'a linha deve continuar existindo depois da migration');
      assert.equal(depois.rows[0].cnpj, PREEXISTENTE, 'o CNPJ gravado não deve ser alterado');

      const { rows } = await contexto.cliente.query(
        "SELECT pg_get_constraintdef(oid) AS definicao FROM pg_constraint WHERE conrelid = (quote_ident($1) || '.empresas')::regclass AND conname = 'chk_empresas_cnpj_formato'",
        [contexto.schema],
      );
      assert.equal(rows.length, 1, 'a constraint deve manter o mesmo nome');
      assert.match(rows[0].definicao, /\[0-9A-Z\]\{12\}\[0-9\]\{2\}/);
    } finally {
      await contexto.encerrar();
    }
  });
});
