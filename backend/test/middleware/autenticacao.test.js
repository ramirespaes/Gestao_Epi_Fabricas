'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { criarAppTeste } = require('../helpers/app-teste');
const { assertSemSensiveis } = require('../helpers/sensiveis');
const { criarExigirSessao, exigirSessao, buscarContextoSessao } = require('../../src/middleware/autenticacao');
const sessaoRepo = require('../../src/repositories/sessao.repository');
const { gerarTokenSessao, hashTokenSessao } = require('../../src/security/token');
const { authConfig } = require('../../src/config/auth');

/**
 * Testes do middleware de autenticação de sessão, sem PostgreSQL real.
 *
 * sessao.repository é sempre mockado via t.mock.method — o middleware não
 * sabe (nem deve saber) como o repositório decide validade; só como reagir
 * ao resultado. src/middleware/autenticacao.js chama `sessaoRepo.funcao(...)`
 * por namespace, nunca desestruturado, o que torna esse mock possível.
 *
 * O cookie é sempre exercitado via cabeçalho HTTP real (supertest), não por
 * chamada direta da função com um req fabricado à mão — garante que a
 * extração reflita o formato real de um cabeçalho Cookie.
 */

const TOKEN = gerarTokenSessao();
const OUTRO_TOKEN = gerarTokenSessao();

const CONTEXTO_SESSAO = Object.freeze({
  sessao: { id: '555', criadoEm: new Date('2026-10-01T10:00:00Z'), expiraEm: new Date('2026-10-01T22:00:00Z'), ultimoUsoEm: new Date('2026-10-01T10:30:00Z') },
  usuario: { id: 7, nome: 'Ana Souza', email: 'ana.souza@demo.safeworkengenharia.com.br', perfil: 'ADMINISTRADOR' },
  empresa: { id: 42, nome: 'Empresa Teste', cnpj: '12345678000195' },
});

function montarApp(middleware) {
  return criarAppTeste((app) => {
    app.get('/protegida', middleware, (req, res) => {
      res.json({ sessao: req.sessao, usuario: req.usuario, empresa: req.empresa });
    });
  });
}

function cookieValido(token = TOKEN) {
  return `${authConfig.sessao.cookieNome}=${token}`;
}

