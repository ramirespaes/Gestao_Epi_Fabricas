'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { criarAppTeste } = require('../helpers/app-teste');
const { assertSemSensiveis } = require('../helpers/sensiveis');
const desafioRepo = require('../../src/repositories/desafio-mfa-plataforma.repository');
const sessaoPlataformaRepo = require('../../src/repositories/sessao-plataforma.repository');
const { gerarTokenSessao, hashTokenSessao } = require('../../src/security/token');
const { authConfig } = require('../../src/config/auth');

const middlewareDesafio = require('../../src/middleware/desafio-mfa-plataforma');

/**
 * Middleware do desafio pré-MFA, sem PostgreSQL: o repositório de desafios
 * é mockado (chamado por namespace). Ele só lê o cookie do desafio, só
 * aceita os tipos que a rota declarar e nunca apresenta o desafio como
 * sessão: req.administradorPlataforma não existe depois dele.
 */

const TODOS = ['LIBERACAO', 'CADASTRO', 'VERIFICACAO', 'RECUPERACAO', 'SUBSTITUICAO'];
const TOKEN = gerarTokenSessao();
const OUTRO = gerarTokenSessao();
const nomeCookie = () => authConfig.desafioMfa.cookieNome;
const cookieDesafio = (token = TOKEN) => `${nomeCookie()}=${token}`;

const DESAFIO = Object.freeze({
  id: '300',
  administradorId: 9,
  tipo: 'VERIFICACAO',
  fatorPendenteId: null,
  sessaoOrigemId: null,
  sessaoCriadaId: null,
  desafioAnteriorId: null,
  criadoEm: new Date('2026-09-28T10:00:00Z'),
  expiraEm: new Date('2026-09-28T10:05:00Z'),
  falhas: 0,
  reinicios: 0,
  encerradoEm: null,
  motivoEncerramento: null,
  vigente: true,
});

function montarApp(middleware) {
  return criarAppTeste((app) => {
    app.get('/auth/mfa/estado', middleware, (req, res) => {
      res.json({
        desafio: req.desafioMfaPlataforma,
        administradorPlataforma: req.administradorPlataforma ?? null,
        sessaoPlataforma: req.sessaoPlataforma ?? null,
      });
    });
  });
}

const criar = (tipos = TODOS, pool = {}) => middlewareDesafio.criarExigirDesafioMfa({ pool, tipos });

function cookieDeRemocao(resposta) {
  const cookies = resposta.headers['set-cookie'] ?? [];
  return cookies.find((c) => c.startsWith(`${nomeCookie()}=;`));
}

