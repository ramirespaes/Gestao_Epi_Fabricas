'use strict';

// Sem IMAGENS_ENTREGAS_POR_MINUTO_IP vale o PADRÃO de produção. O limite é lido na carga do app e cada arquivo de teste roda em processo próprio.
delete process.env.IMAGENS_ENTREGAS_POR_MINUTO_IP;

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

/**
 * O limite padrão da entrega de imagens é 600 por minuto por IP, em janela de 60 s (decisão da V8), e a variável de ambiente só o substitui:
 * os testes de limite usam valores reduzidos, e é aqui que o valor operacional fica fixado, na configuração e no app real.
 */

describe('limite padrão da entrega de imagens (ajuste da Unidade 5A-1)', () => {
  const ORIGEM = 'http://localhost:5500';
  const ENTREGA = '/api/imagens-material/empresa/9007199254740993/miniatura';
  const numero = (r, cabecalho, campo) => {
    const m = new RegExp(`;\\s*${campo}=(\\d+)`).exec(String(r.headers[cabecalho] ?? ''));
    return m === null ? null : Number(m[1]);
  };

  test('LIM-ENT-08 — configuração: o padrão decidido é 600 por minuto, e a variável em branco volta a ele', () => {
    const { lerConfiguracao } = require('../src/config/imagens');
    assert.equal(lerConfiguracao({}).entregasPorMinutoIp, 600);
    assert.equal(lerConfiguracao({ IMAGENS_ENTREGAS_POR_MINUTO_IP: '   ' }).entregasPorMinutoIp, 600);
    assert.equal(lerConfiguracao({ IMAGENS_ENTREGAS_POR_MINUTO_IP: '7' }).entregasPorMinutoIp, 7, 'a variável substitui o padrão');
  });

  test('LIM-ENT-09 — aplicação: no app real, sem configurar nada, o limitador da entrega aplica 600 por minuto em janela de 60 s e conta cada pedido', async () => {
    const app = require('../src/app');
    const primeiro = await request(app).get(ENTREGA).set('Origin', ORIGEM);
    const segundo = await request(app).get(ENTREGA).set('Origin', ORIGEM);
    for (const r of [primeiro, segundo]) {
      assert.equal(r.status, 401, `${r.status} ${JSON.stringify(r.body)}`);
      assert.deepEqual([numero(r, 'ratelimit-policy', 'q'), numero(r, 'ratelimit-policy', 'w')], [600, 60], String(r.headers['ratelimit-policy']));
    }
    assert.equal(numero(segundo, 'ratelimit', 'r'), numero(primeiro, 'ratelimit', 'r') - 1, 'cada pedido consome uma unidade da cota');
  });
});
