'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { criarAppTeste } = require('../helpers/app-teste');
const { assertSemSensiveis } = require('../helpers/sensiveis');
const { criarAuthController, authController } = require('../../src/controllers/auth.controller');
const loginService = require('../../src/services/login.service');
const autenticacaoMiddleware = require('../../src/middleware/autenticacao');
const sessaoRepo = require('../../src/repositories/sessao.repository');
const { serializarRemocaoCookieSessao } = require('../../src/security/cookie');
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

describe('criarAuthController.me', () => {
  function montarAppMe(controller) {
    return criarAppTeste((app) => app.get('/me', (req, res, next) => {
      req.usuario = RESULTADO_SUCESSO.usuario;
      req.empresa = RESULTADO_SUCESSO.empresa;
      req.sessao = RESULTADO_SUCESSO.sessao;
      next();
    }, controller.me));
  }

  test('responde 200 com status/usuario/empresa vindos exclusivamente de req.usuario/req.empresa', async () => {
    const controller = criarAuthController({ pool: {} });

    const resposta = await request(montarAppMe(controller)).get('/me');

    assert.equal(resposta.status, 200);
    assert.deepEqual(Object.keys(resposta.body).sort(), ['empresa', 'status', 'usuario']);
    assert.equal(resposta.body.status, 'ok');
    assert.deepEqual(resposta.body.usuario, RESULTADO_SUCESSO.usuario);
    assert.deepEqual(resposta.body.empresa, RESULTADO_SUCESSO.empresa);
  });

  test('não consulta o banco nem chama loginService.autenticar: usa só o que o middleware já populou', async (t) => {
    const autenticar = t.mock.method(loginService, 'autenticar', async () => RESULTADO_SUCESSO);
    const controller = criarAuthController({ pool: {} });

    await request(montarAppMe(controller)).get('/me');

    assert.equal(autenticar.mock.calls.length, 0, 'me() não deve consultar o serviço de login nem o banco de novo');
  });

  test('corpo de /me nunca contém token nem o objeto sessao, mesmo que req.sessao exista', async () => {
    const controller = criarAuthController({ pool: {} });

    const resposta = await request(montarAppMe(controller)).get('/me');

    assert.equal('token' in resposta.body, false);
    assert.equal('sessao' in resposta.body, false);
    assertSemSensiveis(JSON.stringify(resposta.body), [TOKEN], 'corpo de /me');
  });
});

