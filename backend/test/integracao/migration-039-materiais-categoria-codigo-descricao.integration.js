'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { abrirSchemaTemporario, inserirEmpresa, migrationExiste, conteudoDaMigration } = require('./helpers/schema-temporario');

/**
 * Migration 039 — materiais: categoria, código interno e descrição (Bloco 9,
 * Etapa C, Parte C2). PostgreSQL real, schema temporário exclusivo.
 *
 * Contrato aprovado: ALTER aditivo sobre a 007 (intocada); três colunas
 * NULÁVEIS (registros existentes ficam como estão); código interno ÚNICO
 * por empresa (case-insensitive), livre entre empresas; NULL nunca
 * conflita com NULL; string vazia ou só espaços é recusada pelo banco
 * (a aplicação já converte vazio em NULL — o CHECK é a segunda barreira).
 */

const MIGRATIONS = ['000', '001', '002', '007', '039'];
const VIOLACAO_UNIQUE = '23505';
const VIOLACAO_CHECK = '23514';
const TAMANHO_TEXTO_LONGO = '22001';

describe('migration 039 — materiais.categoria / codigo_interno / descricao', () => {
  let contexto;
  let c;
  let empresaA;
  let empresaB;

  const inserir = async (empresaId, extra = {}) => {
    try {
      const { rows } = await c.query(
        'INSERT INTO materiais (empresa_id, nome, categoria, codigo_interno, descricao) VALUES ($1, $2, $3, $4, $5) RETURNING id, categoria, codigo_interno, descricao',
        [empresaId, extra.nome ?? 'Material', extra.categoria ?? null, extra.codigoInterno ?? null, extra.descricao ?? null],
      );
      return { ok: true, linha: rows[0] };
    } catch (erro) {
      return { ok: false, code: erro.code };
    }
  };

  before(async () => {
    contexto = await abrirSchemaTemporario(MIGRATIONS);
    c = contexto.cliente;
    await inserirEmpresa(c, '11222333000181', 'A');
    await inserirEmpresa(c, '22333444000100', 'B');
    const { rows } = await c.query('SELECT id FROM empresas ORDER BY id');
    [empresaA, empresaB] = [rows[0].id, rows[1].id];
  });
  after(async () => { if (contexto) await contexto.encerrar(); });

  test('registro anterior à migration continua íntegro: as três colunas nascem NULL e o INSERT antigo (sem elas) segue válido', async () => {
    const antes = await c.query("INSERT INTO materiais (empresa_id, nome) VALUES ($1, 'Legado') RETURNING categoria, codigo_interno, descricao", [empresaA]);
    assert.deepEqual(antes.rows[0], { categoria: null, codigo_interno: null, descricao: null });
  });

  test('grava as três colunas; código interno único por empresa, inclusive ignorando maiúsculas/minúsculas', async () => {
    const r = await inserir(empresaA, { categoria: 'EPI', codigoInterno: 'EPI-000245', descricao: 'Botina com biqueira' });
    assert.equal(r.ok, true);
    assert.deepEqual([r.linha.categoria, r.linha.codigo_interno, r.linha.descricao], ['EPI', 'EPI-000245', 'Botina com biqueira']);
    const repetido = await inserir(empresaA, { codigoInterno: 'EPI-000245' });
    assert.deepEqual([repetido.ok, repetido.code], [false, VIOLACAO_UNIQUE]);
    const caixa = await inserir(empresaA, { codigoInterno: 'epi-000245' });
    assert.deepEqual([caixa.ok, caixa.code], [false, VIOLACAO_UNIQUE], 'case-insensitive');
  });

  test('empresas diferentes podem usar o mesmo código interno', async () => {
    const r = await inserir(empresaB, { codigoInterno: 'EPI-000245' });
    assert.equal(r.ok, true);
  });

  test('vários materiais sem código interno (NULL) na mesma empresa não conflitam', async () => {
    assert.equal((await inserir(empresaA, { nome: 'Sem código 1' })).ok, true);
    assert.equal((await inserir(empresaA, { nome: 'Sem código 2' })).ok, true);
  });

  test('vazio ou só espaços em categoria/código/descrição é recusado pelo banco (CHECK); espaços nas pontas também', async () => {
    for (const extra of [{ codigoInterno: '' }, { codigoInterno: '   ' }, { codigoInterno: ' X-1' }, { codigoInterno: 'X-1 ' }, { categoria: '' }, { categoria: ' EPI' }, { descricao: '' }, { descricao: '  ' }]) {
      const r = await inserir(empresaA, extra);
      assert.deepEqual([r.ok, r.code], [false, VIOLACAO_CHECK], JSON.stringify(extra));
    }
  });

  test('limites: categoria e código até 30, descrição até 500', async () => {
    assert.equal((await inserir(empresaA, { categoria: 'a'.repeat(30), codigoInterno: 'b'.repeat(30), descricao: 'c'.repeat(500) })).ok, true);
    const cat = await inserir(empresaA, { categoria: 'a'.repeat(31) });
    assert.deepEqual([cat.ok, cat.code], [false, TAMANHO_TEXTO_LONGO]);
    const cod = await inserir(empresaA, { codigoInterno: 'z'.repeat(31) });
    assert.deepEqual([cod.ok, cod.code], [false, TAMANHO_TEXTO_LONGO]);
    const desc = await inserir(empresaA, { descricao: 'c'.repeat(501) });
    assert.deepEqual([desc.ok, desc.code], [false, VIOLACAO_CHECK]);
  });

  test('índice único parcial existe e não alcança linhas com código NULL', async () => {
    const { rows } = await c.query("SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = 'uq_materiais_empresa_codigo_interno'", [contexto.schema]);
    assert.equal(rows.length, 1);
    assert.match(rows[0].indexdef, /UNIQUE/);
    assert.match(rows[0].indexdef, /upper\(\(codigo_interno\)::text\)|upper\(codigo_interno\)/);
    assert.match(rows[0].indexdef, /WHERE \(codigo_interno IS NOT NULL\)/);
  });
});

describe('estrutura declarada na migration 039 (sem banco)', () => {
  test('existe, é aditiva e não toca a 007', () => {
    assert.equal(migrationExiste('039'), true);
    const sql = conteudoDaMigration('039').replace(/^--.*$/gm, '');
    assert.match(sql, /ALTER TABLE materiais/);
    assert.match(sql, /ADD COLUMN categoria\s+VARCHAR\(30\)/);
    assert.match(sql, /ADD COLUMN codigo_interno\s+VARCHAR\(30\)/);
    assert.match(sql, /ADD COLUMN descricao\s+TEXT/);
    for (const clausula of sql.match(/ADD COLUMN[^,;]*/g)) {
      assert.doesNotMatch(clausula, /NOT NULL|DEFAULT/, 'coluna nova nasce nulável e sem DEFAULT');
    }
    assert.doesNotMatch(sql, /DROP|UPDATE materiais|DELETE|ALTER COLUMN/);
    assert.match(sql, /CREATE UNIQUE INDEX uq_materiais_empresa_codigo_interno/);
    assert.equal(conteudoDaMigration('007').includes('categoria'), false, 'a 007 permanece intocada');
  });
});
