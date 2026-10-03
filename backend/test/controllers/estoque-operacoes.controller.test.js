'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const servico = require('../../src/services/estoque.service');
const { criarEstoqueController } = require('../../src/controllers/estoque.controller');

/**
 * GET /api/estoque/operacoes (E8 e 12D-2): a empresa, o usuário e o perfil só
 * da sessão. O perfil e o usuário seguem para o serviço, que decide pela
 * permissão epiFicha se o detalhe da entrega pode sair; nada disso vem da
 * query. A origem é filtro novo e é repassada como veio validada.
 */

const respostaFalsa = () => ({ statusCode: 0, corpo: null, status(c) { this.statusCode = c; return this; }, json(b) { this.corpo = b; return this; } });

describe('estoque.controller.operacoes', () => {
  test('passa a empresa, o usuário e o perfil da sessão, o tipo, a origem e a paginação; a query do cliente não decide quem é o ator', async (t) => {
    const chamada = {};
    t.mock.method(servico, 'listarOperacoes', async (_pool, dados) => { chamada.dados = dados; return { operacoes: [], total: 0, pagina: 2, limite: 20, paginas: 0 }; });
    const res = respostaFalsa();
    await criarEstoqueController({ pool: {} }).operacoes({
      empresa: { id: 3 },
      usuario: { id: 9, perfil: 'SUPERVISOR' },
      query: { empresaId: '999', usuarioId: '1', perfil: 'MASTER' },
      validado: { query: { tipo: 'ENTREGA', origem: 'SOLICITACAO', de: '2026-10-01', pagina: 2, limite: 20 } },
    }, res);
    assert.deepEqual(chamada.dados, {
      empresaId: 3, usuarioId: 9, perfil: 'SUPERVISOR', tipo: 'ENTREGA', origem: 'SOLICITACAO', de: '2026-10-01', ate: null, busca: null, pagina: 2, limite: 20,
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.corpo, { status: 'ok', operacoes: [], total: 0, pagina: 2, limite: 20, paginas: 0 });
  });

  test('sem filtros opcionais, tudo vai como null', async (t) => {
    const chamada = {};
    t.mock.method(servico, 'listarOperacoes', async (_pool, dados) => { chamada.dados = dados; return { operacoes: [], total: 0, pagina: 1, limite: 50, paginas: 0 }; });
    await criarEstoqueController({ pool: {} }).operacoes({ empresa: { id: 3 }, usuario: { id: 9, perfil: 'MASTER' }, validado: { query: { pagina: 1, limite: 50 } } }, respostaFalsa());
    assert.deepEqual(chamada.dados, {
      empresaId: 3, usuarioId: 9, perfil: 'MASTER', tipo: null, origem: null, de: null, ate: null, busca: null, pagina: 1, limite: 50,
    });
  });
});
