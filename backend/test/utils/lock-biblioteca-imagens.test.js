'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * Biblioteca de Imagens, Unidade 3 (RED) — trava lógica da BIBLIOTECA de uma empresa: advisory lock de 64 bits num espaço próprio, que serializa
 * a deduplicação por SHA-256 e a conferência de cota (dois envios do mesmo arquivo, ou duas disputas pela última vaga, nunca passam juntos).
 * Mesmo desenho de utils/lock-par-estoque.js: texto do inteiro de 64 bits, derivado de um espaço nomeado e da empresa.
 */

const util = () => exigirModulo('src/utils/lock-biblioteca-imagens');
const referencia = (empresaId) => crypto.createHash('sha256').update(`imagens_biblioteca\n${empresaId}`).digest().readBigInt64BE(0).toString();

describe('lockDaBiblioteca', () => {
  test('é o inteiro de 64 bits com sinal, em texto, do espaço "imagens_biblioteca" e da empresa', () => {
    const { lockDaBiblioteca, ESPACO_BIBLIOTECA_IMAGENS } = util();
    assert.equal(ESPACO_BIBLIOTECA_IMAGENS, 'imagens_biblioteca');
    assert.equal(lockDaBiblioteca(7), referencia(7));
    assert.equal(typeof lockDaBiblioteca(7), 'string');
    assert.match(lockDaBiblioteca(7), /^-?\d{1,19}$/);
  });

  test('determinístico, diferente por empresa, e fora do espaço da trava dos pares de estoque (nunca colide por construção)', () => {
    const { lockDaBiblioteca } = util();
    const { lockDoPar } = require('../../src/utils/lock-par-estoque');
    assert.equal(lockDaBiblioteca(7), lockDaBiblioteca(7));
    assert.notEqual(lockDaBiblioteca(7), lockDaBiblioteca(8));
    assert.notEqual(lockDaBiblioteca(7), lockDoPar(7, 1, null));
  });

  test('empresa inválida é erro de programação (TypeError), sem aceitar texto, zero, negativo ou fracionário', () => {
    const { lockDaBiblioteca } = util();
    for (const invalido of ['7', 0, -1, 1.5, null, undefined, NaN]) assert.throws(() => lockDaBiblioteca(invalido), TypeError, String(invalido));
  });
});
