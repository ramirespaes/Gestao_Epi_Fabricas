'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const schemas = require('../../src/schemas/auth-plataforma.schema');

/**
 * Corpos das rotas de cadastro do MFA do Painel Privado. Estritos: só o
 * campo esperado, com limite de tamanho e formato; o valor nunca volta em
 * erro (isso é do middleware validar, coberto em test/middleware).
 */

const valido = (schema, corpo) => schema.safeParse(corpo).success;

describe('mfaLiberacao', () => {
  const body = () => schemas.mfaLiberacao.body;

  test('aceita o código de liberação como texto de até 64 caracteres; a forma canônica é conferida no serviço', () => {
    assert.equal(valido(body(), { codigoLiberacao: 'ABCD-EFGH-JKMN-PQRS' }), true);
    assert.equal(valido(body(), { codigoLiberacao: 'abcd efgh jkmn pqrs' }), true);
  });

  test('recusa ausência, vazio, longo demais, tipo errado e campo a mais', () => {
    for (const corpo of [{}, { codigoLiberacao: '' }, { codigoLiberacao: 'A'.repeat(65) }, { codigoLiberacao: 1234 }, { codigoLiberacao: 'ABCD-EFGH-JKMN-PQRS', email: 'x@y.com' }]) {
      assert.equal(valido(body(), corpo), false, JSON.stringify(corpo));
    }
  });
});

describe('mfaCadastroConfirmar', () => {
  const body = () => schemas.mfaCadastroConfirmar.body;

  test('exatamente 6 dígitos', () => {
    assert.equal(valido(body(), { codigo: '012345' }), true);
    for (const codigo of ['12345', '1234567', '12a456', ' 123456', 123456, '']) {
      assert.equal(valido(body(), { codigo }), false, String(codigo));
    }
    assert.equal(valido(body(), { codigo: '123456', extra: 1 }), false);
  });
});

describe('mfaCadastroReiniciar', () => {
  test('corpo vazio; qualquer campo é recusado', () => {
    assert.equal(valido(schemas.mfaCadastroReiniciar.body, {}), true);
    assert.equal(valido(schemas.mfaCadastroReiniciar.body, { codigo: '123456' }), false);
  });
});
