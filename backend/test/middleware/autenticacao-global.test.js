'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { criarAppTeste } = require('../helpers/app-teste');
const { assertSemSensiveis } = require('../helpers/sensiveis');
const { criarExigirSessaoGlobal } = require('../../src/middleware/autenticacao-global');
const sessaoGlobalRepo = require('../../src/repositories/sessao-global.repository');
const { gerarTokenSessao, hashTokenSessao } = require('../../src/security/token');
const { authConfig } = require('../../src/config/auth');

/**
 * Testes do middleware de autenticação de sessão do Painel Privado da
 * plataforma, sem PostgreSQL real — mesma técnica de
 * middleware/autenticacao.test.js: sessao-global.repository é sempre
 * mockado via t.mock.method (chamado por namespace no middleware).
 *
 * Cobre especificamente a diferença de propósito deste módulo: o cookie
 * PRÓPRIO (nome diferente do cliente) e a propriedade PRÓPRIA
 * (req.identidade, nunca req.usuario/req.empresa).
 */

const TOKEN = gerarTokenSessao();
const OUTRO_TOKEN = gerarTokenSessao();

const CONTEXTO_SESSAO = Object.freeze({
  sessao: { id: '321', criadoEm: new Date('2026-09-23T10:00:00Z'), expiraEm: new Date('2026-09-23T22:00:00Z'), ultimoUsoEm: new Date('2026-09-23T10:30:00Z') },
  identidade: { id: 9, email: 'admin@safework.com.br' },
});

function montarApp(middleware) {
  return criarAppTeste((app) => {
    app.get('/painel', middleware, (req, res) => {
      res.json({ sessaoGlobal: req.sessaoGlobal, identidade: req.identidade });
    });
  });
}

function cookieValido(token = TOKEN) {
  return `${authConfig.sessao.cookieNomeGlobal}=${token}`;
}

