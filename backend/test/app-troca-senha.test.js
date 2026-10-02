'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const app = require('../src/app');
const { exigirModulo } = require('./helpers/exigir-modulo');
const { httpConfig } = require('../src/config/http');
const { authConfig } = require('../src/config/auth');
const token = require('../src/security/token');
const sessaoGlobalRepo = require('../src/repositories/sessao-global.repository');
const sessaoPlataformaRepo = require('../src/repositories/sessao-plataforma.repository');

/**
 * Troca de senha autenticada no app real (Bloco 11E): as duas rotas montadas
 * em app.js, cada uma na cadeia do próprio portal. Sem banco: o service e a
 * leitura da sessão são substituídos; CORS, origem, política de conteúdo,
 * cabeçalhos de segurança, limitador e validação são os reais.
 */

const servicoGlobal = () => exigirModulo('src/services/troca-senha-global.service');
const servicoPlataforma = () => exigirModulo('src/services/troca-senha-plataforma.service');

const ORIGEM_CLIENTE = httpConfig.cors.origens[0];
const ORIGEM_PAINEL = httpConfig.plataforma.corsOrigens[0];
const SENHA_ATUAL = 'planeta-nebulosa-ozonio-42';
const SENHA_NOVA = 'girassol-quartzo-bussola-58';
const CODIGO = '123456';
const OK = { status: 'SENHA_ALTERADA' };

const PORTAL = '/api/auth/global/senha';
const PAINEL = '/api/plataforma/auth/senha';
const CORPO_PORTAL = { senhaAtual: SENHA_ATUAL, novaSenha: SENHA_NOVA };
const CORPO_PAINEL = { senhaAtual: SENHA_ATUAL, novaSenha: SENHA_NOVA, codigo: CODIGO };

const { cookieNomeGlobal: NOME_GLOBAL, cookieNome: NOME_EMPRESA, cookieNomeAdmin: NOME_ADMIN } = authConfig.sessao;
const TOKEN_GLOBAL = token.gerarTokenSessao();
const TOKEN_EMPRESARIAL = token.gerarTokenSessao();
const TOKEN_ADMIN = token.gerarTokenSessao();
const COOKIE_PORTAL = `${NOME_GLOBAL}=${TOKEN_GLOBAL}; ${NOME_EMPRESA}=${TOKEN_EMPRESARIAL}`;
const COOKIE_PAINEL = `${NOME_ADMIN}=${TOKEN_ADMIN}`;
const INSTANTE = new Date('2026-10-02T12:00:00.000Z');

/** Sessão global e administrativa "válidas", sem banco: o que o middleware real recebe do repositório. */
function sessoesFalsas(t) {
  const global = t.mock.method(sessaoGlobalRepo, 'buscarValidaPorHash', async () => ({
    sessao: { id: '7', criadoEm: INSTANTE, expiraEm: INSTANTE, ultimoUsoEm: INSTANTE },
    identidade: { id: 42, email: 'pessoa@example.invalid' },
  }));
  const globalUso = t.mock.method(sessaoGlobalRepo, 'registrarUso', async () => true);
  const plataforma = t.mock.method(sessaoPlataformaRepo, 'buscarValidaPorHash', async () => ({
    sessao: { id: '5', criadoEm: INSTANTE, expiraEm: INSTANTE, ultimoUsoEm: INSTANTE },
    administrador: { id: 9, email: 'admin@example.invalid' },
  }));
  const plataformaUso = t.mock.method(sessaoPlataformaRepo, 'registrarUso', async () => true);
  return {
    leituras: () => global.mock.calls.length + plataforma.mock.calls.length,
    usos: () => globalUso.mock.calls.length + plataformaUso.mock.calls.length,
  };
}

function servicosFalsos(t) {
  return {
    global: t.mock.method(servicoGlobal(), 'trocar', async () => OK),
    plataforma: t.mock.method(servicoPlataforma(), 'trocar', async () => OK),
  };
}

const postar = (caminho, origem, corpo, cookie) => {
  let r = request(app).post(caminho);
  if (origem !== undefined) r = r.set('Origin', origem);
  if (cookie !== undefined) r = r.set('Cookie', cookie);
  return r.send(corpo);
};
const setCookies = (r) => r.headers['set-cookie'] ?? [];

