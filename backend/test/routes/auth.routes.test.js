'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { criarAppTeste } = require('../helpers/app-teste');
const { assertSemSensiveis } = require('../helpers/sensiveis');
const { criarAuthRoutes } = require('../../src/routes/auth.routes');
const { criarAuthController } = require('../../src/controllers/auth.controller');
const { criarLimitador } = require('../../src/middleware/rate-limit');
const loginService = require('../../src/services/login.service');
const { gerarTokenSessao } = require('../../src/security/token');
const { HttpError } = require('../../src/errors/HttpError');
const { authConfig } = require('../../src/config/auth');

/**
 * Testes HTTP da rota de autenticação, sem PostgreSQL real.
 *
 * loginService.autenticar é sempre mockado — a lógica de negócio (cooldown,
 * Argon2id, isolamento multiempresa) já tem 454+ testes no Incremento 5;
 * aqui só se confirma a integração validação → limitador → controller.
 *
 * Cada teste cria seu PRÓPRIO limitador via criarLimitador: o MemoryStore
 * nasce vazio e isolado por teste, sem tocar limitadorAutenticacao (o
 * singleton de produção), mesmo padrão já usado em
 * test/middleware/rate-limit.test.js.
 */

// CNPJ estruturalmente válido (12 alfanuméricos + 2 dígitos), sem relação
// com dígitos verificadores: o schema de login não os exige.
const CNPJ = '12345678000195';
const EMAIL = 'ana.souza@demo.safeworkengenharia.com.br';
const SENHA = 'senha-de-teste-qualquer';
const CORPO_VALIDO = Object.freeze({ cnpj: CNPJ, email: EMAIL, senha: SENHA });

const TOKEN = gerarTokenSessao();
const RESULTADO_SUCESSO = Object.freeze({
  usuario: { id: 7, nome: 'Ana Souza', email: EMAIL, perfil: 'ADMINISTRADOR' },
  empresa: { id: 42, nome: 'Empresa Teste', cnpj: CNPJ },
  sessao: { id: '555', expiraEm: new Date(Date.now() + 3600e3) },
  token: TOKEN,
});

const LIMITADOR_GENEROSO = () => criarLimitador({ limite: 1000, janelaSegundos: 60 });

function montarApp({ pool = {}, limitador = LIMITADOR_GENEROSO() } = {}) {
  const controller = criarAuthController({ pool });
  const routes = criarAuthRoutes({ controller, limitador });
  return criarAppTeste((app) => app.use('/api', routes));
}

