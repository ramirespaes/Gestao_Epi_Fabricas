'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { criarAppTeste } = require('../helpers/app-teste');
const { criarAuthGlobalController } = require('../../src/controllers/auth-global.controller');
const loginGlobalService = require('../../src/services/login-global.service');
const contextoService = require('../../src/services/contexto-empresarial.service');
const sessaoRepo = require('../../src/repositories/sessao.repository');
const autenticacao = require('../../src/middleware/autenticacao');
const autenticacaoGlobal = require('../../src/middleware/autenticacao-global');
const { gerarTokenSessao } = require('../../src/security/token');
const { authConfig } = require('../../src/config/auth');

/**
 * Controller do login global (Pacote 4), sem PostgreSQL: serviços e
 * helpers de sessão mockados por namespace. Prova a tradução HTTP —
 * quais cookies saem em cada desfecho, que nenhum token vai no corpo, e
 * o que é revogado em cada saída. O fluxo real está em
 * test/integracao/auth-global-routes.integration.js.
 */

const { cookieNome: C_EMPRESA, cookieNomeGlobal: C_GLOBAL } = authConfig.sessao;
const TOKEN_GLOBAL = gerarTokenSessao();
const TOKEN_EMPRESA = gerarTokenSessao();
const identidade = { id: 9, email: 'p@x.com' };
const contextoEmpresarial = { usuario: { id: 70, nome: 'P', email: 'p@x.com', perfil: 'MASTER' }, empresa: { id: 3, nome: 'A', cnpj: '11222333000181' }, sessao: { id: '900' }, token: TOKEN_EMPRESA };

function montar({ comSessaoGlobal = false } = {}) {
  const controller = criarAuthGlobalController({ pool: {} });
  return criarAppTeste((app) => {
    const injetar = (req, res, next) => { if (comSessaoGlobal) { req.identidade = identidade; req.sessaoGlobal = { id: '55' }; } next(); };
    app.post('/login', (req, res, next) => { req.validado = { body: req.body }; next(); }, controller.login);
    app.get('/me', injetar, controller.me);
    app.post('/sel/:id', injetar, (req, res, next) => { req.validado = { params: { id: Number(req.params.id) } }; next(); }, controller.selecionarEmpresa);
    app.post('/logout', controller.logout);
  });
}
const nomes = (r) => (r.headers['set-cookie'] || []).map((c) => [c.split('=')[0], /Max-Age=0/.test(c)]);