describe('app.js: as duas rotas da troca de senha existem, cada uma na cadeia do próprio portal', () => {
  test('Portal: sem cookie é 401 pela sessão real, sem tocar no banco nem no service', async (t) => {
    const servicos = servicosFalsos(t);
    const sessoes = sessoesFalsas(t);
    const r = await postar(PORTAL, ORIGEM_CLIENTE, CORPO_PORTAL);
    assert.deepEqual([r.status, r.body.codigo], [401, 'SESSAO_INVALIDA']);
    assert.deepEqual(setCookies(r), []);
    assert.equal(sessoes.leituras(), 0, 'sem cookie nem a leitura da sessão acontece');
    assert.equal(servicos.global.mock.calls.length, 0);
  });

  test('Portal: com a sessão global válida, 200 com o corpo fixo; o service recebe a identidade da sessão e os tokens dos cookies; nenhum cookie sai', async (t) => {
    const servicos = servicosFalsos(t);
    const sessoes = sessoesFalsas(t);
    const r = await postar(PORTAL, ORIGEM_CLIENTE, CORPO_PORTAL, COOKIE_PORTAL);

    assert.equal(r.status, 200);
    assert.deepEqual(r.body, OK);
    assert.deepEqual(setCookies(r), []);
    assert.equal(sessoes.usos(), 1, 'o uso da sessão é registrado pelo middleware de sempre');
    const [dados] = servicos.global.mock.calls.map((c) => c.arguments[1]);
    assert.deepEqual(
      [dados.identidadeId, dados.sessaoGlobalId, dados.tokenSessaoGlobal, dados.tokenSessaoEmpresarial, dados.senhaAtual, dados.novaSenha],
      [42, '7', TOKEN_GLOBAL, TOKEN_EMPRESARIAL, SENHA_ATUAL, SENHA_NOVA],
    );
    assert.equal(servicos.plataforma.mock.calls.length, 0);
  });

  test('Painel Privado: sem cookie é 401; com a sessão plena válida, 200 com o corpo fixo; o service recebe o administrador da sessão, o TOTP e o token do cookie; nenhum cookie sai', async (t) => {
    const servicos = servicosFalsos(t);
    const sessoes = sessoesFalsas(t);
    const semCookie = await postar(PAINEL, ORIGEM_PAINEL, CORPO_PAINEL);
    assert.deepEqual([semCookie.status, semCookie.body.codigo], [401, 'SESSAO_INVALIDA']);
    assert.equal(sessoes.leituras(), 0);

    const r = await postar(PAINEL, ORIGEM_PAINEL, CORPO_PAINEL, COOKIE_PAINEL);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, OK);
    assert.deepEqual(setCookies(r), []);
    const dados = servicos.plataforma.mock.calls[0].arguments[1];
    assert.deepEqual(
      [dados.administradorId, dados.sessaoId, dados.tokenSessao, dados.senhaAtual, dados.novaSenha, dados.codigo],
      [9, '5', TOKEN_ADMIN, SENHA_ATUAL, SENHA_NOVA, CODIGO],
    );
    assert.equal(servicos.global.mock.calls.length, 0);
  });

  test('os cookies não se misturam: o cookie do Painel não autentica no Portal, e o do Portal não autentica no Painel', async (t) => {
    const servicos = servicosFalsos(t);
    const sessoes = sessoesFalsas(t);
    const noPortal = await postar(PORTAL, ORIGEM_CLIENTE, CORPO_PORTAL, COOKIE_PAINEL);
    const noPainel = await postar(PAINEL, ORIGEM_PAINEL, CORPO_PAINEL, COOKIE_PORTAL);
    assert.deepEqual([noPortal.status, noPortal.body.codigo], [401, 'SESSAO_INVALIDA']);
    assert.deepEqual([noPainel.status, noPainel.body.codigo], [401, 'SESSAO_INVALIDA']);
    assert.equal(sessoes.leituras(), 0);
    assert.equal(servicos.global.mock.calls.length + servicos.plataforma.mock.calls.length, 0);
  });

  test('só a sessão empresarial no Portal não basta: a troca exige a sessão global', async (t) => {
    const servicos = servicosFalsos(t);
    const sessoes = sessoesFalsas(t);
    const r = await postar(PORTAL, ORIGEM_CLIENTE, CORPO_PORTAL, `${NOME_EMPRESA}=${TOKEN_EMPRESARIAL}`);
    assert.deepEqual([r.status, r.body.codigo], [401, 'SESSAO_INVALIDA']);
    assert.equal(sessoes.leituras(), 0);
    assert.equal(servicos.global.mock.calls.length, 0);
  });

  test('qualquer parâmetro na query dá 400 depois da sessão e antes do service, nas duas rotas', async (t) => {
    const servicos = servicosFalsos(t);
    sessoesFalsas(t);
    const portal = await postar(`${PORTAL}?a=1`, ORIGEM_CLIENTE, CORPO_PORTAL, COOKIE_PORTAL);
    const painel = await postar(`${PAINEL}?token=${TOKEN_ADMIN}`, ORIGEM_PAINEL, CORPO_PAINEL, COOKIE_PAINEL);
    assert.deepEqual([portal.status, portal.body.codigo], [400, 'VALIDACAO']);
    assert.deepEqual([painel.status, painel.body.codigo], [400, 'VALIDACAO']);
    assert.equal(JSON.stringify(painel.body).includes(TOKEN_ADMIN), false);
    assert.equal(servicos.global.mock.calls.length + servicos.plataforma.mock.calls.length, 0);
  });

  test('o caminho de um portal não existe na cadeia do outro: 404 nos dois sentidos', async (t) => {
    servicosFalsos(t);
    sessoesFalsas(t);
    const portalNoPainel = await postar('/api/plataforma/auth/global/senha', ORIGEM_PAINEL, CORPO_PORTAL, COOKIE_PAINEL);
    const painelNoPortal = await postar('/api/auth/senha', ORIGEM_CLIENTE, CORPO_PAINEL, COOKIE_PORTAL);
    assert.equal(portalNoPainel.status, 404);
    assert.equal(painelNoPortal.status, 404);
  });
});

