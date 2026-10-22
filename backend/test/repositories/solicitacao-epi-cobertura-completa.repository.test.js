'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * 12I (21/10/2026) — "Disponíveis para entrega" = só os pedidos COMPLETAMENTE disponíveis (RED), sem PostgreSQL real: TODOS os itens ainda
 * pendentes estão cobertos pelo estoque (coberta = pendente) e NENHUM item pendente está fora da fila de cobertura (trabalhador ou EPI inativo
 * = suspenso). É a mesma cobertura FIFO das demais contagens; a regra de "algum item coberto" (parcial) continua como estava, para quem a usa.
 * O banco real prova a regra em dashboard-contagens-e-destinos.integration.js.
 */

const repo = () => exigirModulo('src/repositories/solicitacao-epi-cobertura.repository');
const EMPRESA = 42;
const HOJE = '2026-10-02';
function executorFalso(rows = []) {
  const chamadas = [];
  return { chamadas, query: async (texto, valores) => { chamadas.push({ texto, valores }); return { rows, rowCount: rows.length }; } };
}

describe('contarSolicitacoesPorCobertura — coberturaCompleta', () => {
  test('devolve as três populações: algum item coberto, nenhum item coberto e cobertura completa (inteiros do servidor)', async () => {
    const ex = executorFalso([{ com_cobertura: 4, sem_cobertura: 3, cobertura_completa: 2 }]);
    assert.deepEqual(await repo().contarSolicitacoesPorCobertura(ex, EMPRESA, { hoje: HOJE }), { comCobertura: 4, semCobertura: 3, coberturaCompleta: 2 });
  });

  test('a regra é SQL fixo sobre a MESMA fila: todos os itens cobertos E nenhum item pendente fora da fila (suspenso); empresa e data só como parâmetro', async () => {
    const ex = executorFalso([{ com_cobertura: 0, sem_cobertura: 0, cobertura_completa: 0 }]);
    await repo().contarSolicitacoesPorCobertura(ex, EMPRESA, { hoje: HOJE });
    const sql = ex.chamadas[0].texto;
    assert.match(sql, /bool_and\(c\.coberta\s*=\s*c\.pendente\)/i);
    assert.match(sql, /itens_na_fila\s*=\s*p\.n/i);
    assert.match(sql, /WITH fila AS/);
    assert.deepEqual(ex.chamadas[0].valores, [EMPRESA, HOJE, null]);
  });
});

describe('idsDeSolicitacoesCoberturaCompleta (filtro COBERTURA_COMPLETA das listas)', () => {
  test('usa a mesma consulta da contagem e devolve só os ids', async () => {
    const ex = executorFalso([{ solicitacao_id: 7 }, { solicitacao_id: 3 }]);
    assert.deepEqual(await repo().idsDeSolicitacoesCoberturaCompleta(ex, EMPRESA, { hoje: HOJE }), [7, 3]);
    assert.match(ex.chamadas[0].texto, /bool_and\(c\.coberta\s*=\s*c\.pendente\)/i);
    assert.match(ex.chamadas[0].texto, /itens_na_fila\s*=\s*p\.n/i);
    assert.deepEqual(ex.chamadas[0].valores, [EMPRESA, HOJE, null]);
  });

  test('valida empresa e data antes de consultar', async () => {
    const ex = executorFalso();
    await assert.rejects(() => repo().idsDeSolicitacoesCoberturaCompleta(ex, 0, { hoje: HOJE }), TypeError);
    await assert.rejects(() => repo().idsDeSolicitacoesCoberturaCompleta(ex, EMPRESA, { hoje: 'x' }), TypeError);
    assert.equal(ex.chamadas.length, 0);
  });
});
