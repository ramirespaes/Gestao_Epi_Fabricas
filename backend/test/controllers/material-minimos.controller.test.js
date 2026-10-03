'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');

const { criarMaterialController } = require('../../src/controllers/material.controller');

/**
 * Controller dos mínimos por tamanho (12D-2): traduz requisição em chamada do
 * serviço e resultado em resposta. Empresa e ator só da sessão; o tamanho e o
 * material, só do caminho já validado; o mínimo, só do corpo já validado.
 */

const servico = () => exigirModulo('src/services/estoque-minimo.service');
const respostaFalsa = () => ({ statusCode: 0, corpo: null, status(c) { this.statusCode = c; return this; }, json(b) { this.corpo = b; return this; } });

const ESTADO = { materialId: 30, estoqueMinimoPadrao: 20, exigeTamanho: true, overrides: [{ tamanho: 'M', minimo: 30 }] };

describe('GET /materiais/:id/minimos', () => {
  test('lê só da empresa da sessão e responde 200 com o estado completo', async (t) => {
    const chamada = {};
    t.mock.method(servico(), 'consultar', async (pool, dados) => { chamada.pool = pool; chamada.dados = dados; return ESTADO; });
    const pool = { marca: 'pool' };
    const res = respostaFalsa();
    await criarMaterialController({ pool }).minimos({ empresa: { id: 3 }, usuario: { id: 9 }, query: { empresaId: '999' }, validado: { params: { id: 30 } } }, res);
    assert.equal(chamada.pool, pool);
    assert.deepEqual(chamada.dados, { empresaId: 3, materialId: 30 });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.corpo, { status: 'ok', ...ESTADO });
  });
});

describe('PUT /materiais/:id/minimos/:tamanho', () => {
  const req = (extra = {}) => ({
    empresa: { id: 3 },
    usuario: { id: 9 },
    ip: '203.0.113.10',
    headers: { 'user-agent': 'Navegador de teste' },
    body: { empresaId: 999 },
    validado: { params: { id: 30, tamanho: 'M' }, body: { minimo: 30 } },
    ...extra,
  });

  test('empresa e ator da sessão, material e tamanho do caminho, mínimo do corpo, ip e dispositivo da requisição', async (t) => {
    const chamada = {};
    t.mock.method(servico(), 'definir', async (_pool, dados) => { chamada.dados = dados; return { criado: false, alterado: true, ...ESTADO }; });
    const res = respostaFalsa();
    await criarMaterialController({ pool: {} }).definirMinimo(req(), res);
    assert.deepEqual(chamada.dados, {
      empresaId: 3, atorId: 9, materialId: 30, tamanho: 'M', minimo: 30, ip: '203.0.113.10', dispositivo: 'Navegador de teste',
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.corpo, { status: 'ok', criado: false, alterado: true, ...ESTADO });
  });

  test('201 quando a sobrescrita nasce; 200 quando já existia (mudou ou não)', async (t) => {
    t.mock.method(servico(), 'definir', async () => ({ criado: true, alterado: true, ...ESTADO }));
    const nova = respostaFalsa();
    await criarMaterialController({ pool: {} }).definirMinimo(req(), nova);
    assert.equal(nova.statusCode, 201);
    t.mock.method(servico(), 'definir', async () => ({ criado: false, alterado: false, ...ESTADO }));
    const igual = respostaFalsa();
    await criarMaterialController({ pool: {} }).definirMinimo(req(), igual);
    assert.equal(igual.statusCode, 200);
    assert.equal(igual.corpo.alterado, false);
  });
});

describe('DELETE /materiais/:id/minimos/:tamanho', () => {
  test('empresa e ator da sessão; responde 200 com alterado e o estado completo (também quando não havia sobrescrita)', async (t) => {
    const chamada = {};
    t.mock.method(servico(), 'remover', async (_pool, dados) => { chamada.dados = dados; return { alterado: false, ...ESTADO, overrides: [] }; });
    const res = respostaFalsa();
    await criarMaterialController({ pool: {} }).removerMinimo({
      empresa: { id: 3 }, usuario: { id: 9 }, ip: '203.0.113.10', headers: { 'user-agent': 'Navegador de teste' }, validado: { params: { id: 30, tamanho: 'M' } },
    }, res);
    assert.deepEqual(chamada.dados, { empresaId: 3, atorId: 9, materialId: 30, tamanho: 'M', ip: '203.0.113.10', dispositivo: 'Navegador de teste' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.corpo, { status: 'ok', alterado: false, ...ESTADO, overrides: [] });
  });
});
