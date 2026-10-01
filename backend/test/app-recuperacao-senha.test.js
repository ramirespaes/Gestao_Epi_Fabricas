'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const app = require('../src/app');
const recuperacaoSenhaService = require('../src/services/recuperacao-senha.service');
const cookies = require('../src/security/cookie');
const { turnstileConfig } = require('../src/config/turnstile');
const { httpConfig } = require('../src/config/http');

/**
 * Recuperação de senha no app real (Bloco 11D): as rotas montadas em app.js,
 * cada uma na cadeia do próprio portal. Sem banco: o service é substituído.
 * O Siteverify do Turnstile é um fetch falso; com as chaves oficiais de
 * teste do ambiente da suíte, `success: true` basta.
 */

const ORIGEM_CLIENTE = httpConfig.cors.origens[0];
const ORIGEM_PAINEL = httpConfig.plataforma.corsOrigens[0];
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE';
const SENHA = 'girassol-quartzo-bussola-58';
const EMAIL = 'pessoa@example.invalid';
const RESPOSTA = { status: 'SOLICITACAO_RECEBIDA' };

const PORTAL = '/api/auth/global/recuperacao-senha';
const PAINEL = '/api/plataforma/auth/recuperacao-senha';

function servicoFalso(t) {
  return {
    solicitar: t.mock.method(recuperacaoSenhaService, 'solicitar', async () => recuperacaoSenhaService.RESPOSTA_SOLICITACAO),
    redefinir: t.mock.method(recuperacaoSenhaService, 'redefinir', async () => ({ status: 'SENHA_REDEFINIDA' })),
  };
}

const turnstileAprovado = (t) => t.mock.method(globalThis, 'fetch', async () => new Response(
  JSON.stringify({ success: true, 'error-codes': [] }), { status: 200, headers: { 'content-type': 'application/json' } },
));

const postar = (caminho, origem, corpo) => {
  const r = request(app).post(caminho);
  return (origem === undefined ? r : r.set('Origin', origem)).send(corpo);
};
const setCookies = (r) => r.headers['set-cookie'] ?? [];

describe('app.js: as rotas da recuperação de senha existem', () => {
  test('Portal: solicitar e redefinir estão montadas (corpo vazio dá 400 de validação, não 404)', async (t) => {
    const servico = servicoFalso(t);
    for (const rota of ['solicitar', 'redefinir']) {
      const r = await postar(`${PORTAL}/${rota}`, ORIGEM_CLIENTE, {});
      assert.equal(r.status, 400, rota);
      assert.equal(r.body.codigo, 'VALIDACAO', rota);
    }
    assert.equal(servico.solicitar.mock.calls.length + servico.redefinir.mock.calls.length, 0);
  });

  test('Portal: GET da configuração do Turnstile da recuperação devolve só status, siteKey e action própria', async () => {
    const r = await request(app).get(`${PORTAL}/turnstile`).set('Origin', ORIGEM_CLIENTE);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { status: 'ok', siteKey: turnstileConfig.portal.siteKey, action: 'portal_recuperacao_senha' });
    assert.equal(JSON.stringify(r.body).includes(turnstileConfig.portal.secretKey), false);
  });

  test('o endpoint do Turnstile do login continua com a action do login', async () => {
    const r = await request(app).get('/api/auth/global/turnstile').set('Origin', ORIGEM_CLIENTE);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { status: 'ok', siteKey: turnstileConfig.portal.siteKey, action: 'portal_login' });
  });

  test('Painel Privado: solicitar e redefinir estão montadas; não há rota de Turnstile', async (t) => {
    const servico = servicoFalso(t);
    for (const rota of ['solicitar', 'redefinir']) {
      const r = await postar(`${PAINEL}/${rota}`, ORIGEM_PAINEL, {});
      assert.equal(r.status, 400, rota);
      assert.equal(r.body.codigo, 'VALIDACAO', rota);
    }
    assert.equal((await request(app).get(`${PAINEL}/turnstile`).set('Origin', ORIGEM_PAINEL)).status, 404);
    assert.equal(servico.solicitar.mock.calls.length + servico.redefinir.mock.calls.length, 0);
  });

  test('não existe rota com token no caminho nem leitura de token por GET', async (t) => {
    servicoFalso(t);
    for (const [base, origem] of [[PORTAL, ORIGEM_CLIENTE], [PAINEL, ORIGEM_PAINEL]]) {
      assert.equal((await postar(`${base}/redefinir/${TOKEN}`, origem, { novaSenha: SENHA })).status, 404);
      assert.equal((await request(app).get(`${base}/redefinir?token=${TOKEN}`).set('Origin', origem)).status, 404);
      const naQuery = await postar(`${base}/redefinir?token=${TOKEN}`, origem, { novaSenha: SENHA });
      assert.deepEqual([naQuery.status, naQuery.body.codigo], [400, 'VALIDACAO']);
      assert.equal(JSON.stringify(naQuery.body).includes(TOKEN), false);
    }
  });

  test('as quatro POST do app real exigem query string vazia: qualquer parâmetro dá 400, mesmo com o corpo correto', async (t) => {
    const servico = servicoFalso(t);
    const fetch = turnstileAprovado(t);
    const casos = [
      [`${PORTAL}/solicitar`, ORIGEM_CLIENTE, { email: EMAIL, turnstileToken: 'token-do-widget' }],
      [`${PORTAL}/redefinir`, ORIGEM_CLIENTE, { token: TOKEN, novaSenha: SENHA }],
      [`${PAINEL}/solicitar`, ORIGEM_PAINEL, { email: 'admin@example.invalid' }],
      [`${PAINEL}/redefinir`, ORIGEM_PAINEL, { token: TOKEN, novaSenha: SENHA }],
    ];
    for (const [caminho, origem, corpo] of casos) {
      for (const query of ['a=1', `token=${TOKEN}`]) {
        const r = await postar(`${caminho}?${query}`, origem, corpo);
        assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], `${caminho}?${query.split('=')[0]}`);
      }
    }
    assert.equal(fetch.mock.calls.length + servico.solicitar.mock.calls.length + servico.redefinir.mock.calls.length, 0);
  });
});

