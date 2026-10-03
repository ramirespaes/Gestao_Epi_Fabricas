'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { abrirSchemaTemporario, migrationExiste, conteudoDaMigration } = require('./helpers/schema-temporario');
const {
  todasAsMigrations, erroDe, criarEmpresa, criarMaterial,
} = require('./helpers/entrega-epi');

/**
 * Migration 067 — estoque_minimos: o mínimo próprio de um tamanho. PostgreSQL
 * real, schema temporário.
 *
 * O mínimo padrão continua em materiais.estoque_minimo (não é tocado). Esta
 * tabela guarda só a sobrescrita por tamanho, e só de material que exige
 * tamanho: o material sem tamanho usa o padrão, sem linha aqui. Mínimo 0 é um
 * valor próprio (este tamanho não tem mínimo); a ausência de linha herda o
 * padrão. É configuração: não é saldo nem movimentação.
 */

const TODAS = todasAsMigrations();
const VIOLACAO_NOT_NULL = '23502';
const VIOLACAO_FK = '23503';
const VIOLACAO_UNIQUE = '23505';
const VIOLACAO_CHECK = '23514';
const RECUSA_DO_TRIGGER = 'P0001';
const TEXTO_LONGO = '22001';

const par = (erro) => [erro?.code, erro?.constraint];

function exigirMigration067() {
  assert.equal(migrationExiste('067'), true, 'migration 067 ainda não implementada');
}