describe('login', () => {
  test('uma empresa: cookie global + cookie empresarial; corpo sem tokens; anteriores substituídos só DEPOIS de autenticar e resolver o contexto', async (t) => {
    const ordem = [];
    t.mock.method(autenticacaoGlobal, 'buscarContextoSessaoGlobal', async () => ({ sessao: { id: '1' } }));
    t.mock.method(autenticacao, 'buscarContextoSessao', async () => ({ empresa: { id: 4 }, sessao: { id: '2' } }));
    const encerrar = t.mock.method(contextoService, 'encerrarAnteriores', async () => { ordem.push('encerrar'); });
    t.mock.method(loginGlobalService, 'autenticar', async () => { ordem.push('autenticar'); return { identidade, sessao: { id: '55' }, token: TOKEN_GLOBAL }; });
    t.mock.method(contextoService, 'resolverAposLogin', async () => { ordem.push('resolver'); return { empresas: [{ id: 3 }], contexto: contextoEmpresarial }; });

    const r = await request(montar()).post('/login').send({ email: 'p@x.com', senha: 's' });

    assert.equal(r.status, 200);
    assert.deepEqual(ordem, ['autenticar', 'resolver', 'encerrar']);
    assert.deepEqual(encerrar.mock.calls[0].arguments[1], { sessaoGlobalAnterior: { sessaoId: '1' }, sessaoEmpresarialAnterior: { empresaId: 4, sessaoId: '2' } });
    assert.deepEqual(nomes(r), [[C_GLOBAL, false], [C_EMPRESA, false]]);
    assert.deepEqual(r.body.contexto, { usuario: contextoEmpresarial.usuario, empresa: contextoEmpresarial.empresa });
    assert.equal(r.text.includes(TOKEN_GLOBAL) || r.text.includes(TOKEN_EMPRESA), false);
  });

  test('várias empresas ou nenhuma: cookie global + REMOÇÃO do empresarial; contexto null', async (t) => {
    t.mock.method(autenticacaoGlobal, 'buscarContextoSessaoGlobal', async () => null);
    t.mock.method(autenticacao, 'buscarContextoSessao', async () => null);
    t.mock.method(contextoService, 'encerrarAnteriores', async () => {});
    t.mock.method(loginGlobalService, 'autenticar', async () => ({ identidade, sessao: { id: '55' }, token: TOKEN_GLOBAL }));
    t.mock.method(contextoService, 'resolverAposLogin', async () => ({ empresas: [{ id: 3 }, { id: 4 }], contexto: null }));

    const r = await request(montar()).post('/login').send({ email: 'p@x.com', senha: 's' });
    assert.deepEqual([r.status, r.body.contexto], [200, null]);
    assert.deepEqual(nomes(r), [[C_GLOBAL, false], [C_EMPRESA, true]]);
  });

  test('credencial inválida (401) ou cooldown (429): erro propaga, nenhum cookie, e as sessões anteriores NÃO são tocadas', async (t) => {
    const { HttpError } = require('../../src/errors/HttpError');
    t.mock.method(autenticacaoGlobal, 'buscarContextoSessaoGlobal', async () => ({ sessao: { id: '1' } }));
    t.mock.method(autenticacao, 'buscarContextoSessao', async () => ({ empresa: { id: 4 }, sessao: { id: '2' } }));
    const encerrar = t.mock.method(contextoService, 'encerrarAnteriores', async () => {});
    const compensar = t.mock.method(contextoService, 'compensarLoginIncompleto', async () => true);
    t.mock.method(loginGlobalService, 'autenticar', async () => { throw HttpError.unauthorized('CREDENCIAIS_INVALIDAS', 'E-mail ou senha inválidos'); });
    const resolver = t.mock.method(contextoService, 'resolverAposLogin', async () => ({}));
    const r = await request(montar()).post('/login').send({ email: 'p@x.com', senha: 's' });
    assert.deepEqual([r.status, r.body.codigo, 'set-cookie' in r.headers], [401, 'CREDENCIAIS_INVALIDAS', false]);
    assert.equal(resolver.mock.calls.length, 0);

    loginGlobalService.autenticar.mock.mockImplementation(async () => { throw HttpError.tooManyRequests('LOGIN_EM_COOLDOWN', 'Muitas tentativas', { retryAfterSegundos: 60 }); });
    const cooldown = await request(montar()).post('/login').send({ email: 'p@x.com', senha: 's' });
    assert.deepEqual([cooldown.status, 'set-cookie' in cooldown.headers], [429, false]);
    assert.deepEqual([encerrar.mock.calls.length, compensar.mock.calls.length], [0, 0], 'nada revogado, nada a compensar');
  });

  test('falha DEPOIS de criar a sessão global (seleção automática): compensação revoga a sessão nova, anteriores preservadas, erro original propaga sem cookie', async (t) => {
    t.mock.method(console, 'error', () => {});
    t.mock.method(autenticacaoGlobal, 'buscarContextoSessaoGlobal', async () => ({ sessao: { id: '1' } }));
    t.mock.method(autenticacao, 'buscarContextoSessao', async () => null);
    const encerrar = t.mock.method(contextoService, 'encerrarAnteriores', async () => {});
    t.mock.method(loginGlobalService, 'autenticar', async () => ({ identidade, sessao: { id: '55' }, token: TOKEN_GLOBAL }));
    t.mock.method(contextoService, 'resolverAposLogin', async () => { throw new Error('falha simulada na seleção'); });
    const compensar = t.mock.method(contextoService, 'compensarLoginIncompleto', async () => true);

    const r = await request(montar()).post('/login').send({ email: 'p@x.com', senha: 's' });

    assert.deepEqual([r.status, r.body.codigo, 'set-cookie' in r.headers], [500, 'ERRO_INTERNO', false]);
    assert.deepEqual(compensar.mock.calls[0].arguments[1], { sessaoGlobalId: '55' });
    assert.equal(encerrar.mock.calls.length, 0, 'as sessões anteriores continuam valendo');
    assert.equal(r.text.includes(TOKEN_GLOBAL), false);
  });

  test('falha ao substituir as anteriores também é compensada', async (t) => {
    t.mock.method(console, 'error', () => {});
    t.mock.method(autenticacaoGlobal, 'buscarContextoSessaoGlobal', async () => null);
    t.mock.method(autenticacao, 'buscarContextoSessao', async () => null);
    t.mock.method(loginGlobalService, 'autenticar', async () => ({ identidade, sessao: { id: '56' }, token: TOKEN_GLOBAL }));
    t.mock.method(contextoService, 'resolverAposLogin', async () => ({ empresas: [], contexto: null }));
    t.mock.method(contextoService, 'encerrarAnteriores', async () => { throw new Error('falha simulada'); });
    const compensar = t.mock.method(contextoService, 'compensarLoginIncompleto', async () => true);
    const r = await request(montar()).post('/login').send({ email: 'p@x.com', senha: 's' });
    assert.deepEqual([r.status, 'set-cookie' in r.headers], [500, false]);
    assert.deepEqual(compensar.mock.calls[0].arguments[1], { sessaoGlobalId: '56' });
  });
});

