'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');

const materialRepo = require('../../src/repositories/material.repository');
const minimoRepo = require('../../src/repositories/estoque-minimo.repository');
const auditoriaRepo = require('../../src/repositories/auditoria.repository');
const { HttpError } = require('../../src/errors/HttpError');

/**
 * Serviço da configuração do mínimo por tamanho (12D-2), sem PostgreSQL real:
 * orquestração, isolamento por empresa, regra "só material que exige tamanho",
 * idempotência funcional (PUT sem mudança não audita) e auditoria na mesma
 * transação. O mínimo padrão continua sendo materiais.estoque_minimo; aqui só
 * se mexe na sobrescrita por tamanho (estoque_minimos).
 */

const servico = () => exigirModulo('src/services/estoque-minimo.service');

const EMPRESA = 42;
const ATOR = 7;
const MATERIAL = 30;

const material = (extra = {}) => ({
  id: MATERIAL, empresaId: EMPRESA, nome: 'Luva de raspa', ativo: true, exigeTamanho: true, estoqueMinimo: 20, ...extra,
});

function criarPoolFalso() {
  const eventos = [];
  const cliente = {
    query: async (texto) => { eventos.push(texto); return { rows: [], rowCount: 0 }; },
    release: () => { eventos.push('RELEASE'); },
  };
  return { eventos, connect: async () => cliente, query: cliente.query };
}

async function esperarHttpError(promessa, status, codigo) {
  await assert.rejects(promessa, (erro) => {
    assert.ok(HttpError.ehHttpError(erro), `esperado HttpError, veio ${erro && erro.name}: ${erro && erro.message}`);
    assert.deepEqual([erro.status, erro.codigo], [status, codigo]);
    return true;
  });
}

const sobrescritas = (...pares) => pares.map(([tamanho, minimo]) => ({ tamanho, minimo, criadoEm: new Date(), atualizadoEm: new Date() }));

describe('consultar — o mínimo padrão do material e as sobrescritas por tamanho', () => {
  test('devolve o contrato público (sem datas), ordenado como o repositório devolve, lendo só da empresa da sessão', async (t) => {
    const buscar = t.mock.method(materialRepo, 'buscarPorId', async () => material());
    const listar = t.mock.method(minimoRepo, 'listarPorMaterial', async () => sobrescritas(['G', 0], ['M', 30], ['P', 10]));
    const r = await servico().consultar({}, { empresaId: EMPRESA, materialId: MATERIAL });
    assert.deepEqual(r, {
      materialId: MATERIAL, estoqueMinimoPadrao: 20, exigeTamanho: true, overrides: [{ tamanho: 'G', minimo: 0 }, { tamanho: 'M', minimo: 30 }, { tamanho: 'P', minimo: 10 }],
    });
    assert.deepEqual(buscar.mock.calls[0].arguments.slice(1), [EMPRESA, MATERIAL]);
    assert.deepEqual(listar.mock.calls[0].arguments.slice(1), [EMPRESA, MATERIAL]);
  });

  test('material sem tamanho e material ainda não classificado: sem sobrescritas e com o exigeTamanho que o cadastro tem', async (t) => {
    t.mock.method(minimoRepo, 'listarPorMaterial', async () => []);
    t.mock.method(materialRepo, 'buscarPorId', async () => material({ exigeTamanho: false }));
    assert.deepEqual(await servico().consultar({}, { empresaId: EMPRESA, materialId: MATERIAL }), { materialId: MATERIAL, estoqueMinimoPadrao: 20, exigeTamanho: false, overrides: [] });
    t.mock.method(materialRepo, 'buscarPorId', async () => material({ exigeTamanho: null }));
    assert.equal((await servico().consultar({}, { empresaId: EMPRESA, materialId: MATERIAL })).exigeTamanho, null);
  });

  test('material inexistente ou de outra empresa: 404 sem consultar as sobrescritas', async (t) => {
    t.mock.method(materialRepo, 'buscarPorId', async () => null);
    const listar = t.mock.method(minimoRepo, 'listarPorMaterial', async () => []);
    await esperarHttpError(servico().consultar({}, { empresaId: 99, materialId: MATERIAL }), 404, 'MATERIAL_NAO_ENCONTRADO');
    assert.equal(listar.mock.callCount(), 0);
  });

  test('identificadores inválidos são erro de programação', async () => {
    await assert.rejects(() => servico().consultar({}, { empresaId: 0, materialId: MATERIAL }), TypeError);
    await assert.rejects(() => servico().consultar({}, { empresaId: EMPRESA, materialId: 1.5 }), TypeError);
  });
});

