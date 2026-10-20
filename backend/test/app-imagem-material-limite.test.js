'use strict';

// O limite é lido na carga do app, e cada arquivo de teste roda em processo próprio: o ambiente é ajustado ANTES de carregar o app.
// Geral baixo (4 por minuto) e limite próprio da entrega MAIOR (7): se a entrega contasse no geral, o geral estouraria antes do próprio.
process.env.RATE_LIMIT_GERAL_LIMITE = '4';
process.env.RATE_LIMIT_GERAL_JANELA_SEGUNDOS = '60';
process.env.IMAGENS_ENTREGAS_POR_MINUTO_IP = '7';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

/**
 * Biblioteca de Imagens, Unidade 5A-1 (RED) — o LIMITADOR PRÓPRIO da rota de entrega de imagens, no app REAL (cadeia de produção de app.js).
 * Contrato (a capacidade operacional NÃO é fixada aqui; só o mecanismo, com limite reduzido por ambiente):
 *   - o caminho GET /api/imagens-material/:origem/:id/:variante tem um limite por IP PRÓPRIO (IMAGENS_ENTREGAS_POR_MINUTO_IP), aplicado ANTES da
 *     sessão: tentativas sem sessão também contam; ao exceder, 429 LIMITE_REQUISICOES_EXCEDIDO (GET e HEAD);
 *   - a entrega NÃO consome o limite geral e o geral continua valendo nas demais rotas; não há isenção ilimitada.
 * Nada aqui acessa o banco: sem sessão, o pedido é recusado (401) antes.
 */

describe('app.js — limitador próprio da entrega de imagens (Unidade 5A-1)', () => {
  const app = require('../src/app');
  const ORIGEM = 'http://localhost:5500';
  const ENTREGA = '/api/imagens-material/empresa/9007199254740993/miniatura';
  const contexto = (r) => `${r.status} ${JSON.stringify(r.body)}`;

  test('LIM-ENT-01 — sete pedidos à entrega SEM sessão passam pelo limite (401 SESSAO_INVALIDA); o oitavo é 429, em GET e em HEAD — tentativas sem sessão também contam, e o geral (4) não é consumido', async () => {
    for (let i = 1; i <= 7; i += 1) {
      const r = await request(app).get(ENTREGA).set('Origin', ORIGEM);
      assert.deepEqual([r.status, r.body.codigo], [401, 'SESSAO_INVALIDA'], `pedido ${i} da entrega: ${contexto(r)}`);
    }
    const excedido = await request(app).get(ENTREGA).set('Origin', ORIGEM);
    assert.deepEqual([excedido.status, excedido.body.codigo], [429, 'LIMITE_REQUISICOES_EXCEDIDO'], `8º pedido da entrega: ${contexto(excedido)}`);
    assert.equal(excedido.headers['cache-control'], 'no-store', 'o 429 não tem cache');
    const head = await request(app).head(ENTREGA).set('Origin', ORIGEM);
    assert.equal(head.status, 429, 'HEAD também conta e também é limitado');
  });

  test('LIM-ENT-02 — o limite GERAL continua nas demais rotas e a entrega esgotada não o consumiu: quatro pedidos a /api/health passam (200) e o quinto é 429', async () => {
    for (let i = 1; i <= 4; i += 1) {
      const r = await request(app).get('/api/health').set('Origin', ORIGEM);
      assert.equal(r.status, 200, `pedido ${i} a /api/health: ${contexto(r)}`);
    }
    const quinto = await request(app).get('/api/health').set('Origin', ORIGEM);
    assert.deepEqual([quinto.status, quinto.body.codigo], [429, 'LIMITE_REQUISICOES_EXCEDIDO'], `5º pedido geral: ${contexto(quinto)}`);
  });

  test('LIM-ENT-03 (controle) — as rotas de GESTÃO da biblioteca continuam sob o limite geral (4): em no máximo cinco pedidos sem sessão a listagem chega ao 429, e antes dele é sempre 401 (a isenção vale só para a entrega; independe da ordem dos testes)', async () => {
    let esgotadoNoPedido = null;
    for (let i = 1; i <= 5 && esgotadoNoPedido === null; i += 1) {
      const gestao = await request(app).get('/api/imagens-material').set('Origin', ORIGEM);
      if (gestao.status === 429) {
        assert.equal(gestao.body.codigo, 'LIMITE_REQUISICOES_EXCEDIDO', `gestão sob o limite geral: ${contexto(gestao)}`);
        esgotadoNoPedido = i;
      } else {
        assert.deepEqual([gestao.status, gestao.body.codigo], [401, 'SESSAO_INVALIDA'], `pedido ${i} à gestão: ${contexto(gestao)}`);
      }
    }
    assert.notEqual(esgotadoNoPedido, null, 'a gestão da biblioteca nunca chegou ao limite geral (isenção ampla demais)');
  });
});
