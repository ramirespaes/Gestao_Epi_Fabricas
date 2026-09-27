'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { abrirSchemaTemporario, inserirEmpresa } = require('./helpers/schema-temporario');

/**
 * Migration 043 — abertura do estoque por lote a partir de estoque_tamanhos.
 * PostgreSQL real, schema temporário. Monto saldos como o sistema antigo os
 * deixaria (CA completo, incompleto, vencido, material inativo, vários
 * tamanhos, saldo zero), tiro uma fotografia e só então rodo a 043.
 */

const ANTERIORES = ['000', '001', '002', '004', '005', '007', '008', '013', '039', '041', '042'];
const DIRETORIO = path.join(__dirname, '..', '..', 'migrations');
const ARQUIVO_043 = '043_migrate_estoque_tamanhos_saldo_inicial.sql';
const CNPJ_A = '11222333000181';
const CNPJ_B = '44555666000162';
const RECUSA_DO_TRIGGER = 'P0001';

const sqlDa043 = () => fs.readFileSync(path.join(DIRETORIO, ARQUIVO_043), 'utf8');

async function erroDe(promessa) {
  try {
    await promessa;
    return null;
  } catch (erro) {
    return { code: erro.code, message: erro.message };
  }
}

describe('migration 043 — saldo inicial de estoque_tamanhos para lotes', () => {
  let contexto;
  const m = {};
  let empresaA;
  let empresaB;
  let usuarioA;
  let fotoTamanhos;
  let fotoMateriais;
  let usuariosAntes;

  const q = (sql, params) => contexto.cliente.query(sql, params);

  const fotografarTamanhos = async () => (await q(
    'SELECT id, material_id, tamanho, quantidade, criado_em::text, atualizado_em::text FROM estoque_tamanhos ORDER BY id',
  )).rows;
  const fotografarMateriais = async () => (await q(
    'SELECT id, empresa_id, nome, ca_numero, ca_validade::text, ativo, exige_ca, atualizado_em::text FROM materiais ORDER BY id',
  )).rows;
  const lotesDe = async (materialId) => (await q(
    `SELECT id, empresa_id, tamanho, ca_numero, ca_validade::text AS ca_validade, origem, quantidade_entrada,
            quantidade_baixada, quantidade_entregue, saldo
       FROM estoque_lotes WHERE material_id = $1 ORDER BY tamanho`,
    [materialId],
  )).rows;

  before(async () => {
    contexto = await abrirSchemaTemporario(ANTERIORES);
    assert.equal(await inserirEmpresa(contexto.cliente, CNPJ_A, 'A'), 'ok');
    assert.equal(await inserirEmpresa(contexto.cliente, CNPJ_B, 'B'), 'ok');
    const { rows } = await q('SELECT id, cnpj FROM empresas ORDER BY id');
    empresaA = rows.find((e) => e.cnpj === CNPJ_A).id;
    empresaB = rows.find((e) => e.cnpj === CNPJ_B).id;
    usuarioA = (await q(
      "INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil) VALUES ($1, 'Usuário', 'a@example.invalid', 'hash-de-teste', 'MASTER') RETURNING id",
      [empresaA],
    )).rows[0].id;

    const material = async (chave, empresaId, nome, { ca = null, validade = null, ativo = true } = {}) => {
      m[chave] = (await q(
        'INSERT INTO materiais (empresa_id, nome, ca_numero, ca_validade, ativo) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [empresaId, nome, ca, validade, ativo],
      )).rows[0].id;
    };
    await material('botina', empresaA, 'Botina', { ca: '12345', validade: '2099-12-31' });
    await material('oculos', empresaA, 'Óculos', { ca: '99881', validade: '2020-01-31' });
    await material('luva', empresaA, 'Luva', { ca: '55771' });
    await material('capacete', empresaA, 'Capacete', { validade: '2099-01-01' });
    await material('protetor', empresaA, 'Protetor', { ca: '   ', validade: '2099-01-01' });
    await material('uniforme', empresaA, 'Uniforme');
    await material('respirador', empresaA, 'Respirador', { ca: '40219', validade: '2099-06-30', ativo: false });
    await material('bota', empresaA, 'Bota', { ca: ' 777 ', validade: '2099-03-31' });
    await material('semSaldo', empresaA, 'Sem saldo', { ca: '31313', validade: '2099-12-31' });
    await material('luvaB', empresaB, 'Luva B', { ca: '11111', validade: '2099-12-31' });

    const saldo = (chave, tamanho, quantidade) => q(
      'INSERT INTO estoque_tamanhos (material_id, tamanho, quantidade) VALUES ($1, $2, $3)',
      [m[chave], tamanho, quantidade],
    );
    await saldo('botina', '40', 10);
    await saldo('botina', '41', 3);
    await saldo('botina', '42', 0);
    await saldo('oculos', 'Único', 7);
    await saldo('luva', 'M', 5);
    await saldo('capacete', 'Único', 2);
    await saldo('protetor', 'Único', 3);
    await saldo('uniforme', 'G', 8);
    await saldo('respirador', 'Único', 4);
    await saldo('bota', ' 43 ', 1);
    await saldo('semSaldo', 'U', 0);
    await saldo('luvaB', 'P', 6);
    await saldo('luvaB', 'M', 0);

    fotoTamanhos = await fotografarTamanhos();
    fotoMateriais = await fotografarMateriais();
    usuariosAntes = (await q('SELECT count(*)::int AS n FROM usuarios')).rows[0].n;

    await q(sqlDa043());
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  test('cada saldo positivo vira exatamente um lote SALDO_INICIAL, com uma operação, na empresa, material, tamanho e quantidade certos', async () => {
    const { rows: faltando } = await q(
      `SELECT et.id
         FROM estoque_tamanhos et
         JOIN materiais mat ON mat.id = et.material_id
        WHERE et.quantidade > 0
          AND (SELECT count(*) FROM estoque_lotes l
                WHERE l.material_id = et.material_id AND l.empresa_id = mat.empresa_id
                  AND l.tamanho = btrim(et.tamanho) AND l.quantidade_entrada = et.quantidade
                  AND l.origem = 'SALDO_INICIAL') <> 1`,
    );
    assert.deepEqual(faltando, []);
    assert.equal((await q("SELECT count(*)::int AS n FROM estoque_lotes WHERE origem = 'SALDO_INICIAL'")).rows[0].n, 10);
    assert.equal((await q('SELECT count(*)::int AS n FROM estoque_lotes')).rows[0].n, 10, 'nenhum lote além dos saldos positivos');

    const { rows: operacoes } = await q(
      `SELECT l.id, count(o.id)::int AS n, bool_and(o.tipo = 'SALDO_INICIAL' AND o.quantidade = l.quantidade_entrada) AS coerente
         FROM estoque_lotes l LEFT JOIN estoque_operacoes o ON o.lote_id = l.id
        GROUP BY l.id`,
    );
    assert.ok(operacoes.every((o) => o.n === 1 && o.coerente), JSON.stringify(operacoes));
    assert.equal((await q('SELECT count(*)::int AS n FROM estoque_operacoes')).rows[0].n, 10);
  });

  test('vários tamanhos do mesmo material viram lotes separados', async () => {
    const lotes = await lotesDe(m.botina);
    assert.deepEqual(lotes.map((l) => [l.tamanho, l.quantidade_entrada]), [['40', 10], ['41', 3]]);
  });

  test('nenhuma linha cruza empresa: lote e operação ficam na empresa do material', async () => {
    const { rows } = await q(
      `SELECT l.id FROM estoque_lotes l
         JOIN materiais mat ON mat.id = l.material_id
         JOIN estoque_operacoes o ON o.lote_id = l.id
        WHERE l.empresa_id <> mat.empresa_id OR o.empresa_id <> l.empresa_id`,
    );
    assert.deepEqual(rows, []);
    assert.deepEqual((await lotesDe(m.luvaB)).map((l) => [l.empresa_id, l.tamanho, l.quantidade_entrada]), [[empresaB, 'P', 6]]);
  });

  test('CA completo é copiado para o lote, ainda válido ou já vencido; o saldo vencido é preservado sem baixa', async () => {
    const [botina40] = await lotesDe(m.botina);
    assert.deepEqual([botina40.ca_numero, botina40.ca_validade], ['12345', '2099-12-31']);
    const [oculos] = await lotesDe(m.oculos);
    assert.deepEqual([oculos.ca_numero, oculos.ca_validade, oculos.quantidade_entrada, oculos.saldo], ['99881', '2020-01-31', 7, 7]);
  });

  test('CA incompleto, em branco ou ausente não é inventado: o lote fica sem CA e sem validade', async () => {
    for (const chave of ['luva', 'capacete', 'protetor', 'uniforme']) {
      const [l] = await lotesDe(m[chave]);
      assert.deepEqual([l.ca_numero, l.ca_validade], [null, null], chave);
      assert.ok(l.saldo > 0, `${chave}: saldo preservado`);
    }
  });

  test('espaços nas pontas do tamanho e do CA são aparados como no serviço', async () => {
    const [bota] = await lotesDe(m.bota);
    assert.deepEqual([bota.tamanho, bota.ca_numero, bota.ca_validade, bota.quantidade_entrada], ['43', '777', '2099-03-31', 1]);
  });

  test('saldo zero não cria lote', async () => {
    assert.deepEqual(await lotesDe(m.semSaldo), []);
    assert.deepEqual((await lotesDe(m.botina)).map((l) => l.tamanho), ['40', '41']);
    assert.deepEqual((await lotesDe(m.luvaB)).map((l) => l.tamanho), ['P']);
  });

  test('material inativo com saldo é migrado e continua inativo', async () => {
    const [l] = await lotesDe(m.respirador);
    assert.deepEqual([l.ca_numero, l.quantidade_entrada], ['40219', 4]);
    assert.equal((await q('SELECT ativo FROM materiais WHERE id = $1', [m.respirador])).rows[0].ativo, false);
  });

  test('estoque_tamanhos e materiais ficam absolutamente intactos; exige_ca não é reclassificado', async () => {
    assert.deepEqual(await fotografarTamanhos(), fotoTamanhos);
    assert.deepEqual(await fotografarMateriais(), fotoMateriais);
    const { rows } = await q('SELECT count(*)::int AS n FROM materiais WHERE NOT exige_ca');
    assert.equal(rows[0].n, 0, 'nenhum material virou exige_ca = false');
  });

  test('a abertura não cria baixa, entrega, usuário, chave ou hash', async () => {
    const { rows: [o] } = await q(
      `SELECT count(*) FILTER (WHERE tipo <> 'SALDO_INICIAL')::int AS outros,
              count(*) FILTER (WHERE usuario_id IS NOT NULL OR chave_idempotencia IS NOT NULL OR requisicao_hash IS NOT NULL
                               OR motivo IS NOT NULL OR justificativa IS NOT NULL)::int AS preenchidos
         FROM estoque_operacoes`,
    );
    assert.deepEqual(o, { outros: 0, preenchidos: 0 });
    const { rows: [l] } = await q('SELECT sum(quantidade_baixada)::int AS baixada, sum(quantidade_entregue)::int AS entregue FROM estoque_lotes');
    assert.deepEqual(l, { baixada: 0, entregue: 0 });
    assert.equal((await q('SELECT count(*)::int AS n FROM usuarios')).rows[0].n, usuariosAntes);
  });

  test('lotes e operações reconciliados: entrada = operação de abertura, saldo = entrada', async () => {
    const { rows } = await q(
      `SELECT l.id FROM estoque_lotes l
         LEFT JOIN estoque_operacoes o ON o.lote_id = l.id
        GROUP BY l.id, l.quantidade_entrada, l.quantidade_baixada, l.quantidade_entregue, l.saldo
       HAVING l.quantidade_entrada <> COALESCE(sum(o.quantidade) FILTER (WHERE o.tipo = 'SALDO_INICIAL'), 0)
           OR l.quantidade_baixada <> 0 OR l.quantidade_entregue <> 0 OR l.saldo <> l.quantidade_entrada`,
    );
    assert.deepEqual(rows, []);
  });

  test('as regras da 042 continuam valendo nos lotes migrados', async () => {
    const [botina40] = await lotesDe(m.botina);
    assert.equal((await erroDe(q("UPDATE estoque_lotes SET ca_validade = '2100-01-01' WHERE id = $1", [botina40.id])))?.code, RECUSA_DO_TRIGGER);
    assert.equal((await erroDe(q("DELETE FROM estoque_operacoes WHERE lote_id = $1", [botina40.id])))?.code, RECUSA_DO_TRIGGER);
    await q(
      `INSERT INTO estoque_operacoes (empresa_id, lote_id, tipo, quantidade, motivo, usuario_id, chave_idempotencia, requisicao_hash)
       VALUES ($1, $2, 'BAIXA', 2, 'AVARIA', $3, $4, $5)`,
      [empresaA, botina40.id, usuarioA, crypto.randomUUID(), 'b'.repeat(64)],
    );
    const [depois] = await lotesDe(m.botina);
    assert.deepEqual([depois.quantidade_entrada, depois.quantidade_baixada, depois.saldo], [10, 2, 8]);
  });

  test('rodar a 043 de novo é recusado e não duplica nada', async () => {
    const antes = (await q('SELECT count(*)::int AS n FROM estoque_lotes')).rows[0].n;
    const erro = await erroDe(q(sqlDa043()));
    assert.equal(erro?.code, RECUSA_DO_TRIGGER);
    assert.equal((await q('SELECT count(*)::int AS n FROM estoque_lotes')).rows[0].n, antes);
  });

  test('manifesto: entrada da 043 coerente com o arquivo; algoritmo sha256', () => {
    const manifesto = JSON.parse(fs.readFileSync(path.join(DIRETORIO, 'checksums.json'), 'utf8'));
    const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(DIRETORIO, ARQUIVO_043))).digest('hex');
    assert.equal(manifesto.algoritmo, 'sha256');
    assert.equal(manifesto.migrations[ARQUIVO_043], sha);
  });
});

describe('migration 043 — saldo em tamanho vazio interrompe a migração inteira', () => {
  let contexto;
  const q = (sql, params) => contexto.cliente.query(sql, params);

  before(async () => {
    contexto = await abrirSchemaTemporario(ANTERIORES);
    assert.equal(await inserirEmpresa(contexto.cliente, CNPJ_A, 'A'), 'ok');
    const empresa = (await q('SELECT id FROM empresas')).rows[0].id;
    const material = (await q("INSERT INTO materiais (empresa_id, nome) VALUES ($1, 'Botina') RETURNING id", [empresa])).rows[0].id;
    await q("INSERT INTO estoque_tamanhos (material_id, tamanho, quantidade) VALUES ($1, '40', 5), ($1, '   ', 2)", [material]);
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  test('nenhum lote é criado e o erro explica o motivo', async () => {
    const erro = await erroDe(q(sqlDa043()));
    assert.equal(erro?.code, RECUSA_DO_TRIGGER);
    assert.match(erro.message, /tamanho vazio/);
    assert.equal((await q('SELECT count(*)::int AS n FROM estoque_lotes')).rows[0].n, 0);
    assert.equal((await q('SELECT count(*)::int AS n FROM estoque_operacoes')).rows[0].n, 0);
  });
});
