'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * Contador da numeração das solicitações de EPI: uma linha por empresa, que
 * nasce em 1 e só avança de um em um. A atomicidade e a ausência de lacuna
 * são provadas com PostgreSQL real na integração; aqui, isolamento, SQL e
 * validação.
 */

const repo = () => exigirModulo('src/repositories/solicitacao-epi-numeracao.repository');

const executorFalso = (...respostas) => {
  const chamadas = [];
  return {
    chamadas,
    query: async (texto, valores) => {
      chamadas.push({ texto, valores });
      return { rows: respostas.length > 0 ? respostas.shift() : [] };
    },
  };
};

describe('proximoNumero', () => {
  test('incrementa o contador da própria empresa com um único INSERT ... ON CONFLICT e devolve o número', async () => {
    const executor = executorFalso([{ ultimo_numero: 7 }]);
    assert.equal(await repo().proximoNumero(executor, 42), 7);
    assert.equal(executor.chamadas.length, 1);
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /INSERT INTO solicitacoes_epi_numeracao \(empresa_id, ultimo_numero\) VALUES \(\$1, 1\)/);
    assert.match(texto, /ON CONFLICT \(empresa_id\) DO UPDATE SET ultimo_numero = solicitacoes_epi_numeracao\.ultimo_numero \+ 1/);
    assert.match(texto, /RETURNING ultimo_numero/);
    assert.deepEqual(valores, [42]);
  });

  test('não toca a numeração das fichas de EPI', async () => {
    const executor = executorFalso([{ ultimo_numero: 1 }]);
    await repo().proximoNumero(executor, 42);
    assert.doesNotMatch(executor.chamadas[0].texto, /fichas_epi/);
  });

  test('recusa empresa inválida antes de qualquer consulta', async () => {
    const executor = executorFalso();
    for (const invalida of [0, -1, 1.5, '1', null, undefined, NaN]) {
      await assert.rejects(() => repo().proximoNumero(executor, invalida), /empresa/, String(invalida));
    }
    assert.equal(executor.chamadas.length, 0);
  });
});