describe('criarExigirSessaoGlobal', () => {
  test('cookie ausente: 401 SESSAO_INVALIDA, repositório nunca consultado', async (t) => {
    const buscar = t.mock.method(sessaoGlobalRepo, 'buscarValidaPorHash', async () => CONTEXTO_SESSAO);
    const middleware = criarExigirSessaoGlobal({ pool: {} });

    const resposta = await request(montarApp(middleware)).get('/painel');

    assert.equal(resposta.status, 401);
    assert.deepEqual(resposta.body, { status: 'error', codigo: 'SESSAO_INVALIDA', message: 'Sessão inválida ou expirada' });
    assert.equal(buscar.mock.calls.length, 0);
  });

  test('o cookie do CLIENTE (nome diferente) nunca é reconhecido: 401, repositório de plataforma nunca consultado', async (t) => {
    const buscar = t.mock.method(sessaoGlobalRepo, 'buscarValidaPorHash', async () => CONTEXTO_SESSAO);
    const middleware = criarExigirSessaoGlobal({ pool: {} });

    const resposta = await request(montarApp(middleware))
      .get('/painel')
      .set('Cookie', `${authConfig.sessao.cookieNome}=${TOKEN}`);

    assert.equal(resposta.status, 401);
    assert.equal(buscar.mock.calls.length, 0, 'um cookie de nome diferente do administrativo é, para este middleware, ausência de cookie');
  });

  test('cookie duplicado (mesmo nome administrativo duas vezes): 401, repositório nunca consultado', async (t) => {
    const buscar = t.mock.method(sessaoGlobalRepo, 'buscarValidaPorHash', async () => CONTEXTO_SESSAO);
    const middleware = criarExigirSessaoGlobal({ pool: {} });

    const resposta = await request(montarApp(middleware))
      .get('/painel')
      .set('Cookie', `${cookieValido(TOKEN)}; ${cookieValido(OUTRO_TOKEN)}`);

    assert.equal(resposta.status, 401);
    assert.equal(buscar.mock.calls.length, 0);
  });

  test('cookie com formato inválido: 401, hashTokenSessao/repositório nunca chamados', async (t) => {
    const buscar = t.mock.method(sessaoGlobalRepo, 'buscarValidaPorHash', async () => CONTEXTO_SESSAO);
    const middleware = criarExigirSessaoGlobal({ pool: {} });

    const resposta = await request(montarApp(middleware))
      .get('/painel')
      .set('Cookie', `${authConfig.sessao.cookieNomeGlobal}=nao-eh-um-token-valido`);

    assert.equal(resposta.status, 401);
    assert.equal(buscar.mock.calls.length, 0);
  });

  test('buscarValidaPorHash chamado com pool injetado, hash correto e inatividade configurada', async (t) => {
    const buscar = t.mock.method(sessaoGlobalRepo, 'buscarValidaPorHash', async () => CONTEXTO_SESSAO);
    t.mock.method(sessaoGlobalRepo, 'registrarUso', async () => true);
    const poolFalso = { marcador: 'pool-de-teste' };
    const middleware = criarExigirSessaoGlobal({ pool: poolFalso });

    await request(montarApp(middleware)).get('/painel').set('Cookie', cookieValido());

    assert.equal(buscar.mock.calls.length, 1);
    assert.equal(buscar.mock.calls[0].arguments[0], poolFalso, 'deve usar o mesmo pool injetado, nunca um pool global');
    assert.equal(buscar.mock.calls[0].arguments[1], hashTokenSessao(TOKEN));
    assert.equal(buscar.mock.calls[0].arguments[2], authConfig.sessao.inatividadeMinutos);
  });

  test('buscarValidaPorHash devolve null: 401, registrarUso nunca chamado', async (t) => {
    t.mock.method(sessaoGlobalRepo, 'buscarValidaPorHash', async () => null);
    const registrar = t.mock.method(sessaoGlobalRepo, 'registrarUso', async () => true);
    const middleware = criarExigirSessaoGlobal({ pool: {} });

    const resposta = await request(montarApp(middleware)).get('/painel').set('Cookie', cookieValido());

    assert.equal(resposta.status, 401);
    assert.equal(registrar.mock.calls.length, 0);
  });

  test('registrarUso devolve false: 401, a rota protegida não é alcançada', async (t) => {
    t.mock.method(sessaoGlobalRepo, 'buscarValidaPorHash', async () => CONTEXTO_SESSAO);
    t.mock.method(sessaoGlobalRepo, 'registrarUso', async () => false);
    const middleware = criarExigirSessaoGlobal({ pool: {} });

    const resposta = await request(montarApp(middleware)).get('/painel').set('Cookie', cookieValido());

    assert.equal(resposta.status, 401);
    assert.equal('identidade' in resposta.body, false);
  });

  test('sessão válida: next() chamado, req.sessaoGlobal/identidade populados, nunca req.usuario/req.empresa', async (t) => {
    t.mock.method(sessaoGlobalRepo, 'buscarValidaPorHash', async () => CONTEXTO_SESSAO);
    t.mock.method(sessaoGlobalRepo, 'registrarUso', async () => true);
    const middleware = criarExigirSessaoGlobal({ pool: {} });
    const app = criarAppTeste((a) => {
      a.get('/painel', middleware, (req, res) => {
        res.json({
          sessaoGlobal: req.sessaoGlobal,
          identidade: req.identidade,
          usuario: req.usuario ?? null,
          empresa: req.empresa ?? null,
        });
      });
    });

    const resposta = await request(app).get('/painel').set('Cookie', cookieValido());

    assert.equal(resposta.status, 200);
    assert.equal(resposta.body.sessaoGlobal.id, CONTEXTO_SESSAO.sessao.id);
    assert.equal(resposta.body.identidade.id, CONTEXTO_SESSAO.identidade.id);
    assert.equal(resposta.body.usuario, null);
    assert.equal(resposta.body.empresa, null);
  });

  test('erro inesperado em buscarValidaPorHash propaga (500), não vira 401', async (t) => {
    t.mock.method(sessaoGlobalRepo, 'buscarValidaPorHash', async () => { throw new Error('conexão perdida com o banco'); });
    const middleware = criarExigirSessaoGlobal({ pool: {} });

    const resposta = await request(montarApp(middleware)).get('/painel').set('Cookie', cookieValido());

    assert.equal(resposta.status, 500);
    assert.deepEqual(resposta.body, { status: 'error', codigo: 'ERRO_INTERNO', message: 'Erro interno do servidor' });
  });

  test('nenhuma resposta 401/500 expõe o token ou o hash, nem no corpo nem no log', async (t) => {
    const logs = [];
    t.mock.method(console, 'error', (...args) => { logs.push(args); });
    t.mock.method(sessaoGlobalRepo, 'buscarValidaPorHash', async () => { throw new Error(`falha com token ${TOKEN}`); });
    const middleware = criarExigirSessaoGlobal({ pool: {} });

    const resposta = await request(montarApp(middleware)).get('/painel').set('Cookie', cookieValido());

    assertSemSensiveis(JSON.stringify(resposta.body), [TOKEN, hashTokenSessao(TOKEN)], 'resposta de erro');
    assertSemSensiveis(JSON.stringify(logs), [TOKEN, hashTokenSessao(TOKEN)], 'log do erro');
  });
});