describe('me', () => {
  test('apresenta o contexto empresarial só se for DA MESMA identidade', async (t) => {
    t.mock.method(contextoService, 'listarEmpresas', async () => [{ id: 3 }]);
    const ctx = { usuario: { id: 70, identidadeId: 9 }, empresa: { id: 3 }, sessao: { id: '900' } };
    const buscar = t.mock.method(autenticacao, 'buscarContextoSessao', async () => ctx);
    const proprio = await request(montar({ comSessaoGlobal: true })).get('/me');
    assert.deepEqual(proprio.body.contexto, { usuario: ctx.usuario, empresa: ctx.empresa });

    buscar.mock.mockImplementation(async () => ({ ...ctx, usuario: { id: 71, identidadeId: 99 } }));
    const alheio = await request(montar({ comSessaoGlobal: true })).get('/me');
    assert.equal(alheio.body.contexto, null);
  });
});

describe('selecionarEmpresa', () => {
  test('passa identidade/sessão global da SESSÃO e a anterior do cookie; emite só o cookie empresarial', async (t) => {
    t.mock.method(autenticacao, 'buscarContextoSessao', async () => ({ empresa: { id: 4 }, sessao: { id: '800' } }));
    const selecionar = t.mock.method(contextoService, 'selecionar', async () => contextoEmpresarial);
    const r = await request(montar({ comSessaoGlobal: true })).post('/sel/3');
    assert.equal(r.status, 200);
    const args = selecionar.mock.calls[0].arguments[1];
    assert.deepEqual([args.identidadeId, args.sessaoGlobalId, args.empresaId, args.sessaoEmpresarialAnterior], [9, '55', 3, { empresaId: 4, sessaoId: '800' }]);
    assert.deepEqual(nomes(r), [[C_EMPRESA, false]]);
    assert.deepEqual(Object.keys(r.body).sort(), ['empresa', 'status', 'usuario']);
  });
});

describe('logout (sair completamente)', () => {
  test('com sessão global: encerrarTudo; sem global mas com empresarial: revoga só ela; sem nada: 200. Sempre remove os dois cookies', async (t) => {
    const global = t.mock.method(autenticacaoGlobal, 'buscarContextoSessaoGlobal', async () => ({ sessao: { id: '55' } }));
    const empresarial = t.mock.method(autenticacao, 'buscarContextoSessao', async () => ({ empresa: { id: 3 }, sessao: { id: '900' } }));
    const tudo = t.mock.method(contextoService, 'encerrarTudo', async () => ({}));
    const revogar = t.mock.method(sessaoRepo, 'revogar', async () => true);

    let r = await request(montar()).post('/logout');
    assert.deepEqual(tudo.mock.calls[0].arguments[1], { sessaoGlobalId: '55', sessaoEmpresarialAtual: { empresaId: 3, sessaoId: '900' } });
    assert.deepEqual(nomes(r), [[C_GLOBAL, true], [C_EMPRESA, true]]);

    global.mock.mockImplementation(async () => null);
    r = await request(montar()).post('/logout');
    assert.deepEqual(revogar.mock.calls[0].arguments.slice(1), [3, '900', 'LOGOUT']);

    empresarial.mock.mockImplementation(async () => null);
    r = await request(montar()).post('/logout');
    assert.deepEqual([r.status, r.body], [200, { status: 'ok' }]);
    assert.equal(tudo.mock.calls.length, 1);
    assert.equal(revogar.mock.calls.length, 1);
  });
});
