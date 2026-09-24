'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const EpiHttp = require('../js/api-http');

/**
 * Sigilo do token de convite no frontend (correção pós-auditoria do
 * Pacote 3, item 1): o aceite envia o token SÓ em corpo JSON (POST). Este
 * teste prova, com fetch injetado e console interceptado, que o cliente
 * HTTP registra método e caminho mas NUNCA o corpo — logo o token não
 * alcança o console do navegador.
 */

const TOKEN = 'Zm9ybWF0b2Jhc2U2NHVybGRldG9rZW5jb21fNDNjaGFy'.slice(0, 43);

test('POST /convite-master/consultar com token no corpo: URL sem token, log sem token', async (t) => {
  const logs = [];
  t.mock.method(console, 'log', (...a) => { logs.push(a.join(' ')); });
  const chamadas = [];
  EpiHttp.configurar({
    baseUrl: 'http://localhost:3000/api/plataforma',
    fetch: async (url, opcoes) => { chamadas.push({ url, opcoes }); return { ok: true, status: 200, text: async () => '{"status":"ok"}' }; },
  });

  const r = await EpiHttp.requisitar('POST', '/convite-master/consultar', { corpo: { token: TOKEN } });
  assert.equal(r.ok, true);
  assert.equal(chamadas[0].url.includes(TOKEN), false, 'o token não vai na URL');
  assert.equal(JSON.parse(chamadas[0].opcoes.body).token, TOKEN, 'o token vai no corpo');
  assert.ok(logs.some((l) => l.includes('/convite-master/consultar')), 'o caminho é registrado');
  assert.equal(logs.join('\n').includes(TOKEN), false, 'o corpo (e o token) nunca vão para o console');

  EpiHttp.configurar({ fetch: null });
});