describe('app.js: fluxo público, sem sessão', () => {
  test('Portal: solicitação com Turnstile aprovado responde 202 com o corpo genérico, sem cookie e sem exigir sessão', async (t) => {
    const servico = servicoFalso(t);
    const fetch = turnstileAprovado(t);
    const r = await postar(`${PORTAL}/solicitar`, ORIGEM_CLIENTE, { email: EMAIL, turnstileToken: 'token-do-widget' });

    assert.equal(r.status, 202);
    assert.deepEqual(r.body, RESPOSTA);
    assert.deepEqual(setCookies(r), []);
    assert.equal(fetch.mock.calls.length, 1);
    assert.equal(servico.solicitar.mock.calls[0].arguments[1].escopo, 'PORTAL');
  });

  test('Portal: Turnstile recusado ou indisponível bloqueia antes do service', async (t) => {
    const servico = servicoFalso(t);
    t.mock.method(console, 'warn', () => {});
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ success: false, 'error-codes': ['invalid-input-response'] }), { status: 200 }));
    assert.equal((await postar(`${PORTAL}/solicitar`, ORIGEM_CLIENTE, { email: EMAIL, turnstileToken: 'token-do-widget' })).status, 403);
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('rede fora'); });
    assert.equal((await postar(`${PORTAL}/solicitar`, ORIGEM_CLIENTE, { email: EMAIL, turnstileToken: 'token-do-widget' })).status, 503);
    assert.equal(servico.solicitar.mock.calls.length, 0);
  });

  test('Portal: reset responde 200 e remove os cookies global e empresarial', async (t) => {
    const servico = servicoFalso(t);
    const r = await postar(`${PORTAL}/redefinir`, ORIGEM_CLIENTE, { token: TOKEN, novaSenha: SENHA });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { status: 'SENHA_REDEFINIDA' });
    assert.deepEqual([...setCookies(r)].sort(), [cookies.serializarRemocaoCookieSessaoGlobal(), cookies.serializarRemocaoCookieSessao()].sort());
    assert.equal(servico.redefinir.mock.calls[0].arguments[1].escopo, 'PORTAL');
  });

  test('Painel Privado: solicitação responde 202 sem chamar o Turnstile, e o reset remove os cookies administrativo e do desafio MFA', async (t) => {
    const servico = servicoFalso(t);
    const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('o Painel não chama o Turnstile'); });

    const solicitada = await postar(`${PAINEL}/solicitar`, ORIGEM_PAINEL, { email: 'admin@example.invalid' });
    assert.deepEqual([solicitada.status, solicitada.body, setCookies(solicitada)], [202, RESPOSTA, []]);
    assert.equal(fetch.mock.calls.length, 0);
    assert.equal(servico.solicitar.mock.calls[0].arguments[1].escopo, 'PLATAFORMA');

    const redefinida = await postar(`${PAINEL}/redefinir`, ORIGEM_PAINEL, { token: TOKEN, novaSenha: SENHA });
    assert.deepEqual([redefinida.status, redefinida.body], [200, { status: 'SENHA_REDEFINIDA' }]);
    assert.deepEqual([...setCookies(redefinida)].sort(), [cookies.serializarRemocaoCookieSessaoPlataforma(), cookies.serializarRemocaoCookieDesafioMfa()].sort());
    assert.equal(servico.redefinir.mock.calls[0].arguments[1].escopo, 'PLATAFORMA');
  });
});

