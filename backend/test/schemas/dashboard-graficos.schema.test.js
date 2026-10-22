'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const schemas = require('../../src/schemas/dashboard.schema');

/** 12I — consulta dos gráficos: só `periodo` (MES | SEIS_MESES | ANO, padrão MES); qualquer outro parâmetro é recusado. */
describe('dashboard.schema.graficos.query', () => {
  test('aceita os três períodos e usa MES por padrão', () => {
    for (const periodo of ['MES', 'SEIS_MESES', 'ANO']) {
      assert.deepEqual(schemas.graficos.query.parse({ periodo }), { periodo });
    }
    assert.deepEqual(schemas.graficos.query.parse({}), { periodo: 'MES' });
  });

  test('recusa período desconhecido, minúsculas, parâmetro extra e empresa', () => {
    for (const q of [{ periodo: 'SEMANA' }, { periodo: 'mes' }, { periodo: 'MES', de: '2026-01-01' }, { empresaId: 1 }, { periodo: ['MES'] }]) {
      assert.equal(schemas.graficos.query.safeParse(q).success, false, JSON.stringify(q));
    }
  });

  test('a consulta dos indicadores continua sem parâmetros', () => {
    assert.equal(schemas.indicadores.query.safeParse({ periodo: 'MES' }).success, false);
  });
});
