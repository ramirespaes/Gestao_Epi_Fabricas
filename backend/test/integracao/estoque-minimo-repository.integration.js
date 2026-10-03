'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { todasAsMigrations, erroDe, criarEmpresa, criarMaterial } = require('./helpers/entrega-epi');

/**
 * Repository dos mínimos por tamanho contra PostgreSQL real, em schema
 * temporário: listar, buscar, upsert, remover, o mínimo efetivo (próprio ou
 * padrão) e o isolamento por empresa. O mínimo padrão é materiais.estoque_minimo.
 */

const repo = () => exigirModulo('src/repositories/estoque-minimo.repository');

describe('repository de mínimos por tamanho — PostgreSQL real', () => {
  let contexto;
  let pool;
  let empresaA;
  let empresaB;
  let n = 0;

  const q = (sql, params) => pool.query(sql, params);
  const novoMaterial = async (opcoes = {}, { padrao = 20, empresaId = empresaA } = {}) => {
    n += 1;
    const id = await criarMaterial(pool, empresaId, `Luva ${n}`, { exigeTamanho: true, ...opcoes });
    await q('UPDATE materiais SET estoque_minimo = $1 WHERE id = $2', [padrao, id]);
    return id;
  };

  before(async () => {
    exigirModulo('src/repositories/estoque-minimo.repository');
    contexto = await abrirPoolTemporario(todasAsMigrations());
    pool = contexto.pool;
    empresaA = await criarEmpresa(pool, '11222333000181', 'Empresa A');
    empresaB = await criarEmpresa(pool, '44555666000162', 'Empresa B');
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  test('definir cria o mínimo próprio (criado = true) e atualiza o mesmo par sem duplicar (criado = false)', async () => {
    const m = await novoMaterial();
    const primeiro = await repo().definir(pool, empresaA, { materialId: m, tamanho: 'P', minimo: 10 });
    assert.deepEqual([primeiro.tamanho, primeiro.minimo, primeiro.criado], ['P', 10, true]);
    const segundo = await repo().definir(pool, empresaA, { materialId: m, tamanho: 'P', minimo: 12 });
    assert.deepEqual([segundo.minimo, segundo.criado], [12, false]);
    assert.deepEqual(segundo.criadoEm, primeiro.criadoEm);
    assert.equal((await repo().listarPorMaterial(pool, empresaA, m)).length, 1);

    // atualizado_em renovado sem depender do relógio: o Date do JavaScript tem milissegundos e o now() do banco,
    // microssegundos, então duas gravações seguidas podem chegar iguais. O registro anterior nasce com um instante
    // conhecido e antigo (por INSERT, porque o gatilho do UPDATE sempre grava now()) e o upsert real o renova.
    const ANTIGO = new Date('2000-01-01T00:00:00.000Z');
    const preparado = await novoMaterial();
    await q(
      'INSERT INTO estoque_minimos (empresa_id, material_id, tamanho, minimo, criado_em, atualizado_em) VALUES ($1, $2, $3, $4, $5, $5)',
      [empresaA, preparado, 'P', 10, ANTIGO],
    );
    const renovado = await repo().definir(pool, empresaA, { materialId: preparado, tamanho: 'P', minimo: 12 });
    assert.deepEqual([renovado.minimo, renovado.criado, renovado.criadoEm], [12, false, ANTIGO]);
    assert.ok(renovado.atualizadoEm > ANTIGO, 'o upsert renova atualizado_em');
    assert.equal((await repo().listarPorMaterial(pool, empresaA, preparado)).length, 1);
  });

  test('listarPorMaterial: todos os tamanhos do material em ordem, e nada de outro material nem de outra empresa', async () => {
    const m = await novoMaterial();
    const outro = await novoMaterial();
    const deB = await novoMaterial({}, { empresaId: empresaB });
    for (const [tamanho, minimo] of [['P', 10], ['M', 30], ['G', 15]]) await repo().definir(pool, empresaA, { materialId: m, tamanho, minimo });
    await repo().definir(pool, empresaA, { materialId: outro, tamanho: 'P', minimo: 99 });
    await repo().definir(pool, empresaB, { materialId: deB, tamanho: 'P', minimo: 77 });
    const lista = await repo().listarPorMaterial(pool, empresaA, m);
    assert.deepEqual(lista.map((x) => [x.tamanho, x.minimo]), [['G', 15], ['M', 30], ['P', 10]]);
    assert.deepEqual(await repo().listarPorMaterial(pool, empresaA, deB), [], 'material da outra empresa não aparece');
    assert.deepEqual(await repo().listarPorMaterial(pool, empresaB, m), [], 'a outra empresa não vê o mínimo da A');
  });

  test('buscar devolve o par exato ou null', async () => {
    const m = await novoMaterial();
    await repo().definir(pool, empresaA, { materialId: m, tamanho: 'P', minimo: 10 });
    assert.equal((await repo().buscar(pool, empresaA, m, 'P')).minimo, 10);
    assert.equal(await repo().buscar(pool, empresaA, m, 'M'), null);
    assert.equal(await repo().buscar(pool, empresaA, m, 'p'), null, 'o tamanho é exato, como nos lotes');
    assert.equal(await repo().buscar(pool, empresaB, m, 'P'), null, 'outra empresa');
  });

  test('remover apaga só o par pedido e diz se havia; o par volta a herdar o padrão', async () => {
    const m = await novoMaterial({}, { padrao: 20 });
    await repo().definir(pool, empresaA, { materialId: m, tamanho: 'P', minimo: 10 });
    await repo().definir(pool, empresaA, { materialId: m, tamanho: 'M', minimo: 30 });
    assert.equal(await repo().remover(pool, empresaA, m, 'P'), true);
    assert.equal(await repo().remover(pool, empresaA, m, 'P'), false);
    assert.equal(await repo().remover(pool, empresaB, m, 'M'), false, 'outra empresa não apaga');
    assert.deepEqual((await repo().listarPorMaterial(pool, empresaA, m)).map((x) => x.tamanho), ['M']);
    assert.deepEqual(await repo().buscarEfetivo(pool, empresaA, m, 'P'), { minimo: 20, origem: 'PADRAO' });
  });

  test('possuiOverrides: verdadeiro enquanto houver linha do material, falso depois de remover tudo', async () => {
    const m = await novoMaterial();
    assert.equal(await repo().possuiOverrides(pool, empresaA, m), false);
    await repo().definir(pool, empresaA, { materialId: m, tamanho: 'P', minimo: 1 });
    assert.equal(await repo().possuiOverrides(pool, empresaA, m), true);
    assert.equal(await repo().possuiOverrides(pool, empresaB, m), false, 'outra empresa');
    await repo().remover(pool, empresaA, m, 'P');
    assert.equal(await repo().possuiOverrides(pool, empresaA, m), false);
  });

  describe('mínimo efetivo: o exemplo Luva padrão 20, P = 10, M = 30, G = 15', () => {
    test('P, M e G usam o próprio; GG, que não tem linha, herda o padrão 20', async () => {
      const m = await novoMaterial({}, { padrao: 20 });
      for (const [tamanho, minimo] of [['P', 10], ['M', 30], ['G', 15]]) await repo().definir(pool, empresaA, { materialId: m, tamanho, minimo });
      assert.deepEqual(await repo().buscarEfetivo(pool, empresaA, m, 'P'), { minimo: 10, origem: 'PROPRIO' });
      assert.deepEqual(await repo().buscarEfetivo(pool, empresaA, m, 'M'), { minimo: 30, origem: 'PROPRIO' });
      assert.deepEqual(await repo().buscarEfetivo(pool, empresaA, m, 'G'), { minimo: 15, origem: 'PROPRIO' });
      assert.deepEqual(await repo().buscarEfetivo(pool, empresaA, m, 'GG'), { minimo: 20, origem: 'PADRAO' });
    });

    test('o mínimo próprio 0 prevalece sobre o padrão 20 (este tamanho não tem mínimo) e é diferente de herdar', async () => {
      const m = await novoMaterial({}, { padrao: 20 });
      await repo().definir(pool, empresaA, { materialId: m, tamanho: 'P', minimo: 0 });
      assert.deepEqual(await repo().buscarEfetivo(pool, empresaA, m, 'P'), { minimo: 0, origem: 'PROPRIO' });
      assert.deepEqual(await repo().buscarEfetivo(pool, empresaA, m, 'M'), { minimo: 20, origem: 'PADRAO' });
    });

    test('padrão 0 e sem linha: sem mínimo (0), origem PADRAO', async () => {
      const m = await novoMaterial({}, { padrao: 0 });
      assert.deepEqual(await repo().buscarEfetivo(pool, empresaA, m, 'P'), { minimo: 0, origem: 'PADRAO' });
    });

    test('alterar o padrão do material muda só quem herda', async () => {
      const m = await novoMaterial({}, { padrao: 20 });
      await repo().definir(pool, empresaA, { materialId: m, tamanho: 'P', minimo: 10 });
      await q('UPDATE materiais SET estoque_minimo = 50 WHERE id = $1', [m]);
      assert.deepEqual(await repo().buscarEfetivo(pool, empresaA, m, 'P'), { minimo: 10, origem: 'PROPRIO' });
      assert.deepEqual(await repo().buscarEfetivo(pool, empresaA, m, 'GG'), { minimo: 50, origem: 'PADRAO' });
    });
  });

  test('material sem tamanho: o mínimo efetivo é o do próprio material, sem linha na tabela', async () => {
    const m = await novoMaterial({ exigeTamanho: false }, { padrao: 7 });
    assert.deepEqual(await repo().buscarEfetivo(pool, empresaA, m, null), { minimo: 7, origem: 'PADRAO' });
    const erro = await erroDe(repo().definir(pool, empresaA, { materialId: m, tamanho: 'P', minimo: 1 }));
    assert.equal(erro?.code, 'P0001', 'a tabela recusa mínimo de material que não usa tamanho');
  });

  test('isolamento: o mínimo efetivo de material de outra empresa não existe (null) e definir recusa o par cruzado', async () => {
    const deB = await novoMaterial({}, { empresaId: empresaB });
    assert.equal(await repo().buscarEfetivo(pool, empresaA, deB, 'P'), null);
    const erro = await erroDe(repo().definir(pool, empresaA, { materialId: deB, tamanho: 'P', minimo: 1 }));
    assert.equal(erro?.code, '23503');
    assert.equal(await repo().possuiOverrides(pool, empresaB, deB), false);
  });

  test('o repository aceita qualquer executor: dentro de uma transação, o ROLLBACK desfaz o mínimo', async () => {
    const m = await novoMaterial();
    const cliente = await pool.connect();
    try {
      await cliente.query('BEGIN');
      await repo().definir(cliente, empresaA, { materialId: m, tamanho: 'P', minimo: 5 });
      assert.equal((await repo().buscar(cliente, empresaA, m, 'P')).minimo, 5);
      await cliente.query('ROLLBACK');
    } finally {
      cliente.release();
    }
    assert.equal(await repo().buscar(pool, empresaA, m, 'P'), null);
  });
});
