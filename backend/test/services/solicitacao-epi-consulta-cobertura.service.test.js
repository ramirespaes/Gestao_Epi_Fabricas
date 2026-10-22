'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const servico = require('../../src/services/solicitacao-epi-consulta.service');
const consultaRepo = require('../../src/repositories/solicitacao-epi-consulta.repository');
const itemRepo = require('../../src/repositories/solicitacao-epi-item.repository');
const coberturaRepo = require('../../src/repositories/solicitacao-epi-cobertura.repository');

/**
 * 12I, Tasks 05 e 06 — o filtro `cobertura` das listas de entregáveis e encerráveis (RED), sem PostgreSQL real. O serviço NÃO tem regra
 * de cobertura própria: pede os ids da mesma população da contagem ao repositório de cobertura (no mesmo retrato único da lista) e os
 * passa à lista e à contagem, para a listagem completa coincidir com o indicador do Dashboard.
 */

const EMPRESA = 42;
const HOJE = '2026-10-03';
const poolFalso = () => {
  const comandos = [];
  const client = { query: async (t) => { comandos.push(t); return { rows: [] }; }, release() {} };
  return { comandos, client, connect: async () => client, query: async () => { throw new Error('use o cliente da transação'); } };
};

function simular(t, { ids = [11, 12] } = {}) {
  const chamadas = { ids: [], listas: [], contagens: [] };
  t.mock.method(coberturaRepo, 'idsDeSolicitacoesPorCobertura', async (...a) => { chamadas.ids.push(a); return ids; });
  t.mock.method(consultaRepo, 'listarEntregaveis', async (...a) => { chamadas.listas.push(a); return []; });
  t.mock.method(consultaRepo, 'contarEntregaveis', async (...a) => { chamadas.contagens.push(a); return 0; });
  t.mock.method(itemRepo, 'listarPorSolicitacoesComEntregue', async () => []);
  t.mock.method(coberturaRepo, 'listarCoberturaDasSolicitacoes', async () => []);
  return chamadas;
}

describe('listarEntregaveis com cobertura', () => {
  test('COM_COBERTURA pede os ids "com cobertura" com a data operacional e repassa os MESMOS ids à lista e à contagem, no mesmo cliente', async (t) => {
    const pool = poolFalso();
    const c = simular(t);
    await servico.listarEntregaveis(pool, { empresaId: EMPRESA, cobertura: 'COM_COBERTURA', pagina: 1, limite: 20, hoje: HOJE });
    assert.deepEqual(c.ids[0], [pool.client, EMPRESA, { hoje: HOJE, comCobertura: true }]);
    assert.deepEqual(c.listas[0][2].solicitacaoIds, [11, 12]);
    assert.deepEqual(c.contagens[0][2].solicitacaoIds, [11, 12]);
    assert.equal(c.listas[0][0], pool.client);
  });

  test('SEM_COBERTURA pede os ids "sem cobertura"', async (t) => {
    const c = simular(t, { ids: [] });
    await servico.listarEntregaveis(poolFalso(), { empresaId: EMPRESA, cobertura: 'SEM_COBERTURA', pagina: 1, limite: 20, hoje: HOJE });
    assert.equal(c.ids[0][2].comCobertura, false);
    assert.deepEqual(c.listas[0][2].solicitacaoIds, [], 'população vazia filtra tudo; não vira "sem filtro"');
  });

  test('sem cobertura (ausente ou null) nada é pedido à cobertura e o filtro de ids é nulo: comportamento anterior', async (t) => {
    const c = simular(t);
    await servico.listarEntregaveis(poolFalso(), { empresaId: EMPRESA, pagina: 1, limite: 20, hoje: HOJE });
    await servico.listarEntregaveis(poolFalso(), { empresaId: EMPRESA, cobertura: null, pagina: 1, limite: 20, hoje: HOJE });
    assert.equal(c.ids.length, 0);
    assert.equal(c.listas[0][2].solicitacaoIds ?? null, null);
  });

  test('valor de cobertura desconhecido é recusado antes de abrir transação', async (t) => {
    simular(t);
    const fechado = { connect: async () => { throw new Error('não deve abrir transação'); } };
    for (const cobertura of ['TODAS', 'com_cobertura', 1, true, '']) {
      await assert.rejects(servico.listarEntregaveis(fechado, { empresaId: EMPRESA, cobertura, pagina: 1, limite: 20, hoje: HOJE }), TypeError, String(cobertura));
    }
  });
});

