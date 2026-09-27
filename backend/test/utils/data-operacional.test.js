'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { dataOperacional, exigirDataOperacional, FUSO } = require('../../src/utils/data-operacional');

describe('dataOperacional — dia civil em America/Sao_Paulo', () => {
  test('o fuso é America/Sao_Paulo', () => {
    assert.equal(FUSO, 'America/Sao_Paulo');
  });

  test('23h59 de 30/09 em São Paulo ainda é 30/09, embora em UTC já seja 01/10', () => {
    assert.equal(dataOperacional(new Date('2026-10-01T02:59:59Z')), '2026-09-30');
  });

  test('à meia-noite de São Paulo o dia muda', () => {
    assert.equal(dataOperacional(new Date('2026-10-01T03:00:00Z')), '2026-10-01');
  });

  test('instante inválido é recusado', () => {
    assert.throws(() => dataOperacional(new Date('não é data')), /data/);
    assert.throws(() => dataOperacional('2026-09-30'), /data/);
  });

  test('exigirDataOperacional aceita só AAAA-MM-DD de calendário', () => {
    assert.doesNotThrow(() => exigirDataOperacional('2026-09-30'));
    for (const invalida of ['2026-9-30', '30/09/2026', '2026-02-30', '', null, undefined, 20260930]) {
      assert.throws(() => exigirDataOperacional(invalida), /data operacional/, String(invalida));
    }
  });
});