describe('criarExigirDesafioMfa', () => {
  test('desafio válido: contexto próprio em req.desafioMfaPlataforma, sem sessão nem administrador de sessão', async (t) => {
    const buscar = t.mock.method(desafioRepo, 'buscarValidoPorHash', async () => DESAFIO);
    const pool = { marcador: 'pool-de-teste' };

    const resposta = await request(montarApp(criar(TODOS, pool))).get('/auth/mfa/estado').set('Cookie', cookieDesafio());

    assert.equal(resposta.status, 200);
    assert.deepEqual(resposta.body.desafio, {
      id: DESAFIO.id, administradorId: DESAFIO.administradorId, tipo: 'VERIFICACAO', expiraEm: DESAFIO.expiraEm.toISOString(),
    });
    assert.equal(resposta.body.administradorPlataforma, null, 'o desafio nunca se apresenta como sessão administrativa');
    assert.equal(resposta.body.sessaoPlataforma, null);
    assert.equal(buscar.mock.calls[0].arguments[0], pool);
    assert.equal(buscar.mock.calls[0].arguments[1], hashTokenSessao(TOKEN), 'só o hash chega ao repositório');
    assert.equal(resposta.headers['set-cookie'], undefined, 'desafio válido não mexe no cookie');
  });

  test('sem cookie do desafio: 401 DESAFIO_INVALIDO, sem consultar o banco e sem Set-Cookie', async (t) => {
    const buscar = t.mock.method(desafioRepo, 'buscarValidoPorHash', async () => DESAFIO);

    const resposta = await request(montarApp(criar())).get('/auth/mfa/estado');

    assert.equal(resposta.status, 401);
    assert.deepEqual(resposta.body, { status: 'error', codigo: 'DESAFIO_INVALIDO', message: 'Etapa de verificação inválida ou expirada' });
    assert.equal(buscar.mock.calls.length, 0);
    assert.equal(resposta.headers['set-cookie'], undefined);
  });

  test('cookie de sessão administrativa, empresarial ou global não servem como desafio', async (t) => {
    const buscar = t.mock.method(desafioRepo, 'buscarValidoPorHash', async () => DESAFIO);
    const buscarSessao = t.mock.method(sessaoPlataformaRepo, 'buscarValidaPorHash', async () => null);

    for (const nome of [authConfig.sessao.cookieNomeAdmin, authConfig.sessao.cookieNome, authConfig.sessao.cookieNomeGlobal]) {
      const resposta = await request(montarApp(criar())).get('/auth/mfa/estado').set('Cookie', `${nome}=${TOKEN}`);
      assert.equal(resposta.status, 401, nome);
    }
    assert.equal(buscar.mock.calls.length, 0);
    assert.equal(buscarSessao.mock.calls.length, 0);
  });

  test('cookie malformado ou duplicado: 401 genérico, banco não consultado, cookie removido', async (t) => {
    const buscar = t.mock.method(desafioRepo, 'buscarValidoPorHash', async () => DESAFIO);

    for (const cabecalho of [`${nomeCookie()}=nao-e-um-token`, `${cookieDesafio(TOKEN)}; ${cookieDesafio(OUTRO)}`]) {
      const resposta = await request(montarApp(criar())).get('/auth/mfa/estado').set('Cookie', cabecalho);
      assert.equal(resposta.status, 401);
      assert.equal(resposta.body.codigo, 'DESAFIO_INVALIDO');
      const remocao = cookieDeRemocao(resposta);
      assert.ok(remocao, 'cookie inválido é removido');
      assert.match(remocao, /Path=\/api\/plataforma\/auth/);
      assert.match(remocao, /Max-Age=0/);
    }
    assert.equal(buscar.mock.calls.length, 0);
  });

  test('desafio inexistente, vencido, encerrado ou de administrador inativo (repositório devolve null): 401 genérico e cookie removido', async (t) => {
    t.mock.method(desafioRepo, 'buscarValidoPorHash', async () => null);

    const resposta = await request(montarApp(criar())).get('/auth/mfa/estado').set('Cookie', cookieDesafio());

    assert.equal(resposta.status, 401);
    assert.equal(resposta.body.codigo, 'DESAFIO_INVALIDO');
    assert.ok(cookieDeRemocao(resposta));
  });

  test('tipo fora da lista da rota: 401 genérico, mas o cookie continua (o desafio vale para outra etapa)', async (t) => {
    t.mock.method(desafioRepo, 'buscarValidoPorHash', async () => DESAFIO);

    const resposta = await request(montarApp(criar(['LIBERACAO']))).get('/auth/mfa/estado').set('Cookie', cookieDesafio());

    assert.equal(resposta.status, 401);
    assert.equal(resposta.body.codigo, 'DESAFIO_INVALIDO');
    assert.equal(cookieDeRemocao(resposta), undefined);
  });

  test('a rota precisa declarar os tipos aceitos', () => {
    assert.throws(() => middlewareDesafio.criarExigirDesafioMfa({ pool: {}, tipos: [] }), TypeError);
    assert.throws(() => middlewareDesafio.criarExigirDesafioMfa({ pool: {}, tipos: ['SESSAO'] }), TypeError);
    assert.throws(() => middlewareDesafio.criarExigirDesafioMfa({ pool: {} }), TypeError);
  });

  test('erro inesperado do banco propaga como 500 e nem corpo nem log carregam token ou hash', async (t) => {
    const logs = [];
    t.mock.method(console, 'error', (...args) => { logs.push(args); });
    t.mock.method(desafioRepo, 'buscarValidoPorHash', async () => { throw new Error(`falha com ${TOKEN}`); });

    const resposta = await request(montarApp(criar())).get('/auth/mfa/estado').set('Cookie', cookieDesafio());

    assert.equal(resposta.status, 500);
    assertSemSensiveis(JSON.stringify(resposta.body), [TOKEN, hashTokenSessao(TOKEN)], 'resposta');
    assertSemSensiveis(JSON.stringify(logs), [TOKEN, hashTokenSessao(TOKEN)], 'log');
  });
});

describe('tokenDoDesafioNaRequisicao', () => {
  const req = (cookie) => ({ headers: cookie === undefined ? {} : { cookie } });

  test('devolve o token só quando há exatamente um cookie do desafio em formato canônico', () => {
    assert.equal(middlewareDesafio.tokenDoDesafioNaRequisicao(req(cookieDesafio())), TOKEN);
    assert.equal(middlewareDesafio.tokenDoDesafioNaRequisicao(req()), null);
    assert.equal(middlewareDesafio.tokenDoDesafioNaRequisicao(req(`${nomeCookie()}=x`)), null);
    assert.equal(middlewareDesafio.tokenDoDesafioNaRequisicao(req(`${cookieDesafio(TOKEN)}; ${cookieDesafio(OUTRO)}`)), null);
    assert.equal(middlewareDesafio.tokenDoDesafioNaRequisicao(req(`${authConfig.sessao.cookieNomeAdmin}=${TOKEN}`)), null);
  });
});
