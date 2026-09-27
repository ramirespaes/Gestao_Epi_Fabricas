'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const util = require('node:util');

const { carregarConfigTurnstile, turnstileConfig, ACAO_PORTAL_LOGIN } = require('../../src/config/turnstile');

// Chaves públicas de teste da Cloudflare (documentação oficial), não segredos.
const SITE_TESTE_SUCESSO = '1x00000000000000000000AA';
const SECRET_TESTE_SUCESSO = '1x0000000000000000000000000000000AA';
const SITE_TESTE_FALHA = '2x00000000000000000000AB';
const SECRET_TESTE_FALHA = '2x0000000000000000000000000000000AA';

// Valores fictícios com formato de chave real; nunca foram chaves válidas.
const SITE_FICTICIA = '0x4AAAAAAAsiteFicticiaParaTeste';
const SECRET_FICTICIA = '0x4AAAAAAAsegredoFicticioParaTeste000';

const CORS_PRODUCAO = ['https://epi.exemplo.com.br', 'https://www.exemplo.com.br:8443'];

const producao = (extra) => ({ NODE_ENV: 'production', ...extra });
const carregar = (origem, corsOrigens = ['http://localhost:5500']) => carregarConfigTurnstile(origem, { corsOrigens });

function recusa(origem, nomeVariavel, valoresQueNaoPodemAparecer = [], corsOrigens = CORS_PRODUCAO) {
  assert.throws(() => carregar(origem, corsOrigens), (erro) => {
    assert.match(erro.message, /^Configuração do Turnstile inválida/);
    assert.ok(erro.message.includes(nomeVariavel), erro.message);
    for (const valor of valoresQueNaoPodemAparecer) assert.equal(erro.message.includes(valor), false, 'valor recebido no erro');
    return true;
  });
}