describe('definir — cria, altera ou confirma o mínimo de um tamanho', () => {
  const dados = (extra = {}) => ({
    empresaId: EMPRESA, atorId: ATOR, materialId: MATERIAL, tamanho: 'M', minimo: 20, ip: '203.0.113.10', dispositivo: 'Navegador de teste', ...extra,
  });

  function simular(t, { gravacao, material: m = material(), depois = sobrescritas(['M', 20]) } = {}) {
    const pool = criarPoolFalso();
    const trava = t.mock.method(materialRepo, 'buscarPorIdParaVinculo', async () => m);
    const grava = t.mock.method(minimoRepo, 'gravar', async () => gravacao);
    t.mock.method(minimoRepo, 'listarPorMaterial', async () => depois);
    const audita = t.mock.method(auditoriaRepo, 'registrar', async () => ({ id: '1', criadoEm: new Date() }));
    return { pool, trava, grava, audita };
  }

  test('par novo: grava, audita ESTOQUE_MINIMO_DEFINIDO na mesma transação e devolve criado e o estado completo', async (t) => {
    const { pool, trava, grava, audita } = simular(t, { gravacao: { criado: true, alterado: true, minimoAnterior: null, minimo: 20 } });
    const r = await servico().definir(pool, dados());
    assert.deepEqual(r, {
      criado: true, alterado: true, materialId: MATERIAL, estoqueMinimoPadrao: 20, exigeTamanho: true, overrides: [{ tamanho: 'M', minimo: 20 }],
    });
    assert.deepEqual(pool.eventos, ['BEGIN', 'COMMIT', 'RELEASE']);
    assert.deepEqual(trava.mock.calls[0].arguments.slice(1), [EMPRESA, MATERIAL], 'o material é lido com a trava compartilhada, da empresa da sessão');
    assert.deepEqual(grava.mock.calls[0].arguments.slice(1), [EMPRESA, { materialId: MATERIAL, tamanho: 'M', minimo: 20 }]);
    assert.equal(audita.mock.callCount(), 1);
    assert.deepEqual(audita.mock.calls[0].arguments[1], {
      empresaId: EMPRESA,
      usuarioId: ATOR,
      acao: 'ESTOQUE_MINIMO_DEFINIDO',
      referencia: String(MATERIAL),
      ip: '203.0.113.10',
      dispositivo: 'Navegador de teste',
      contexto: { materialId: MATERIAL, tamanho: 'M', minimoAnterior: null, minimoNovo: 20 },
    });
  });

  test('par existente com valor diferente: alterado, não criado; a auditoria leva o mínimo anterior e o novo', async (t) => {
    const { pool, audita } = simular(t, { gravacao: { criado: false, alterado: true, minimoAnterior: 10, minimo: 20 } });
    const r = await servico().definir(pool, dados());
    assert.deepEqual([r.criado, r.alterado], [false, true]);
    assert.deepEqual(audita.mock.calls[0].arguments[1].contexto, { materialId: MATERIAL, tamanho: 'M', minimoAnterior: 10, minimoNovo: 20 });
  });

  test('PUT sem mudança (M = 20 já é 20): operação válida, alterado falso e NENHUMA auditoria', async (t) => {
    const { pool, audita } = simular(t, { gravacao: { criado: false, alterado: false, minimoAnterior: 20, minimo: 20 } });
    const r = await servico().definir(pool, dados());
    assert.deepEqual([r.criado, r.alterado], [false, false]);
    assert.equal(r.overrides[0].minimo, 20);
    assert.equal(audita.mock.callCount(), 0);
    assert.deepEqual(pool.eventos, ['BEGIN', 'COMMIT', 'RELEASE']);
  });

  test('o mínimo zero próprio é válido e auditado como qualquer outro valor (zero não é "ausente")', async (t) => {
    const { pool, audita } = simular(t, { gravacao: { criado: true, alterado: true, minimoAnterior: null, minimo: 0 }, depois: sobrescritas(['M', 0]) });
    const r = await servico().definir(pool, dados({ minimo: 0 }));
    assert.deepEqual(r.overrides, [{ tamanho: 'M', minimo: 0 }]);
    assert.equal(audita.mock.calls[0].arguments[1].contexto.minimoNovo, 0);
  });

  test('de 10 para 0 também é mudança real (0 não é "igual a ausente")', async (t) => {
    const { pool, audita } = simular(t, { gravacao: { criado: false, alterado: true, minimoAnterior: 10, minimo: 0 } });
    await servico().definir(pool, dados({ minimo: 0 }));
    assert.deepEqual(audita.mock.calls[0].arguments[1].contexto, { materialId: MATERIAL, tamanho: 'M', minimoAnterior: 10, minimoNovo: 0 });
  });

  test('material que não exige tamanho: 409 MATERIAL_NAO_EXIGE_TAMANHO, nada gravado nem auditado, ROLLBACK', async (t) => {
    const { pool, grava, audita } = simular(t, { gravacao: null, material: material({ exigeTamanho: false }) });
    await esperarHttpError(servico().definir(pool, dados()), 409, 'MATERIAL_NAO_EXIGE_TAMANHO');
    assert.equal(grava.mock.callCount(), 0);
    assert.equal(audita.mock.callCount(), 0);
    assert.deepEqual(pool.eventos, ['BEGIN', 'ROLLBACK', 'RELEASE']);
  });

  test('material ainda não classificado (exige_tamanho nulo): 409 MATERIAL_TAMANHO_NAO_CLASSIFICADO, o mesmo código da entrada de estoque', async (t) => {
    const { pool, grava } = simular(t, { gravacao: null, material: material({ exigeTamanho: null }) });
    await esperarHttpError(servico().definir(pool, dados()), 409, 'MATERIAL_TAMANHO_NAO_CLASSIFICADO');
    assert.equal(grava.mock.callCount(), 0);
  });

  test('material inexistente ou de outra empresa: 404, sem gravar', async (t) => {
    const { pool, grava, audita } = simular(t, { gravacao: null, material: null });
    await esperarHttpError(servico().definir(pool, dados({ empresaId: 99 })), 404, 'MATERIAL_NAO_ENCONTRADO');
    assert.equal(grava.mock.callCount() + audita.mock.callCount(), 0);
    assert.deepEqual(pool.eventos, ['BEGIN', 'ROLLBACK', 'RELEASE']);
  });

  test('material inativo pode ter o mínimo configurado (a reativação volta com a configuração)', async (t) => {
    const { pool, grava } = simular(t, { gravacao: { criado: true, alterado: true, minimoAnterior: null, minimo: 20 }, material: material({ ativo: false }) });
    await servico().definir(pool, dados());
    assert.equal(grava.mock.callCount(), 1);
  });

  test('falha da auditoria desfaz a gravação: ROLLBACK e o erro propaga', async (t) => {
    const { pool, audita } = simular(t, { gravacao: { criado: true, alterado: true, minimoAnterior: null, minimo: 20 } });
    audita.mock.mockImplementation(async () => { throw new Error('auditoria indisponível'); });
    await assert.rejects(() => servico().definir(pool, dados()), /auditoria indisponível/);
    assert.deepEqual(pool.eventos, ['BEGIN', 'ROLLBACK', 'RELEASE']);
  });

  test('entrada inválida (ator, tamanho fora da forma canônica, mínimo fora do intervalo) é erro de programação, antes de abrir transação', async (t) => {
    const { pool } = simular(t, { gravacao: null });
    for (const extra of [{ atorId: 0 }, { empresaId: 0 }, { materialId: 0 }, { tamanho: ' M' }, { tamanho: '' }, { minimo: -1 }, { minimo: 1.5 }, { minimo: 2147483648 }]) {
      await assert.rejects(() => servico().definir(pool, dados(extra)), TypeError, JSON.stringify(extra));
    }
    assert.deepEqual(pool.eventos, []);
  });
});

