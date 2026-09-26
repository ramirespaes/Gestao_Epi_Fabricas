'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { abrirSchemaTemporario, inserirEmpresa, migrationExiste, conteudoDaMigration } = require('./helpers/schema-temporario');

/**
 * Migration 040 — funcionarios.data_admissao (Bloco 9, Etapa C, Parte C4,
 * decisão D2 de 25/09/2026). PostgreSQL real, schema temporário exclusivo.
 *
 * Contrato aprovado: ALTER aditivo sobre a 006 (intocada); coluna DATE
 * NULÁVEL e sem DEFAULT (registros existentes ficam como estão); admissão
 * nunca antes de 1900-01-01; admissão sempre DEPOIS do nascimento quando os
 * dois existem; data futura permitida (admissão agendada).
 */

const MIGRATIONS = ['000', '001', '002', '004', '006', '040'];
const VIOLACAO_CHECK = '23514';

describe('migration 040 — funcionarios.data_admissao', () => {
  let contexto;
  let c;
  let empresa;
  let sequencia = 0;

  const inserir = async (extra = {}) => {
    sequencia += 1;
    try {
      const { rows } = await c.query(
        `INSERT INTO funcionarios (empresa_id, matricula, nome, cpf, data_nascimento, data_admissao)
         VALUES ($1, $2, 'Funcionário', $3, $4, $5)
         RETURNING to_char(data_nascimento, 'YYYY-MM-DD') AS nascimento, to_char(data_admissao, 'YYYY-MM-DD') AS admissao`,
        [empresa, `M-${sequencia}`, String(10000000000 + sequencia), extra.nascimento ?? null, extra.admissao ?? null],
      );
      return { ok: true, linha: rows[0] };
    } catch (erro) {
      return { ok: false, code: erro.code, constraint: erro.constraint };
    }
  };

  before(async () => {
    contexto = await abrirSchemaTemporario(MIGRATIONS);
    c = contexto.cliente;
    await inserirEmpresa(c, '11222333000181', 'A');
    empresa = (await c.query('SELECT id FROM empresas ORDER BY id LIMIT 1')).rows[0].id;
  });
  after(async () => { if (contexto) await contexto.encerrar(); });

  test('coluna DATE nulável, sem DEFAULT; o INSERT antigo (sem a coluna) continua válido e nasce com NULL', async () => {
    const { rows } = await c.query(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'funcionarios' AND column_name = 'data_admissao'`,
      [contexto.schema],
    );
    assert.deepEqual(rows, [{ data_type: 'date', is_nullable: 'YES', column_default: null }]);
    const legado = await c.query("INSERT INTO funcionarios (empresa_id, matricula, nome, cpf) VALUES ($1, 'LEGADO', 'Legado', '52998224725') RETURNING data_admissao", [empresa]);
    assert.equal(legado.rows[0].data_admissao, null);
  });

  test('aceita: nula, sem nascimento, 1900-01-01, depois do nascimento e data futura', async () => {
    for (const extra of [{}, { admissao: '2020-06-01' }, { admissao: '1900-01-01' }, { nascimento: '1990-03-15', admissao: '2010-01-02' }, { admissao: '2099-12-31' }]) {
      const r = await inserir(extra);
      assert.equal(r.ok, true, JSON.stringify(extra));
      assert.equal(r.linha.admissao, extra.admissao ?? null);
    }
  });

  test('recusa: antes de 1900-01-01 (chk_funcionarios_data_admissao_minima)', async () => {
    const r = await inserir({ admissao: '1899-12-31' });
    assert.deepEqual([r.ok, r.code, r.constraint], [false, VIOLACAO_CHECK, 'chk_funcionarios_data_admissao_minima']);
  });

  test('recusa: admissão no mesmo dia ou antes do nascimento (chk_funcionarios_admissao_apos_nascimento)', async () => {
    for (const extra of [{ nascimento: '1990-03-15', admissao: '1990-03-15' }, { nascimento: '1990-03-15', admissao: '1980-01-01' }]) {
      const r = await inserir(extra);
      assert.deepEqual([r.ok, r.code, r.constraint], [false, VIOLACAO_CHECK, 'chk_funcionarios_admissao_apos_nascimento'], JSON.stringify(extra));
    }
  });

  test('UPDATE também é barrado: nascimento posterior a uma admissão já gravada', async () => {
    const r = await inserir({ admissao: '2010-01-02' });
    assert.equal(r.ok, true);
    await assert.rejects(
      c.query("UPDATE funcionarios SET data_nascimento = '2011-01-01' WHERE matricula = $1", [`M-${sequencia}`]),
      (e) => e.code === VIOLACAO_CHECK && e.constraint === 'chk_funcionarios_admissao_apos_nascimento',
    );
  });
});

describe('estrutura declarada na migration 040 (sem banco)', () => {
  test('existe, é aditiva, nulável, sem DEFAULT e não toca a 006', () => {
    assert.equal(migrationExiste('040'), true);
    const sql = conteudoDaMigration('040').replace(/^--.*$/gm, '');
    assert.match(sql, /ALTER TABLE funcionarios/);
    assert.match(sql, /ADD COLUMN data_admissao\s+DATE/);
    for (const clausula of sql.match(/ADD COLUMN[^,;]*/g)) {
      assert.doesNotMatch(clausula, /NOT NULL|DEFAULT/, 'coluna nova nasce nulável e sem DEFAULT');
    }
    assert.match(sql, /chk_funcionarios_data_admissao_minima/);
    assert.match(sql, /chk_funcionarios_admissao_apos_nascimento/);
    assert.doesNotMatch(sql, /DROP|UPDATE funcionarios|DELETE|ALTER COLUMN|CURRENT_DATE/);
    assert.equal(conteudoDaMigration('006').includes('data_admissao'), false, 'a 006 permanece intocada');
  });
});