describe('app.js: as rotas herdam a cadeia do próprio portal', () => {
  test('origem permitida: resposta com CORS da origem certa, credenciais, no-store e cabeçalhos de segurança', async (t) => {
    servicoFalso(t);
    const casos = [
      [`${PORTAL}/redefinir`, ORIGEM_CLIENTE],
      [`${PAINEL}/redefinir`, ORIGEM_PAINEL],
    ];
    for (const [caminho, origem] of casos) {
      const r = await postar(caminho, origem, { token: TOKEN, novaSenha: SENHA });
      assert.equal(r.status, 200, caminho);
      assert.equal(r.headers['access-control-allow-origin'], origem, caminho);
      assert.equal(r.headers['access-control-allow-credentials'], 'true', caminho);
      assert.equal(r.headers['cache-control'], 'no-store', caminho);
      assert.equal(r.headers['x-content-type-options'], 'nosniff', caminho);
    }
  });

  test('origem do outro portal, origem estranha ou ausente: 403 antes de qualquer rota, sem chamar o service', async (t) => {
    const servico = servicoFalso(t);
    const casos = [
      [`${PORTAL}/solicitar`, ORIGEM_PAINEL, { email: EMAIL, turnstileToken: 'token-do-widget' }],
      [`${PORTAL}/redefinir`, ORIGEM_PAINEL, { token: TOKEN, novaSenha: SENHA }],
      [`${PORTAL}/redefinir`, 'http://mal.test', { token: TOKEN, novaSenha: SENHA }],
      [`${PORTAL}/redefinir`, undefined, { token: TOKEN, novaSenha: SENHA }],
      [`${PAINEL}/solicitar`, ORIGEM_CLIENTE, { email: 'admin@example.invalid' }],
      [`${PAINEL}/redefinir`, ORIGEM_CLIENTE, { token: TOKEN, novaSenha: SENHA }],
      [`${PAINEL}/redefinir`, undefined, { token: TOKEN, novaSenha: SENHA }],
    ];
    for (const [caminho, origem, corpo] of casos) {
      const r = await postar(caminho, origem, corpo);
      assert.equal(r.status, 403, `${caminho} ${origem}`);
      assert.match(r.body.codigo, /^ORIGEM_(NAO_PERMITIDA|AUSENTE)$/);
      assert.equal(r.headers['access-control-allow-origin'], undefined);
    }
    assert.equal(servico.solicitar.mock.calls.length + servico.redefinir.mock.calls.length, 0);
  });

  test('política de conteúdo: corpo que não é JSON é recusado com 415 antes da rota', async (t) => {
    const servico = servicoFalso(t);
    for (const [caminho, origem] of [[`${PORTAL}/redefinir`, ORIGEM_CLIENTE], [`${PAINEL}/redefinir`, ORIGEM_PAINEL]]) {
      const r = await request(app).post(caminho).set('Origin', origem).set('content-type', 'text/plain').send(`token=${TOKEN}`);
      assert.equal(r.status, 415, caminho);
    }
    assert.equal(servico.redefinir.mock.calls.length, 0);
  });
});
