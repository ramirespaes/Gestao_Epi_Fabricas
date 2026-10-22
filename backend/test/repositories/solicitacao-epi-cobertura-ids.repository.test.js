'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * 12I — os ids das solicitações da fila com e sem cobertura, para o filtro das listas de destino dos cartões do Dashboard, sem PostgreSQL
 * real. A cobertura é a MESMA consulta FIFO que a contagem usa (nenhuma segunda regra). A equivalência com a contagem em banco real está em
 * dashboard-contagens-e-destinos.integration.js.
 */

const repo = () => exigirModulo('src/repositories/solicitacao-epi-cobertura.repository');
const EMPRESA = 42;
const HOJE = '2026-10-02';
function executorFalso(rows = []) {
  const chamadas = [];
  return { chamadas, query: async (texto, valores) => { chamadas.push({ texto, valores }); return { rows, rowCount: rows.length }; } };
}

describe('idsDeSolicitacoesPorCobertura (filtro das listas)', () => {
  test('usa a mesma cobertura da contagem e devolve só os ids, sem ordem de exibição própria', async () => {
    const ex = executorFalso([{ solicitacao_id: 5 }, { solicitacao_id: 2 }]);
    const ids = await repo().idsDeSolicitacoesPorCobertura(ex, EMPRESA, { hoje: HOJE, comCobertura: false });
    assert.deepEqual(ids, [5, 2]);
    assert.match(ex.chamadas[0].texto, /WITH fila AS/);
    assert.deepEqual(ex.chamadas[0].valores.slice(0, 3), [EMPRESA, HOJE, null]);
    assert.ok(ex.chamadas[0].valores.includes(false));
  });

  test('valida os argumentos', async () => {
    const ex = executorFalso();
    await assert.rejects(() => repo().idsDeSolicitacoesPorCobertura(ex, EMPRESA, { hoje: HOJE }), TypeError);
    await assert.rejects(() => repo().idsDeSolicitacoesPorCobertura(ex, 0, { hoje: HOJE, comCobertura: true }), TypeError);
    assert.equal(ex.chamadas.length, 0);
  });
});
