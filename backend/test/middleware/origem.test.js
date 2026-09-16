'use strict';

const { describe, test, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const request = require('supertest');
const express = require('express');
const { criarVerificacaoOrigem } = require('../../src/middleware/origem');
const { criarCors } = require('../../src/middleware/cors');
const { criarCabecalhosSeguranca, semCache } = require('../../src/middleware/cabecalhos');
const { notFoundHandler, errorHandler } = require('../../src/middleware/errorHandler');
const { assertSemSensiveis } = require('../helpers/sensiveis');

// Allowlist explícita da factory; o app real usa httpConfig (app.test.js).
const ORIGENS = ['http://a.test', 'http://b.test'];
const SENTINELA_PATH = '/caminho-sentinela-7f3c';
const SENTINELA_QUERY = 'segredo=valor-sentinela-9a2b';
const SENTINELA_HOST = 'host-sentinela-4d8e.test';
const SENSIVEIS = [SENTINELA_PATH, 'valor-sentinela-9a2b', SENTINELA_HOST, 'mal.test'];

const app = express();
app.use(criarCabecalhosSeguranca({ hstsAtivo: false }));
app.use('/api', criarCors({ origens: ORIGENS }), semCache, criarVerificacaoOrigem({ origens: ORIGENS }));
app.all('/api/x', (req, res) => res.json({ metodo: req.method }));
app.all('/fora', (req, res) => res.json({ fora: true }));
app.use(notFoundHandler);
app.use(errorHandler);

let logs;
beforeEach(() => {
  logs = [];
  mock.method(console, 'error', (...args) => logs.push(args.map(String).join(' ')));
});
afterEach(() => mock.restoreAll());

const esperar403 = (r, codigo, rotulo) => {
  assert.equal(r.status, 403, rotulo);
  assert.deepEqual(Object.keys(r.body).sort(), ['codigo', 'message', 'status'], rotulo);
  assert.equal(r.body.codigo, codigo, rotulo);
  assertSemSensiveis(r.text, SENSIVEIS, `resposta ${rotulo}`);
  assert.deepEqual(logs, [], `${rotulo} não deve logar`);
};

// Envio com cabeçalhos repetidos: o Supertest não repete, o http.request sim.
// O bind informa 127.0.0.1 porque o cliente abaixo conecta por esse endereço:
// listen(0) sem host abre :: em dual-stack e pode receber uma porta já ocupada
// especificamente em IPv4 por outro processo, que passaria a responder.
const enviarComRepetidos = (metodo, caminho, headers) => new Promise((resolve) => {
  const servidor = app.listen(0, '127.0.0.1', () => {
    const req = http.request({ host: '127.0.0.1', port: servidor.address().port, method: metodo, path: caminho, headers }, (res) => {
      let texto = '';
      res.on('data', (parte) => { texto += parte; });
      res.on('end', () => { servidor.close(); resolve({ status: res.statusCode, text: texto, body: texto ? JSON.parse(texto) : {}, headers: res.headers }); });
    });
    req.end();
  });
});

describe('verificarOrigem: métodos seguros', () => {
  test('GET, HEAD e OPTIONS passam sem Origin nem Referer', async () => {
    assert.equal((await request(app).get('/api/x')).status, 200);
    assert.equal((await request(app).head('/api/x')).status, 200);
    assert.equal((await request(app).options('/api/x')).status, 200);
  });

  test('métodos seguros com origem não permitida não viram 403', async () => {
    for (const origem of ['http://mal.test', 'null']) {
      const r = await request(app).get('/api/x').set('Origin', origem);
      assert.deepEqual([r.status, r.body], [200, { metodo: 'GET' }], origem);
      assert.equal('access-control-allow-origin' in r.headers, false, origem);
    }
  });
});

describe('verificarOrigem: métodos inseguros com Origin', () => {
  test('origem permitida passa em POST, PUT, PATCH e DELETE', async () => {
    for (const metodo of ['post', 'put', 'patch', 'delete']) {
      const r = await request(app)[metodo]('/api/x').set('Origin', 'http://a.test');
      assert.deepEqual([r.status, r.body.metodo], [200, metodo.toUpperCase()], metodo);
    }
    const outraOrigem = await request(app).post('/api/x').set('Origin', 'http://b.test');
    assert.equal(outraOrigem.status, 200);
  });

  test('método não padrão sem origem é tratado como inseguro', async () => {
    const r = await enviarComRepetidos('PURGE', '/api/x', {});
    esperar403(r, 'ORIGEM_AUSENTE', 'PURGE sem origem');
  });

  test('origem fora da allowlist, mesmo parecida, recebe 403 ORIGEM_NAO_PERMITIDA', async () => {
    for (const origem of ['http://mal.test', 'http://a.test:8080', 'https://a.test', 'http://A.TEST', 'http://a.test.mal', 'http://a.test/', `http://${SENTINELA_HOST}`]) {
      logs = [];
      const r = await request(app).post('/api/x').set('Origin', origem);
      esperar403(r, 'ORIGEM_NAO_PERMITIDA', origem);
    }
  });

  test('Origin: null recebe 403 ORIGEM_NAO_PERMITIDA', async () => {
    const r = await request(app).post('/api/x').set('Origin', 'null');
    esperar403(r, 'ORIGEM_NAO_PERMITIDA', 'null');
  });

  test('Origin inválida com Referer permitido continua 403: Referer não é segunda chance', async () => {
    const r = await request(app).post('/api/x').set('Origin', 'http://mal.test').set('Referer', `http://a.test${SENTINELA_PATH}`);
    esperar403(r, 'ORIGEM_NAO_PERMITIDA', 'origin inválida + referer válido');
  });

  test('Origin duplicado, mesmo com ambas permitidas, é ambíguo e recebe 403', async () => {
    const r = await enviarComRepetidos('POST', '/api/x', { Origin: ['http://a.test', 'http://b.test'] });
    esperar403(r, 'ORIGEM_NAO_PERMITIDA', 'origin duplicado');
  });
});

describe('verificarOrigem: fallback por Referer', () => {
  test('Referer de origem permitida com path, query e fragmento passa', async () => {
    for (const referer of [`http://a.test${SENTINELA_PATH}?${SENTINELA_QUERY}`, 'http://a.test/', 'http://A.TEST:80/x', 'http://b.test/app#frag']) {
      const r = await request(app).post('/api/x').set('Referer', referer);
      assert.deepEqual([r.status, r.body.metodo], [200, 'POST'], referer);
    }
  });

  test('Referer de origem não permitida recebe 403', async () => {
    for (const referer of [`http://mal.test${SENTINELA_PATH}`, 'https://a.test/x', 'http://a.test:8080/x', `http://${SENTINELA_HOST}/x`]) {
      logs = [];
      const r = await request(app).post('/api/x').set('Referer', referer);
      esperar403(r, 'ORIGEM_NAO_PERMITIDA', referer);
    }
  });

  test('Referer malformado, com credenciais ou esquema não HTTP recebe 403', async () => {
    for (const referer of ['a.test/login', 'http://user:senha@a.test/', 'ftp://a.test/', 'javascript:alert(1)', 'null', 'about:blank', '']) {
      logs = [];
      const r = await request(app).post('/api/x').set('Referer', referer);
      // Header enviado com valor vazio é presente porém inválido, nunca ausente.
      esperar403(r, 'ORIGEM_NAO_PERMITIDA', JSON.stringify(referer));
    }
  });

  test('Origin com valor vazio é presente porém inválido', async () => {
    const r = await request(app).post('/api/x').set('Origin', '').set('Referer', 'http://a.test/x');
    esperar403(r, 'ORIGEM_NAO_PERMITIDA', 'origin vazio');
  });

  test('Referer duplicado é ambíguo e recebe 403', async () => {
    const r = await enviarComRepetidos('POST', '/api/x', { Referer: ['http://a.test/x', 'http://b.test/y'] });
    esperar403(r, 'ORIGEM_NAO_PERMITIDA', 'referer duplicado');
  });
});

describe('verificarOrigem: ausência total e integração com as demais camadas', () => {
  test('sem Origin e sem Referer em método inseguro: 403 ORIGEM_AUSENTE com mensagem fixa', async () => {
    const r = await request(app).post('/api/x');
    esperar403(r, 'ORIGEM_AUSENTE', 'sem origem');
    assert.equal(r.body.message, 'Origem da requisição não informada');
  });

  test('mensagem fixa de origem não permitida', async () => {
    const r = await request(app).post('/api/x').set('Origin', 'http://mal.test');
    assert.equal(r.body.message, 'Origem da requisição não permitida');
  });

  test('403 dentro de /api recebe no-store e cabeçalhos do Helmet, sem cabeçalhos CORS', async () => {
    const r = await request(app).post('/api/x').set('Origin', 'http://mal.test');
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers['x-frame-options'], 'DENY');
    assert.equal('access-control-allow-origin' in r.headers, false);
  });

  test('origem permitida em método inseguro recebe os cabeçalhos CORS normalmente', async () => {
    const r = await request(app).post('/api/x').set('Origin', 'http://a.test');
    assert.equal(r.headers['access-control-allow-origin'], 'http://a.test');
    assert.equal(r.headers['access-control-allow-credentials'], 'true');
  });

  test('fora de /api a política não se aplica', async () => {
    const r = await request(app).post('/fora');
    assert.deepEqual([r.status, r.body], [200, { fora: true }]);
  });
});