describe('criarExigirSessao', () => {
  test('cookie ausente: 401 SESSAO_INVALIDA, repositório nunca consultado', async (t) => {
    const buscar = t.mock.method(sessaoRepo, 'buscarValidaPorHash', async () => CONTEXTO_SESSAO);
    const middleware = criarExigirSessao({ pool: {} });

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 401);
    assert.deepEqual(resposta.body, { status: 'error', codigo: 'SESSAO_INVALIDA', message: 'Sessão inválida ou expirada' });
    assert.equal(buscar.mock.calls.length, 0);
  });

  test('cookie duplicado (mesmo nome duas vezes, ambos formato válido): 401, repositório nunca consultado', async (t) => {
    const buscar = t.mock.method(sessaoRepo, 'buscarValidaPorHash', async () => CONTEXTO_SESSAO);
    const middleware = criarExigirSessao({ pool: {} });

    const resposta = await request(montarApp(middleware))
      .get('/protegida')
      .set('Cookie', `${cookieValido(TOKEN)}; ${cookieValido(OUTRO_TOKEN)}`);

    assert.equal(resposta.status, 401);
    assert.equal(resposta.body.codigo, 'SESSAO_INVALIDA');
    assert.equal(buscar.mock.calls.length, 0, 'ambiguidade não pode ser resolvida aceitando o primeiro nem o último valor');
  });

  test('cookie com formato inválido: 401, hashTokenSessao/repositório nunca chamados', async (t) => {
    const buscar = t.mock.method(sessaoRepo, 'buscarValidaPorHash', async () => CONTEXTO_SESSAO);
    const middleware = criarExigirSessao({ pool: {} });

    const resposta = await request(montarApp(middleware))
      .get('/protegida')
      .set('Cookie', `${authConfig.sessao.cookieNome}=nao-eh-um-token-valido`);

    assert.equal(resposta.status, 401);
    assert.equal(resposta.body.codigo, 'SESSAO_INVALIDA');
    assert.equal(buscar.mock.calls.length, 0, 'token de formato inválido nunca pode chegar ao PostgreSQL');
  });

  test('buscarValidaPorHash com o hash correto e a janela de inatividade configurada', async (t) => {
    const buscar = t.mock.method(sessaoRepo, 'buscarValidaPorHash', async () => CONTEXTO_SESSAO);
    t.mock.method(sessaoRepo, 'registrarUso', async () => true);
    const poolFalso = { marcador: 'pool-de-teste' };
    const middleware = criarExigirSessao({ pool: poolFalso });

    await request(montarApp(middleware)).get('/protegida').set('Cookie', cookieValido());

    assert.equal(buscar.mock.calls.length, 1);
    assert.equal(buscar.mock.calls[0].arguments[0], poolFalso, 'deve usar o mesmo pool injetado, nunca um pool global');
    assert.equal(buscar.mock.calls[0].arguments[1], hashTokenSessao(TOKEN));
    assert.equal(buscar.mock.calls[0].arguments[2], authConfig.sessao.inatividadeMinutos);
  });

  test('buscarValidaPorHash devolve null: 401, registrarUso nunca chamado', async (t) => {
    t.mock.method(sessaoRepo, 'buscarValidaPorHash', async () => null);
    const registrar = t.mock.method(sessaoRepo, 'registrarUso', async () => true);
    const middleware = criarExigirSessao({ pool: {} });

    const resposta = await request(montarApp(middleware)).get('/protegida').set('Cookie', cookieValido());

    assert.equal(resposta.status, 401);
    assert.equal(registrar.mock.calls.length, 0);
  });

  test('sessão válida: registrarUso chamado com pool, sessaoId e inatividadeMinutos (3 argumentos)', async (t) => {
    t.mock.method(sessaoRepo, 'buscarValidaPorHash', async () => CONTEXTO_SESSAO);
    const registrar = t.mock.method(sessaoRepo, 'registrarUso', async () => true);
    const poolFalso = { marcador: 'pool-de-teste' };
    const middleware = criarExigirSessao({ pool: poolFalso });

    await request(montarApp(middleware)).get('/protegida').set('Cookie', cookieValido());

    assert.equal(registrar.mock.calls.length, 1);
    assert.equal(registrar.mock.calls[0].arguments.length, 3);
    assert.equal(registrar.mock.calls[0].arguments[0], poolFalso);
    assert.equal(registrar.mock.calls[0].arguments[1], CONTEXTO_SESSAO.sessao.id);
    assert.equal(registrar.mock.calls[0].arguments[2], authConfig.sessao.inatividadeMinutos);
  });

  test('registrarUso devolve false (sessão venceu entre a leitura e a atualização): 401, next() nunca chamado', async (t) => {
    t.mock.method(sessaoRepo, 'buscarValidaPorHash', async () => CONTEXTO_SESSAO);
    t.mock.method(sessaoRepo, 'registrarUso', async () => false);
    const middleware = criarExigirSessao({ pool: {} });

    const resposta = await request(montarApp(middleware)).get('/protegida').set('Cookie', cookieValido());

    assert.equal(resposta.status, 401);
    assert.equal(resposta.body.codigo, 'SESSAO_INVALIDA');
    assert.equal('sessao' in resposta.body, false, 'a rota protegida não pode ter sido alcançada');
  });

  test('sessão válida e registrarUso bem-sucedido: next() chamado, req.sessao/usuario/empresa populados só então', async (t) => {
    t.mock.method(sessaoRepo, 'buscarValidaPorHash', async () => CONTEXTO_SESSAO);
    t.mock.method(sessaoRepo, 'registrarUso', async () => true);
    const middleware = criarExigirSessao({ pool: {} });

    const resposta = await request(montarApp(middleware)).get('/protegida').set('Cookie', cookieValido());

    assert.equal(resposta.status, 200);
    assert.equal(resposta.body.sessao.id, CONTEXTO_SESSAO.sessao.id);
    assert.equal(resposta.body.usuario.id, CONTEXTO_SESSAO.usuario.id);
    assert.equal(resposta.body.usuario.email, CONTEXTO_SESSAO.usuario.email);
    assert.equal(resposta.body.empresa.id, CONTEXTO_SESSAO.empresa.id);
    assert.equal(resposta.body.empresa.cnpj, CONTEXTO_SESSAO.empresa.cnpj);
  });

  test('não confia em nada vindo do cliente: req.usuario/req.empresa vêm exclusivamente do repositório', async (t) => {
    // Mesmo que a requisição não tenha absolutamente nenhum jeito de indicar
    // empresaId/usuarioId (não há corpo, nem params, nem query nesta rota),
    // reforçamos que os dados populados são exatamente os devolvidos pelo
    // repositório — nunca derivados de outra fonte.
    t.mock.method(sessaoRepo, 'buscarValidaPorHash', async () => CONTEXTO_SESSAO);
    t.mock.method(sessaoRepo, 'registrarUso', async () => true);
    const middleware = criarExigirSessao({ pool: {} });

    const resposta = await request(montarApp(middleware))
      .get('/protegida?empresaId=999&usuarioId=999')
      .set('Cookie', cookieValido());

    assert.equal(resposta.body.empresa.id, CONTEXTO_SESSAO.empresa.id);
    assert.equal(resposta.body.usuario.id, CONTEXTO_SESSAO.usuario.id);
  });

  test('erro inesperado em buscarValidaPorHash propaga (500), não vira 401', async (t) => {
    t.mock.method(sessaoRepo, 'buscarValidaPorHash', async () => { throw new Error('conexão perdida com o banco'); });
    const middleware = criarExigirSessao({ pool: {} });

    const resposta = await request(montarApp(middleware)).get('/protegida').set('Cookie', cookieValido());

    assert.equal(resposta.status, 500);
    assert.deepEqual(resposta.body, { status: 'error', codigo: 'ERRO_INTERNO', message: 'Erro interno do servidor' });
  });

  test('erro inesperado em registrarUso propaga (500), não vira 401', async (t) => {
    t.mock.method(sessaoRepo, 'buscarValidaPorHash', async () => CONTEXTO_SESSAO);
    t.mock.method(sessaoRepo, 'registrarUso', async () => { throw new Error('falha ao atualizar ultimo_uso_em'); });
    const middleware = criarExigirSessao({ pool: {} });

    const resposta = await request(montarApp(middleware)).get('/protegida').set('Cookie', cookieValido());

    assert.equal(resposta.status, 500);
    assert.deepEqual(resposta.body, { status: 'error', codigo: 'ERRO_INTERNO', message: 'Erro interno do servidor' });
  });

  test('nenhuma resposta 401 ou 500 expõe o token, o hash ou dados sensíveis, nem no corpo nem no log', async (t) => {
    const logs = [];
    t.mock.method(console, 'error', (...args) => { logs.push(args); });
    t.mock.method(sessaoRepo, 'buscarValidaPorHash', async () => { throw new Error(`falha com token ${TOKEN}`); });
    const middleware = criarExigirSessao({ pool: {} });

    const resposta = await request(montarApp(middleware)).get('/protegida').set('Cookie', cookieValido());

    assertSemSensiveis(JSON.stringify(resposta.body), [TOKEN, hashTokenSessao(TOKEN)], 'resposta de erro');
    assertSemSensiveis(JSON.stringify(logs), [TOKEN, hashTokenSessao(TOKEN)], 'log do erro');
  });
});

describe('exigirSessao (instância padrão)', () => {
  test('existe como função de middleware', () => {
    assert.equal(typeof exigirSessao, 'function');
  });
});

describe('buscarContextoSessao (exportado para reuso futuro pelo logout)', () => {
  test('existe como função exportada', () => {
    assert.equal(typeof buscarContextoSessao, 'function');
  });
});