describe('configuração do Turnstile do Portal', () => {
  test('development/test sem variáveis: chaves oficiais de teste, action portal_login e hostnames das origens do cliente', () => {
    for (const ambiente of ['development', 'test']) {
      const { portal } = carregar({ NODE_ENV: ambiente }, ['http://localhost:5500', 'http://127.0.0.1:5500']);
      assert.equal(portal.siteKey, SITE_TESTE_SUCESSO);
      assert.equal(portal.secretKey, SECRET_TESTE_SUCESSO);
      assert.equal(portal.modoTeste, true);
      assert.equal(portal.acao, 'portal_login');
      assert.deepEqual(portal.hostnamesPermitidos, ['localhost', '127.0.0.1']);
    }
    assert.equal(ACAO_PORTAL_LOGIN, 'portal_login');
  });

  test('a configuração carregada pela aplicação na suíte usa as chaves de teste', () => {
    assert.equal(turnstileConfig.portal.modoTeste, true);
    assert.equal(turnstileConfig.portal.siteKey, SITE_TESTE_SUCESSO);
  });

  test('production sem site key ou sem secret: falha na subida, citando só o nome da variável', () => {
    recusa(producao({ TURNSTILE_PORTAL_SECRET_KEY: SECRET_FICTICIA }), 'TURNSTILE_PORTAL_SITE_KEY', [SECRET_FICTICIA]);
    recusa(producao({ TURNSTILE_PORTAL_SITE_KEY: SITE_FICTICIA }), 'TURNSTILE_PORTAL_SECRET_KEY', [SITE_FICTICIA]);
    recusa(producao({}), 'TURNSTILE_PORTAL_SITE_KEY');
  });

  test('production com chave oficial de teste (site ou secret) é recusada, sem ecoar o valor', () => {
    recusa(producao({ TURNSTILE_PORTAL_SITE_KEY: SITE_TESTE_SUCESSO, TURNSTILE_PORTAL_SECRET_KEY: SECRET_FICTICIA }), 'TURNSTILE_PORTAL_SITE_KEY', [SITE_TESTE_SUCESSO, SECRET_FICTICIA]);
    recusa(producao({ TURNSTILE_PORTAL_SITE_KEY: SITE_FICTICIA, TURNSTILE_PORTAL_SECRET_KEY: SECRET_TESTE_SUCESSO }), 'TURNSTILE_PORTAL_SECRET_KEY', [SECRET_TESTE_SUCESSO]);
    recusa(producao({ TURNSTILE_PORTAL_SITE_KEY: SITE_TESTE_FALHA, TURNSTILE_PORTAL_SECRET_KEY: SECRET_TESTE_FALHA }), 'TURNSTILE_PORTAL_SECRET_KEY', [SECRET_TESTE_FALHA]);
  });

  test('production com as duas chaves: sem modo de teste e com os hostnames exatos das origens do cliente', () => {
    const { portal } = carregar(producao({ TURNSTILE_PORTAL_SITE_KEY: SITE_FICTICIA, TURNSTILE_PORTAL_SECRET_KEY: SECRET_FICTICIA }), CORS_PRODUCAO);
    assert.equal(portal.modoTeste, false);
    assert.equal(portal.siteKey, SITE_FICTICIA);
    assert.equal(portal.secretKey, SECRET_FICTICIA);
    assert.deepEqual(portal.hostnamesPermitidos, ['epi.exemplo.com.br', 'www.exemplo.com.br']);
  });

  test('fora de production, as duas chaves vêm juntas e do mesmo tipo (teste ou não)', () => {
    recusa({ NODE_ENV: 'development', TURNSTILE_PORTAL_SITE_KEY: SITE_FICTICIA }, 'TURNSTILE_PORTAL_SECRET_KEY', [SITE_FICTICIA]);
    recusa({ NODE_ENV: 'development', TURNSTILE_PORTAL_SECRET_KEY: SECRET_FICTICIA }, 'TURNSTILE_PORTAL_SITE_KEY', [SECRET_FICTICIA]);
    recusa({ NODE_ENV: 'development', TURNSTILE_PORTAL_SITE_KEY: SITE_TESTE_SUCESSO, TURNSTILE_PORTAL_SECRET_KEY: SECRET_FICTICIA }, 'TURNSTILE_PORTAL_SECRET_KEY', [SECRET_FICTICIA]);
    const { portal } = carregar({ NODE_ENV: 'development', TURNSTILE_PORTAL_SITE_KEY: SITE_FICTICIA, TURNSTILE_PORTAL_SECRET_KEY: SECRET_FICTICIA });
    assert.equal(portal.modoTeste, false);
  });

  test('formato inválido é recusado sem ecoar o valor', () => {
    for (const ruim of ['curta', 'com espaço no meio 000000', 'x'.repeat(256), 'aspas"<script>000000']) {
      recusa(producao({ TURNSTILE_PORTAL_SITE_KEY: ruim, TURNSTILE_PORTAL_SECRET_KEY: SECRET_FICTICIA }), 'TURNSTILE_PORTAL_SITE_KEY', [ruim, SECRET_FICTICIA]);
    }
  });

  test('a secret não aparece ao serializar ou inspecionar a configuração, e nada pode ser alterado', () => {
    const config = carregar(producao({ TURNSTILE_PORTAL_SITE_KEY: SITE_FICTICIA, TURNSTILE_PORTAL_SECRET_KEY: SECRET_FICTICIA }), CORS_PRODUCAO);
    assert.equal(JSON.stringify(config).includes(SECRET_FICTICIA), false);
    assert.equal(util.inspect(config, { depth: null }).includes(SECRET_FICTICIA), false);
    assert.equal(Object.keys(config.portal).includes('secretKey'), false);
    assert.ok(Object.isFrozen(config.portal));
    assert.throws(() => { config.portal.secretKey = 'outra'; }, TypeError);
    assert.throws(() => { config.portal.hostnamesPermitidos.push('mal.test'); }, TypeError);
  });
});
