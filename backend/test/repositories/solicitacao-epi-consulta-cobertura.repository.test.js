'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const repo = require('../../src/repositories/solicitacao-epi-consulta.repository');

/**
 * 12I, Tasks 05 e 06 — as listas de entregáveis e encerráveis aceitam um conjunto opcional de ids (o filtro por cobertura, decidido pelo
 * serviço com a MESMA cobertura da contagem). A ordem da lista (decidida_em, id), a empresa e o trabalhador não mudam; sem o filtro, o
 * comportamento anterior é idêntico.
 */

const EMPRESA = 42;
function executorFalso(rows = [{ total: 0 }]) {
  const chamadas = [];
  return { chamadas, query: async (texto, valores) => { chamadas.push({ texto, valores }); return { rows, rowCount: rows.length }; } };
}

describe('consultaRepo — entregáveis e encerráveis com solicitacaoIds', () => {
  test('sem o filtro: o mesmo SQL de antes com o conjunto nulo; ordem da fila preservada', async () => {
    const ex = executorFalso([]);
    await repo.listarEntregaveis(ex, EMPRESA, { pagina: 2, limite: 20 });
    assert.match(ex.chamadas[0].texto, /ORDER BY s\.decidida_em, s\.id/);
    assert.deepEqual(ex.chamadas[0].valores, [EMPRESA, null, null, 20, 20]);
    const c = executorFalso();
    await repo.contarEntregaveis(c, EMPRESA, {});
    assert.deepEqual(c.chamadas[0].valores, [EMPRESA, null, null]);
  });

  test('com o filtro: ids como parâmetro de vetor (nunca interpolados), empresa e status continuam no WHERE', async () => {
    const ex = executorFalso([]);
    await repo.listarEntregaveis(ex, EMPRESA, { solicitacaoIds: [7, 3], pagina: 1, limite: 20 });
    assert.match(ex.chamadas[0].texto, /s\.id\s*=\s*ANY\(\$3::int\[\]\)/);
    assert.match(ex.chamadas[0].texto, /s\.empresa_id = \$1 AND s\.status IN \('APROVADA', 'APROVADA_PARCIAL'\)/);
    assert.deepEqual(ex.chamadas[0].valores, [EMPRESA, null, [7, 3], 20, 0]);
    const c = executorFalso();
    await repo.contarEntregaveis(c, EMPRESA, { solicitacaoIds: [] });
    assert.deepEqual(c.chamadas[0].valores, [EMPRESA, null, []], 'lista vazia é filtro que não deixa passar nada, não "sem filtro"');
  });

  test('as encerráveis são as mesmas funções e aceitam o filtro igualmente', async () => {
    assert.equal(repo.listarEncerraveis, repo.listarEntregaveis);
    assert.equal(repo.contarEncerraveis, repo.contarEntregaveis);
  });

  test('ids inválidos são recusados antes de consultar', async () => {
    const ex = executorFalso();
    for (const ids of ['1', [0], [1.5], ['1'], [null]]) {
      await assert.rejects(() => repo.listarEntregaveis(ex, EMPRESA, { solicitacaoIds: ids, pagina: 1, limite: 20 }), TypeError);
      await assert.rejects(() => repo.contarEntregaveis(ex, EMPRESA, { solicitacaoIds: ids }), TypeError);
    }
    assert.equal(ex.chamadas.length, 0);
  });
});
