'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { criarAppTeste } = require('../helpers/app-teste');
const { criarVerificarHostPlataforma } = require('../../src/middleware/host-plataforma');

/**
 * host-plataforma.js é defesa em profundidade (adendo v2.1): quando
 * PLATAFORMA_HOST não está definido (host: null), não recusa nada — não há
 * subdomínio real ainda. Quando definido, só aquele host exato passa.
 */

function montarApp(middleware) {
  return criarAppTeste((app) => app.get('/rota', middleware, (req, res) => res.json({ ok: true })));
}

describe('criarVerificarHostPlataforma', () => {
  test('host null: nunca recusa, qualquer Host passa', async () => {
    const middleware = criarVerificarHostPlataforma({ host: null });
    for (const host of ['admin.safework.com.br', 'localhost', 'qualquer.coisa']) {
      const resposta = await request(montarApp(middleware)).get('/rota').set('Host', host);
      assert.equal(resposta.status, 200, host);
    }
  });

  test('host definido: só o host exato passa, qualquer outro é 404', async () => {
    const middleware = criarVerificarHostPlataforma({ host: 'admin.safework.com.br' });

    const certo = await request(montarApp(middleware)).get('/rota').set('Host', 'admin.safework.com.br');
    assert.equal(certo.status, 200);

    const errado = await request(montarApp(middleware)).get('/rota').set('Host', 'app.safework.com.br');
    assert.equal(errado.status, 404);
  });

  test('recusa host em opções fora do contrato (nem string nem null)', () => {
    assert.throws(() => criarVerificarHostPlataforma({ host: 123 }), TypeError);
    assert.throws(() => criarVerificarHostPlataforma({ host: undefined }), TypeError);
  });
});
