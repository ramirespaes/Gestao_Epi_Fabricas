'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

/**
 * Privacidade e LGPD (integração da página, V2): a resposta de GET /api/lgpd/resumo, autenticada ou não, nunca pode ser
 * armazenada em cache (dados empresariais protegidos). A política é a do namespace /api (middleware/cabecalhos.js, semCache);
 * este teste prova que ela cobre a rota real montada em app.js, sem banco (401 antes de qualquer consulta).
 */
describe('GET /api/lgpd/resumo — política de cache', () => {
  test('a resposta traz Cache-Control: no-store, mesmo no 401', async () => {
    const app = require('../../src/app'); // eslint-disable-line global-require
    const r = await request(app).get('/api/lgpd/resumo').set('Origin', 'http://localhost:5500');
    assert.equal(r.status, 401);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
  });
});
