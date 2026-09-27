'use strict';

const { criarValidadorTurnstile } = require('../../../src/security/turnstile');
const { criarExigirTurnstile } = require('../../../src/middleware/turnstile');
const { criarTurnstileController } = require('../../../src/controllers/turnstile.controller');

/**
 * Turnstile das suítes de integração: validador e middleware reais, com um
 * Siteverify falso que só aprova TOKEN_TURNSTILE_TESTE. Nenhuma chamada sai
 * da máquina.
 */

const TOKEN_TURNSTILE_TESTE = 'XXXX.DUMMY.TOKEN.XXXX';

async function siteverifyDasSuites(url, opcoes) {
  const aprovado = new URLSearchParams(opcoes.body).get('response') === TOKEN_TURNSTILE_TESTE;
  const corpo = aprovado
    ? { success: true, 'error-codes': [], hostname: 'localhost', action: 'portal_login' }
    : { success: false, 'error-codes': ['invalid-input-response'] };
  return new Response(JSON.stringify(corpo), { status: 200, headers: { 'content-type': 'application/json' } });
}

function turnstileDeTeste() {
  const validador = criarValidadorTurnstile({
    secretKey: 'segredo-ficticio-das-suites',
    acao: 'portal_login',
    hostnamesPermitidos: ['localhost'],
    modoTeste: false,
    timeoutMs: 1000,
    fetch: siteverifyDasSuites,
  });
  return {
    exigirTurnstile: criarExigirTurnstile({ validador }),
    turnstileController: criarTurnstileController({ siteKey: '1x00000000000000000000AA', acao: 'portal_login' }),
  };
}

module.exports = { turnstileDeTeste, TOKEN_TURNSTILE_TESTE };
