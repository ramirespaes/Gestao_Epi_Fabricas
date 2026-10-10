'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * 12K-D6: configuração do pacote de fiscalização. Limites aprovados: 100.000 linhas POR módulo, 100 MiB para o ZIP inteiro,
 * 366 dias, heartbeat de 15 s e abandono após 120 s (os dois por variável de ambiente). O diretório vem só do ambiente.
 */
const C = () => exigirModulo('src/config/fiscalizacao');
const DIR = process.platform === 'win32' ? 'C:\\dados\\fiscalizacao' : '/var/dados/fiscalizacao';

describe('configuração da fiscalização', () => {
  test('padrões aprovados', () => {
    const c = C().lerConfiguracao({ FISCALIZACAO_ARMAZENAMENTO_DIRETORIO: DIR });
    assert.equal(c.limiteLinhasPorModulo, 100000);
    assert.equal(c.limiteBytesZip, 100 * 1024 * 1024);
    assert.equal(c.periodoMaximoDias, 366);
    assert.equal(c.heartbeatMs, 15000);
    assert.equal(c.abandonoMs, 120000);
    assert.equal(c.diretorio, DIR);
    assert.equal(c.geracoesSimultaneasPorEmpresa, 1);
  });

  test('heartbeat e abandono configuráveis em segundos por variável de ambiente', () => {
    const c = C().lerConfiguracao({
      FISCALIZACAO_ARMAZENAMENTO_DIRETORIO: DIR, FISCALIZACAO_HEARTBEAT_SEGUNDOS: '5', FISCALIZACAO_ABANDONO_SEGUNDOS: '60',
    });
    assert.deepEqual([c.heartbeatMs, c.abandonoMs], [5000, 60000]);
  });

  test('abandono precisa ser bem maior que o heartbeat; valores inválidos são recusados', () => {
    const base = { FISCALIZACAO_ARMAZENAMENTO_DIRETORIO: DIR };
    assert.throws(() => C().lerConfiguracao({ ...base, FISCALIZACAO_HEARTBEAT_SEGUNDOS: '30', FISCALIZACAO_ABANDONO_SEGUNDOS: '40' }), /abandono/i);
    assert.throws(() => C().lerConfiguracao({ ...base, FISCALIZACAO_HEARTBEAT_SEGUNDOS: '0' }), /heartbeat/i);
    assert.throws(() => C().lerConfiguracao({ ...base, FISCALIZACAO_ABANDONO_SEGUNDOS: 'abc' }), /abandono/i);
  });

  test('o diretório de armazenamento é obrigatório, absoluto e nunca fixado no código', () => {
    assert.throws(() => C().lerConfiguracao({}), /FISCALIZACAO_ARMAZENAMENTO_DIRETORIO/);
    assert.throws(() => C().lerConfiguracao({ FISCALIZACAO_ARMAZENAMENTO_DIRETORIO: 'relativo/pasta' }), /absoluto/i);
    const fonte = require('node:fs').readFileSync(require.resolve('../../src/config/fiscalizacao'), 'utf8');
    assert.equal(/['"`]\/(var|tmp|home|Users|opt)\//.test(fonte), false, 'nenhum caminho absoluto fixo no código');
  });
});
