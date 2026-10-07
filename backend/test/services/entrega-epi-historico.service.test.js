'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { statusDaValidade } = require('../../src/services/entrega-epi-consulta.service');

describe('EPIs Entregues: status pelo número de dias restantes', () => {
  test('vencido abaixo de zero, próximo de 0 a 30, válido acima de 30', () => {
    assert.deepEqual([-100, -1].map(statusDaValidade), ['VENCIDO', 'VENCIDO']);
    assert.deepEqual([0, 1, 29, 30].map(statusDaValidade), ['PROXIMO', 'PROXIMO', 'PROXIMO', 'PROXIMO']);
    assert.deepEqual([31, 365].map(statusDaValidade), ['VALIDO', 'VALIDO']);
  });
});
