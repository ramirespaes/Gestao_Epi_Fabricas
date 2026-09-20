'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const express = require('express');
const { criarCabecalhosSeguranca, semCache } = require('../../src/middleware/cabecalhos');

// Contrato de cabeçalhos observáveis; nenhum teste depende da ordem textual
// produzida pelo Helmet nem de detalhes internos.
const ESPERADOS = {
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'origin-agent-cluster': '?1',
  'x-permitted-cross-domain-policies': 'none',
  'x-dns-prefetch-control': 'off',
  'x-download-options': 'noopen',
  'x-xss-protection': '0',
};
const CSP_ESPERADA = new Set(["default-src 'none'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'"]);
const CSP_PROIBIDAS = ['script-src', 'style-src', 'img-src', 'font-src', 'upgrade-insecure-requests'];

// Parseia a CSP por ';', normalizando espaços, e devolve o conjunto de diretivas.
const diretivasCsp = (valor) => new Set(String(valor).split(';').map((d) => d.trim().replace(/\s+/g, ' ')).filter((d) => d !== ''));

const appCom = (hstsAtivo, extra = () => {}) => {
  const app = express();
  app.use(criarCabecalhosSeguranca({ hstsAtivo }));
  extra(app);
  app.get('/', (req, res) => res.json({ ok: true }));
  app.get('/erro', (req, res) => res.status(500).json({ status: 'error' }));
  return app;
};

const conferirCabecalhos = (headers, rotulo) => {
  for (const [nome, valor] of Object.entries(ESPERADOS)) {
    assert.equal(headers[nome], valor, `${rotulo}: ${nome}`);
  }
  const csp = diretivasCsp(headers['content-security-policy']);
  assert.deepEqual(csp, CSP_ESPERADA, `${rotulo}: CSP`);
  for (const proibida of CSP_PROIBIDAS) {
    assert.equal([...csp].some((d) => d.startsWith(proibida)), false, `${rotulo}: CSP não deve conter ${proibida}`);
  }
  assert.equal('cross-origin-embedder-policy' in headers, false, `${rotulo}: COEP deve estar desativado`);
  // X-Powered-By é responsabilidade do app (app.disable) e é testado em app.test.js.
};

describe('criarCabecalhosSeguranca', () => {
  test('com hstsAtivo=false: cabeçalhos de segurança da API, sem HSTS, sem COEP', async () => {
    const r = await request(appCom(false)).get('/');
    assert.equal(r.status, 200);
    conferirCabecalhos(r.headers, 'hsts inativo');
    assert.equal('strict-transport-security' in r.headers, false);
  });

  test('com hstsAtivo=true: HSTS de um ano, sem includeSubDomains e sem preload', async () => {
    const r = await request(appCom(true)).get('/');
    conferirCabecalhos(r.headers, 'hsts ativo');
    assert.equal(r.headers['strict-transport-security'], 'max-age=31536000');
  });

  test('os cabeçalhos também saem em respostas de erro', async () => {
    const r = await request(appCom(false)).get('/erro');
    assert.equal(r.status, 500);
    conferirCabecalhos(r.headers, 'resposta de erro');
  });
});

describe('semCache', () => {
  test('define Cache-Control: no-store sem alterar os demais cabeçalhos', async () => {
    const app = appCom(false, (a) => a.use('/api', semCache));
    app.get('/api/dado', (req, res) => res.json({ ok: true }));
    const dentro = await request(app).get('/api/dado');
    assert.equal(dentro.headers['cache-control'], 'no-store');
    conferirCabecalhos(dentro.headers, 'com semCache');
    const fora = await request(app).get('/');
    assert.equal('cache-control' in fora.headers, false);
  });
});
