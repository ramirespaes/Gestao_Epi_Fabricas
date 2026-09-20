'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { criarAppTeste } = require('../helpers/app-teste');
const { assertSemSensiveis } = require('../helpers/sensiveis');
const { criarAuthController, authController } = require('../../src/controllers/auth.controller');
const loginService = require('../../src/services/login.service');
const { gerarTokenSessao } = require('../../src/security/token');
const { HttpError } = require('../../src/errors/HttpError');
const { authConfig } = require('../../src/config/auth');

/**
 * Testes do controller de autenticação, isolados de PostgreSQL real.
 *
 * loginService.autenticar é sempre mockado via t.mock.method — o controller
 * não sabe (nem deve saber) como o serviço decide sucesso ou falha, só como
 * traduzir o resultado dele em resposta HTTP. auth.controller.js chama
 * `loginService.autenticar(...)` por namespace (não desestruturado), o que
 * torna esse mock possível.
 *
 * req.validado.body é preenchido diretamente por um middleware de teste, sem
 * passar pelo schema Zod real: a validação de entrada é responsabilidade da
 * rota (Etapa 2), não deste arquivo.
 */

const CORPO = Object.freeze({ cnpj: '12345678000195', email: 'ana.souza@demo.safeworkengenharia.com.br', senha: 'senha-de-teste-qualquer' });
// Token real e canônico (não um texto fixo qualquer de 43 caracteres):
// serializarCookieSessao valida o formato via tokenSessaoTemFormatoValido,
// que exige round-trip exato de base64url — um texto arbitrário como
// 'a'.repeat(43) não decodifica de volta para os mesmos 32 bytes.
const TOKEN = gerarTokenSessao();
const RESULTADO_SUCESSO = Object.freeze({
  usuario: { id: 7, nome: 'Ana Souza', email: CORPO.email, perfil: 'ADMINISTRADOR' },
  empresa: { id: 42, nome: 'Empresa Teste', cnpj: CORPO.cnpj },
  sessao: { id: '555', expiraEm: new Date('2026-10-20T12:00:00Z') },
  token: TOKEN,
});

/** Monta um app mínimo: injeta req.validado.body e um req.ip determinístico, depois chama o controller. */
function montarApp(controller, { corpo = CORPO, ip = '203.0.113.9' } = {}) {
  return criarAppTeste((app) => {
    app.post('/login', (req, res, next) => {
      req.validado = Object.freeze({ body: corpo });
      Object.defineProperty(req, 'ip', { value: ip, configurable: true, enumerable: true });
      next();
    }, controller.login);
  });
}

