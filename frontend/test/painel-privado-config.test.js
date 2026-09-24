'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const Config = require('../painel-privado/config');

/**
 * Resolução do endereço da API do Painel Privado (correção final do
 * Pacote 2, item 5: "remover a dependência fixa de localhost como
 * endereço da API em produção"). Testado com `location` fabricado — sem
 * navegador, sem rede.
 */

describe('resolverApiBaseUrl', () => {
  for (const hostname of ['localhost', '127.0.0.1', '[::1]']) {
    test(`hosts de desenvolvimento (${hostname}) usam sempre http://localhost:3000/api/plataforma`, () => {
      const url = Config.resolverApiBaseUrl({ hostname, origin: `http://${hostname}:5501` });
      assert.equal(url, Config.API_BASE_DESENVOLVIMENTO);
      assert.equal(url, 'http://localhost:3000/api/plataforma');
    });
  }

  test('qualquer outro host (produção) usa a PRÓPRIA origem da página, sob /api/plataforma', () => {
    assert.equal(
      Config.resolverApiBaseUrl({ hostname: 'admin.safework.com.br', origin: 'https://admin.safework.com.br' }),
      'https://admin.safework.com.br/api/plataforma',
    );
    assert.equal(
      Config.resolverApiBaseUrl({ hostname: 'painel-teste.exemplo.com', origin: 'https://painel-teste.exemplo.com:8443' }),
      'https://painel-teste.exemplo.com:8443/api/plataforma',
    );
  });

  test('nunca produz um endereço com "localhost" fora dos hosts de desenvolvimento (item 5 da correção)', () => {
    const url = Config.resolverApiBaseUrl({ hostname: 'app.producao.com.br', origin: 'https://app.producao.com.br' });
    assert.equal(url.includes('localhost'), false);
  });

  test('recusa location inválido ou incompleto', () => {
    assert.throws(() => Config.resolverApiBaseUrl(null), TypeError);
    assert.throws(() => Config.resolverApiBaseUrl(undefined), TypeError);
    assert.throws(() => Config.resolverApiBaseUrl({}), TypeError);
    assert.throws(() => Config.resolverApiBaseUrl({ hostname: 'x' }), TypeError);
    assert.throws(() => Config.resolverApiBaseUrl({ origin: 'https://x' }), TypeError);
  });
});

describe('separação de origens preservada', () => {
  test('a configuração da plataforma não depende nem interfere em EpiHttp/api-http.js do cliente', () => {
    const EpiHttp = require('../js/api-http');
    assert.equal(typeof Config.resolverApiBaseUrl, 'function');
    assert.equal('resolverApiBaseUrl' in EpiHttp, false, 'módulos distintos, sem mistura de responsabilidades');
  });
});
