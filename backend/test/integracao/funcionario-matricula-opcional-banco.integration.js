'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { todasAsMigrations, criarEmpresa, criarFuncionario } = require('./helpers/entrega-epi');

/**
 * 12K-E — ESTRUTURA da matrícula opcional (RED da migration 081, ainda inexistente): funcionarios.matricula e
 * entregas_epi.trabalhador_matricula ainda são NOT NULL e os CHECKs futuros ainda não existem. PostgreSQL real em
 * schema temporário. Os fluxos de entrega que dependem desta migration estão em
 * funcionario-matricula-opcional-entregas.integration.js (GREEN dependente da 081).
 */

let cpfSeq = 70000000000;
const proximoCpf = () => String(cpfSeq++);

describe('12K-E — estrutura da matrícula opcional (migration 081 ausente)', () => {
  let contexto;
  let pool;
  const q = (sql, params) => pool.query(sql, params);

  before(async () => {
    contexto = await abrirPoolTemporario(todasAsMigrations());
    pool = contexto.pool;
  });
  after(async () => { if (contexto) await contexto.encerrar(); });

  test('funcionarios.matricula aceita NULL', async () => {
    const { rows } = await q(
      "SELECT is_nullable FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'funcionarios' AND column_name = 'matricula'",
    );
    assert.equal(rows[0].is_nullable, 'YES');
  });

  test('entregas_epi.trabalhador_matricula aceita NULL', async () => {
    const { rows } = await q(
      "SELECT is_nullable FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'entregas_epi' AND column_name = 'trabalhador_matricula'",
    );
    assert.equal(rows[0].is_nullable, 'YES');
  });

  test('o CHECK do snapshot da entrega valida a matrícula somente quando ela existe', async () => {
    const { rows } = await q(
      `SELECT pg_get_constraintdef(c.oid) AS definicao FROM pg_constraint c
        WHERE c.conrelid = 'entregas_epi'::regclass AND c.conname = 'chk_entregas_epi_snapshots_aparados'`,
    );
    assert.match(rows[0].definicao, /trabalhador_matricula IS NULL/);
  });

  test('existe CHECK em funcionarios que só admite matrícula NULL ou aparada e não vazia', async () => {
    const { rows } = await q(
      `SELECT pg_get_constraintdef(c.oid) AS definicao FROM pg_constraint c
        WHERE c.conrelid = 'funcionarios'::regclass AND c.contype = 'c' AND pg_get_constraintdef(c.oid) ILIKE '%matricula%'`,
    );
    assert.equal(rows.length, 1, 'um CHECK de formato da matrícula');
    assert.match(rows[0].definicao, /matricula IS NULL/);
  });

  test('dois funcionários sem matrícula na mesma empresa convivem; a UNIQUE da matrícula informada continua valendo', async () => {
    const empresa = await criarEmpresa(pool, '66777888000181', 'Empresa Estrutura');
    const a = await criarFuncionario(pool, empresa, { matricula: null, cpf: proximoCpf() });
    const b = await criarFuncionario(pool, empresa, { matricula: null, cpf: proximoCpf() });
    assert.notEqual(a, b);
    await criarFuncionario(pool, empresa, { matricula: 'UNICA', cpf: proximoCpf() });
    await assert.rejects(
      criarFuncionario(pool, empresa, { matricula: 'UNICA', cpf: proximoCpf() }),
      (e) => e.code === '23505' && e.constraint === 'uq_funcionarios_empresa_matricula',
    );
  });

  test('string vazia ou com espaços externos NÃO substitui NULL: o banco recusa com violação de CHECK', async () => {
    const empresa = await criarEmpresa(pool, '77888999000181', 'Empresa Check');
    for (const ruim of ['', ' M1', 'M1 ', '   ']) {
      // eslint-disable-next-line no-await-in-loop
      await assert.rejects(criarFuncionario(pool, empresa, { matricula: ruim, cpf: proximoCpf() }), (e) => e.code === '23514', `matrícula ${JSON.stringify(ruim)} deveria violar CHECK`);
    }
  });
});
