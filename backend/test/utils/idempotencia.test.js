'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  chaveCanonica, hashRequisicao, lockDaChave, ESPACO_ESTOQUE, ESPACO_ENTREGAS,
} = require('../../src/utils/idempotencia');

/**
 * Helpers de idempotência compartilhados por estoque e entrega: chave UUID
 * canônica, hash SHA-256 da requisição lógica e advisory lock de 64 bits por
 * espaço, empresa e chave. A derivação do lock do estoque é a mesma de antes
 * da extração.
 */

const CHAVE = '3F2B8C1E-9A4D-4E7B-8C2A-1D5E6F7A8B9C';
const CHAVE_MINUSCULA = CHAVE.toLowerCase();

describe('chaveCanonica', () => {
  test('aceita UUID em qualquer caixa e devolve minúsculo; qualquer outra coisa devolve null', () => {
    assert.equal(chaveCanonica(CHAVE), CHAVE_MINUSCULA);
    assert.equal(chaveCanonica(CHAVE_MINUSCULA), CHAVE_MINUSCULA);
    for (const invalida of ['abc', '', null, undefined, 42, `${CHAVE_MINUSCULA} `, CHAVE_MINUSCULA.slice(1), { chave: CHAVE }]) {
      assert.equal(chaveCanonica(invalida), null, String(invalida));
    }
  });
});

describe('hashRequisicao', () => {
  test('SHA-256 hexadecimal do JSON das partes, determinístico e sensível a qualquer parte', () => {
    const hash = hashRequisicao(['ENTRADA', 30, '40', 10, '12345', '2027-06-30']);
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.equal(hash, hashRequisicao(['ENTRADA', 30, '40', 10, '12345', '2027-06-30']));
    assert.equal(hash, crypto.createHash('sha256').update(JSON.stringify(['ENTRADA', 30, '40', 10, '12345', '2027-06-30'])).digest('hex'));
    assert.notEqual(hash, hashRequisicao(['ENTRADA', 30, '40', 11, '12345', '2027-06-30']));
    assert.notEqual(hash, hashRequisicao(['BAIXA', 30, '40', 10, '12345', '2027-06-30']));
  });
});

describe('lockDaChave', () => {
  test('inteiro de 64 bits com sinal, em texto, o mesmo para a mesma entrada', () => {
    const lock = lockDaChave(ESPACO_ESTOQUE, 4242, CHAVE_MINUSCULA);
    assert.match(lock, /^-?\d{1,19}$/);
    const n = BigInt(lock);
    assert.ok(n >= -(2n ** 63n) && n < 2n ** 63n);
    assert.equal(lock, lockDaChave(ESPACO_ESTOQUE, 4242, CHAVE_MINUSCULA));
  });

  test('o lock do estoque é exatamente o de antes da extração (sha256 de "estoque_operacoes\\n<empresa>\\n<chave>")', () => {
    const legado = crypto.createHash('sha256').update(`estoque_operacoes\n4242\n${CHAVE_MINUSCULA}`).digest().readBigInt64BE(0).toString();
    assert.equal(ESPACO_ESTOQUE, 'estoque_operacoes');
    assert.equal(lockDaChave(ESPACO_ESTOQUE, 4242, CHAVE_MINUSCULA), legado);
  });

  test('espaços, empresas e chaves diferentes dão locks diferentes: estoque e entregas não colidem', () => {
    assert.equal(ESPACO_ENTREGAS, 'entregas_epi');
    const estoque = lockDaChave(ESPACO_ESTOQUE, 4242, CHAVE_MINUSCULA);
    assert.notEqual(estoque, lockDaChave(ESPACO_ENTREGAS, 4242, CHAVE_MINUSCULA));
    assert.notEqual(estoque, lockDaChave(ESPACO_ESTOQUE, 4243, CHAVE_MINUSCULA));
    assert.notEqual(estoque, lockDaChave(ESPACO_ESTOQUE, 4242, '3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9d'));
  });

  test('recusa espaço desconhecido, empresa ou chave fora do formato', () => {
    assert.throws(() => lockDaChave('outro', 1, CHAVE_MINUSCULA), /espaço/);
    assert.throws(() => lockDaChave(ESPACO_ESTOQUE, 0, CHAVE_MINUSCULA), /empresa/);
    assert.throws(() => lockDaChave(ESPACO_ESTOQUE, 1, CHAVE), /chave/);
  });
});
