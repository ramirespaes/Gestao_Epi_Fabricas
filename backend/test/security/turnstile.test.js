'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { criarValidadorTurnstile, SITEVERIFY_URL } = require('../../src/security/turnstile');

const SECRET = '0x4AAAAAAAsegredoFicticioParaTeste000';
const TOKEN = 'token-de-teste.abc_DEF-123';
const HOSTNAME = 'epi.exemplo.com.br';

function fetchFalso(responder) {
  const chamadas = [];
  const fn = async (url, opcoes) => {
    chamadas.push({ url, opcoes });
    return responder(url, opcoes);
  };
  fn.chamadas = chamadas;
  return fn;
}

const json = (corpo, status = 200) => () => new Response(typeof corpo === 'string' ? corpo : JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json' } });
const sucesso = (extra = {}) => json({ success: true, 'error-codes': [], challenge_ts: '2026-09-27T12:00:00.000Z', hostname: HOSTNAME, action: 'portal_login', cdata: '', ...extra });

function validador(fetch, opcoes = {}) {
  return criarValidadorTurnstile({
    secretKey: SECRET, acao: 'portal_login', hostnamesPermitidos: [HOSTNAME], modoTeste: false, timeoutMs: 1000, fetch, ...opcoes,
  });
}

function capturarConsole(t) {
  const linhas = [];
  for (const metodo of ['log', 'info', 'warn', 'error', 'debug']) {
    t.mock.method(console, metodo, (...args) => { linhas.push({ metodo, args }); });
  }
  return linhas;
}

describe('validador do Turnstile (Siteverify)', () => {
  test('sucesso, action esperada e hostname permitido: VALIDO; POST no endereço fixo com secret, token e IP no corpo', async () => {
    const fetch = fetchFalso(sucesso());
    const r = await validador(fetch).verificar({ token: TOKEN, ip: '203.0.113.7' });
    assert.deepEqual(r, { resultado: 'VALIDO' });

    assert.equal(fetch.chamadas.length, 1);
    const [{ url, opcoes }] = fetch.chamadas;
    assert.equal(url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
    assert.equal(SITEVERIFY_URL, url);
    assert.equal(opcoes.method, 'POST');
    assert.equal(opcoes.redirect, 'error');
    assert.ok(opcoes.signal instanceof AbortSignal);
    const corpo = new URLSearchParams(opcoes.body);
    assert.deepEqual([...corpo.keys()].sort(), ['remoteip', 'response', 'secret']);
    assert.deepEqual([corpo.get('secret'), corpo.get('response'), corpo.get('remoteip')], [SECRET, TOKEN, '203.0.113.7']);
  });

  test('IP ausente ou que não é endereço IP não é enviado', async () => {
    for (const ip of [undefined, null, '', 'não-é-ip', '::ffff:999.1.1.1']) {
      const fetch = fetchFalso(sucesso());
      await validador(fetch).verificar({ token: TOKEN, ip });
      assert.equal(new URLSearchParams(fetch.chamadas[0].opcoes.body).has('remoteip'), false, String(ip));
    }
  });

  test('success false: INVALIDO', async () => {
    for (const codigos of [['invalid-input-response'], ['timeout-or-duplicate'], ['missing-input-response'], ['bad-request'], []]) {
      const r = await validador(fetchFalso(json({ success: false, 'error-codes': codigos }))).verificar({ token: TOKEN });
      assert.deepEqual(r, { resultado: 'INVALIDO' }, codigos.join());
    }
  });

  test('action diferente de portal_login: INVALIDO', async () => {
    for (const action of ['outra_acao', 'portal_login ', 'PORTAL_LOGIN', 'test', '']) {
      const r = await validador(fetchFalso(sucesso({ action }))).verificar({ token: TOKEN });
      assert.deepEqual(r, { resultado: 'INVALIDO' }, action);
    }
  });

  test('hostname fora da lista exata: INVALIDO (sem sufixo, subdomínio ou curinga)', async () => {
    for (const hostname of ['mal.test', `${HOSTNAME}.mal.test`, `sub.${HOSTNAME}`, 'exemplo.com.br', `x${HOSTNAME}`, '']) {
      const r = await validador(fetchFalso(sucesso({ hostname }))).verificar({ token: TOKEN });
      assert.deepEqual(r, { resultado: 'INVALIDO' }, hostname);
    }
  });

  test('HTTP não-2xx: INDISPONIVEL (fail-closed)', async () => {
    for (const status of [400, 403, 429, 500, 502, 503]) {
      const r = await validador(fetchFalso(json({ success: true, action: 'portal_login', hostname: HOSTNAME }, status))).verificar({ token: TOKEN });
      assert.deepEqual(r, { resultado: 'INDISPONIVEL' }, String(status));
    }
  });

  test('timeout: a chamada é abortada e o resultado é INDISPONIVEL', async () => {
    let sinal;
    const fetch = fetchFalso((url, opcoes) => new Promise((resolve, reject) => {
      sinal = opcoes.signal;
      opcoes.signal.addEventListener('abort', () => reject(opcoes.signal.reason));
    }));
    const inicio = Date.now();
    const r = await validador(fetch, { timeoutMs: 30 }).verificar({ token: TOKEN });
    assert.deepEqual(r, { resultado: 'INDISPONIVEL' });
    assert.equal(sinal.aborted, true);
    assert.ok(Date.now() - inicio < 1000);
  });

  test('erro de rede: INDISPONIVEL', async () => {
    const fetch = fetchFalso(() => { throw new TypeError('fetch failed'); });
    assert.deepEqual(await validador(fetch).verificar({ token: TOKEN }), { resultado: 'INDISPONIVEL' });
  });

  test('JSON inválido ou resposta malformada: INDISPONIVEL', async () => {
    const respostas = [
      json('não é json'),
      json(''),
      json('null'),
      json('[]'),
      json({ success: 'true', action: 'portal_login', hostname: HOSTNAME }),
      json({ success: true, hostname: HOSTNAME }),
      json({ success: true, action: 'portal_login' }),
      json({ success: true, action: 'portal_login', hostname: ['epi.exemplo.com.br'] }),
      json(JSON.stringify({ success: true, action: 'portal_login', hostname: HOSTNAME, sobra: 'x'.repeat(20000) })),
    ];
    for (const responder of respostas) {
      assert.deepEqual(await validador(fetchFalso(responder)).verificar({ token: TOKEN }), { resultado: 'INDISPONIVEL' });
    }
  });

  test('erro de configuração ou interno da Cloudflare: INDISPONIVEL, não INVALIDO', async () => {
    for (const codigo of ['missing-input-secret', 'invalid-input-secret', 'internal-error']) {
      const r = await validador(fetchFalso(json({ success: false, 'error-codes': [codigo] }))).verificar({ token: TOKEN });
      assert.deepEqual(r, { resultado: 'INDISPONIVEL' }, codigo);
    }
  });

  test('token fora do contrato é INVALIDO antes da rede', async () => {
    const fetch = fetchFalso(sucesso());
    for (const token of [undefined, null, '', 123, ['x'], { t: 'x' }, 'a'.repeat(2049)]) {
      assert.deepEqual(await validador(fetch).verificar({ token }), { resultado: 'INVALIDO' });
    }
    assert.equal(fetch.chamadas.length, 0);
  });

  test('modo de teste (chaves oficiais de teste, nunca em production): exige a action fixa "test" e não confere hostname', async () => {
    const teste = (extra) => validador(fetchFalso(sucesso(extra)), { modoTeste: true, hostnamesPermitidos: ['localhost'] });
    assert.deepEqual(await teste({ action: 'test', hostname: 'localhost' }).verificar({ token: TOKEN }), { resultado: 'VALIDO' });
    assert.deepEqual(await teste({ action: 'test', hostname: 'example.com' }).verificar({ token: TOKEN }), { resultado: 'VALIDO' });
    assert.deepEqual(await teste({ action: 'outra', hostname: 'localhost' }).verificar({ token: TOKEN }), { resultado: 'INVALIDO' });
    assert.deepEqual(await teste({ success: false, 'error-codes': ['invalid-input-response'] }).verificar({ token: TOKEN }), { resultado: 'INVALIDO' });
    assert.deepEqual(
      await validador(fetchFalso(sucesso({ action: 'test' }))).verificar({ token: TOKEN }),
      { resultado: 'INVALIDO' },
      'fora do modo de teste, "test" não é a action esperada',
    );
  });

  test('nenhuma saída de console leva token, secret ou a resposta da Cloudflare; só a indisponibilidade gera uma linha mínima', async (t) => {
    const linhas = capturarConsole(t);
    await validador(fetchFalso(sucesso())).verificar({ token: TOKEN, ip: '203.0.113.7' });
    await validador(fetchFalso(json({ success: false, 'error-codes': ['invalid-input-response'] }))).verificar({ token: TOKEN });
    await validador(fetchFalso(sucesso({ hostname: 'mal.test' }))).verificar({ token: TOKEN });
    assert.equal(linhas.length, 0, 'falha provocável pelo cliente não gera log');

    await validador(fetchFalso(json({ success: true }, 500))).verificar({ token: TOKEN });
    await validador(fetchFalso(() => { throw new TypeError('fetch failed'); })).verificar({ token: TOKEN });
    assert.equal(linhas.length, 2);
    for (const { args } of linhas) {
      assert.match(args[0], /^\[turnstile\]/);
      const texto = JSON.stringify(args);
      for (const proibido of [TOKEN, SECRET, '203.0.113.7', 'error-codes', 'fetch failed']) {
        assert.equal(texto.includes(proibido), false, proibido);
      }
    }
  });

  test('construção sem secret, sem fetch, com timeout inválido ou sem hostnames fora do modo de teste é erro de programação', () => {
    const base = { secretKey: SECRET, acao: 'portal_login', hostnamesPermitidos: [HOSTNAME], modoTeste: false, timeoutMs: 1000, fetch: async () => {} };
    for (const ruim of [{ secretKey: '' }, { fetch: undefined }, { timeoutMs: 0 }, { timeoutMs: 60000 }, { hostnamesPermitidos: [] }, { acao: '' }]) {
      assert.throws(() => criarValidadorTurnstile({ ...base, ...ruim }), TypeError, JSON.stringify(Object.keys(ruim)));
    }
  });
});
