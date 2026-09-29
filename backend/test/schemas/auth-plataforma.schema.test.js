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

describe('mfaVerificar', () => {
  test('existe, com corpo estrito de exatamente 6 dígitos em texto', () => {
    assert.ok(schemas.mfaVerificar, 'schema mfaVerificar ausente');
    const body = schemas.mfaVerificar.body;
    assert.equal(valido(body, { codigo: '000000' }), true);
    for (const codigo of ['12345', '1234567', '12a456', ' 123456', '123456 ', '12 456', 123456, '', null]) {
      assert.equal(valido(body, { codigo }), false, String(codigo));
    }
    assert.equal(valido(body, {}), false);
    assert.equal(valido(body, { codigo: '123456', extra: 1 }), false);
  });
});

describe('mfaRecuperacao', () => {
  test('existe; aceita o recovery code como texto de até 64 caracteres, a forma canônica é do serviço', () => {
    assert.ok(schemas.mfaRecuperacao, 'schema mfaRecuperacao ausente');
    const body = schemas.mfaRecuperacao.body;
    assert.equal(valido(body, { codigoRecuperacao: 'ABCD-EFGH-JKMN-PQRS' }), true);
    assert.equal(valido(body, { codigoRecuperacao: 'abcd efgh jkmn pqrs' }), true);
    for (const corpo of [{}, { codigoRecuperacao: '' }, { codigoRecuperacao: 'A'.repeat(65) }, { codigoRecuperacao: 1234 }, { codigoRecuperacao: 'ABCD-EFGH-JKMN-PQRS', extra: 1 }]) {
      assert.equal(valido(body, corpo), false, JSON.stringify(corpo));
    }
  });
});

describe('mfaReautenticacao e mfaSubstituicaoConfirmar', () => {
  test('reautenticação: senha e TOTP de 6 dígitos, nada além', () => {
    assert.ok(schemas.mfaReautenticacao, 'schema mfaReautenticacao ausente');
    const body = schemas.mfaReautenticacao.body;
    assert.equal(valido(body, { senha: 'uma-senha-qualquer', codigo: '123456' }), true);
    for (const corpo of [{}, { senha: 'x' }, { codigo: '123456' }, { senha: 'uma-senha-qualquer', codigo: '12345' },
      { senha: 'uma-senha-qualquer', codigo: 123456 }, { senha: 'uma-senha-qualquer', codigo: '123456', extra: 1 }]) {
      assert.equal(valido(body, corpo), false, JSON.stringify(corpo));
    }
  });

  test('confirmação da substituição: só o TOTP novo de 6 dígitos', () => {
    assert.ok(schemas.mfaSubstituicaoConfirmar, 'schema mfaSubstituicaoConfirmar ausente');
    const body = schemas.mfaSubstituicaoConfirmar.body;
    assert.equal(valido(body, { codigo: '000000' }), true);
    for (const corpo of [{}, { codigo: ' 12345' }, { codigo: '123456', senha: 'x' }]) {
      assert.equal(valido(body, corpo), false, JSON.stringify(corpo));
    }
  });
});

describe('mfaCadastroReiniciar', () => {
  test('corpo vazio; qualquer campo é recusado', () => {
    assert.equal(valido(schemas.mfaCadastroReiniciar.body, {}), true);
    assert.equal(valido(schemas.mfaCadastroReiniciar.body, { codigo: '123456' }), false);
  });
});