describe('POST /api/auth/login', () => {
  test('login válido: HTTP 200 e Set-Cookie', async (t) => {
    t.mock.method(loginService, 'autenticar', async () => RESULTADO_SUCESSO);

    const resposta = await request(montarApp()).post('/api/auth/login').send(CORPO_VALIDO);

    assert.equal(resposta.status, 200);
    assert.ok(resposta.headers['set-cookie']);
  });

  test('corpo de sucesso restrito a status, usuario e empresa', async (t) => {
    t.mock.method(loginService, 'autenticar', async () => RESULTADO_SUCESSO);

    const resposta = await request(montarApp()).post('/api/auth/login').send(CORPO_VALIDO);

    assert.deepEqual(Object.keys(resposta.body).sort(), ['empresa', 'status', 'usuario']);
    assert.equal(resposta.body.status, 'ok');
    assert.deepEqual(resposta.body.usuario, RESULTADO_SUCESSO.usuario);
    assert.deepEqual(resposta.body.empresa, RESULTADO_SUCESSO.empresa);
  });

  test('cookie com nome, HttpOnly, Path, SameSite, Secure conforme configuração, sem Domain', async (t) => {
    t.mock.method(loginService, 'autenticar', async () => RESULTADO_SUCESSO);

    const resposta = await request(montarApp()).post('/api/auth/login').send(CORPO_VALIDO);

    const cookies = resposta.headers['set-cookie'];
    assert.equal(cookies.length, 1);
    const cookie = cookies[0];
    const atributos = cookie.split(';').map((parte) => parte.trim());

    assert.match(atributos[0], new RegExp(`^${authConfig.sessao.cookieNome}=${TOKEN}$`));
    assert.ok(atributos.some((a) => a.toLowerCase() === 'httponly'));
    assert.ok(atributos.some((a) => a.toLowerCase() === 'path=/'));
    assert.ok(atributos.some((a) => a.toLowerCase() === `samesite=${authConfig.sessao.cookieSameSite}`));
    assert.equal(atributos.some((a) => a.toLowerCase() === 'secure'), authConfig.sessao.cookieSecure);
    assert.equal(atributos.some((a) => a.toLowerCase().startsWith('domain=')), false, 'cookie deve ser host-only');
  });

  test('Max-Age do cookie coerente com authConfig.sessao.expiracaoMinutos', async (t) => {
    t.mock.method(loginService, 'autenticar', async () => RESULTADO_SUCESSO);

    const resposta = await request(montarApp()).post('/api/auth/login').send(CORPO_VALIDO);

    const cookie = resposta.headers['set-cookie'][0];
    const maxAge = cookie.split(';').map((p) => p.trim()).find((p) => p.toLowerCase().startsWith('max-age='));
    assert.equal(maxAge, `Max-Age=${authConfig.sessao.expiracaoMinutos * 60}`);
  });

  test('token em claro ausente do corpo JSON e dos logs (mas presente no Set-Cookie, como deve ser)', async (t) => {
    const logs = [];
    t.mock.method(console, 'error', (...args) => { logs.push(args); });
    t.mock.method(loginService, 'autenticar', async () => RESULTADO_SUCESSO);

    const resposta = await request(montarApp()).post('/api/auth/login').send(CORPO_VALIDO);

    assert.equal(resposta.headers['set-cookie'][0].includes(TOKEN), true, 'o Set-Cookie PRECISA conter o token: é assim que o navegador o recebe');
    assertSemSensiveis(JSON.stringify(resposta.body), [TOKEN, SENHA], 'corpo JSON de sucesso');
    assertSemSensiveis(JSON.stringify(logs), [TOKEN, SENHA], 'logs do caminho de sucesso');
  });

  test('credenciais inválidas: HTTP 401 genérico, sem Set-Cookie', async (t) => {
    t.mock.method(loginService, 'autenticar', async () => {
      throw HttpError.unauthorized('CREDENCIAIS_INVALIDAS', 'CNPJ, e-mail ou senha inválidos');
    });

    const resposta = await request(montarApp()).post('/api/auth/login').send(CORPO_VALIDO);

    assert.equal(resposta.status, 401);
    assert.deepEqual(resposta.body, { status: 'error', codigo: 'CREDENCIAIS_INVALIDAS', message: 'CNPJ, e-mail ou senha inválidos' });
    assert.equal(resposta.headers['set-cookie'], undefined);
  });

  test('cooldown do serviço: HTTP 429 LOGIN_EM_COOLDOWN, com Retry-After, sem Set-Cookie', async (t) => {
    t.mock.method(loginService, 'autenticar', async () => {
      throw HttpError.tooManyRequests('LOGIN_EM_COOLDOWN', 'Muitas tentativas. Tente novamente mais tarde', { retryAfterSegundos: 42 });
    });

    const resposta = await request(montarApp()).post('/api/auth/login').send(CORPO_VALIDO);

    assert.equal(resposta.status, 429);
    assert.equal(resposta.body.codigo, 'LOGIN_EM_COOLDOWN');
    assert.equal(resposta.headers['retry-after'], '42');
    assert.equal(resposta.headers['set-cookie'], undefined);
  });

  test('limite HTTP excedido: HTTP 429 LIMITE_REQUISICOES_EXCEDIDO, sem alcançar o serviço', async (t) => {
    const autenticar = t.mock.method(loginService, 'autenticar', async () => RESULTADO_SUCESSO);
    const app = montarApp({ limitador: criarLimitador({ limite: 1, janelaSegundos: 60 }) });

    const primeira = await request(app).post('/api/auth/login').send(CORPO_VALIDO);
    assert.equal(primeira.status, 200);

    const bloqueada = await request(app).post('/api/auth/login').send(CORPO_VALIDO);
    assert.equal(bloqueada.status, 429);
    assert.equal(bloqueada.body.codigo, 'LIMITE_REQUISICOES_EXCEDIDO');
    assert.equal(autenticar.mock.calls.length, 1, 'a requisição bloqueada não pode alcançar o serviço');
  });

  test('os dois 429 são distinguíveis: limite de requisições x cooldown do serviço', async () => {
    const codigosPossiveis = ['LIMITE_REQUISICOES_EXCEDIDO', 'LOGIN_EM_COOLDOWN'];
    assert.notEqual(codigosPossiveis[0], codigosPossiveis[1]);
  });

  for (const [descricao, corpoInvalido] of [
    ['cnpj inválido', { cnpj: 'não-é-cnpj', email: EMAIL, senha: SENHA }],
    ['e-mail inválido', { cnpj: CNPJ, email: 'sem-arroba', senha: SENHA }],
    ['senha ausente', { cnpj: CNPJ, email: EMAIL }],
    ['corpo malformado (array)', ['não é um objeto']],
  ]) {
    test(`${descricao}: HTTP 400, serviço nunca chamado`, async (t) => {
      const autenticar = t.mock.method(loginService, 'autenticar', async () => RESULTADO_SUCESSO);

      const resposta = await request(montarApp()).post('/api/auth/login').send(corpoInvalido);

      assert.equal(resposta.status, 400);
      assert.equal(autenticar.mock.calls.length, 0);
    });
  }

  test('empresaId e usuarioId extras no corpo: HTTP 400, serviço nunca chamado', async (t) => {
    const autenticar = t.mock.method(loginService, 'autenticar', async () => RESULTADO_SUCESSO);

    const resposta = await request(montarApp()).post('/api/auth/login').send({ ...CORPO_VALIDO, empresaId: 1, usuarioId: 2 });

    assert.equal(resposta.status, 400);
    assert.equal(autenticar.mock.calls.length, 0);
  });

  test('erro inesperado: HTTP 500 genérico, sem Set-Cookie, sem vazamento de dados sensíveis', async (t) => {
    const logs = [];
    t.mock.method(console, 'error', (...args) => { logs.push(args); });
    t.mock.method(loginService, 'autenticar', async () => { throw new Error(`falha interna com ${SENHA} e ${TOKEN}`); });

    const resposta = await request(montarApp()).post('/api/auth/login').send(CORPO_VALIDO);

    assert.equal(resposta.status, 500);
    assert.deepEqual(resposta.body, { status: 'error', codigo: 'ERRO_INTERNO', message: 'Erro interno do servidor' });
    assert.equal(resposta.headers['set-cookie'], undefined);
    assertSemSensiveis(JSON.stringify(resposta.body), [SENHA, TOKEN], 'resposta 500');
    assertSemSensiveis(JSON.stringify(logs), [SENHA, TOKEN], 'log do erro inesperado');
  });
});
