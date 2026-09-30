'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { abrirSchemaTemporario, conteudoDaMigration } = require('./helpers/schema-temporario');
const {
  todasAsMigrations, erroDe, criarEmpresa, criarFuncionario, criarMaterial, criarLote,
} = require('./helpers/entrega-epi');

/**
 * Migration 057 — UNIQUE (empresa_id, id) em funcionarios e
 * UNIQUE (empresa_id, id, material_id) em estoque_lotes. São as chaves que
 * as FKs compostas da ficha e dos itens da entrega referenciam. PostgreSQL
 * real, schema temporário.
 */

const TODAS = todasAsMigrations();
const ATE_A_056 = TODAS.filter((prefixo) => prefixo < '057');
const VIOLACAO_FK = '23503';
const CNPJ_A = '11222333000181';
const CNPJ_B = '44555666000162';
const NOVAS = [
  { tabela: 'estoque_lotes', conname: 'uq_estoque_lotes_empresa_id_material', tipo: 'u', colunas: ['empresa_id', 'id', 'material_id'] },
  { tabela: 'funcionarios', conname: 'uq_funcionarios_empresa_id', tipo: 'u', colunas: ['empresa_id', 'id'] },
];

// Todas as constraints do schema, com tipo, colunas e definição.
async function restricoesDoSchema(q) {
  const { rows } = await q(
    `SELECT t.relname::text AS tabela, c.conname::text AS conname, c.contype::text AS tipo,
            ARRAY(SELECT a.attname::text
                    FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ordem)
                    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
                   ORDER BY k.ordem) AS colunas,
            pg_get_constraintdef(c.oid) AS definicao
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
      WHERE c.connamespace = current_schema()::regnamespace
      ORDER BY t.relname, c.conname`,
  );
  return rows;
}

describe('migration 057 — aplicada sobre 000–056 com dados', () => {
  let contexto;
  const d = {};
  let antes;

  const q = (sql, params) => contexto.cliente.query(sql, params);
  const contagens = async () => (await q(
    `SELECT (SELECT count(*) FROM funcionarios)::int AS funcionarios,
            (SELECT count(*) FROM estoque_lotes)::int AS lotes,
            (SELECT count(*) FROM estoque_operacoes)::int AS operacoes,
            (SELECT sum(saldo) FROM estoque_lotes)::int AS saldo`,
  )).rows[0];

  before(async () => {
    contexto = await abrirSchemaTemporario(ATE_A_056);
    const c = contexto.cliente;
    d.empresaA = await criarEmpresa(c, CNPJ_A, 'Empresa A');
    d.empresaB = await criarEmpresa(c, CNPJ_B, 'Empresa B');
    d.funcionarioA = await criarFuncionario(c, d.empresaA, { matricula: 'A-1', cpf: '11111111111' });
    d.funcionarioB = await criarFuncionario(c, d.empresaB, { matricula: 'B-1', cpf: '22222222222' });
    d.botinaA = await criarMaterial(c, d.empresaA, 'Botina');
    d.luvaA = await criarMaterial(c, d.empresaA, 'Luva');
    d.botinaB = await criarMaterial(c, d.empresaB, 'Botina B');
    d.loteA = await criarLote(c, { empresaId: d.empresaA, materialId: d.botinaA, quantidade: 10 });
    d.loteB = await criarLote(c, { empresaId: d.empresaB, materialId: d.botinaB, quantidade: 4 });
    antes = { restricoes: await restricoesDoSchema(q), contagens: await contagens() };
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  test('aplica sobre a estrutura 000–056 com dados e só acrescenta as duas UNIQUE; as constraints existentes ficam intactas', async () => {
    await q(conteudoDaMigration('057'));

    const depois = await restricoesDoSchema(q);
    const chave = (r) => `${r.tabela}.${r.conname}`;
    const nomesAntes = new Set(antes.restricoes.map(chave));
    const acrescentadas = depois.filter((r) => !nomesAntes.has(chave(r)));
    assert.deepEqual(
      acrescentadas.map(({ tabela, conname, tipo, colunas }) => ({ tabela, conname, tipo, colunas })),
      NOVAS,
    );
    const preservadas = depois.filter((r) => nomesAntes.has(chave(r)));
    assert.deepEqual(preservadas, antes.restricoes, 'nenhuma constraint existente sumiu nem mudou');
  });

  test('os dados existentes não mudam', async () => {
    assert.deepEqual(await contagens(), antes.contagens);
    assert.deepEqual(antes.contagens, { funcionarios: 2, lotes: 2, operacoes: 2, saldo: 14 });
  });

  test('isolamento: FK composta sobre as novas chaves recusa funcionário de outra empresa e lote de outro material ou de outra empresa', async () => {
    await q(`CREATE TABLE sonda_057 (
               empresa_id INTEGER NOT NULL,
               funcionario_id INTEGER,
               lote_id INTEGER,
               material_id INTEGER,
               CONSTRAINT fk_sonda_057_funcionario FOREIGN KEY (empresa_id, funcionario_id) REFERENCES funcionarios (empresa_id, id),
               CONSTRAINT fk_sonda_057_lote FOREIGN KEY (empresa_id, lote_id, material_id) REFERENCES estoque_lotes (empresa_id, id, material_id))`);
    const sondar = (valores) => q(
      'INSERT INTO sonda_057 (empresa_id, funcionario_id, lote_id, material_id) VALUES ($1, $2, $3, $4)',
      valores,
    );

    assert.equal(await erroDe(sondar([d.empresaA, d.funcionarioA, d.loteA, d.botinaA])), null);
    const funcionarioDeOutra = await erroDe(sondar([d.empresaA, d.funcionarioB, null, null]));
    assert.deepEqual([funcionarioDeOutra?.code, funcionarioDeOutra?.constraint], [VIOLACAO_FK, 'fk_sonda_057_funcionario']);
    const loteDeOutroMaterial = await erroDe(sondar([d.empresaA, null, d.loteA, d.luvaA]));
    assert.deepEqual([loteDeOutroMaterial?.code, loteDeOutroMaterial?.constraint], [VIOLACAO_FK, 'fk_sonda_057_lote']);
    const loteDeOutraEmpresa = await erroDe(sondar([d.empresaA, null, d.loteB, d.botinaB]));
    assert.deepEqual([loteDeOutraEmpresa?.code, loteDeOutraEmpresa?.constraint], [VIOLACAO_FK, 'fk_sonda_057_lote']);
  });
});

describe('migration 057 — aplicação limpa, com todas as migrations do diretório', () => {
  let contexto;

  const q = (sql, params) => contexto.cliente.query(sql, params);

  before(async () => {
    contexto = await abrirSchemaTemporario(TODAS);
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  test('as duas UNIQUE existem com as colunas exatas, na ordem', async () => {
    const encontradas = (await restricoesDoSchema(q))
      .filter((r) => NOVAS.some((n) => n.conname === r.conname))
      .map(({ tabela, conname, tipo, colunas }) => ({ tabela, conname, tipo, colunas }));
    assert.deepEqual(encontradas, NOVAS);
  });
});
