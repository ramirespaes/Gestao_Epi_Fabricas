'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const util = require('../../src/utils/senha-provisoria');
const { FUSO } = require('../../src/utils/data-operacional');

/**
 * Validade da senha provisória (Gestão de Usuários): 48 horas, ou 72 horas
 * quando criada numa SEXTA-FEIRA no fuso operacional do sistema. Sábado e
 * domingo seguem as 48 horas. Nenhuma renovação: o prazo é só função do
 * instante de definição.
 */

const HORA = 3_600_000;
// Instantes em horário de Brasília (UTC-3), outubro de 2026.
const segunda = new Date('2026-10-05T15:00:00-03:00');
const terca = new Date('2026-10-06T09:30:00-03:00');
const quarta = new Date('2026-10-07T18:45:00-03:00');
const quinta = new Date('2026-10-08T08:00:00-03:00');
const sexta = new Date('2026-10-09T15:00:00-03:00');
const sabado = new Date('2026-10-10T11:00:00-03:00');
const domingo = new Date('2026-10-11T20:00:00-03:00');

describe('senha provisória — validade 48h/72h no fuso operacional', () => {
  test('constantes: 48 horas por padrão, 72 na sexta, mesmo fuso da data operacional', () => {
    assert.deepEqual([util.HORAS_PADRAO, util.HORAS_SEXTA, util.FUSO], [48, 72, FUSO]);
    assert.equal(FUSO, 'America/Sao_Paulo');
  });

  test('segunda a quinta: 48 horas exatas', () => {
    for (const dia of [segunda, terca, quarta, quinta]) {
      const v = util.calcularValidade(dia);
      assert.equal(v.horas, 48, dia.toISOString());
      assert.equal(v.expiraEm.getTime() - v.definidaEm.getTime(), 48 * HORA);
      assert.equal(v.definidaEm.getTime(), dia.getTime(), 'a definição é o próprio instante, sem arredondar');
    }
  });

  test('sexta-feira: 72 horas — sexta 15:00 expira segunda 15:00', () => {
    const v = util.calcularValidade(sexta);
    assert.equal(v.horas, 72);
    assert.equal(v.expiraEm.toISOString(), new Date('2026-10-12T15:00:00-03:00').toISOString());
  });

  test('sábado e domingo: regra padrão de 48 horas, sem calendário de dias úteis', () => {
    assert.equal(util.calcularValidade(sabado).horas, 48);
    assert.equal(util.calcularValidade(domingo).horas, 48);
  });

  test('o dia da semana é o do fuso operacional, não o de UTC: quinta 23:59 em Brasília (já sexta em UTC) é 48h; sexta 00:00 em Brasília é 72h', () => {
    const quintaNoite = new Date('2026-10-08T23:59:59-03:00'); // 2026-10-09T02:59:59Z
    const sextaMadrugada = new Date('2026-10-09T00:00:00-03:00');
    assert.equal(util.diaDaSemana(quintaNoite), 'Thu');
    assert.equal(util.calcularValidade(quintaNoite).horas, 48);
    assert.equal(util.diaDaSemana(sextaMadrugada), 'Fri');
    assert.equal(util.calcularValidade(sextaMadrugada).horas, 72);
    const sextaNoite = new Date('2026-10-09T23:30:00-03:00'); // já sábado em UTC
    assert.equal(util.calcularValidade(sextaNoite).horas, 72);
  });

  test('expirada: no instante exato da expiração já está vencida; um milissegundo antes não; sem renovação por tentativa', () => {
    const v = util.calcularValidade(segunda);
    assert.equal(util.expirada(v.expiraEm, new Date(v.expiraEm.getTime() - 1)), false);
    assert.equal(util.expirada(v.expiraEm, v.expiraEm), true);
    assert.equal(util.expirada(v.expiraEm, new Date(v.expiraEm.getTime() + 1)), true);
    const deNovo = util.calcularValidade(segunda);
    assert.equal(deNovo.expiraEm.getTime(), v.expiraEm.getTime(), 'o cálculo é determinístico: nada prolonga o prazo');
  });

  test('entrada inválida é erro de programação, nunca uma validade; sem argumento, o instante é agora', () => {
    for (const ruim of [null, 'hoje', 0, new Date('x')]) assert.throws(() => util.calcularValidade(ruim), TypeError, String(ruim));
    assert.throws(() => util.expirada('amanhã', new Date()), TypeError);
    const agora = util.calcularValidade();
    assert.ok(Math.abs(agora.definidaEm.getTime() - Date.now()) < 5000);
  });
});
