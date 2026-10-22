'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { periodoDoGrafico, PERIODOS } = require('../../src/services/dashboard-graficos.service');

/**
 * 12I — gráficos do Dashboard: os três períodos são de CALENDÁRIO, pela data operacional de São Paulo (`hoje`), e o servidor os calcula:
 *   MES         = o mês corrente, do dia 1 ao último dia, agrupado por DIA (os dias de 1º até hoje);
 *   SEIS_MESES  = os seis meses de calendário terminando no corrente (inclusive), agrupado por MÊS;
 *   ANO         = os doze meses de calendário terminando no corrente (inclusive), agrupado por MÊS.
 * As chaves dos grupos saem do servidor, para o gráfico mostrar os dias/meses sem dado com zero (nunca inventados no navegador).
 */

describe('periodoDoGrafico (12I)', () => {
  test('PERIODOS é a lista fixa dos três códigos', () => {
    assert.deepEqual([...PERIODOS], ['MES', 'SEIS_MESES', 'ANO']);
  });

  test('MES: 1º ao último dia do mês da data operacional, por dia, só até hoje', () => {
    const p = periodoDoGrafico('2026-10-21', 'MES');
    assert.deepEqual({ periodo: p.periodo, de: p.de, ate: p.ate, agrupamento: p.agrupamento }, { periodo: 'MES', de: '2026-10-01', ate: '2026-10-31', agrupamento: 'DIA' });
    assert.equal(p.chaves.length, 21);
    assert.equal(p.chaves[0], '2026-10-01');
    assert.equal(p.chaves[20], '2026-10-21');
  });

  test('MES no dia 1º tem uma chave só; o último dia de fevereiro bissexto é o 29', () => {
    assert.deepEqual(periodoDoGrafico('2026-11-01', 'MES').chaves, ['2026-11-01']);
    const fev = periodoDoGrafico('2028-02-29', 'MES');
    assert.equal(fev.ate, '2028-02-29');
    assert.equal(fev.chaves.length, 29);
  });

  test('SEIS_MESES: seis meses de calendário incluindo o corrente, por mês, com virada de ano', () => {
    const p = periodoDoGrafico('2026-03-15', 'SEIS_MESES');
    assert.deepEqual({ de: p.de, ate: p.ate, agrupamento: p.agrupamento }, { de: '2025-10-01', ate: '2026-03-31', agrupamento: 'MES' });
    assert.deepEqual(p.chaves, ['2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03']);
  });

  test('ANO: doze meses de calendário incluindo o corrente', () => {
    const p = periodoDoGrafico('2026-10-21', 'ANO');
    assert.deepEqual({ de: p.de, ate: p.ate, agrupamento: p.agrupamento }, { de: '2025-11-01', ate: '2026-10-31', agrupamento: 'MES' });
    assert.equal(p.chaves.length, 12);
    assert.equal(p.chaves[0], '2025-11');
    assert.equal(p.chaves[11], '2026-10');
  });

  test('data operacional ou período inválidos são TypeError', () => {
    assert.throws(() => periodoDoGrafico('2026-13-01', 'MES'), TypeError);
    assert.throws(() => periodoDoGrafico('2026-10-21', 'SEMANA'), TypeError);
    assert.throws(() => periodoDoGrafico('2026-10-21', undefined), TypeError);
  });
});
