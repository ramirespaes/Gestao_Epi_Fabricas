'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const { montarAmbiente12f } = require('./helpers/ambiente-http-12f');
const { sessaoDeTeste, CABECALHO } = require('./helpers/ambiente-http-12d2');
const { corsApi } = require('../../src/middleware/cors');
const { semCache } = require('../../src/middleware/cabecalhos');
const { verificarOrigem } = require('../../src/middleware/origem');
const { exigirJson, parserJson } = require('../../src/middleware/conteudo');
const { notFoundHandler, errorHandler } = require('../../src/middleware/errorHandler');
const { criarAlertaEstoqueController } = require('../../src/controllers/alerta-estoque.controller');
const { criarAlertaEstoqueRoutes } = require('../../src/routes/alerta-estoque.routes');
const { httpConfig } = require('../../src/config/http');

/**
 * 12G-6 — o "Gerar alerta" (POST /api/alertas-estoque/falta) atrás das mesmas
 * camadas de /api de app.js: CORS do Portal, verificação de origem (CSRF)
 * antes da sessão e da autorização, e JSON obrigatório. Nenhum e-mail sai de
 * uma requisição recusada.
 */

const ROTA = '/api/alertas-estoque/falta';
const ORIGEM = httpConfig.cors.origens[0];
const ORIGEM_DO_PAINEL = httpConfig.plataforma.corsOrigens[0];

describe('12G-6 — Gerar alerta pela cadeia de /api: CORS, origem e JSON', () => {
  let env;
  let app;
  let ator;
  let alvo;
  const enviados = [];
  const servicoEmail = { async enviarAguardando(m) { enviados.push(m); return { estado: 'ENVIADO' }; } };
  const cabecalhosCors = (r) => Object.keys(r.headers).filter((h) => h.startsWith('access-control-'));

  before(async () => {
    env = await montarAmbiente12f();
    const { pool, d, f } = env;
    ator = await env.usuarioCom(d.empresaA, { acoes: ['REALIZAR_ENTREGA'] });
    alvo = await f.aprovada({ materialId: await f.material(), quantidade: 2 });
    app = express();
    app.use(
      '/api',
      corsApi,
      semCache,
      verificarOrigem,
      exigirJson,
      parserJson,
      criarAlertaEstoqueRoutes({ controller: criarAlertaEstoqueController({ pool, servicoEmail }), exigirSessao: sessaoDeTeste(pool), pool }),
    );
    app.use(notFoundHandler);
    app.use(errorHandler);
  });
  after(async () => { if (env) await env.encerrar(); });

  test('preflight: 204 com a origem do Portal, credentials, POST anunciado e só Content-Type; outra origem não recebe CORS', async () => {
    const preflight = (origem) => request(app).options(ROTA).set('Origin', origem).set('Access-Control-Request-Method', 'POST').set('Access-Control-Request-Headers', 'Content-Type');
    const r = await preflight(ORIGEM);
    assert.equal(r.status, 204);
    assert.equal(r.headers['access-control-allow-origin'], ORIGEM);
    assert.equal(r.headers['access-control-allow-credentials'], 'true');
    assert.ok(r.headers['access-control-allow-methods'].split(',').map((m) => m.trim()).includes('POST'));
    assert.equal(r.headers['access-control-allow-headers'], 'Content-Type');
    for (const origem of ['http://mal.test', ORIGEM_DO_PAINEL]) assert.deepEqual(cabecalhosCors(await preflight(origem)), [], origem);
  });

  test('sem Origin nem Referer, ou com origem estranha ou a do Painel: 403 antes da sessão e nenhum e-mail', async () => {
    const semOrigem = await request(app).post(ROTA).set(CABECALHO, String(ator)).send({ solicitacaoId: alvo.id });
    assert.deepEqual([semOrigem.status, semOrigem.body.codigo], [403, 'ORIGEM_AUSENTE']);
    for (const origem of ['http://mal.test', ORIGEM_DO_PAINEL]) {
      const r = await request(app).post(ROTA).set(CABECALHO, String(ator)).set('Origin', origem).send({ solicitacaoId: alvo.id });
      assert.deepEqual([r.status, r.body.codigo], [403, 'ORIGEM_NAO_PERMITIDA'], origem);
    }
    assert.deepEqual(enviados, []);
  });

  test('Content-Type que não é JSON: 415 e nenhum e-mail', async () => {
    const r = await request(app).post(ROTA).set(CABECALHO, String(ator)).set('Origin', ORIGEM).set('Content-Type', 'text/plain').send(`solicitacaoId=${alvo.id}`);
    assert.equal(r.status, 415);
    assert.deepEqual(enviados, []);
  });

  test('com a origem do Portal, a sessão e REALIZAR_ENTREGA: 200, no-store e CORS na resposta', async () => {
    const r = await request(app).post(ROTA).set(CABECALHO, String(ator)).set('Origin', ORIGEM).send({ solicitacaoId: alvo.id });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers['access-control-allow-origin'], ORIGEM);
    assert.ok(enviados.length > 0);
  });
});
