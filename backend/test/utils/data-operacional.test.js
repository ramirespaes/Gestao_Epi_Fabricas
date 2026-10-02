'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { dataOperacional, exigirDataOperacional, FUSO } = require('../../src/utils/data-operacional');

describe('dataOperacional — dia civil em America/Sao_Paulo', () => {
  test('o fuso é America/Sao_Paulo', () => {
    assert.equal(FUSO, 'America/Sao_Paulo');
  });

  test('23h59 de 30/09 em São Paulo ainda é 30/09, embora em UTC já seja 01/10', () => {
    assert.equal(dataOperacional(new Date('2026-10-01T02:59:59Z')), '2026-09-30');
  });

  test('à meia-noite de São Paulo o dia muda', () => {
    assert.equal(dataOperacional(new Date('2026-10-01T03:00:00Z')), '2026-10-01');
  });

  test('instante inválido é recusado', () => {
    assert.throws(() => dataOperacional(new Date('não é data')), /data/);
    assert.throws(() => dataOperacional('2026-09-30'), /data/);
  });

  test('exigirDataOperacional aceita só AAAA-MM-DD de calendário', () => {
    assert.doesNotThrow(() => exigirDataOperacional('2026-09-30'));
    for (const invalida of ['2026-9-30', '30/09/2026', '2026-02-30', '', null, undefined, 20260930]) {
      assert.throws(() => exigirDataOperacional(invalida), /data operacional/, String(invalida));
    }
  });

  test('todo valor inválido termina em TypeError("data operacional inválida"): mês ou dia impossível nunca vira RangeError', () => {
    const impossiveis = [
      '2026-13-01', '2026-00-01', '2026-12-32', '2026-01-00', '2026-00-00', '2026-99-99', '0000-00-00',
      '2026-02-30', '2026-04-31', '2023-02-29', '1900-02-29',
    ];
    for (const invalida of impossiveis) {
      assert.throws(() => exigirDataOperacional(invalida), (erro) => {
        assert.ok(erro instanceof TypeError, `${invalida}: esperado TypeError, veio ${erro && erro.name}`);
        assert.equal(erro.message, 'data operacional inválida', invalida);
        return true;
      }, invalida);
    }
  });

  test('as datas de calendário válidas continuam aceitas, inclusive 29/02 de ano bissexto e as pontas do ano', () => {
    for (const valida of ['2026-09-30', '2026-02-28', '2024-02-29', '2000-02-29', '2026-01-01', '2026-12-31', '2026-04-30']) {
      assert.doesNotThrow(() => exigirDataOperacional(valida), valida);
      assert.equal(exigirDataOperacional(valida), undefined, 'o contrato não devolve valor');
    }
  });
});
