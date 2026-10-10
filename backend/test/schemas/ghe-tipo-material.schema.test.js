'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const schemas = require('../../src/schemas/ghe-tipo-material.schema');

describe('schema do vínculo GHE × tipo de material', () => {
  test('aceita só as duas classificações, sem nulo, e recusa campos extras', () => {
    for (const classificacao of ['OBRIGATORIO', 'NAO_OBRIGATORIO']) {
      assert.deepEqual(schemas.definir.body.parse({ classificacao }), { classificacao });
    }
    for (const corpo of [{}, { classificacao: null }, { classificacao: 'obrigatorio' }, { classificacao: '' }, { classificacao: 1 }, { classificacao: 'OBRIGATORIO', empresaId: 1 }]) {
      assert.equal(schemas.definir.body.safeParse(corpo).success, false, JSON.stringify(corpo));
    }
  });

  test('os identificadores do caminho são inteiros positivos; DELETE não aceita corpo', () => {
    assert.equal(schemas.definir.params.safeParse({ id: '3', tipoId: '7' }).success, true);
    for (const params of [{ id: 'abc', tipoId: '1' }, { id: '1', tipoId: '0' }, { id: '1' }, { id: '1', tipoId: '1', x: '1' }]) {
      assert.equal(schemas.definir.params.safeParse(params).success, false, JSON.stringify(params));
    }
    assert.equal(schemas.desvincular.body.safeParse({ qualquer: 1 }).success, false);
  });
});
