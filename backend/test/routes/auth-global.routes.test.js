'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { criarAppTeste } = require('../helpers/app-teste');
const { criarAuthGlobalRoutes, authGlobalRoutes } = require('../../src/routes/auth-global.routes');
const { criarAuthGlobalController } = require('../../src/controllers/auth-global.controller');
const { criarTurnstileController } = require('../../src/controllers/turnstile.controller');
const { criarExigirTurnstile, exigirTurnstilePortal } = require('../../src/middleware/turnstile');
const { criarValidadorTurnstile } = require('../../src/security/turnstile');
const { criarLimitador, limitadorAutenticacao } = require('../../src/middleware/rate-limit');
const loginGlobalService = require('../../src/services/login-global.service');
const { turnstileConfig } = require('../../src/config/turnstile');
const { HttpError } = require('../../src/errors/HttpError');

/**
 * POST /auth/global/login exige a verificação do Turnstile entre a
 * validação do corpo e o controller. A rede (Siteverify) é um fetch falso;
 * o validador, o middleware, a rota e o controller são os reais.
 */

const TOKEN = 'token-de-teste.abc_DEF-123';
const SECRET = '0x4AAAAAAAsegredoFicticioParaTeste000';
const CORPO = { email: 'pessoa@exemplo-cliente.com.br', senha: 'uma-senha-qualquer', turnstileToken: TOKEN };

const poolSemBanco = {
  connect: async () => { throw new Error('o banco não pode ser tocado'); },
  query: async () => { throw new Error('o banco não pode ser tocado'); },
};