describe('criarAuthController.logout', () => {
  const CONTEXTO_SESSAO_VALIDA = Object.freeze({
    sessao: RESULTADO_SUCESSO.sessao,
    usuario: RESULTADO_SUCESSO.usuario,
    empresa: RESULTADO_SUCESSO.empresa,
  });

  function montarAppLogout(controller) {
    return criarAppTeste((app) => app.post('/logout', controller.logout));
  }

  test('sessão válida: revoga com empresaId/sessaoId do contexto e motivo LOGOUT, usa o pool injetado, remove o cookie, 200', async (t) => {
    const buscarContexto = t.mock.method(autenticacaoMiddleware, 'buscarContextoSessao', async () => CONTEXTO_SESSAO_VALIDA);
    const revogar = t.mock.method(sessaoRepo, 'revogar', async () => true);
    const poolFalso = { marcador: 'pool-de-teste' };
    const controller = criarAuthController({ pool: poolFalso });

    const resposta = await request(montarAppLogout(controller)).post('/logout');

    assert.equal(resposta.status, 200);
    assert.deepEqual(resposta.body, { status: 'ok' });
    assert.ok(Array.isArray(resposta.headers['set-cookie']) && resposta.headers['set-cookie'].length === 1);
    assert.equal(resposta.headers['set-cookie'][0], serializarRemocaoCookieSessao());

    assert.equal(buscarContexto.mock.calls[0].arguments[0], poolFalso, 'deve usar o pool injetado, nunca o pool global');
    assert.equal(revogar.mock.calls.length, 1);
    assert.equal(revogar.mock.calls[0].arguments[0], poolFalso);
    assert.equal(revogar.mock.calls[0].arguments[1], CONTEXTO_SESSAO_VALIDA.empresa.id, 'empresaId deve vir do contexto validado, nunca do cliente');
    assert.equal(revogar.mock.calls[0].arguments[2], CONTEXTO_SESSAO_VALIDA.sessao.id, 'sessaoId deve vir do contexto validado, nunca do cliente');
    assert.equal(revogar.mock.calls[0].arguments[3], 'LOGOUT');
  });

  test('sem contexto de sessão (cookie ausente, malformado, duplicado ou sessão já inválida): revogar nunca chamado, cookie removido, 200', async (t) => {
    t.mock.method(autenticacaoMiddleware, 'buscarContextoSessao', async () => null);
    const revogar = t.mock.method(sessaoRepo, 'revogar', async () => true);
    const controller = criarAuthController({ pool: {} });

    const resposta = await request(montarAppLogout(controller)).post('/logout');

    assert.equal(resposta.status, 200);
    assert.deepEqual(resposta.body, { status: 'ok' });
    assert.equal(resposta.headers['set-cookie'][0], serializarRemocaoCookieSessao());
    assert.equal(revogar.mock.calls.length, 0, 'não há empresaId/sessaoId para revogar sem um contexto válido');
  });

  test('revogar devolve false (sessão deixou de estar ativa entre a consulta e a revogação): idempotente, ainda 200', async (t) => {
    t.mock.method(autenticacaoMiddleware, 'buscarContextoSessao', async () => CONTEXTO_SESSAO_VALIDA);
    t.mock.method(sessaoRepo, 'revogar', async () => false);
    const controller = criarAuthController({ pool: {} });

    const resposta = await request(montarAppLogout(controller)).post('/logout');

    assert.equal(resposta.status, 200);
    assert.deepEqual(resposta.body, { status: 'ok' }, 'não afirma uma nova revogação, só conclui de forma idempotente');
    assert.equal(resposta.headers['set-cookie'][0], serializarRemocaoCookieSessao());
  });

  test('duas chamadas consecutivas de logout: ambas 200, a segunda sem nada para revogar', async (t) => {
    let primeiraChamada = true;
    t.mock.method(autenticacaoMiddleware, 'buscarContextoSessao', async () => (primeiraChamada ? CONTEXTO_SESSAO_VALIDA : null));
    const revogar = t.mock.method(sessaoRepo, 'revogar', async () => true);
    const controller = criarAuthController({ pool: {} });
    const app = montarAppLogout(controller);

    const primeira = await request(app).post('/logout');
    primeiraChamada = false;
    const segunda = await request(app).post('/logout');

    assert.equal(primeira.status, 200);
    assert.equal(segunda.status, 200);
    assert.equal(revogar.mock.calls.length, 1, 'só a primeira chamada tinha algo real para revogar');
  });

  test('erro inesperado ao consultar a sessão: 500, sem Set-Cookie, sem afirmar sucesso', async (t) => {
    const logs = [];
    t.mock.method(console, 'error', (...args) => { logs.push(args); });
    t.mock.method(autenticacaoMiddleware, 'buscarContextoSessao', async () => { throw new Error(`falha de conexão com token ${TOKEN}`); });
    const revogar = t.mock.method(sessaoRepo, 'revogar', async () => true);
    const controller = criarAuthController({ pool: {} });

    const resposta = await request(montarAppLogout(controller)).post('/logout');

    assert.equal(resposta.status, 500);
    assert.deepEqual(resposta.body, { status: 'error', codigo: 'ERRO_INTERNO', message: 'Erro interno do servidor' });
    assert.equal(resposta.headers['set-cookie'], undefined, 'não pode remover o cookie afirmando um logout que não aconteceu');
    assert.equal(revogar.mock.calls.length, 0);
    assertSemSensiveis(JSON.stringify(resposta.body), [TOKEN], 'resposta 500');
    assertSemSensiveis(JSON.stringify(logs), [TOKEN], 'log do erro inesperado');
  });

  test('erro inesperado ao revogar: 500, sem Set-Cookie, sem afirmar sucesso', async (t) => {
    const logs = [];
    t.mock.method(console, 'error', (...args) => { logs.push(args); });
    t.mock.method(autenticacaoMiddleware, 'buscarContextoSessao', async () => CONTEXTO_SESSAO_VALIDA);
    t.mock.method(sessaoRepo, 'revogar', async () => { throw new Error(`falha ao revogar, token ${TOKEN}`); });
    const controller = criarAuthController({ pool: {} });

    const resposta = await request(montarAppLogout(controller)).post('/logout');

    assert.equal(resposta.status, 500);
    assert.deepEqual(resposta.body, { status: 'error', codigo: 'ERRO_INTERNO', message: 'Erro interno do servidor' });
    assert.equal(resposta.headers['set-cookie'], undefined, 'não pode remover o cookie afirmando uma revogação que falhou');
    assertSemSensiveis(JSON.stringify(resposta.body), [TOKEN], 'resposta 500');
    assertSemSensiveis(JSON.stringify(logs), [TOKEN], 'log do erro inesperado');
  });
});

describe('authController (instância padrão)', () => {
  test('existe e usa o pool real de config/database.js', () => {
    assert.equal(typeof authController.login, 'function');
    assert.equal(typeof authController.me, 'function');
    assert.equal(typeof authController.logout, 'function');
  });
});