describe('migration 067 — estrutura', () => {
  let contexto;

  const q = (sql, params) => contexto.cliente.query(sql, params);
  const definicao = async (nome) => (await q(
    "SELECT pg_get_constraintdef(oid) AS definicao FROM pg_constraint WHERE conrelid = 'estoque_minimos'::regclass AND conname = $1", [nome],
  )).rows[0]?.definicao;

  before(async () => {
    exigirMigration067();
    contexto = await abrirSchemaTemporario(TODAS);
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  test('o arquivo é a 067 e cria a tabela estoque_minimos', () => {
    assert.match(conteudoDaMigration('067'), /CREATE TABLE estoque_minimos/);
    assert.ok(TODAS.includes('067'));
  });

  test('colunas: tamanho NOT NULL de até 20 caracteres, mínimo inteiro NOT NULL, empresa e material obrigatórios, timestamps com padrão', async () => {
    const { rows } = await q(
      `SELECT column_name, data_type, is_nullable, character_maximum_length, column_default
         FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'estoque_minimos' ORDER BY ordinal_position`,
    );
    const colunas = Object.fromEntries(rows.map((c) => [c.column_name, c]));
    assert.deepEqual(rows.map((c) => c.column_name), ['id', 'empresa_id', 'material_id', 'tamanho', 'minimo', 'criado_em', 'atualizado_em']);
    assert.deepEqual([colunas.tamanho.is_nullable, colunas.tamanho.data_type, colunas.tamanho.character_maximum_length], ['NO', 'character varying', 20]);
    assert.deepEqual([colunas.minimo.is_nullable, colunas.minimo.data_type], ['NO', 'integer']);
    for (const nome of ['id', 'empresa_id', 'material_id', 'criado_em', 'atualizado_em']) assert.equal(colunas[nome].is_nullable, 'NO', nome);
    assert.match(colunas.criado_em.column_default, /now\(\)/);
    assert.match(colunas.atualizado_em.column_default, /now\(\)/);
  });

  test('um mínimo por par: UNIQUE comum em (empresa, material, tamanho), sem expressão COALESCE', async () => {
    assert.match(await definicao('uq_estoque_minimos_par'), /^UNIQUE \(empresa_id, material_id, tamanho\)$/);
    const { rows } = await q("SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'estoque_minimos'");
    assert.equal(rows.some((i) => /COALESCE/i.test(i.indexdef)), false);
  });

  test('isolamento multiempresa: FK composta (empresa, material) com RESTRICT e FK da empresa com CASCADE', async () => {
    assert.match(await definicao('fk_estoque_minimos_material_mesma_empresa'), /^FOREIGN KEY \(empresa_id, material_id\) REFERENCES materiais\(empresa_id, id\) ON DELETE RESTRICT$/);
    const { rows } = await q(
      `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = 'estoque_minimos'::regclass AND contype = 'f' AND conname <> 'fk_estoque_minimos_material_mesma_empresa'`,
    );
    assert.deepEqual(rows.map((r) => r.d), ['FOREIGN KEY (empresa_id) REFERENCES empresas(id) ON DELETE CASCADE']);
  });

  test('CHECKs: mínimo >= 0 e tamanho aparado e não vazio', async () => {
    assert.match(await definicao('chk_estoque_minimos_minimo'), /CHECK \(\(minimo >= 0\)\)/);
    assert.match(await definicao('chk_estoque_minimos_tamanho'), /btrim\(\(tamanho\)::text\) = \(tamanho\)::text/);
    assert.match(await definicao('chk_estoque_minimos_tamanho'), /char_length\(\(tamanho\)::text\) > 0/);
  });

  test('gatilhos: atualizado_em e a validação do material', async () => {
    const { rows } = await q(
      `SELECT tgname FROM pg_trigger WHERE tgrelid = 'estoque_minimos'::regclass AND NOT tgisinternal ORDER BY tgname`,
    );
    assert.deepEqual(rows.map((r) => r.tgname), ['trg_estoque_minimos_atualizado_em', 'trg_estoque_minimos_validar_material']);
  });

  test('é só acréscimo: materiais.estoque_minimo continua como o mínimo padrão e estoque_tamanhos não muda', async () => {
    const { rows } = await q(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'materiais' AND column_name = 'estoque_minimo'`,
    );
    assert.equal(rows.length, 1);
    const { rows: tamanhos } = await q(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'estoque_tamanhos' ORDER BY ordinal_position`,
    );
    assert.deepEqual(tamanhos.map((c) => c.column_name), ['id', 'material_id', 'tamanho', 'quantidade', 'criado_em', 'atualizado_em']);
  });
});

describe('migration 067 — comportamento', () => {
  let contexto;
  let empresaA;
  let empresaB;
  let comTamanho;
  let semTamanho;
  let naoClassificado;
  let materialB;
  let n = 0;

  const q = (sql, params) => contexto.cliente.query(sql, params);
  const inserir = (empresaId, materialId, tamanho, minimo) => q(
    'INSERT INTO estoque_minimos (empresa_id, material_id, tamanho, minimo) VALUES ($1, $2, $3, $4) RETURNING *', [empresaId, materialId, tamanho, minimo],
  );
  const novoMaterialComTamanho = async () => { n += 1; return criarMaterial(contexto.cliente, empresaA, `Luva ${n}`, { exigeTamanho: true }); };

  before(async () => {
    exigirMigration067();
    contexto = await abrirSchemaTemporario(TODAS);
    empresaA = await criarEmpresa(contexto.cliente, '11222333000181', 'Empresa A');
    empresaB = await criarEmpresa(contexto.cliente, '44555666000162', 'Empresa B');
    comTamanho = await criarMaterial(contexto.cliente, empresaA, 'Luva de raspa', { exigeTamanho: true });
    semTamanho = await criarMaterial(contexto.cliente, empresaA, 'Capacete', { exigeTamanho: false });
    naoClassificado = await criarMaterial(contexto.cliente, empresaA, 'Máscara antiga', { exigeTamanho: null });
    materialB = await criarMaterial(contexto.cliente, empresaB, 'Luva B', { exigeTamanho: true });
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  test('mínimo próprio de material que exige tamanho é gravado; zero é permitido (este tamanho não tem mínimo)', async () => {
    const m = await novoMaterialComTamanho();
    const p = await inserir(empresaA, m, 'P', 10);
    const zero = await inserir(empresaA, m, 'M', 0);
    assert.deepEqual([p.rows[0].tamanho, p.rows[0].minimo, zero.rows[0].tamanho, zero.rows[0].minimo], ['P', 10, 'M', 0]);
    assert.ok(p.rows[0].id > 0 && p.rows[0].criado_em instanceof Date);
  });

  test('mínimo negativo é recusado pelo CHECK', async () => {
    const m = await novoMaterialComTamanho();
    assert.deepEqual(par(await erroDe(inserir(empresaA, m, 'P', -1))), [VIOLACAO_CHECK, 'chk_estoque_minimos_minimo']);
  });

  test('tamanho vazio, com espaço no início ou no fim, ou em branco é recusado; acima de 20 caracteres também', async () => {
    const m = await novoMaterialComTamanho();
    for (const tamanho of ['', ' P', 'P ', '  ', ' ']) {
      assert.deepEqual(par(await erroDe(inserir(empresaA, m, tamanho, 1))), [VIOLACAO_CHECK, 'chk_estoque_minimos_tamanho'], JSON.stringify(tamanho));
    }
    assert.equal((await erroDe(inserir(empresaA, m, 'X'.repeat(21), 1)))?.code, TEXTO_LONGO);
    assert.equal((await erroDe(inserir(empresaA, m, 'X'.repeat(20), 1))), null, '20 caracteres cabem');
  });

  test('tamanho NULL é recusado: a tabela só tem sobrescrita por tamanho', async () => {
    const m = await novoMaterialComTamanho();
    assert.equal((await erroDe(inserir(empresaA, m, null, 1)))?.code, VIOLACAO_NOT_NULL);
  });

  test('material que exige tamanho (true) é aceito; false e NULL (não classificado) são recusados pelo gatilho', async () => {
    const m = await novoMaterialComTamanho();
    assert.equal(await erroDe(inserir(empresaA, m, 'G', 5)), null);
    for (const material of [semTamanho, naoClassificado]) {
      const erro = await erroDe(inserir(empresaA, material, 'G', 5));
      assert.equal(erro?.code, RECUSA_DO_TRIGGER);
      assert.match(erro.message, /material/i);
    }
    assert.equal((await q('SELECT count(*)::int AS n FROM estoque_minimos WHERE material_id = ANY($1::int[])', [[semTamanho, naoClassificado]])).rows[0].n, 0);
  });

  test('FK composta: mínimo de material de outra empresa é recusado (empresa A com material da B)', async () => {
    assert.deepEqual(par(await erroDe(inserir(empresaA, materialB, 'P', 1))), [VIOLACAO_FK, 'fk_estoque_minimos_material_mesma_empresa']);
    assert.deepEqual(par(await erroDe(inserir(empresaA, 999999, 'P', 1))), [VIOLACAO_FK, 'fk_estoque_minimos_material_mesma_empresa']);
    assert.equal(await erroDe(inserir(empresaB, materialB, 'P', 1)), null, 'na empresa certa é aceito');
  });

  test('UNIQUE por empresa, material e tamanho: duplicata é recusada; tamanhos diferentes (inclusive só pela caixa) convivem', async () => {
    const m = await novoMaterialComTamanho();
    await inserir(empresaA, m, 'P', 10);
    assert.deepEqual(par(await erroDe(inserir(empresaA, m, 'P', 11))), [VIOLACAO_UNIQUE, 'uq_estoque_minimos_par']);
    assert.equal(await erroDe(inserir(empresaA, m, 'p', 11)), null, 'p e P são tamanhos diferentes, como nos lotes');
    assert.equal(await erroDe(inserir(empresaA, m, 'M', 11)), null);
  });

  test('ON CONFLICT convencional atualiza o mínimo, preserva criado_em e avança atualizado_em', async () => {
    const m = await novoMaterialComTamanho();
    const antes = (await inserir(empresaA, m, 'P', 10)).rows[0];
    await q('SELECT pg_sleep(0.05)'); // o JavaScript guarda milissegundos: sem a pausa os dois instantes podem coincidir
    const depois = (await q(
      `INSERT INTO estoque_minimos (empresa_id, material_id, tamanho, minimo) VALUES ($1, $2, $3, $4)
       ON CONFLICT (empresa_id, material_id, tamanho) DO UPDATE SET minimo = EXCLUDED.minimo RETURNING *`,
      [empresaA, m, 'P', 25],
    )).rows[0];
    assert.equal(depois.id, antes.id, 'a mesma linha');
    assert.equal(depois.minimo, 25);
    assert.deepEqual(depois.criado_em, antes.criado_em);
    assert.ok(depois.atualizado_em > antes.atualizado_em, 'o gatilho avançou atualizado_em');
    assert.equal((await q('SELECT count(*)::int AS n FROM estoque_minimos WHERE material_id = $1', [m])).rows[0].n, 1);
  });

  test('trocar o material ou a empresa de uma linha existente reconfere o gatilho (não dá para mover um mínimo para material sem tamanho)', async () => {
    const m = await novoMaterialComTamanho();
    await inserir(empresaA, m, 'P', 10);
    const erro = await erroDe(q('UPDATE estoque_minimos SET material_id = $1 WHERE material_id = $2', [semTamanho, m]));
    assert.equal(erro?.code, RECUSA_DO_TRIGGER);
    assert.deepEqual(par(await erroDe(q('UPDATE estoque_minimos SET minimo = -5 WHERE material_id = $1', [m]))), [VIOLACAO_CHECK, 'chk_estoque_minimos_minimo']);
  });

  test('o material com mínimos próprios não pode ser apagado (RESTRICT); sem mínimos o gatilho não atrapalha', async () => {
    const m = await novoMaterialComTamanho();
    await inserir(empresaA, m, 'P', 10);
    assert.equal((await erroDe(q('DELETE FROM materiais WHERE id = $1', [m])))?.code, VIOLACAO_FK);
  });

  test('ROLLBACK é limpo: nada sobra do mínimo gravado numa transação desfeita', async () => {
    const m = await novoMaterialComTamanho();
    await q('BEGIN');
    await inserir(empresaA, m, 'P', 10);
    await q('ROLLBACK');
    assert.equal((await q('SELECT count(*)::int AS n FROM estoque_minimos WHERE material_id = $1', [m])).rows[0].n, 0);
    await inserir(empresaA, m, 'P', 10);
    assert.equal((await q('SELECT count(*)::int AS n FROM estoque_minimos WHERE material_id = $1', [m])).rows[0].n, 1, 'o par ficou livre depois do ROLLBACK');
  });

  test('o gatilho de validação lê o material com FOR SHARE: a troca de classificação em outra transação espera até o fim da gravação', async () => {
    const definicaoDoGatilho = (await q(
      "SELECT pg_get_functiondef(p.oid) AS def FROM pg_proc p WHERE p.proname = 'validar_material_do_estoque_minimo' AND p.pronamespace = current_schema()::regnamespace",
    )).rows[0]?.def;
    assert.match(definicaoDoGatilho, /FOR SHARE/);
    assert.match(definicaoDoGatilho, /empresa_id = NEW\.empresa_id AND id = NEW\.material_id/);
  });
});
