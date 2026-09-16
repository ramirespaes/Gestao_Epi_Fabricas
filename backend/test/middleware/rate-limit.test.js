'use strict';

const { describe, test, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const express = require('express');
const { criarLimitador, limitadorAutenticacao } = require('../../src/middleware/rate-limit');
const { criarCors } = require('../../src/middleware/cors');
const { criarVerificacaoOrigem } = require('../../src/middleware/origem');
const { criarCabecalhosSeguranca, semCache } = require('../../src/middleware/cabecalhos');
const { exigirJson, parserJson } = require('../../src/middleware/conteudo');
const { notFoundHandler, errorHandler } = require('../../src/middleware/errorHandler');

const ORIGENS = ['http://a.test'];
const CORPO_429 = { status: 'error', codigo: 'LIMITE_REQUISICOES_EXCEDIDO', message: 'Muitas requisições. Tente novamente mais tarde' };
const LEGACY = ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset'];

// Cada teste monta o próprio app: o MemoryStore nasce vazio e nada vaza
// entre casos, sem reset manual nem sleep.
const criarApp = ({ limite = 2, janelaSegundos = 60, hops = 0, comCadeia = false } = {}) => {
  const app = express();
  app.set('trust proxy', hops === 0 ? false : hops);
  app.use(criarCabecalhosSeguranca({ hstsAtivo: false }));
  const camadas = comCadeia
    ? [criarCors({ origens: ORIGENS }), semCache, criarVerificacaoOrigem({ origens: ORIGENS }), criarLimitador({ limite, janelaSegundos }), exigirJson, parserJson]
    : [criarLimitador({ limite, janelaSegundos })];
  app.use('/api', ...camadas);
  app.all('/api/x', (req, res) => res.json({ metodo: req.method }));
  app.all('/fora', (req, res) => res.json({ fora: true }));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
};

const parametros = (valor) => Object.fromEntries(String(valor).split(';').slice(1).map((parte) => {
  const [nome, conteudo] = parte.split('=');
  return [nome.trim(), (conteudo ?? '').trim()];
}));

let logs;
beforeEach(() => {
  logs = [];
  mock.method(console, 'error', (...args) => logs.push(args.map(String).join(' ')));
});
afterEach(() => mock.restoreAll());

describe('criarLimitador: contagem e bloqueio', () => {
  test('abaixo do limite passa, no limite passa, a primeira acima recebe 429 com corpo fixo e sem log', async () => {
    const app = criarApp({ limite: 2 });
    assert.equal((await request(app).get('/api/x')).status, 200);
    assert.equal((await request(app).get('/api/x')).status, 200);
    const bloqueada = await request(app).get('/api/x');
    assert.equal(bloqueada.status, 429);
    assert.deepEqual(bloqueada.body, CORPO_429);
    assert.deepEqual(logs, []);
    assert.equal((await request(app).get('/api/x')).status, 429, 'segue bloqueado dentro da janela');
  });

  test('GET e POST contam no mesmo contador quando atravessam o limitador', async () => {
    const app = criarApp({ limite: 2 });
    assert.equal((await request(app).get('/api/x')).status, 200);
    assert.equal((await request(app).post('/api/x')).status, 200);
    assert.equal((await request(app).post('/api/x')).status, 429);
  });

  test('limitadores diferentes têm contadores independentes', async () => {
    const appA = criarApp({ limite: 1 });
    const appB = criarApp({ limite: 1 });
    assert.equal((await request(appA).get('/api/x')).status, 200);
    assert.equal((await request(appA).get('/api/x')).status, 429);
    assert.equal((await request(appB).get('/api/x')).status, 200, 'store do outro limitador não foi afetado');
    assert.equal(typeof limitadorAutenticacao, 'function', 'limitador de autenticação é exportado');
  });

  test('IPs distintos têm contadores independentes (trust proxy = 1)', async () => {
    const app = criarApp({ limite: 1, hops: 1 });
    const comIp = (ip) => request(app).get('/api/x').set('X-Forwarded-For', ip);
    assert.equal((await comIp('203.0.113.1')).status, 200);
    assert.equal((await comIp('203.0.113.1')).status, 429, 'mesmo IP: cota consumida');
    assert.equal((await comIp('203.0.113.2')).status, 200, 'outro IP: cota própria');
  });
});

describe('criarLimitador: cabeçalhos', () => {
  test('draft-8 presente em 200 e 429; sem cabeçalhos legados', async () => {
    const app = criarApp({ limite: 2, janelaSegundos: 60 });
    const ok = await request(app).get('/api/x');
    const rateLimit = parametros(ok.headers.ratelimit);
    assert.ok(
      'r' in rateLimit && /^[0-9]+$/.test(rateLimit.r),
      'RateLimit deve trazer r=',
    );
    assert.ok('t' in rateLimit && /^[0-9]+$/.test(rateLimit.t), 'RateLimit deve trazer t=');
    const policy = parametros(ok.headers['ratelimit-policy']);
    assert.equal(policy.q, '2');
    assert.equal(policy.w, '60');
    for (const legado of LEGACY) {
      assert.equal(legado in ok.headers, false, legado);
    }
    await request(app).get('/api/x');
    const bloqueada = await request(app).get('/api/x');
    assert.equal(bloqueada.status, 429);
    assert.equal(parametros(bloqueada.headers.ratelimit).r, '0');
    assert.ok('q' in parametros(bloqueada.headers['ratelimit-policy']));
    for (const legado of LEGACY) {
      assert.equal(legado in bloqueada.headers, false, legado);
    }
  });

  test('Retry-After só no 429, inteiro positivo e no máximo a janela', async () => {
    const janelaSegundos = 60;
    const app = criarApp({ limite: 1, janelaSegundos });
    const ok = await request(app).get('/api/x');
    assert.equal('retry-after' in ok.headers, false);
    const bloqueada = await request(app).get('/api/x');
    const retryAfter = Number(bloqueada.headers['retry-after']);
    assert.ok(Number.isInteger(retryAfter) && retryAfter > 0, `Retry-After inteiro positivo, recebido ${bloqueada.headers['retry-after']}`);
    assert.ok(retryAfter <= janelaSegundos, 'Retry-After não deve exceder a janela');
  });
});

describe('criarLimitador: posição na cadeia de /api', () => {
  test('429 recebe no-store, cabeçalhos do Helmet e, com origem permitida, CORS', async () => {
    const app = criarApp({ limite: 1, comCadeia: true });
    assert.equal((await request(app).get('/api/x').set('Origin', 'http://a.test')).status, 200);
    const bloqueada = await request(app).get('/api/x').set('Origin', 'http://a.test');
    assert.equal(bloqueada.status, 429);
    assert.deepEqual(bloqueada.body, CORPO_429);
    assert.equal(bloqueada.headers['cache-control'], 'no-store');
    assert.equal(bloqueada.headers['x-frame-options'], 'DENY');
    assert.equal(bloqueada.headers['access-control-allow-origin'], 'http://a.test');
    assert.deepEqual(logs, []);
  });

  test('origem inválida em método inseguro recebe 403 antes do limitador e não consome cota', async () => {
    const app = criarApp({ limite: 1, comCadeia: true });
    const bloqueadaPorOrigem = await request(app).post('/api/x').set('Origin', 'http://mal.test');
    assert.equal(bloqueadaPorOrigem.status, 403);
    assert.equal('ratelimit' in bloqueadaPorOrigem.headers, false, '403 de origem não passa pelo limitador');
    const seguinte = await request(app).get('/api/x');
    assert.equal(seguinte.status, 200, 'a cota continua intacta');
    assert.equal(parametros(seguinte.headers.ratelimit).r, '0', 'esta foi a primeira requisição contada');
  });

  test('preflight permitido termina no CORS e não consome cota', async () => {
    const app = criarApp({ limite: 1, comCadeia: true });
    for (let i = 0; i < 3; i += 1) {
      const preflight = await request(app).options('/api/x').set('Origin', 'http://a.test').set('Access-Control-Request-Method', 'POST');
      assert.equal(preflight.status, 204);
      assert.equal('ratelimit' in preflight.headers, false);
    }
    const depois = await request(app).get('/api/x').set('Origin', 'http://a.test');
    assert.equal(depois.status, 200, 'cota não foi consumida pelos preflights');
  });

  test('payload rejeitado depois de origem válida consome cota: o limitador vem antes do parser', async () => {
    const app = criarApp({ limite: 1, comCadeia: true });
    const tipoErrado = await request(app).post('/api/x').set('Origin', 'http://a.test').set('content-type', 'text/plain').send('x');
    assert.equal(tipoErrado.status, 415);
    assert.equal(parametros(tipoErrado.headers.ratelimit).r, '0', 'a requisição foi contada antes do 415');
    const seguinte = await request(app).get('/api/x').set('Origin', 'http://a.test');
    assert.equal(seguinte.status, 429, 'a cota já havia sido consumida');
  });

  test('fora de /api o limitador não se aplica', async () => {
    const app = criarApp({ limite: 1 });
    for (let i = 0; i < 3; i += 1) {
      const r = await request(app).get('/fora');
      assert.equal(r.status, 200);
      assert.equal('ratelimit' in r.headers, false);
    }
  });
});

describe('trust proxy: contrato do Express, sem rate limiter', () => {
  const appIp = (hops) => {
    const app = express();
    app.set('trust proxy', hops === 0 ? false : hops);
    app.get('/', (req, res) => res.json({ ip: req.ip, ips: req.ips }));
    return app;
  };

  test('trust proxy false ignora X-Forwarded-For: req.ip não muda entre requisições', async () => {
    const app = appIp(0);
    const a = await request(app).get('/').set('X-Forwarded-For', '203.0.113.1');
    const b = await request(app).get('/').set('X-Forwarded-For', '203.0.113.2');
    const semCabecalho = await request(app).get('/');
    assert.equal(a.body.ip, b.body.ip, 'XFF não deve influenciar req.ip');
    assert.equal(a.body.ip, semCabecalho.body.ip, 'req.ip é sempre o endereço do socket');
    assert.deepEqual(a.body.ips, []);
    assert.notEqual(a.body.ip, '203.0.113.1');
  });

  test('trust proxy 1 usa o endereço encaminhado', async () => {
    const app = appIp(1);
    const a = await request(app).get('/').set('X-Forwarded-For', '203.0.113.1');
    const b = await request(app).get('/').set('X-Forwarded-For', '203.0.113.2');
    assert.equal(a.body.ip, '203.0.113.1');
    assert.equal(b.body.ip, '203.0.113.2');
    assert.deepEqual(a.body.ips, ['203.0.113.1']);
  });
});
