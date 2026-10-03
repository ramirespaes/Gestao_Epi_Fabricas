'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const servico = require('../../src/services/estoque.service');
const { criarItensDisponiveisController } = require('../../src/controllers/itens-disponiveis.controller');

const respostaFalsa = () => ({ statusCode: 0, corpo: null, status(c) { this.statusCode = c; return this; }, json(b) { this.corpo = b; return this; } });
const vazio = { itens: [], total: 0, pagina: 1, limite: 50, filtros: { categorias: [], tipos: [], tamanhos: [] } };

describe('itens-disponiveis.controller — Parte C3 e 12D-2', () => {
  test('usa só a empresa da sessão, a query validada e a data operacional do relógio; responde 200 com status ok', async (t) => {
    const chamada = {};
    t.mock.method(servico, 'listarDisponiveis', async (pool, dados) => { chamada.pool = pool; chamada.dados = dados; return vazio; });
    const pool = { marca: 'pool' };
    const controller = criarItensDisponiveisController({ pool, relogio: () => new Date('2026-10-01T02:30:00Z') });
    const res = respostaFalsa();
    await controller.listar({ empresa: { id: 3 }, usuario: { id: 9 }, query: { empresaId: '999' }, validado: { query: { tipo: 'Luva', pagina: 1, limite: 50 } } }, res);
    assert.equal(chamada.pool, pool);
    assert.deepEqual(chamada.dados, {
      empresaId: 3, hoje: '2026-09-30', categoria: null, tipo: 'Luva', tamanho: null, validade: null, busca: null, situacao: null, somenteComNecessidade: false, pagina: 1, limite: 50,
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.corpo, { status: 'ok', ...vazio });
  });

  test('os filtros novos (busca, situacao, somenteComNecessidade) chegam ao serviço; a empresa do cliente continua ignorada', async (t) => {
    const chamada = {};
    t.mock.method(servico, 'listarDisponiveis', async (_pool, dados) => { chamada.dados = dados; return vazio; });
    const controller = criarItensDisponiveisController({ pool: {}, relogio: () => new Date('2026-10-01T15:00:00Z') });
    await controller.listar({
      empresa: { id: 3 },
      query: { empresaId: '999' },
      body: { empresaId: 998 },
      validado: {
        query: {
          categoria: 'EPI', tipo: 'Luva', tamanho: 'G', validade: 'expiring', busca: 'nitr', situacao: 'SEM_COBERTURA', somenteComNecessidade: true, pagina: 2, limite: 10,
        },
      },
    }, respostaFalsa());
    assert.deepEqual(chamada.dados, {
      empresaId: 3, hoje: '2026-10-01', categoria: 'EPI', tipo: 'Luva', tamanho: 'G', validade: 'expiring', busca: 'nitr', situacao: 'SEM_COBERTURA', somenteComNecessidade: true, pagina: 2, limite: 10,
    });
  });

  test('somenteComNecessidade falso explícito continua falso', async (t) => {
    const chamada = {};
    t.mock.method(servico, 'listarDisponiveis', async (_pool, dados) => { chamada.dados = dados; return vazio; });
    const controller = criarItensDisponiveisController({ pool: {} });
    await controller.listar({ empresa: { id: 3 }, validado: { query: { somenteComNecessidade: false, pagina: 1, limite: 50 } } }, respostaFalsa());
    assert.equal(chamada.dados.somenteComNecessidade, false);
  });
});
