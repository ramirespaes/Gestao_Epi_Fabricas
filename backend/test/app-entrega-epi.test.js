'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

/**
 * As rotas da entrega de EPI e da ficha estão montadas no app real, sob /api
 * e atrás da cadeia global: sem sessão, cada uma responde 401 (nunca 404,
 * nunca 200). Nada aqui acessa o banco: exigirSessao recusa antes.
 */

describe('app.js — rotas da entrega de EPI e da ficha (10E/10F)', () => {
  const app = require('../src/app');
  const ORIGEM = 'http://localhost:5500';

  test('nenhum endpoint novo é público: sem cookie de sessão, 401 SESSAO_INVALIDA em todos', async () => {
    const rotas = [
      ['get', '/api/entregas-epi/contexto/1'],
      ['get', '/api/entregas-epi/contexto/1/materiais'],
      ['get', '/api/entregas-epi/contexto/1/materiais/1/lotes'],
      ['get', '/api/entregas-epi/contexto/funcionarios'],
      ['post', '/api/entregas-epi/contexto/consulta-cpf'],
      ['get', '/api/entregas-epi/1'],
      ['get', '/api/fichas-epi'],
      ['get', '/api/fichas-epi/1'],
      ['get', '/api/fichas-epi/1/entregas'],
      ['post', '/api/entregas-epi'],
      ['post', '/api/fichas-epi/consulta-cpf'],
    ];
    for (const [metodo, rota] of rotas) {
      const requisicao = request(app)[metodo](rota).set('Origin', ORIGEM);
      const r = metodo === 'post' ? await requisicao.set('Content-Type', 'application/json').send({}) : await requisicao;
      assert.equal(r.status, 401, `${metodo} ${rota} -> ${r.status}`);
      assert.equal(r.body.codigo, 'SESSAO_INVALIDA', `${metodo} ${rota}`);
    }
  });

  test('rota inexistente ao lado das novas continua 404 fixo', async () => {
    const r = await request(app).get('/api/fichas-epi/1/inexistente');
    assert.deepEqual([r.status, r.body.codigo], [404, 'ROTA_NAO_ENCONTRADA']);
  });
});
