'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { httpConfig, carregarConfigHttp, JSON_LIMITE } = require('../../src/config/http');
const { assertSemSensiveis } = require('../helpers/sensiveis');

const erroDe = (env) => {
  try {
    carregarConfigHttp(env);
    return null;
  } catch (erro) {
    return erro.message;
  }
};

const PADRAO_DEV = {
  ambiente: 'development',
  cors: { origens: ['http://localhost:5500'] },
  proxy: { hops: 0 },
  rateLimit: { geral: { limite: 120, janelaSegundos: 60 }, autenticacao: { limite: 20, janelaSegundos: 60 } },
  hstsAtivo: false,
  jsonLimite: '32kb',
};

describe('configuração HTTP carregada do ambiente de teste', () => {
  test('reflete exatamente o ambiente da suíte: limites elevados do setup e demais padrões', () => {
    // test/setup.js eleva os limites de rate limit para isolar o MemoryStore
    // do app real; os defaults reais seguem cobertos por carregarConfigHttp.
    assert.deepEqual(httpConfig, {
      ...PADRAO_DEV,
      ambiente: 'test',
      rateLimit: { geral: { limite: 100000, janelaSegundos: 60 }, autenticacao: { limite: 100000, janelaSegundos: 60 } },
    });
    assert.equal(JSON_LIMITE, '32kb');
    for (const objeto of [httpConfig, httpConfig.cors, httpConfig.cors.origens, httpConfig.proxy, httpConfig.rateLimit, httpConfig.rateLimit.geral, httpConfig.rateLimit.autenticacao]) {
      assert.equal(Object.isFrozen(objeto), true);
    }
    assert.throws(() => { httpConfig.cors.origens.push('http://mal.test'); }, TypeError);
  });
});

describe('carregarConfigHttp: CORS_ORIGIN', () => {
  test('padrão localhost:5500 só em development e test; obrigatória em production', () => {
    assert.deepEqual(carregarConfigHttp({}), PADRAO_DEV);
    assert.deepEqual(carregarConfigHttp({ NODE_ENV: 'test' }).cors.origens, ['http://localhost:5500']);
    assert.match(erroDe({ NODE_ENV: 'production' }), /CORS_ORIGIN: obrigatória em production/);
    assert.deepEqual(carregarConfigHttp({ NODE_ENV: 'production', CORS_ORIGIN: 'https://app.empresa.com.br' }).cors.origens, ['https://app.empresa.com.br']);
  });

  test('lista separada por vírgula, canonizada e sem duplicatas', () => {
    const origens = carregarConfigHttp({ CORS_ORIGIN: ' HTTP://Localhost:5500 , https://App.Empresa.com.br:443,http://127.0.0.1:8080, http://localhost:5500' }).cors.origens;
    assert.deepEqual(origens, ['http://localhost:5500', 'https://app.empresa.com.br', 'http://127.0.0.1:8080']);
  });

  test('somente origem canônica scheme://host[:port]; curinga rejeitado', () => {
    for (const ruim of ['*', 'http://localhost:5500/', 'http://localhost:5500/app', 'http://localhost:5500?x=1', 'http://localhost:5500#f', 'http://user:senha@localhost:5500', 'localhost:5500', 'ftp://localhost:5500', 'http://', 'https://app.empresa.com.br,*', 'javascript:alert(1)']) {
      const mensagem = erroDe({ CORS_ORIGIN: ruim });
      assert.match(mensagem, /^Configuração HTTP inválida:\n  - CORS_ORIGIN: /, ruim);
      assertSemSensiveis(mensagem, ['senha', 'alert', 'empresa', 'localhost'], `mensagem para ${ruim}`);
    }
    assert.match(erroDe({ CORS_ORIGIN: '*' }), /curinga/);
    assert.match(erroDe({ CORS_ORIGIN: 'http://localhost:5500/app' }), /origem canônica/);
  });

  test('porta explícita deve ser TCP válida de 1 a 65535; sem porta continua válido', () => {
    for (const ruim of ['http://localhost:0', 'https://app.example.com:0', 'http://localhost:65536', 'http://localhost:99999']) {
      assert.match(erroDe({ CORS_ORIGIN: ruim }), /CORS_ORIGIN: cada item deve ser uma origem canônica/, ruim);
    }
    assert.deepEqual(carregarConfigHttp({ CORS_ORIGIN: 'http://localhost:3000,http://localhost:5500,https://app.example.com:8443,https://app.example.com:65535,https://app.example.com' }).cors.origens, ['http://localhost:3000', 'http://localhost:5500', 'https://app.example.com:8443', 'https://app.example.com:65535', 'https://app.example.com']);
  });

  test('em production toda origem exige https, inclusive localhost e loopback', () => {
    for (const ruim of ['http://app.example.com', 'http://localhost:5500', 'http://127.0.0.1:5500', 'http://[::1]:5500', 'https://app.example.com,http://localhost:5500']) {
      assert.match(erroDe({ NODE_ENV: 'production', CORS_ORIGIN: ruim }), /CORS_ORIGIN: em production toda origem exige https/, ruim);
    }
    assert.deepEqual(carregarConfigHttp({ NODE_ENV: 'production', CORS_ORIGIN: 'https://app.example.com,https://app.example.com:8443' }).cors.origens, ['https://app.example.com', 'https://app.example.com:8443']);
  });

  test('em development e test http continua permitido, com o padrão localhost:5500', () => {
    assert.equal(carregarConfigHttp({ CORS_ORIGIN: 'http://app.empresa.com.br' }).cors.origens[0], 'http://app.empresa.com.br');
    assert.deepEqual(carregarConfigHttp({ NODE_ENV: 'development' }).cors.origens, ['http://localhost:5500']);
    assert.deepEqual(carregarConfigHttp({ NODE_ENV: 'test', CORS_ORIGIN: 'http://127.0.0.1:5500,http://[::1]:5500' }).cors.origens, ['http://127.0.0.1:5500', 'http://[::1]:5500']);
  });
});

