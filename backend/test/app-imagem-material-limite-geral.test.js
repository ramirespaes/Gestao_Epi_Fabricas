'use strict';

// Geral BAIXO (3 por minuto) e limite próprio da entrega ALTO (50): a prova inversa da outra suíte — com o geral esgotado, a entrega NÃO é afetada.
process.env.RATE_LIMIT_GERAL_LIMITE = '3';
process.env.RATE_LIMIT_GERAL_JANELA_SEGUNDOS = '60';
process.env.IMAGENS_ENTREGAS_POR_MINUTO_IP = '50';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

/**
 * Biblioteca de Imagens, Unidade 5A-1 (RED) — a entrega de imagens tem orçamento próprio e NÃO depende do limite geral: uma grade de miniaturas
 * carregada por vários usuários atrás do mesmo IP não pode ser derrubada (nem derrubar o resto) pelo geral de 120 por minuto. A isenção do geral
 * vale SÓ para a entrega, e nunca é ilimitada (isso é provado em app-imagem-material-limite.test.js).
 */

describe('app.js — a entrega de imagens não depende do limite geral (Unidade 5A-1)', () => {
  const app = require('../src/app');
  const ORIGEM = 'http://localhost:5500';
  const ENTREGA = '/api/imagens-material/padrao/9007199254740993/miniatura';
  const contexto = (r) => `${r.status} ${JSON.stringify(r.body)}`;

  test('LIM-ENT-04 — com o geral (3) esgotado por uma rota de gestão da biblioteca (4º pedido = 429), a entrega ainda responde pelo próprio limite (50): cinco pedidos sem sessão dão 401 SESSAO_INVALIDA, nunca o 429 do geral; as demais rotas seguem sob o geral esgotado', async () => {
    let esgotadoNoPedido = null;
    for (let i = 1; i <= 6 && esgotadoNoPedido === null; i += 1) {
      const r = await request(app).get('/api/imagens-material').set('Origin', ORIGEM);
      if (r.status === 429) esgotadoNoPedido = i;
      else assert.deepEqual([r.status, r.body.codigo], [401, 'SESSAO_INVALIDA'], `pedido ${i} à gestão: ${contexto(r)}`);
    }
    assert.equal(esgotadoNoPedido, 4, 'o geral (3) esgota no 4º pedido à gestão da biblioteca');
    for (let i = 1; i <= 5; i += 1) {
      const r = await request(app).get(ENTREGA).set('Origin', ORIGEM);
      assert.deepEqual([r.status, r.body.codigo], [401, 'SESSAO_INVALIDA'], `pedido ${i} da entrega com o geral esgotado: ${contexto(r)}`);
    }
    const outra = await request(app).get('/api/health').set('Origin', ORIGEM);
    assert.equal(outra.status, 429, `outra rota segue sob o geral esgotado: ${contexto(outra)}`);
  });
});