function fetchFalso(responder) {
  const chamadas = [];
  const fn = async (url, opcoes) => { chamadas.push({ url, opcoes }); return responder(); };
  fn.chamadas = chamadas;
  return fn;
}
const siteverify = (corpo, status = 200) => () => new Response(JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json' } });
const aprovado = siteverify({ success: true, 'error-codes': [], hostname: 'localhost', action: 'portal_login' });

function montar({ fetch = fetchFalso(aprovado), limite = 1000 } = {}) {
  const validador = criarValidadorTurnstile({
    secretKey: SECRET, acao: 'portal_login', hostnamesPermitidos: ['localhost'], modoTeste: false, timeoutMs: 1000, fetch,
  });
  const router = criarAuthGlobalRoutes({
    controller: criarAuthGlobalController({ pool: poolSemBanco }),
    limitador: criarLimitador({ limite, janelaSegundos: 60 }),
    exigirSessaoGlobal: (req, res, next) => next(HttpError.unauthorized()),
    exigirTurnstile: criarExigirTurnstile({ validador }),
    turnstileController: criarTurnstileController({ siteKey: '0x4AAAAAAAsiteFicticiaParaTeste', acao: 'portal_login' }),
  });
  return { app: criarAppTeste((app) => app.use(router)), fetch };
}

const login = (app, corpo = CORPO) => request(app).post('/auth/global/login').send(corpo);

describe('POST /auth/global/login com Turnstile', () => {
  test('sem turnstileToken: 400 de validação; nem Siteverify nem o login são chamados', async (t) => {
    const autenticar = t.mock.method(loginGlobalService, 'autenticar', async () => { throw new Error('não deveria'); });
    const { app, fetch } = montar();
    const { turnstileToken, ...semToken } = CORPO;
    const r = await login(app, semToken);
    assert.equal(r.status, 400);
    assert.equal(r.body.codigo, 'VALIDACAO');
    assert.equal(turnstileToken, TOKEN);
    assert.equal(fetch.chamadas.length, 0);
    assert.equal(autenticar.mock.calls.length, 0);
  });

  test('corpo inválido com token presente: 400 antes do Siteverify', async (t) => {
    const autenticar = t.mock.method(loginGlobalService, 'autenticar', async () => { throw new Error('não deveria'); });
    const { app, fetch } = montar();
    const r = await login(app, { senha: 'x', turnstileToken: TOKEN });
    assert.equal(r.status, 400);
    assert.equal(fetch.chamadas.length, 0);
    assert.equal(autenticar.mock.calls.length, 0);
  });

  test('Turnstile inválido: 403 VERIFICACAO_SEGURANCA_INVALIDA; o login (cooldown, Argon2, sessão) nunca é chamado', async (t) => {
    const autenticar = t.mock.method(loginGlobalService, 'autenticar', async () => { throw new Error('não deveria'); });
    for (const resposta of [
      siteverify({ success: false, 'error-codes': ['invalid-input-response'] }),
      siteverify({ success: true, hostname: 'localhost', action: 'outra_acao' }),
      siteverify({ success: true, hostname: 'mal.test', action: 'portal_login' }),
    ]) {
      const { app } = montar({ fetch: fetchFalso(resposta) });
      const r = await login(app);
      assert.equal(r.status, 403);
      assert.deepEqual(Object.keys(r.body).sort(), ['codigo', 'message', 'status']);
      assert.equal(r.body.codigo, 'VERIFICACAO_SEGURANCA_INVALIDA');
      for (const proibido of [TOKEN, 'invalid-input-response', 'outra_acao', 'mal.test']) assert.equal(r.text.includes(proibido), false, proibido);
    }
    assert.equal(autenticar.mock.calls.length, 0);
  });

  test('Siteverify indisponível (rede, timeout, HTTP não-2xx, JSON inválido): 503 VERIFICACAO_SEGURANCA_INDISPONIVEL; o login nunca é chamado', async (t) => {
    t.mock.method(console, 'warn', () => {});
    t.mock.method(console, 'error', () => {});
    const autenticar = t.mock.method(loginGlobalService, 'autenticar', async () => { throw new Error('não deveria'); });
    for (const responder of [
      () => { throw new TypeError('fetch failed'); },
      siteverify({ success: true }, 502),
      () => new Response('não é json', { status: 200 }),
    ]) {
      const { app } = montar({ fetch: fetchFalso(responder) });
      const r = await login(app);
      assert.equal(r.status, 503);
      assert.equal(r.body.codigo, 'VERIFICACAO_SEGURANCA_INDISPONIVEL');
      assert.equal(r.text.includes(TOKEN), false);
    }
    assert.equal(autenticar.mock.calls.length, 0);
  });

  test('Turnstile válido: o login segue igual — o serviço recebe só e-mail, senha, IP e dispositivo; senha inválida mantém o 401 genérico', async (t) => {
    const autenticar = t.mock.method(loginGlobalService, 'autenticar', async () => {
      throw HttpError.unauthorized('CREDENCIAIS_INVALIDAS', 'E-mail ou senha inválidos');
    });
    const { app, fetch } = montar();
    const r = await login(app);
    assert.equal(fetch.chamadas.length, 1);
    assert.equal(autenticar.mock.calls.length, 1);
    const argumentos = autenticar.mock.calls[0].arguments[1];
    assert.deepEqual(Object.keys(argumentos).sort(), ['dispositivo', 'email', 'ip', 'senha']);
    assert.equal(argumentos.email, CORPO.email);
    assert.deepEqual([r.status, r.body.codigo, r.body.message], [401, 'CREDENCIAIS_INVALIDAS', 'E-mail ou senha inválidos']);
  });

  test('Turnstile válido com cooldown ativo: o 429 do login continua, com Retry-After', async (t) => {
    t.mock.method(loginGlobalService, 'autenticar', async () => {
      throw HttpError.tooManyRequests('LOGIN_EM_COOLDOWN', 'Muitas tentativas. Tente novamente mais tarde', { retryAfterSegundos: 90 });
    });
    const { app } = montar();
    const r = await login(app);
    assert.deepEqual([r.status, r.body.codigo, r.headers['retry-after']], [429, 'LOGIN_EM_COOLDOWN', '90']);
  });

  test('rate limit continua ANTES do Siteverify: acima do limite, 429 sem chamada à Cloudflare', async (t) => {
    t.mock.method(loginGlobalService, 'autenticar', async () => { throw HttpError.unauthorized('CREDENCIAIS_INVALIDAS', 'E-mail ou senha inválidos'); });
    const { app, fetch } = montar({ limite: 2 });
    assert.equal((await login(app)).status, 401);
    assert.equal((await login(app)).status, 401);
    const bloqueada = await login(app);
    assert.equal(bloqueada.status, 429);
    assert.equal(bloqueada.body.codigo, 'LIMITE_REQUISICOES_EXCEDIDO');
    assert.equal(fetch.chamadas.length, 2);
  });

  test('a fábrica não monta o login sem a verificação: sem exigirTurnstile ou sem o controller de configuração é erro', () => {
    const base = {
      controller: criarAuthGlobalController({ pool: poolSemBanco }),
      limitador: (req, res, next) => next(),
      exigirSessaoGlobal: (req, res, next) => next(),
      exigirTurnstile: (req, res, next) => next(),
      turnstileController: criarTurnstileController({ siteKey: 'x'.repeat(20), acao: 'portal_login' }),
    };
    assert.throws(() => criarAuthGlobalRoutes({ ...base, exigirTurnstile: undefined }), TypeError);
    assert.throws(() => criarAuthGlobalRoutes({ ...base, turnstileController: undefined }), TypeError);
  });

  test('rota de produção: limitadorAutenticacao -> validar -> exigirTurnstilePortal -> controller.login, nessa ordem', () => {
    const camada = authGlobalRoutes.stack.find((c) => c.route && c.route.path === '/auth/global/login' && c.route.methods.post);
    assert.ok(camada);
    const pilha = camada.route.stack.map((c) => c.handle);
    assert.equal(pilha.length, 4);
    assert.equal(pilha[0], limitadorAutenticacao);
    assert.equal(pilha[2], exigirTurnstilePortal);
  });
});

describe('GET /auth/global/turnstile (configuração pública do widget)', () => {
  test('devolve só siteKey e action; sem secret, sem sessão e sem banco', async () => {
    const { app } = montar();
    const r = await request(app).get('/auth/global/turnstile');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { status: 'ok', siteKey: '0x4AAAAAAAsiteFicticiaParaTeste', action: 'portal_login' });
    assert.equal(r.text.includes(SECRET), false);
  });

  test('o controller de produção usa a configuração carregada e nunca expõe a secret', async () => {
    const router = criarAuthGlobalRoutes({
      controller: criarAuthGlobalController({ pool: poolSemBanco }),
      limitador: (req, res, next) => next(),
      exigirSessaoGlobal: (req, res, next) => next(),
      exigirTurnstile: exigirTurnstilePortal,
      turnstileController: require('../../src/controllers/turnstile.controller').turnstileController,
    });
    const r = await request(criarAppTeste((app) => app.use(router))).get('/auth/global/turnstile');
    assert.deepEqual(r.body, { status: 'ok', siteKey: turnstileConfig.portal.siteKey, action: 'portal_login' });
    assert.equal(r.text.includes(turnstileConfig.portal.secretKey), false);
  });
});