describe('carregarConfigHttp: proxy, rate limit, HSTS', () => {
  test('TRUST_PROXY_HOPS de 0 a 10, padrão 0', () => {
    assert.equal(carregarConfigHttp({ TRUST_PROXY_HOPS: '2' }).proxy.hops, 2);
    assert.equal(carregarConfigHttp({ TRUST_PROXY_HOPS: '10' }).proxy.hops, 10);
    assert.match(erroDe({ TRUST_PROXY_HOPS: '11' }), /TRUST_PROXY_HOPS: acima do máximo permitido \(10\)/);
    assert.match(erroDe({ TRUST_PROXY_HOPS: '-1' }), /TRUST_PROXY_HOPS: deve ser um número inteiro/); // negativo não é decimal canônico não negativo
    assert.match(erroDe({ TRUST_PROXY_HOPS: 'true' }), /TRUST_PROXY_HOPS: deve ser um número inteiro/);
    assert.equal(carregarConfigHttp({ TRUST_PROXY_HOPS: '0' }).proxy.hops, 0);
  });

  test('TRUST_PROXY_HOPS aceita somente decimal canônico não negativo', () => {
    for (const ruim of ['1e1', '0x2', '01', '+1', '1.0', '-0', '0b11', '10abc', 'Infinity']) {
      assert.match(erroDe({ TRUST_PROXY_HOPS: ruim }), /TRUST_PROXY_HOPS: deve ser um número inteiro/, JSON.stringify(ruim));
    }
    assert.match(erroDe({ RATE_LIMIT_GERAL_LIMITE: '1e2' }), /RATE_LIMIT_GERAL_LIMITE: deve ser um número inteiro/);
    assert.match(erroDe({ RATE_LIMIT_GERAL_JANELA_SEGUNDOS: '060' }), /RATE_LIMIT_GERAL_JANELA_SEGUNDOS: deve ser um número inteiro/);
  });

  test('rate limit geral e de autenticação com padrões e faixas', () => {
    const cfg = carregarConfigHttp({ RATE_LIMIT_GERAL_LIMITE: '500', RATE_LIMIT_GERAL_JANELA_SEGUNDOS: '300', RATE_LIMIT_AUTH_LIMITE: '5', RATE_LIMIT_AUTH_JANELA_SEGUNDOS: '900' });
    assert.deepEqual(cfg.rateLimit, { geral: { limite: 500, janelaSegundos: 300 }, autenticacao: { limite: 5, janelaSegundos: 900 } });
    assert.match(erroDe({ RATE_LIMIT_GERAL_LIMITE: '0' }), /RATE_LIMIT_GERAL_LIMITE: abaixo do mínimo permitido \(1\)/);
    assert.match(erroDe({ RATE_LIMIT_GERAL_LIMITE: '100001' }), /RATE_LIMIT_GERAL_LIMITE: acima do máximo permitido \(100000\)/);
    assert.match(erroDe({ RATE_LIMIT_AUTH_JANELA_SEGUNDOS: '0' }), /RATE_LIMIT_AUTH_JANELA_SEGUNDOS: abaixo do mínimo permitido \(1\)/);
    assert.match(erroDe({ RATE_LIMIT_AUTH_JANELA_SEGUNDOS: '86401' }), /RATE_LIMIT_AUTH_JANELA_SEGUNDOS: acima do máximo permitido \(86400\)/);
    assert.match(erroDe({ RATE_LIMIT_AUTH_LIMITE: '2.5' }), /RATE_LIMIT_AUTH_LIMITE: deve ser um número inteiro/);
  });

  test('HSTS ativo somente em production; NODE_ENV validado', () => {
    assert.equal(carregarConfigHttp({ NODE_ENV: 'production', CORS_ORIGIN: 'https://app.empresa.com.br' }).hstsAtivo, true);
    assert.equal(carregarConfigHttp({ NODE_ENV: 'development' }).hstsAtivo, false);
    assert.equal(carregarConfigHttp({ NODE_ENV: 'test' }).hstsAtivo, false);
    assert.match(erroDe({ NODE_ENV: 'staging' }), /NODE_ENV: deve ser um de: development, test, production/);
  });

  test('vários problemas listados juntos; variáveis desconhecidas ignoradas', () => {
    const mensagem = erroDe({ NODE_ENV: 'production', TRUST_PROXY_HOPS: 'x', OUTRA: 'valorQualquer' });
    assert.match(mensagem, /CORS_ORIGIN: obrigatória em production/);
    assert.match(mensagem, /TRUST_PROXY_HOPS: deve ser um número inteiro/);
    assertSemSensiveis(mensagem, ['valorQualquer'], 'erro combinado');
  });
});