describe('listarEncerraveis com cobertura (só SEM_COBERTURA: a lista de quem encerra não revela disponibilidade)', () => {
  function simularEncerraveis(t) {
    const c = { ids: [], listas: [] };
    t.mock.method(coberturaRepo, 'idsDeSolicitacoesPorCobertura', async (...a) => { c.ids.push(a); return [5]; });
    t.mock.method(consultaRepo, 'listarEncerraveis', async (...a) => { c.listas.push(a); return []; });
    t.mock.method(consultaRepo, 'contarEncerraveis', async () => 0);
    t.mock.method(itemRepo, 'listarPorSolicitacoesComEntregue', async () => []);
    return c;
  }

  test('SEM_COBERTURA filtra pela mesma cobertura e exige a data operacional', async (t) => {
    const c = simularEncerraveis(t);
    await servico.listarEncerraveis(poolFalso(), { empresaId: EMPRESA, cobertura: 'SEM_COBERTURA', pagina: 1, limite: 20, hoje: HOJE });
    assert.equal(c.ids[0][2].comCobertura, false);
    assert.deepEqual(c.listas[0][2].solicitacaoIds, [5]);
  });

  test('COM_COBERTURA é recusada (quem só encerra não filtra por disponibilidade)', async (t) => {
    simularEncerraveis(t);
    const fechado = { connect: async () => { throw new Error('não deve abrir transação'); } };
    await assert.rejects(servico.listarEncerraveis(fechado, { empresaId: EMPRESA, cobertura: 'COM_COBERTURA', pagina: 1, limite: 20, hoje: HOJE }), TypeError);
  });

  test('sem cobertura, nada é pedido à cobertura (a lista das encerráveis continua sem derivar do estoque)', async (t) => {
    const c = simularEncerraveis(t);
    await servico.listarEncerraveis(poolFalso(), { empresaId: EMPRESA, pagina: 1, limite: 20 });
    assert.equal(c.ids.length, 0);
  });
});

describe('listarEntregaveis com COBERTURA_COMPLETA (12I): só os pedidos completamente disponíveis', () => {
  test('pede os ids da cobertura COMPLETA (não os de "algum item coberto") e repassa à lista e à contagem, no mesmo cliente', async (t) => {
    const pool = poolFalso();
    const chamadas = { completa: [], algum: [], listas: [], contagens: [] };
    t.mock.method(coberturaRepo, 'idsDeSolicitacoesCoberturaCompleta', async (...a) => { chamadas.completa.push(a); return [21, 22]; });
    t.mock.method(coberturaRepo, 'idsDeSolicitacoesPorCobertura', async (...a) => { chamadas.algum.push(a); return [99]; });
    t.mock.method(consultaRepo, 'listarEntregaveis', async (...a) => { chamadas.listas.push(a); return []; });
    t.mock.method(consultaRepo, 'contarEntregaveis', async (...a) => { chamadas.contagens.push(a); return 0; });
    t.mock.method(itemRepo, 'listarPorSolicitacoesComEntregue', async () => []);
    t.mock.method(coberturaRepo, 'listarCoberturaDasSolicitacoes', async () => []);
    await servico.listarEntregaveis(pool, { empresaId: EMPRESA, cobertura: 'COBERTURA_COMPLETA', pagina: 1, limite: 20, hoje: HOJE });
    assert.deepEqual(chamadas.completa[0], [pool.client, EMPRESA, { hoje: HOJE }]);
    assert.equal(chamadas.algum.length, 0, 'a regra parcial não é usada');
    assert.deepEqual(chamadas.listas[0][2].solicitacaoIds, [21, 22]);
    assert.deepEqual(chamadas.contagens[0][2].solicitacaoIds, [21, 22]);
  });

  test('as encerráveis (quem só encerra) NÃO aceitam COBERTURA_COMPLETA: só SEM_COBERTURA (disponibilidade não é dela)', async (t) => {
    const fechado = { connect: async () => { throw new Error('não deve abrir transação'); } };
    t.mock.method(consultaRepo, 'listarEncerraveis', async () => []);
    await assert.rejects(servico.listarEncerraveis(fechado, { empresaId: EMPRESA, cobertura: 'COBERTURA_COMPLETA', pagina: 1, limite: 20, hoje: HOJE }), TypeError);
  });
});