describe('remover — volta o tamanho a herdar o padrão', () => {
  const dados = (extra = {}) => ({
    empresaId: EMPRESA, atorId: ATOR, materialId: MATERIAL, tamanho: 'M', ip: '203.0.113.10', dispositivo: 'Navegador de teste', ...extra,
  });

  function simular(t, { remocao, material: m = material({ estoqueMinimo: 20 }), depois = [] } = {}) {
    const pool = criarPoolFalso();
    t.mock.method(materialRepo, 'buscarPorIdParaVinculo', async () => m);
    const apaga = t.mock.method(minimoRepo, 'removerComAnterior', async () => remocao);
    t.mock.method(minimoRepo, 'listarPorMaterial', async () => depois);
    const audita = t.mock.method(auditoriaRepo, 'registrar', async () => ({ id: '1', criadoEm: new Date() }));
    return { pool, apaga, audita };
  }

  test('remove a linha (nunca grava zero), audita ESTOQUE_MINIMO_REMOVIDO com o anterior e o mínimo efetivo depois (o padrão)', async (t) => {
    const { pool, apaga, audita } = simular(t, { remocao: { removido: true, minimoAnterior: 30 } });
    const r = await servico().remover(pool, dados());
    assert.deepEqual(r, { alterado: true, materialId: MATERIAL, estoqueMinimoPadrao: 20, exigeTamanho: true, overrides: [] });
    assert.deepEqual(apaga.mock.calls[0].arguments.slice(1), [EMPRESA, MATERIAL, 'M']);
    assert.deepEqual(audita.mock.calls[0].arguments[1], {
      empresaId: EMPRESA,
      usuarioId: ATOR,
      acao: 'ESTOQUE_MINIMO_REMOVIDO',
      referencia: String(MATERIAL),
      ip: '203.0.113.10',
      dispositivo: 'Navegador de teste',
      contexto: { materialId: MATERIAL, tamanho: 'M', minimoAnterior: 30, minimoEfetivoDepois: 20 },
    });
    assert.deepEqual(pool.eventos, ['BEGIN', 'COMMIT', 'RELEASE']);
  });

  test('remover um zero próprio é remoção como outra qualquer: o anterior 0 vai na auditoria', async (t) => {
    const { pool, audita } = simular(t, { remocao: { removido: true, minimoAnterior: 0 } });
    await servico().remover(pool, dados());
    assert.equal(audita.mock.calls[0].arguments[1].contexto.minimoAnterior, 0);
  });

  test('tamanho sem sobrescrita: idempotente, 200 com alterado falso e nenhuma auditoria', async (t) => {
    const { pool, audita } = simular(t, { remocao: { removido: false, minimoAnterior: null } });
    const r = await servico().remover(pool, dados());
    assert.equal(r.alterado, false);
    assert.equal(audita.mock.callCount(), 0);
  });

  test('material inexistente ou de outra empresa: 404', async (t) => {
    const { pool, apaga } = simular(t, { remocao: null, material: null });
    await esperarHttpError(servico().remover(pool, dados({ empresaId: 99 })), 404, 'MATERIAL_NAO_ENCONTRADO');
    assert.equal(apaga.mock.callCount(), 0);
    assert.deepEqual(pool.eventos, ['BEGIN', 'ROLLBACK', 'RELEASE']);
  });

  test('falha da auditoria desfaz a remoção', async (t) => {
    const { pool, audita } = simular(t, { remocao: { removido: true, minimoAnterior: 5 } });
    audita.mock.mockImplementation(async () => { throw new Error('auditoria indisponível'); });
    await assert.rejects(() => servico().remover(pool, dados()), /auditoria indisponível/);
    assert.deepEqual(pool.eventos, ['BEGIN', 'ROLLBACK', 'RELEASE']);
  });

  test('entrada inválida é erro de programação, antes de abrir transação', async (t) => {
    const { pool } = simular(t, { remocao: null });
    for (const extra of [{ atorId: 0 }, { empresaId: -1 }, { materialId: 0 }, { tamanho: ' M' }, { tamanho: '' }]) {
      await assert.rejects(() => servico().remover(pool, dados(extra)), TypeError, JSON.stringify(extra));
    }
    assert.deepEqual(pool.eventos, []);
  });
});
