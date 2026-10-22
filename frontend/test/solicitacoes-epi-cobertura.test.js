'use strict';

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const EpiHttp = require('../js/api-http');
const S = () => require('../js/solicitacoes-epi'); // eslint-disable-line global-require

/**
 * 12I, Tasks 05 e 06 — o filtro `cobertura` das listas de entregáveis e encerráveis (RED), com `fetch` injetado: só os valores que o
 * servidor aceita (entregáveis: COM_COBERTURA e SEM_COBERTURA; encerráveis: só SEM_COBERTURA), nada além, antes da rede.
 */

const BASE = 'http://localhost:3000/api';
const resposta = (status, corpo) => ({ status, ok: status >= 200 && status < 300, text: async () => (corpo === undefined ? '' : JSON.stringify(corpo)) });
let chamadas;
beforeEach(() => {
  chamadas = [];
  EpiHttp.configurar({ baseUrl: BASE, fetch: async (url, opcoes) => { chamadas.push({ url, metodo: opcoes.method }); return resposta(200, { status: 'ok' }); } });
});
const caminho = (c) => c.url.slice(BASE.length);

describe('entregaveis com cobertura', () => {
  test('o filtro vai na consulta, junto da paginação; sem ele a consulta é a de antes', async () => {
    await S().acoes.entregaveis({ cobertura: 'COM_COBERTURA', pagina: 2, limite: 20 });
    await S().acoes.entregaveis({ cobertura: 'SEM_COBERTURA' });
    await S().acoes.entregaveis({ pagina: 1, limite: 20 });
    assert.deepEqual(chamadas.map(caminho), [
      '/solicitacoes-epi/entregaveis?cobertura=COM_COBERTURA&pagina=2&limite=20',
      '/solicitacoes-epi/entregaveis?cobertura=SEM_COBERTURA&pagina=1&limite=20',
      '/solicitacoes-epi/entregaveis?pagina=1&limite=20',
    ]);
  });

  test('valor desconhecido é TypeError antes da rede', () => {
    for (const ruim of ['TODAS', 'com_cobertura', '', 1, true]) {
      assert.throws(() => S().acoes.entregaveis({ cobertura: ruim }), TypeError, String(ruim));
    }
    assert.equal(chamadas.length, 0);
  });
});

describe('encerraveis com cobertura', () => {
  test('só SEM_COBERTURA vai na consulta', async () => {
    await S().acoes.encerraveis({ cobertura: 'SEM_COBERTURA', pagina: 1, limite: 20 });
    assert.equal(caminho(chamadas[0]), '/solicitacoes-epi/encerraveis?cobertura=SEM_COBERTURA&pagina=1&limite=20');
  });

  test('COM_COBERTURA e outros valores são TypeError antes da rede (quem só encerra não filtra por disponibilidade)', () => {
    for (const ruim of ['COM_COBERTURA', 'TODAS', '', 1]) assert.throws(() => S().acoes.encerraveis({ cobertura: ruim }), TypeError, String(ruim));
    assert.equal(chamadas.length, 0);
  });
});

describe('as demais listas continuam recusando o filtro', () => {
  test('minhas e fila: filtro desconhecido é TypeError', () => {
    assert.throws(() => S().acoes.minhas({ cobertura: 'SEM_COBERTURA' }), TypeError);
    assert.throws(() => S().acoes.fila({ cobertura: 'SEM_COBERTURA' }), TypeError);
  });
});

describe('COBERTURA_COMPLETA (12I): só os pedidos completamente disponíveis', () => {
  test('entregaveis aceita COBERTURA_COMPLETA e leva o valor na consulta; COM_COBERTURA continua válido (regra parcial, para quem a usa)', async () => {
    await S().acoes.entregaveis({ cobertura: 'COBERTURA_COMPLETA', pagina: 1, limite: 20 });
    assert.equal(caminho(chamadas[0]), '/solicitacoes-epi/entregaveis?cobertura=COBERTURA_COMPLETA&pagina=1&limite=20');
    await S().acoes.entregaveis({ cobertura: 'COM_COBERTURA' });
    assert.match(caminho(chamadas[1]), /cobertura=COM_COBERTURA/);
  });

  test('encerraveis NÃO aceita COBERTURA_COMPLETA (TypeError antes da rede): disponibilidade não é de quem só encerra', () => {
    assert.throws(() => S().acoes.encerraveis({ cobertura: 'COBERTURA_COMPLETA' }), TypeError);
    assert.equal(chamadas.length, 0);
  });
});
