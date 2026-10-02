'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * Teto de envios de convite por (empresa, e-mail) (Bloco 11H): no mínimo
 * 60 segundos entre dois envios e no máximo 5 convites em 24 horas, contando
 * criações e reenvios. A regra é pura: recebe o resumo lido do banco e decide.
 */

const modulo = () => exigirModulo('src/services/limite-envio-convite');

const AGORA = new Date('2026-10-02T12:00:00.000Z');
const antes = (segundos) => new Date(AGORA.getTime() - segundos * 1000);
const resumo = (extra = {}) => ({
  total: 1, primeiroEm: antes(300), ultimoEm: antes(300), agora: AGORA, ...extra,
});

describe('limites', () => {
  test('os valores aprovados: 60 segundos entre envios e 5 envios em 24 horas', () => {
    const { INTERVALO_MINIMO_SEGUNDOS, MAXIMO_NA_JANELA, JANELA_HORAS } = modulo();
    assert.equal(INTERVALO_MINIMO_SEGUNDOS, 60);
    assert.equal(MAXIMO_NA_JANELA, 5);
    assert.equal(JANELA_HORAS, 24);
  });
});

describe('exigirEnvioPermitido', () => {
  test('sem envio anterior na janela, permite', () => {
    assert.doesNotThrow(() => modulo().exigirEnvioPermitido({
      total: 0, primeiroEm: null, ultimoEm: null, agora: AGORA,
    }));
  });

  test('passados os 60 segundos e abaixo do máximo, permite', () => {
    assert.doesNotThrow(() => modulo().exigirEnvioPermitido(resumo({ ultimoEm: antes(61), total: 4 })));
    assert.doesNotThrow(() => modulo().exigirEnvioPermitido(resumo({ ultimoEm: antes(60), total: 4 })));
  });

  test('antes de 60 segundos do último envio: 429 com código próprio e Retry-After com o tempo que falta', () => {
    for (const [decorrido, falta] of [[0, 60], [1, 59], [30, 30], [59.2, 1]]) {
      assert.throws(
        () => modulo().exigirEnvioPermitido(resumo({ ultimoEm: antes(decorrido) })),
        (e) => e.status === 429 && e.codigo === 'CONVITE_ENVIO_MUITO_RECENTE' && e.headers['Retry-After'] === String(falta),
        `decorrido ${decorrido}`,
      );
    }
  });

  test('com 5 envios na janela, o sexto é recusado com 429 e Retry-After até o mais antigo sair da janela', () => {
    const r = resumo({ total: 5, primeiroEm: antes(23 * 3600 + 1800), ultimoEm: antes(120) });
    assert.throws(
      () => modulo().exigirEnvioPermitido(r),
      (e) => e.status === 429 && e.codigo === 'CONVITE_ENVIO_LIMITE_DIARIO' && e.headers['Retry-After'] === '1800',
    );
  });

  test('quando as duas regras valem, a espera mais longa é a informada, sem ser a de 60 segundos', () => {
    const r = resumo({ total: 5, primeiroEm: antes(3600), ultimoEm: antes(5) });
    assert.throws(
      () => modulo().exigirEnvioPermitido(r),
      (e) => e.codigo === 'CONVITE_ENVIO_LIMITE_DIARIO' && e.headers['Retry-After'] === String(23 * 3600),
    );
  });

  test('a mensagem é fixa: não leva e-mail, empresa, identificadores nem contagem', () => {
    for (const r of [resumo({ ultimoEm: antes(1) }), resumo({ total: 5, ultimoEm: antes(120) })]) {
      assert.throws(() => modulo().exigirEnvioPermitido(r), (e) => {
        assert.match(e.message, /^[^\d@]*$/);
        return true;
      });
    }
  });

  test('resumo malformado é erro de programação', () => {
    for (const ruim of [null, {}, { total: 1 }, { total: -1, primeiroEm: null, ultimoEm: null, agora: AGORA }, { total: 1, primeiroEm: antes(1), ultimoEm: antes(1), agora: 'x' }]) {
      assert.throws(() => modulo().exigirEnvioPermitido(ruim), TypeError, JSON.stringify(ruim));
    }
  });
});