describe('app.js: a troca de senha herda a cadeia do próprio portal', () => {
  test('origem permitida: CORS da origem certa com credenciais, no-store e cabeçalhos de segurança', async (t) => {
    servicosFalsos(t);
    sessoesFalsas(t);
    for (const [caminho, origem, corpo, cookie] of [[PORTAL, ORIGEM_CLIENTE, CORPO_PORTAL, COOKIE_PORTAL], [PAINEL, ORIGEM_PAINEL, CORPO_PAINEL, COOKIE_PAINEL]]) {
      const r = await postar(caminho, origem, corpo, cookie);
      assert.equal(r.status, 200, caminho);
      assert.equal(r.headers['access-control-allow-origin'], origem, caminho);
      assert.equal(r.headers['access-control-allow-credentials'], 'true', caminho);
      assert.equal(r.headers['cache-control'], 'no-store', caminho);
      assert.equal(r.headers['x-content-type-options'], 'nosniff', caminho);
    }
  });

  test('origem do outro portal, origem estranha ou ausente: 403 antes de qualquer sessão e de qualquer service', async (t) => {
    const servicos = servicosFalsos(t);
    const sessoes = sessoesFalsas(t);
    const casos = [
      [PORTAL, ORIGEM_PAINEL, CORPO_PORTAL, COOKIE_PORTAL],
      [PORTAL, 'http://mal.test', CORPO_PORTAL, COOKIE_PORTAL],
      [PORTAL, undefined, CORPO_PORTAL, COOKIE_PORTAL],
      [PAINEL, ORIGEM_CLIENTE, CORPO_PAINEL, COOKIE_PAINEL],
      [PAINEL, 'http://mal.test', CORPO_PAINEL, COOKIE_PAINEL],
      [PAINEL, undefined, CORPO_PAINEL, COOKIE_PAINEL],
    ];
    for (const [caminho, origem, corpo, cookie] of casos) {
      const r = await postar(caminho, origem, corpo, cookie);
      assert.equal(r.status, 403, `${caminho} ${origem}`);
      assert.match(r.body.codigo, /^ORIGEM_(NAO_PERMITIDA|AUSENTE)$/);
      assert.equal(r.headers['access-control-allow-origin'], undefined);
    }
    assert.equal(sessoes.leituras(), 0);
    assert.equal(servicos.global.mock.calls.length + servicos.plataforma.mock.calls.length, 0);
  });

  test('política de conteúdo: corpo que não é JSON é recusado com 415 antes da rota, nas duas', async (t) => {
    const servicos = servicosFalsos(t);
    sessoesFalsas(t);
    for (const [caminho, origem, cookie] of [[PORTAL, ORIGEM_CLIENTE, COOKIE_PORTAL], [PAINEL, ORIGEM_PAINEL, COOKIE_PAINEL]]) {
      const r = await request(app).post(caminho).set('Origin', origem).set('Cookie', cookie).set('content-type', 'text/plain').send(`senhaAtual=${SENHA_ATUAL}`);
      assert.equal(r.status, 415, caminho);
    }
    assert.equal(servicos.global.mock.calls.length + servicos.plataforma.mock.calls.length, 0);
  });
});
