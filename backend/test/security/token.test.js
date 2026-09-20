'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  TOKEN_BYTES,
  TOKEN_TAMANHO,
  TOKEN_HASH_TAMANHO,
  gerarTokenSessao,
  tokenSessaoTemFormatoValido,
  hashTokenSessao,
} = require('../../src/security/token');

const FORMATO = /^[A-Za-z0-9_-]{43}$/;
const ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

describe('token de sessão', () => {
  test('constantes do contrato da migration 013', () => {
    assert.deepEqual([TOKEN_BYTES, TOKEN_TAMANHO, TOKEN_HASH_TAMANHO], [32, 43, 64]);
  });

  test('1.000 tokens: 32 bytes, 43 caracteres base64url canônicos e distintos', () => {
    const vistos = new Set();
    for (let i = 0; i < 1000; i += 1) {
      const token = gerarTokenSessao();
      assert.equal(token.length, TOKEN_TAMANHO);
      assert.match(token, FORMATO);
      assert.equal(token.includes('='), false);
      assert.equal(Buffer.from(token, 'base64url').length, TOKEN_BYTES);
      assert.equal(tokenSessaoTemFormatoValido(token), true);
      vistos.add(token);
    }
    assert.equal(vistos.size, 1000);
  });

  test('hash persistido é SHA-256 hex minúsculo de 64 caracteres, determinístico e sem o token', () => {
    const a = gerarTokenSessao();
    const b = gerarTokenSessao();
    const hashA = hashTokenSessao(a);
    assert.equal(hashA.length, TOKEN_HASH_TAMANHO);
    assert.match(hashA, /^[0-9a-f]{64}$/);
    assert.equal(hashA, crypto.createHash('sha256').update(a).digest('hex'));
    assert.equal(hashTokenSessao(a), hashA);
    assert.notEqual(hashTokenSessao(b), hashA);
    assert.equal(hashA.includes(a.slice(0, 8)), false);
  });

  test('representações base64url não canônicas dos mesmos bytes são rejeitadas', () => {
    const token = gerarTokenSessao();
    const indice = ALFABETO.indexOf(token[42]);
    assert.equal(indice % 4, 0, 'token gerado tem os 2 bits finais zerados');
    for (const delta of [1, 2, 3]) {
      const variante = token.slice(0, 42) + ALFABETO[indice + delta];
      assert.match(variante, FORMATO);
      assert.equal(Buffer.from(variante, 'base64url').equals(Buffer.from(token, 'base64url')), true);
      assert.equal(tokenSessaoTemFormatoValido(variante), false);
      assert.throws(() => hashTokenSessao(variante), TypeError);
    }
  });

  test('entradas inválidas: false na validação e TypeError fixo no hash, sem o valor', () => {
    const token = gerarTokenSessao();
    const ruins = ['', token + '=', token.slice(0, 42) + '+', token.slice(0, 42) + '/', token.slice(0, 42), token + 'A', ' ' + token.slice(1), null, undefined, 12345, {}, Buffer.from(token, 'base64url'), [token]];
    for (const ruim of ruins) {
      assert.equal(tokenSessaoTemFormatoValido(ruim), false);
      assert.throws(() => hashTokenSessao(ruim), (erro) => {
        assert.ok(erro instanceof TypeError);
        assert.equal(erro.message, 'token de sessão com formato inválido');
        return true;
      });
    }
  });
});
