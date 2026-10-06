'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { criarAppTeste } = require('../helpers/app-teste');
const { criarExigirSessaoGlobal } = require('../../src/middleware/autenticacao-global');
const { criarExigirSessao } = require('../../src/middleware/autenticacao');
const sessaoGlobalRepo = require('../../src/repositories/sessao-global.repository');
const sessaoRepo = require('../../src/repositories/sessao.repository');
const { gerarTokenSessao } = require('../../src/security/token');
const { authConfig } = require('../../src/config/auth');

/**
 * Troca de senha obrigatória (Gestão de Usuários): enquanto a identidade
 * estiver com senha PROVISÓRIA, os dois middlewares de sessão recusam tudo
 * com 403 TROCA_SENHA_OBRIGATORIA, exceto nas rotas montadas com
 * `permitirSenhaProvisoria` (sessão própria, troca de senha, logout). O
 * bloqueio é do servidor; o redirecionamento do navegador é só conforto.
 */

const TOKEN = gerarTokenSessao();
const BLOQUEIO = { status: 'error', codigo: 'TROCA_SENHA_OBRIGATORIA', message: 'Defina uma nova senha para continuar' };

const GLOBAL_PROVISORIA = Object.freeze({
  sessao: { id: '321', criadoEm: new Date('2026-10-05T10:00:00Z'), expiraEm: new Date('2026-10-05T22:00:00Z'), ultimoUsoEm: new Date('2026-10-05T10:30:00Z') },
  identidade: { id: 9, email: 'pessoa@example.invalid' },
  senhaProvisoria: true,
});
const GLOBAL_NORMAL = Object.freeze({ ...GLOBAL_PROVISORIA, senhaProvisoria: false });
const EMPRESARIAL_PROVISORIA = Object.freeze({
  sessao: { id: '555', criadoEm: new Date('2026-10-05T10:00:00Z'), expiraEm: new Date('2026-10-05T22:00:00Z'), ultimoUsoEm: new Date('2026-10-05T10:30:00Z') },
  usuario: { id: 7, nome: 'Pessoa', email: 'pessoa@example.invalid', perfil: 'USUARIO', identidadeId: 9 },
  empresa: { id: 42, nome: 'Empresa Teste', cnpj: '12345678000195' },
  senhaProvisoria: true,
});
const EMPRESARIAL_NORMAL = Object.freeze({ ...EMPRESARIAL_PROVISORIA, senhaProvisoria: false });

function appGlobal(middleware) {
  return criarAppTeste((app) => { app.get('/g', middleware, (req, res) => res.json({ identidade: req.identidade, sessao: req.sessaoGlobal })); });
}
function appEmpresarial(middleware) {
  return criarAppTeste((app) => { app.get('/e', middleware, (req, res) => res.json({ usuario: req.usuario, empresa: req.empresa })); });
}
const cookieGlobal = `${authConfig.sessao.cookieNomeGlobal}=${TOKEN}`;
const cookieEmpresarial = `${authConfig.sessao.cookieNome}=${TOKEN}`;

describe('exigirSessaoGlobal com senha provisória', () => {
  test('sessão válida com senha provisória: 403 TROCA_SENHA_OBRIGATORIA e nada do contexto chega à rota', async (t) => {
    t.mock.method(sessaoGlobalRepo, 'buscarValidaPorHash', async () => GLOBAL_PROVISORIA);
    const uso = t.mock.method(sessaoGlobalRepo, 'registrarUso', async () => true);
    const r = await request(appGlobal(criarExigirSessaoGlobal({ pool: {} }))).get('/g').set('Cookie', cookieGlobal);
    assert.equal(r.status, 403);
    assert.deepEqual(r.body, BLOQUEIO);
    assert.equal(uso.mock.calls.length, 1, 'a sessão continua válida e em uso; só a operação é recusada');
  });

  test('rota liberada (permitirSenhaProvisoria): passa, e req.identidade não carrega o estado para a rota decidir sozinha', async (t) => {
    t.mock.method(sessaoGlobalRepo, 'buscarValidaPorHash', async () => GLOBAL_PROVISORIA);
    t.mock.method(sessaoGlobalRepo, 'registrarUso', async () => true);
    const r = await request(appGlobal(criarExigirSessaoGlobal({ pool: {}, permitirSenhaProvisoria: true }))).get('/g').set('Cookie', cookieGlobal);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.identidade, { id: 9, email: 'pessoa@example.invalid' });
    assert.equal(r.body.sessao.id, '321');
  });

  test('sem senha provisória nada muda, com ou sem a liberação', async (t) => {
    t.mock.method(sessaoGlobalRepo, 'buscarValidaPorHash', async () => GLOBAL_NORMAL);
    t.mock.method(sessaoGlobalRepo, 'registrarUso', async () => true);
    for (const opcoes of [{ pool: {} }, { pool: {}, permitirSenhaProvisoria: true }]) {
      const r = await request(appGlobal(criarExigirSessaoGlobal(opcoes))).get('/g').set('Cookie', cookieGlobal);
      assert.equal(r.status, 200, JSON.stringify(opcoes));
    }
  });

  test('contexto antigo sem o campo (undefined) é tratado como senha definitiva', async (t) => {
    const { senhaProvisoria, ...semCampo } = GLOBAL_PROVISORIA;
    t.mock.method(sessaoGlobalRepo, 'buscarValidaPorHash', async () => semCampo);
    t.mock.method(sessaoGlobalRepo, 'registrarUso', async () => true);
    const r = await request(appGlobal(criarExigirSessaoGlobal({ pool: {} }))).get('/g').set('Cookie', cookieGlobal);
    assert.equal(r.status, 200);
  });
});

describe('exigirSessao (empresarial) com senha provisória', () => {
  test('sessão empresarial válida com a identidade em senha provisória: 403 TROCA_SENHA_OBRIGATORIA', async (t) => {
    t.mock.method(sessaoRepo, 'buscarValidaPorHash', async () => EMPRESARIAL_PROVISORIA);
    t.mock.method(sessaoRepo, 'registrarUso', async () => true);
    const r = await request(appEmpresarial(criarExigirSessao({ pool: {} }))).get('/e').set('Cookie', cookieEmpresarial);
    assert.equal(r.status, 403);
    assert.deepEqual(r.body, BLOQUEIO);
  });

  test('liberada explicitamente passa; sem provisória passa; o corpo nunca leva o estado dentro de usuario', async (t) => {
    t.mock.method(sessaoRepo, 'registrarUso', async () => true);
    const buscar = t.mock.method(sessaoRepo, 'buscarValidaPorHash', async () => EMPRESARIAL_PROVISORIA);
    const liberada = await request(appEmpresarial(criarExigirSessao({ pool: {}, permitirSenhaProvisoria: true }))).get('/e').set('Cookie', cookieEmpresarial);
    assert.equal(liberada.status, 200);
    assert.equal('senhaProvisoria' in liberada.body.usuario, false);
    buscar.mock.mockImplementation(async () => EMPRESARIAL_NORMAL);
    const normal = await request(appEmpresarial(criarExigirSessao({ pool: {} }))).get('/e').set('Cookie', cookieEmpresarial);
    assert.equal(normal.status, 200);
    assert.deepEqual(normal.body.usuario, EMPRESARIAL_NORMAL.usuario);
  });
});
