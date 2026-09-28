'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const repo = require('../../src/repositories/lote-recuperacao-mfa-plataforma.repository');

/**
 * Contrato do repositório de lotes de recovery codes (migration 050). O
 * banco garante um único lote ATIVO por administrador; aqui ficam só a
 * criação, a busca (com trava opcional) e a revogação condicional.
 */

const ADMIN = 7;
const LOTE = '12';

const executorFalso = (linhas = [], rowCount) => {
  const chamadas = [];
  return {
    chamadas,
    query: async (texto, valores) => {
      chamadas.push({ texto, valores });
      return { rows: linhas, rowCount: rowCount ?? linhas.length };
    },
  };
};

describe('criar', () => {
  test('cria o lote ATIVO pelo relógio do banco e devolve id e criação', async () => {
    const criadoEm = new Date('2026-09-28T10:00:00Z');
    const executor = executorFalso([{ id: LOTE, criado_em: criadoEm }]);

    assert.deepEqual(await repo.criar(executor, ADMIN), { id: LOTE, criadoEm });

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /insert\s+into\s+lotes_recuperacao_mfa_plataforma/i);
    assert.match(texto, /'ATIVO'/);
    assert.match(texto, /clock_timestamp\(\)/i);
    assert.deepEqual(valores, [ADMIN]);
  });

  test('recusa administrador inválido antes de consultar', async () => {
    const executor = executorFalso([]);
    for (const id of [0, -1, '7', 1.5, null]) {
      await assert.rejects(() => repo.criar(executor, id), TypeError);
    }
    assert.equal(executor.chamadas.length, 0);
  });
});

describe('buscarAtivo', () => {
  test('busca o lote ATIVO do administrador; FOR UPDATE só quando pedido', async () => {
    const criadoEm = new Date();
    const executor = executorFalso([{ id: LOTE, criado_em: criadoEm }]);

    assert.deepEqual(await repo.buscarAtivo(executor, ADMIN), { id: LOTE, criadoEm });
    await repo.buscarAtivo(executor, ADMIN, { travar: true });

    assert.match(executor.chamadas[0].texto, /estado\s*=\s*'ATIVO'/i);
    assert.doesNotMatch(executor.chamadas[0].texto, /for\s+update/i);
    assert.match(executor.chamadas[1].texto, /for\s+update/i);
    assert.deepEqual(executor.chamadas[0].valores, [ADMIN]);
  });

  test('sem lote ativo devolve null', async () => {
    assert.equal(await repo.buscarAtivo(executorFalso([]), ADMIN), null);
  });
});

describe('revogarAtivo', () => {
  test('revoga só o lote ATIVO, com instante e motivo', async () => {
    const executor = executorFalso([], 1);

    assert.equal(await repo.revogarAtivo(executor, { administradorId: ADMIN, motivo: 'REGENERADO' }), true);

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /update\s+lotes_recuperacao_mfa_plataforma/i);
    assert.match(texto, /estado\s*=\s*'REVOGADO'/i);
    assert.match(texto, /revogado_em\s*=\s*clock_timestamp\(\)/i);
    assert.match(texto, /where[\s\S]*estado\s*=\s*'ATIVO'/i);
    assert.deepEqual(valores, [ADMIN, 'REGENERADO']);
  });

  test('sem lote ativo devolve false (idempotente)', async () => {
    assert.equal(await repo.revogarAtivo(executorFalso([], 0), { administradorId: ADMIN, motivo: 'REGENERADO' }), false);
  });

  test('motivo fora do formato é recusado antes de consultar', async () => {
    const executor = executorFalso([], 1);
    await assert.rejects(() => repo.revogarAtivo(executor, { administradorId: ADMIN, motivo: 'regenerado' }), TypeError);
    assert.equal(executor.chamadas.length, 0);
  });
});
