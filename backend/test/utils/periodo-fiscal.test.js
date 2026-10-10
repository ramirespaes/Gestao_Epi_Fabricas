'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * 12K-D6: período do pacote de fiscalização. Máximo de 366 dias INCLUINDO as duas datas, contado por data civil
 * (nunca por diferença de timestamps).
 */
const P = () => exigirModulo('src/utils/periodo-fiscal');

describe('período do pacote de fiscalização', () => {
  test('o máximo é 366 dias inclusivos', () => {
    assert.equal(P().DIAS_MAXIMOS, 366);
  });

  test('mesmo dia = 1 dia', () => {
    assert.equal(P().diasInclusivos('2026-01-01', '2026-01-01'), 1);
  });

  test('dois dias seguidos = 2 dias; ano comum inteiro = 365; ano bissexto inteiro = 366', () => {
    assert.equal(P().diasInclusivos('2026-01-01', '2026-01-02'), 2);
    assert.equal(P().diasInclusivos('2026-01-01', '2026-12-31'), 365);
    assert.equal(P().diasInclusivos('2028-01-01', '2028-12-31'), 366);
  });

  test('exatamente 366 dias inclusivos é permitido e 367 é recusado (sem ambiguidade de 365/366)', () => {
    assert.deepEqual(P().validar('2026-01-01', '2027-01-01'), { dias: 366 });
    assert.throws(() => P().validar('2026-01-01', '2027-01-02'), (e) => e.codigo === 'PERIODO_MAXIMO_EXCEDIDO');
    assert.deepEqual(P().validar('2028-01-01', '2028-12-31'), { dias: 366 });
    assert.throws(() => P().validar('2028-01-01', '2029-01-01'), (e) => e.codigo === 'PERIODO_MAXIMO_EXCEDIDO');
  });

  test('a virada de horário de verão ou de fuso não muda a contagem civil', () => {
    assert.equal(P().diasInclusivos('2026-10-31', '2026-11-02'), 3);
    assert.equal(P().diasInclusivos('2018-11-03', '2018-11-05'), 3);
  });

  test('datas inválidas, fora do formato ou invertidas são recusadas com código controlado', () => {
    assert.throws(() => P().validar('2026-02-30', '2026-03-01'), (e) => e.codigo === 'DATA_INVALIDA');
    assert.throws(() => P().validar('01/01/2026', '2026-03-01'), (e) => e.codigo === 'DATA_INVALIDA');
    assert.throws(() => P().validar('2026-03-02', '2026-03-01'), (e) => e.codigo === 'PERIODO_INVERTIDO');
    assert.throws(() => P().validar(undefined, '2026-03-01'), (e) => e.codigo === 'DATA_INVALIDA');
  });
});
