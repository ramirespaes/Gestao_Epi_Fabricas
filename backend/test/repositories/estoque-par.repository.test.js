'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * Contrato do repositório da trava do par (empresa, material, tamanho). O
 * efeito de bloquear, a espera e a ausência de deadlock são provados com
 * PostgreSQL real na integração; aqui confiro o SQL, a ordem de aquisição e
 * a validação.
 */

const repo = () => exigirModulo('src/repositories/estoque-par.repository');

const EMPRESA = 4242;
const par = (materialId, tamanho) => ({ materialId, tamanho });

// Registra início e fim de cada consulta: duas em andamento ao mesmo tempo apareceriam intercaladas.
const executorSequencial = () => {
  const eventos = [];
  const chamadas = [];
  return {
    eventos,
    chamadas,
    query: async (texto, valores) => {
      const n = chamadas.length;
      chamadas.push({ texto, valores });
      eventos.push(`inicio ${n}`);
      await new Promise((resolve) => { setTimeout(resolve, 2); });
      eventos.push(`fim ${n}`);
      return { rows: [] };
    },
  };
};

describe('travarPares', () => {
  test('uma trava advisory de transação de 64 bits por par, na ordem canônica, e devolve os pares travados', async () => {
    const { lockDoPar } = exigirModulo('src/utils/lock-par-estoque');
    const executor = executorSequencial();
    const travados = await repo().travarPares(executor, EMPRESA, [par(31, '41'), par(30, null), par(30, '40')]);
    assert.deepEqual(travados, [par(30, null), par(30, '40'), par(31, '41')]);
    assert.equal(executor.chamadas.length, 3);
    for (const { texto } of executor.chamadas) assert.match(texto, /^SELECT pg_advisory_xact_lock\(\$1::bigint\)$/);
    assert.deepEqual(executor.chamadas.map((c) => c.valores), [
      [lockDoPar(EMPRESA, 30, null)], [lockDoPar(EMPRESA, 30, '40')], [lockDoPar(EMPRESA, 31, '41')],
    ]);
  });

  test('as travas são pedidas uma de cada vez: a ordem de aquisição é a ordem canônica', async () => {
    const executor = executorSequencial();
    await repo().travarPares(executor, EMPRESA, [par(32, 'G'), par(31, 'M'), par(30, 'P')]);
    assert.deepEqual(executor.eventos, ['inicio 0', 'fim 0', 'inicio 1', 'fim 1', 'inicio 2', 'fim 2']);
  });

  test('pares repetidos são travados uma vez; sem pares não consulta', async () => {
    const executor = executorSequencial();
    await repo().travarPares(executor, EMPRESA, [par(30, '40'), par(30, '40')]);
    assert.equal(executor.chamadas.length, 1);
    const vazio = executorSequencial();
    assert.deepEqual(await repo().travarPares(vazio, EMPRESA, []), []);
    assert.equal(vazio.chamadas.length, 0);
  });

  test('outra empresa gera outra trava para o mesmo material e tamanho', async () => {
    const a = executorSequencial();
    const b = executorSequencial();
    await repo().travarPares(a, EMPRESA, [par(30, '40')]);
    await repo().travarPares(b, EMPRESA + 1, [par(30, '40')]);
    assert.notDeepEqual(a.chamadas[0].valores, b.chamadas[0].valores);
  });

  test('recusa empresa e pares inválidos antes de qualquer consulta', async () => {
    const executor = executorSequencial();
    await assert.rejects(() => repo().travarPares(executor, 0, [par(30, '40')]), /empresa/);
    await assert.rejects(() => repo().travarPares(executor, EMPRESA, 'x'), /pares/);
    await assert.rejects(() => repo().travarPares(executor, EMPRESA, [par(30, '40'), par(0, '40')]), /material/);
    await assert.rejects(() => repo().travarPares(executor, EMPRESA, [par(30, '')]), /tamanho/);
    assert.equal(executor.chamadas.length, 0, 'nenhuma trava parcial');
  });
});
