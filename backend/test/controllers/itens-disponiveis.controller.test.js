'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const servico = require('../../src/services/estoque.service');
const { criarItensDisponiveisController } = require('../../src/controllers/itens-disponiveis.controller');

describe('itens-disponiveis.controller — Parte C3', () => {
  test('usa só a empresa da sessão e a query validada; responde 200 com status ok', async (t) => {
    const chamada = {};
    t.mock.method(servico, 'listarDisponiveis', async (pool, dados) => { chamada.pool = pool; chamada.dados = dados; return { itens: [], total: 0, pagina: 1, limite: 50, filtros: { categorias: [], tipos: [], tamanhos: [] } }; });
    const pool = { marca: 'pool' };
    const controller = criarItensDisponiveisController({ pool });
    const res = { statusCode: 0, corpo: null, status(c) { this.statusCode = c; return this; }, json(b) { this.corpo = b; return this; } };
    await controller.listar({ empresa: { id: 3 }, usuario: { id: 9 }, query: { empresaId: '999' }, validado: { query: { tipo: 'Luva', pagina: 1, limite: 50 } } }, res);
    assert.equal(chamada.pool, pool);
    assert.deepEqual(chamada.dados, { empresaId: 3, categoria: null, tipo: 'Luva', tamanho: null, validade: null, pagina: 1, limite: 50 });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.corpo, { status: 'ok', itens: [], total: 0, pagina: 1, limite: 50, filtros: { categorias: [], tipos: [], tamanhos: [] } });
  });
});
