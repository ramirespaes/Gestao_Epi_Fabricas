'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
  CNPJ_TAMANHO,
  EMAIL_TAMANHO_MAXIMO,
  normalizarCnpj,
  cnpjTemDigitosVerificadoresValidos,
  normalizarEmail,
} = require('../../src/utils/normalizacao');

describe('normalizarCnpj', () => {
  test('constantes exportadas refletem o contrato do banco', () => {
    assert.equal(CNPJ_TAMANHO, 14);
    assert.equal(EMAIL_TAMANHO_MAXIMO, 150);
  });

  test('CNPJ numérico tradicional, com e sem máscara e espaços externos', () => {
    assert.equal(normalizarCnpj('12.345.678/0001-95'), '12345678000195');
    assert.equal(normalizarCnpj('12345678000195'), '12345678000195');
    assert.equal(normalizarCnpj('  12345678000195  '), '12345678000195');
  });

  test('CNPJ alfanumérico, com máscara e em minúsculas, sai em maiúsculas', () => {
    assert.equal(normalizarCnpj('00.000.000/E08G-12'), '00000000E08G12');
    assert.equal(normalizarCnpj('00000000E08G12'), '00000000E08G12');
    assert.equal(normalizarCnpj('00.000.000/e08g-12'), '00000000E08G12');
    assert.equal(normalizarCnpj('AB.CDE.FGH/IJKL-00'), 'ABCDEFGHIJKL00');
  });

  test('só estrutura: DV inválido ainda normaliza', () => {
    assert.equal(normalizarCnpj('12345678000196'), '12345678000196');
  });

  test('rejeições estruturais devolvem null', () => {
    for (const ruim of [
      '00000000E08GA2', '00000000E08G1A', '1234567800019', '123456780001951',
      '12 345 678 0001 95', '12345678000195x', '12.345.678/0001_95', '12.345.678/0001-9O',
      'ÇBCDEFGHIJKL00', '', '   ', '..//--',
    ]) {
      assert.equal(normalizarCnpj(ruim), null, JSON.stringify(ruim));
    }
    assert.equal(normalizarCnpj(null), null);
    assert.equal(normalizarCnpj(undefined), null);
    assert.equal(normalizarCnpj(12345678000195), null);
  });

  test('é idempotente', () => {
    assert.equal(normalizarCnpj(normalizarCnpj('12.345.678/0001-95')), '12345678000195');
    assert.equal(normalizarCnpj(normalizarCnpj('00.000.000/e08g-12')), '00000000E08G12');
    assert.equal(normalizarCnpj('00000000E08G12').length, CNPJ_TAMANHO);
  });
});

describe('cnpjTemDigitosVerificadoresValidos', () => {
  test('aceita DV correto nos dois formatos', () => {
    assert.equal(cnpjTemDigitosVerificadoresValidos('12345678000195'), true);
    assert.equal(cnpjTemDigitosVerificadoresValidos('11444777000161'), true);
    assert.equal(cnpjTemDigitosVerificadoresValidos('00000000E08G12'), true);
    assert.equal(cnpjTemDigitosVerificadoresValidos('00000000000000'), true);
  });

  test('rejeita DV incorreto nos dois formatos', () => {
    assert.equal(cnpjTemDigitosVerificadoresValidos('12345678000196'), false);
    assert.equal(cnpjTemDigitosVerificadoresValidos('12345678000185'), false);
    assert.equal(cnpjTemDigitosVerificadoresValidos('00000000E08G13'), false);
    assert.equal(cnpjTemDigitosVerificadoresValidos('00000000E08G22'), false);
    assert.equal(cnpjTemDigitosVerificadoresValidos('ABCDEFGHIJKL00'), false);
  });

  test('entrada não normalizada devolve false sem normalizar', () => {
    for (const ruim of ['12.345.678/0001-95', ' 12345678000195', '00000000e08g12', '', null, 12345678000195]) {
      assert.equal(cnpjTemDigitosVerificadoresValidos(ruim), false, JSON.stringify(ruim));
    }
  });
});

describe('normalizarEmail', () => {
  test('remove espaços externos e converte para minúsculas de forma determinística', () => {
    assert.equal(normalizarEmail('  Luis@Empresa.com '), 'luis@empresa.com');
    assert.equal(normalizarEmail('A.B-c_d+tag@Sub.Dominio.com.br'), 'a.b-c_d+tag@sub.dominio.com.br');
    assert.equal(normalizarEmail('x@y.z'), 'x@y.z');
    assert.equal(normalizarEmail('LUIS@EMPRESA.COM'), normalizarEmail('luis@empresa.com'));
  });

  test('respeita o limite de 150 caracteres do banco', () => {
    assert.equal(normalizarEmail('a'.repeat(138) + '@empresa.com').length, EMAIL_TAMANHO_MAXIMO);
    assert.equal(normalizarEmail('a'.repeat(140) + '@empresa.com'), null);
  });

  test('rejeita formatos inválidos, não ASCII e tipos errados', () => {
    for (const ruim of ['semarroba.com', 'a@b', 'a@@b.com', 'lu is@empresa.com', 'lu\tis@empresa.com', 'josé@empresa.com', 'luis@empresa.com​', '', '   ']) {
      assert.equal(normalizarEmail(ruim), null, JSON.stringify(ruim));
    }
    assert.equal(normalizarEmail(null), null);
    assert.equal(normalizarEmail({}), null);
  });

  test('é idempotente', () => {
    assert.equal(normalizarEmail(normalizarEmail('  Luis@Empresa.com ')), 'luis@empresa.com');
  });
});