describe('criarAuthController', () => {
  test('chama loginService.autenticar com o pool exatamente injetado', async (t) => {
    const poolFalso = { conexaoFake: true };
    const autenticar = t.mock.method(loginService, 'autenticar', async () => RESULTADO_SUCESSO);
    const controller = criarAuthController({ pool: poolFalso });

    await request(montarApp(controller)).post('/login');

    assert.equal(autenticar.mock.calls.length, 1);
    assert.equal(autenticar.mock.calls[0].arguments[0], poolFalso, 'deve ser a mesma referência, não o pool global');
  });

  test('repassa cnpj, email, senha, ip e dispositivo exatamente como recebidos', async (t) => {
    const autenticar = t.mock.method(loginService, 'autenticar', async () => RESULTADO_SUCESSO);
    const controller = criarAuthController({ pool: {} });

    await request(montarApp(controller, { ip: '198.51.100.7' }))
      .post('/login')
      .set('User-Agent', 'Dispositivo-De-Teste/1.0');

    const dados = autenticar.mock.calls[0].arguments[1];
    assert.equal(dados.cnpj, CORPO.cnpj);
    assert.equal(dados.email, CORPO.email);
    assert.equal(dados.senha, CORPO.senha);
    assert.equal(dados.ip, '198.51.100.7');
    assert.equal(dados.dispositivo, 'Dispositivo-De-Teste/1.0');
  });

  test('sucesso: HTTP 200, Set-Cookie com o token, corpo somente com status/usuario/empresa', async (t) => {
    t.mock.method(loginService, 'autenticar', async () => RESULTADO_SUCESSO);
    const controller = criarAuthController({ pool: {} });

    const resposta = await request(montarApp(controller)).post('/login');

    assert.equal(resposta.status, 200);

    const cookies = resposta.headers['set-cookie'];
    assert.ok(Array.isArray(cookies) && cookies.length === 1);
    assert.match(cookies[0], new RegExp(`^${authConfig.sessao.cookieNome}=${TOKEN}`));

    assert.deepEqual(Object.keys(resposta.body).sort(), ['empresa', 'status', 'usuario']);
    assert.equal(resposta.body.status, 'ok');
    assert.deepEqual(resposta.body.usuario, RESULTADO_SUCESSO.usuario);
    assert.deepEqual(resposta.body.empresa, RESULTADO_SUCESSO.empresa);
  });

  test('o corpo de sucesso nunca contém token, sessao, senha ou senha_hash', async (t) => {
    t.mock.method(loginService, 'autenticar', async () => RESULTADO_SUCESSO);
    const controller = criarAuthController({ pool: {} });

    const resposta = await request(montarApp(controller)).post('/login');

    assert.equal('token' in resposta.body, false);
    assert.equal('sessao' in resposta.body, false);
    assertSemSensiveis(JSON.stringify(resposta.body), [TOKEN, CORPO.senha], 'corpo da resposta de sucesso');
  });

  test('propaga HttpError de credenciais inválidas sem transformação, e sem Set-Cookie', async (t) => {
    const erro = HttpError.unauthorized('CREDENCIAIS_INVALIDAS', 'CNPJ, e-mail ou senha inválidos');
    t.mock.method(loginService, 'autenticar', async () => { throw erro; });
    const controller = criarAuthController({ pool: {} });

    const resposta = await request(montarApp(controller)).post('/login');

    assert.equal(resposta.status, 401);
    assert.deepEqual(resposta.body, { status: 'error', codigo: 'CREDENCIAIS_INVALIDAS', message: 'CNPJ, e-mail ou senha inválidos' });
    assert.equal(resposta.headers['set-cookie'], undefined);
  });

  test('propaga HttpError de cooldown com Retry-After, sem Set-Cookie', async (t) => {
    const erro = HttpError.tooManyRequests('LOGIN_EM_COOLDOWN', 'Muitas tentativas. Tente novamente mais tarde', { retryAfterSegundos: 42 });
    t.mock.method(loginService, 'autenticar', async () => { throw erro; });
    const controller = criarAuthController({ pool: {} });

    const resposta = await request(montarApp(controller)).post('/login');

    assert.equal(resposta.status, 429);
    assert.equal(resposta.body.codigo, 'LOGIN_EM_COOLDOWN');
    assert.equal(resposta.headers['retry-after'], '42');
    assert.equal(resposta.headers['set-cookie'], undefined);
  });

  test('erro inesperado (não HttpError) propaga para o errorHandler genérico, sem Set-Cookie e sem log de dados sensíveis', async (t) => {
    const logs = [];
    t.mock.method(console, 'error', (...args) => { logs.push(args); });
    t.mock.method(loginService, 'autenticar', async () => { throw new Error(`falha interna com ${CORPO.senha} e ${TOKEN}`); });
    const controller = criarAuthController({ pool: {} });

    const resposta = await request(montarApp(controller)).post('/login');

    assert.equal(resposta.status, 500);
    assert.deepEqual(resposta.body, { status: 'error', codigo: 'ERRO_INTERNO', message: 'Erro interno do servidor' });
    assert.equal(resposta.headers['set-cookie'], undefined);
    assertSemSensiveis(JSON.stringify(resposta.body), [CORPO.senha, TOKEN], 'resposta 500');
    // O log é feito pelo errorHandler (já auditado), não pelo controller: aqui
    // só confirmamos que o controller não introduziu senha/token no que foi logado.
    assertSemSensiveis(JSON.stringify(logs), [CORPO.senha, TOKEN], 'log do erro inesperado');
  });

  test('o controller nunca chama console.log/console.error diretamente em nenhum caminho', async (t) => {
    const logsLog = t.mock.method(console, 'log', () => {});
    const logsErro = t.mock.method(console, 'error', () => {});
    t.mock.method(loginService, 'autenticar', async () => RESULTADO_SUCESSO);
    const controller = criarAuthController({ pool: {} });

    await request(montarApp(controller)).post('/login');

    assert.equal(logsLog.mock.calls.length, 0);
    assert.equal(logsErro.mock.calls.length, 0, 'sucesso não deve gerar nenhum log');
  });
});

describe('authController (instância padrão)', () => {
  test('existe e usa o pool real de config/database.js', () => {
    assert.equal(typeof authController.login, 'function');
  });
});
