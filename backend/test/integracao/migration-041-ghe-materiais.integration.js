'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { abrirSchemaTemporario, inserirEmpresa } = require('./helpers/schema-temporario');

/**
 * Migration 041 — ghe_materiais (Bloco 9, Etapa C, Parte C5): vínculo
 * GHE ↔ EPI (material). PostgreSQL real, schema temporário. Dependências
 * mínimas: empresas (001), GHE (004, com uq_ghe_empresa_id), materiais
 * (007 e 039).
 */

const MIGRATIONS = ['000', '001', '004', '007', '039', '041'];
const VIOLACAO_FK = '23503';
const VIOLACAO_UNIQUE = '23505';
const DIRETORIO = path.join(__dirname, '..', '..', 'migrations');
const ARQUIVO_041 = '041_create_ghe_materiais.sql';

describe('migration 041 — ghe_materiais', () => {
  let contexto;
  let empresaA;
  let empresaB;
  let gheA;
  let gheB;
  let materialA;
  let materialB;

  const q = (sql, params) => contexto.cliente.query(sql, params);

  before(async () => {
    contexto = await abrirSchemaTemporario(MIGRATIONS);
    await inserirEmpresa(contexto.cliente, '11222333000181', 'A');
    await inserirEmpresa(contexto.cliente, '44555666000162', 'B');
    const { rows } = await q('SELECT id, cnpj FROM empresas ORDER BY id');
    empresaA = rows.find((e) => e.cnpj === '11222333000181').id;
    empresaB = rows.find((e) => e.cnpj === '44555666000162').id;
    gheA = (await q("INSERT INTO grupos_homogeneos_exposicao (empresa_id, nome) VALUES ($1, 'GHE A') RETURNING id", [empresaA])).rows[0].id;
    gheB = (await q("INSERT INTO grupos_homogeneos_exposicao (empresa_id, nome) VALUES ($1, 'GHE B') RETURNING id", [empresaB])).rows[0].id;
    materialA = (await q("INSERT INTO materiais (empresa_id, nome) VALUES ($1, 'Luva A') RETURNING id", [empresaA])).rows[0].id;
    materialB = (await q("INSERT INTO materiais (empresa_id, nome) VALUES ($1, 'Luva B') RETURNING id", [empresaB])).rows[0].id;
  });
  after(async () => { if (contexto) await contexto.encerrar(); });

  async function vincular(empresaId, gheId, materialId) {
    try {
      await q('INSERT INTO ghe_materiais (empresa_id, grupo_homogeneo_id, material_id) VALUES ($1, $2, $3)', [empresaId, gheId, materialId]);
      return { ok: true };
    } catch (erro) {
      return { ok: false, code: erro.code, constraint: erro.constraint };
    }
  }

  test('estrutura: colunas, constraints (FKs compostas ON DELETE RESTRICT, UNIQUE) e índice', async () => {
    const { rows: colunas } = await q(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'ghe_materiais' ORDER BY ordinal_position`,
    );
    assert.deepEqual(colunas.map((c) => [c.column_name, c.data_type, c.is_nullable]), [
      ['id', 'integer', 'NO'],
      ['empresa_id', 'integer', 'NO'],
      ['grupo_homogeneo_id', 'integer', 'NO'],
      ['material_id', 'integer', 'NO'],
      ['criado_em', 'timestamp with time zone', 'NO'],
    ]);

    const { rows: cons } = await q(
      `SELECT c.conname, pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = current_schema() AND t.relname = 'ghe_materiais' ORDER BY c.conname`,
    );
    const def = Object.fromEntries(cons.map((c) => [c.conname, c.def]));
    assert.equal(def.uq_ghe_materiais, 'UNIQUE (empresa_id, grupo_homogeneo_id, material_id)');
    assert.equal(def.fk_ghe_materiais_ghe_mesma_empresa, 'FOREIGN KEY (empresa_id, grupo_homogeneo_id) REFERENCES grupos_homogeneos_exposicao(empresa_id, id) ON DELETE RESTRICT');
    assert.equal(def.fk_ghe_materiais_material_mesma_empresa, 'FOREIGN KEY (empresa_id, material_id) REFERENCES materiais(empresa_id, id) ON DELETE RESTRICT');
    assert.equal(def.ghe_materiais_empresa_id_fkey, 'FOREIGN KEY (empresa_id) REFERENCES empresas(id) ON DELETE CASCADE');
    assert.equal(def.ghe_materiais_pkey, 'PRIMARY KEY (id)');
    assert.equal(cons.length, 5, 'nenhuma constraint além das previstas');

    const { rows: indice } = await q(
      "SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_ghe_materiais_material'",
    );
    assert.equal(indice.length, 1);
    assert.match(indice[0].indexdef, /ON \S*ghe_materiais USING btree \(empresa_id, material_id\)$/);

    const { rows: uqMat } = await q(
      `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = current_schema() AND t.relname = 'materiais' AND c.conname = 'uq_materiais_empresa_id'`,
    );
    assert.deepEqual(uqMat.map((r) => r.def), ['UNIQUE (empresa_id, id)']);
  });

  test('vínculo entre GHE e material da MESMA empresa é aceito', async () => {
    assert.deepEqual(await vincular(empresaA, gheA, materialA), { ok: true });
  });

  test('duplicidade é recusada pelo banco (uq_ghe_materiais)', async () => {
    assert.deepEqual(await vincular(empresaA, gheA, materialA), { ok: false, code: VIOLACAO_UNIQUE, constraint: 'uq_ghe_materiais' });
  });

  test('GHE de outra empresa é recusado pelo banco (FK composta)', async () => {
    assert.deepEqual(await vincular(empresaA, gheB, materialA), { ok: false, code: VIOLACAO_FK, constraint: 'fk_ghe_materiais_ghe_mesma_empresa' });
  });

  test('material de outra empresa é recusado pelo banco (FK composta)', async () => {
    assert.deepEqual(await vincular(empresaA, gheA, materialB), { ok: false, code: VIOLACAO_FK, constraint: 'fk_ghe_materiais_material_mesma_empresa' });
  });

  test('manifesto: entrada da 041 coerente com o arquivo; algoritmo sha256', () => {
    const manifesto = JSON.parse(fs.readFileSync(path.join(DIRETORIO, 'checksums.json'), 'utf8'));
    const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(DIRETORIO, ARQUIVO_041))).digest('hex');
    assert.equal(manifesto.algoritmo, 'sha256');
    assert.equal(manifesto.migrations[ARQUIVO_041], sha);
  });
});
