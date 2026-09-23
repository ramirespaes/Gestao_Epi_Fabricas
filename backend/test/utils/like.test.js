'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { escaparCoringasLike } = require('../../src/utils/like');

/** Bloco 9, Etapa B — promovido de material.repository.js (Etapa A). */
describe('escaparCoringasLike', () => {
  test('% e _ viram literais', () => {
    assert.equal(escaparCoringasLike('100%_seguro'), '100\\%\\_seguro');
    assert.equal(escaparCoringasLike('50%'), '50\\%');
  });

  test('barra invertida é escapada primeiro, sem escapar em dobro o que ela mesma produz', () => {
    assert.equal(escaparCoringasLike('a\\b'), 'a\\\\b');
    assert.equal(escaparCoringasLike('\\%'), '\\\\\\%');
  });

  test('texto sem coringas sai intacto', () => {
    assert.equal(escaparCoringasLike('botina'), 'botina');
    assert.equal(escaparCoringasLike(''), '');
  });

  test('recusa não-string', () => {
    for (const ruim of [null, undefined, 42, {}]) {
      assert.throws(() => escaparCoringasLike(ruim), /string/);
    }
  });
});
