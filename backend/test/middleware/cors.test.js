'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const express = require('express');
const { criarCors, METODOS_PORTAL, METODOS_PLATAFORMA } = require('../../src/middleware/cors');
const { criarCabecalhosSeguranca, semCache } = require('../../src/middleware/cabecalhos');
const { notFoundHandler, errorHandler } = require('../../src/middleware/errorHandler');

// Allowlist explícita para a factory; o app real usa httpConfig e é testado em app.test.js.
const ORIGENS = ['http://a.test', 'http://b.test'];
// Os métodos são sempre explícitos, por namespace (12D-2): este app usa o conjunto mínimo de GET, HEAD, POST e PATCH.
const METODOS_MINIMOS = ['GET', 'HEAD', 'POST', 'PATCH'];

const app = express();
app.use(criarCabecalhosSeguranca({ hstsAtivo: false }));
app.use('/api', criarCors({ origens: ORIGENS, metodos: METODOS_MINIMOS }), semCache);
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
    assert.deepEqual(r.headers['access-control-allow-methods'].split(',').map((m) => m.trim()).sort(), [...METODOS_MINIMOS].sort());
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

describe('criarCors: métodos explícitos por namespace (12D-2)', () => {
  const metodosDe = (r) => r.headers['access-control-allow-methods'].split(',').map((m) => m.trim()).sort();
  const appCom = (metodos) => {
    const a = express();
    a.use('/api', criarCors({ origens: ORIGENS, metodos }), semCache);
    a.get('/api/x', (req, res) => res.json({ ok: true }));
    return a;
  };
  const preflightPara = (a, metodo, origem = 'http://a.test') => request(a).options('/api/x')
    .set('Origin', origem)
    .set('Access-Control-Request-Method', metodo)
    .set('Access-Control-Request-Headers', 'content-type');

  test('o Portal anuncia GET, HEAD, POST, PUT, PATCH e DELETE; o Painel Privado, só GET, HEAD, POST e PATCH', () => {
    assert.deepEqual([...METODOS_PORTAL].sort(), ['DELETE', 'GET', 'HEAD', 'PATCH', 'POST', 'PUT']);
    assert.deepEqual([...METODOS_PLATAFORMA].sort(), ['GET', 'HEAD', 'PATCH', 'POST']);
    assert.ok(Object.isFrozen(METODOS_PORTAL) && Object.isFrozen(METODOS_PLATAFORMA));
    assert.ok(!METODOS_PLATAFORMA.includes('PUT') && !METODOS_PLATAFORMA.includes('DELETE'), 'o Painel Privado não ganha PUT nem DELETE por tabela');
  });

  test('preflight de PUT no Portal: 204, origem exata, credentials, PUT nos métodos, só Content-Type, Max-Age 600 e Vary: Origin', async () => {
    const r = await preflightPara(appCom(METODOS_PORTAL), 'PUT');
    assert.equal(r.status, 204);
    assert.equal(r.headers['access-control-allow-origin'], 'http://a.test');
    assert.equal(r.headers['access-control-allow-credentials'], 'true');
    assert.ok(metodosDe(r).includes('PUT'), `métodos: ${metodosDe(r)}`);
    assert.equal(r.headers['access-control-allow-headers'], 'Content-Type');
    assert.equal(r.headers['access-control-max-age'], '600');
    varyTemOrigin(r, 'preflight PUT');
  });

  test('preflight de DELETE no Portal: DELETE nos métodos anunciados', async () => {
    const r = await preflightPara(appCom(METODOS_PORTAL), 'DELETE');
    assert.equal(r.status, 204);
    assert.equal(r.headers['access-control-allow-origin'], 'http://a.test');
    assert.ok(metodosDe(r).includes('DELETE'), `métodos: ${metodosDe(r)}`);
    assert.deepEqual(metodosDe(r), ['DELETE', 'GET', 'HEAD', 'PATCH', 'POST', 'PUT']);
  });

  test('o conjunto anunciado é exatamente o que a fábrica recebeu: sem PUT nem DELETE quando o namespace não os pede', async () => {
    const r = await preflightPara(appCom(METODOS_PLATAFORMA), 'PUT');
    assert.deepEqual(metodosDe(r), ['GET', 'HEAD', 'PATCH', 'POST']);
    const so = await preflightPara(appCom(['GET', 'HEAD']), 'POST');
    assert.deepEqual(metodosDe(so), ['GET', 'HEAD']);
  });

  test('origem fora da allowlist, para PUT e DELETE, não recebe nenhum Access-Control-* e a origem não é refletida', async () => {
    for (const metodo of ['PUT', 'DELETE']) {
      for (const origem of ['http://mal.test', 'http://a.test:8080', 'null']) {
        const r = await preflightPara(appCom(METODOS_PORTAL), metodo, origem);
        semCors(r, `${metodo} ${origem}`);
        assert.ok(!JSON.stringify(r.headers).includes(origem === 'null' ? '"null"' : origem), `${metodo}: a origem ${origem} não deve ser refletida`);
      }
    }
  });

  test('Authorization e X-* continuam fora, mesmo no Portal com PUT e DELETE', async () => {
    const r = await request(appCom(METODOS_PORTAL)).options('/api/x')
      .set('Origin', 'http://a.test')
      .set('Access-Control-Request-Method', 'DELETE')
      .set('Access-Control-Request-Headers', 'authorization, x-custom, content-type');
    assert.equal(r.headers['access-control-allow-headers'], 'Content-Type');
    assert.equal(r.headers['access-control-expose-headers'], undefined);
  });

  test('a fábrica exige a lista de métodos: ausente, vazia, com duplicata, com OPTIONS ou com verbo desconhecido é erro de programação', () => {
    const base = { origens: ORIGENS };
    for (const metodos of [undefined, null, [], 'GET', ['GET', 'GET'], ['GET', 'OPTIONS'], ['GET', 'TRACE'], ['get'], ['GET', 1]]) {
      assert.throws(() => criarCors({ ...base, metodos }), TypeError, JSON.stringify(metodos));
    }
    assert.doesNotThrow(() => criarCors({ ...base, metodos: ['GET'] }));
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
