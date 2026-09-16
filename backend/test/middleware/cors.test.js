'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const express = require('express');
const { criarCors } = require('../../src/middleware/cors');
const { criarCabecalhosSeguranca, semCache } = require('../../src/middleware/cabecalhos');
const { notFoundHandler, errorHandler } = require('../../src/middleware/errorHandler');

// Allowlist explícita para a factory; o app real usa httpConfig e é testado em app.test.js.
const ORIGENS = ['http://a.test', 'http://b.test'];

const app = express();
app.use(criarCabecalhosSeguranca({ hstsAtivo: false }));
app.use('/api', criarCors({ origens: ORIGENS }), semCache);
app.get('/api/x', (req, res) => res.json({ ok: true }));
app.post('/api/x', (req, res) => res.json({ ok: true }));
app.get('/fora', (req, res) => res.json({ fora: true }));
app.use(notFoundHandler);
app.use(errorHandler);

const cors = (r) => Object.fromEntries(Object.entries(r.headers).filter(([k]) => k.startsWith('access-control-')));
const semCors = (r, rotulo) => {
  assert.deepEqual(cors(r), {}, `${rotulo}: não deve haver cabeçalho Access-Control-*`);
};
const varyTemOrigin = (r, rotulo) => {
  assert.ok(String(r.headers.vary || '').split(',').map((v) => v.trim()).includes('Origin'), `${rotulo}: Vary deve conter Origin`);
};

describe('criarCors: requisições simples', () => {
  test('origem permitida recebe a própria origem, credentials e Vary: Origin', async () => {
    for (const origem of ORIGENS) {
      const r = await request(app).get('/api/x').set('Origin', origem);
      assert.equal(r.status, 200);
      assert.equal(r.headers['access-control-allow-origin'], origem);
      assert.equal(r.headers['access-control-allow-credentials'], 'true');
      varyTemOrigin(r, origem);
    }
  });

  test('origem fora da allowlist, mesmo parecida, não recebe cabeçalhos CORS e a requisição segue', async () => {
    for (const origem of ['http://mal.test', 'http://a.test:8080', 'https://a.test', 'http://A.TEST', 'http://a.test.mal', 'http://xa.test', 'http://a.test/', 'a.test']) {
      const r = await request(app).get('/api/x').set('Origin', origem);
      assert.deepEqual([r.status, r.body], [200, { ok: true }], origem);
      semCors(r, origem);
      varyTemOrigin(r, origem);
    }
  });

  test('Origin: null e ausência de Origin não recebem cabeçalhos CORS, mas mantêm Vary: Origin', async () => {
    const nulo = await request(app).get('/api/x').set('Origin', 'null');
    semCors(nulo, 'null');
    varyTemOrigin(nulo, 'null');
    const ausente = await request(app).get('/api/x');
    assert.equal(ausente.status, 200);
    semCors(ausente, 'sem Origin');
    varyTemOrigin(ausente, 'sem Origin');
  });

  test('nunca Access-Control-Allow-Origin: *', async () => {
    for (const origem of [...ORIGENS, 'http://mal.test', 'null', '*']) {
      const r = await request(app).get('/api/x').set('Origin', origem);
      assert.notEqual(r.headers['access-control-allow-origin'], '*', origem);
    }
  });

  test('404 e erro dentro de /api com origem permitida mantêm os cabeçalhos CORS e no-store', async () => {
    const r = await request(app).get('/api/nada').set('Origin', 'http://a.test');
    assert.equal(r.status, 404);
    assert.equal(r.headers['access-control-allow-origin'], 'http://a.test');
    assert.equal(r.headers['access-control-allow-credentials'], 'true');
    assert.equal(r.headers['cache-control'], 'no-store');
  });
});

describe('criarCors: preflight', () => {
  const preflight = (origem, headersPedidos = 'content-type') => request(app).options('/api/x')
    .set('Origin', origem)
    .set('Access-Control-Request-Method', 'POST')
    .set('Access-Control-Request-Headers', headersPedidos);

  test('origem permitida: 204 com métodos e headers restritos, Max-Age 600 e credentials', async () => {
    const r = await preflight('http://a.test');
    assert.equal(r.status, 204);
    assert.equal(r.headers['access-control-allow-origin'], 'http://a.test');
    assert.equal(r.headers['access-control-allow-credentials'], 'true');
    assert.deepEqual(r.headers['access-control-allow-methods'].split(',').map((m) => m.trim()).sort(), ['GET', 'HEAD', 'PATCH', 'POST']);
    assert.equal(r.headers['access-control-allow-headers'], 'Content-Type');
    assert.equal(r.headers['access-control-max-age'], '600');
    varyTemOrigin(r, 'preflight');
  });

  test('headers pedidos além de Content-Type não são refletidos', async () => {
    const r = await preflight('http://a.test', 'x-custom, authorization, content-type');
    assert.equal(r.status, 204);
    assert.equal(r.headers['access-control-allow-headers'], 'Content-Type');
  });

  test('preflight termina no CORS: mantém cabeçalhos do Helmet e não recebe no-store', async () => {
    const r = await preflight('http://b.test');
    assert.equal(r.status, 204);
    assert.equal(r.headers['x-frame-options'], 'DENY');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal('cache-control' in r.headers, false);
  });

  test('origem não permitida no preflight não recebe nenhum Access-Control-*', async () => {
    const r = await preflight('http://mal.test');
    semCors(r, 'preflight não permitido');
    assert.notEqual(r.status, 403);
  });
});

describe('criarCors: escopo', () => {
  test('fora de /api não há política CORS nem no-store, mas há Helmet', async () => {
    const r = await request(app).get('/fora').set('Origin', 'http://a.test');
    assert.equal(r.status, 200);
    semCors(r, '/fora');
    assert.equal('cache-control' in r.headers, false);
    assert.equal(r.headers['x-frame-options'], 'DENY');
    assert.equal(String(r.headers.vary || '').split(',').map((v) => v.trim()).includes('Origin'), false, '/fora: Vary não deve conter Origin');
  });
});
