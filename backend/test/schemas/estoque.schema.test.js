'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const estoque = require('../../src/schemas/estoque.schema');

/** Testes do schema de estoque (Bloco 9, Etapa A — correção pós-auditoria de 23/09/2026). */

describe('quantidade — teto do INTEGER do PostgreSQL', () => {
  test('aceita exatamente o teto do INTEGER (2147483647)', () => {
    const r = estoque.movimentar.body.safeParse({ tamanho: '40', tipo: 'ENTRADA', quantidade: 2147483647 });
    assert.equal(r.success, true);
  });

  test('rejeita quantidade acima do teto do INTEGER', () => {
    const r = estoque.movimentar.body.safeParse({ tamanho: '40', tipo: 'ENTRADA', quantidade: 2147483648 });
    assert.equal(r.success, false);
  });

  test('rejeita quantidade zero ou negativa', () => {
    for (const quantidade of [0, -1]) {
      const r = estoque.movimentar.body.safeParse({ tamanho: '40', tipo: 'ENTRADA', quantidade });
      assert.equal(r.success, false);
    }
  });
});

describe('motivo — null explícito não gera invalid_union', () => {
  test('motivo null é aceito, com o código correto quando o conteúdo é inválido', () => {
    const nulo = estoque.movimentar.body.safeParse({ tamanho: '40', tipo: 'ENTRADA', quantidade: 1, motivo: null });
    assert.equal(nulo.success, true);
    assert.equal(nulo.data.motivo, null);

    const invalido = estoque.movimentar.body.safeParse({ tamanho: '40', tipo: 'ENTRADA', quantidade: 1, motivo: 'x'.repeat(300) });
    assert.equal(invalido.success, false);
    assert.equal(invalido.error.issues[0].code, 'custom');
    assert.equal(invalido.error.issues[0].params.codigo, 'MOTIVO_INVALIDO');
  });
});
