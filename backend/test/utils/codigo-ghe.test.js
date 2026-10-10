'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { normalizarCodigoGhe } = require('../../src/utils/codigo-ghe');

describe('normalizarCodigoGhe', () => {
  test('apara, põe em maiúsculas e aceita GHE- + 3 a 6 dígitos', () => {
    for (const [entrada, esperado] of [
      ['GHE-001', 'GHE-001'], ['GHE-032', 'GHE-032'], ['GHE-1000', 'GHE-1000'], ['GHE-999999', 'GHE-999999'],
      ['ghe-003', 'GHE-003'], ['  Ghe-004\t', 'GHE-004'], ['\nGHE-005 ', 'GHE-005'],
    ]) {
      assert.equal(normalizarCodigoGhe(entrada), esperado, JSON.stringify(entrada));
    }
  });

  test('recusa formato fora da regra, inclusive dígitos que não são 0-9', () => {
    for (const entrada of [
      'GHE-01', 'GHE-1234567', 'ABC-001', 'GHE-ABC', 'GHE 001', 'GHE001', 'GHE--001', '-GHE-001', 'GHE-0 01', 'GHE-001-',
      '', '   ', 'GHE-00１', 'GHE-٠٠١', 'ＧＨＥ-001', 'GHE-001\u0000',
    ]) {
      assert.equal(normalizarCodigoGhe(entrada), null, JSON.stringify(entrada));
    }
  });

  test('só string é aceita', () => {
    for (const entrada of [undefined, null, 1, {}, [], ['GHE-001'], true]) {
      assert.equal(normalizarCodigoGhe(entrada), null);
    }
  });
});
