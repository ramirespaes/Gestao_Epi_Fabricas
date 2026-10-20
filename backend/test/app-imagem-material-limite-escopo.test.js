'use strict';

// Limites lidos na carga do app; cada arquivo de teste roda em processo próprio. Geral BAIXO (3) e limite da entrega ALTO (50): um pedido que
// escape do geral por engano não esbarra em 429. TRUST_PROXY_HOPS=1 (como atrás de um proxy) permite um IP simulado por teste, então cada
// teste tem o seu orçamento e nenhum depende da ordem.
process.env.RATE_LIMIT_GERAL_LIMITE = '3';
process.env.RATE_LIMIT_GERAL_JANELA_SEGUNDOS = '60';
process.env.IMAGENS_ENTREGAS_POR_MINUTO_IP = '50';
process.env.TRUST_PROXY_HOPS = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

/**
 * Escopo da exceção do limite geral para a entrega de imagens (app.js). A exceção vale SÓ para GET e HEAD da forma exata
 * /imagens-material/(empresa|padrao)/<id>/(miniatura|exibicao); todo o resto (outro método, origem, variante ou número de segmentos) continua
 * sob o limite geral. Quem governa o pedido aparece no cabeçalho RateLimit-Policy (q = cota, w = janela em segundos), sem depender de esgotar nada.
 */

describe('app.js — escopo da exceção do limite geral para a entrega de imagens (ajuste da Unidade 5A-1)', () => {
  const app = require('../src/app');
  const ORIGEM = 'http://localhost:5500';
  const ENTREGA = '/api/imagens-material/empresa/9007199254740993/miniatura';
  const LIMITE_GERAL = 3;
  const LIMITE_ENTREGA = 50;
  const contexto = (r) => `${r.status} ${JSON.stringify(r.body)}`;
  const politica = (r) => {
    const bruto = String(r.headers['ratelimit-policy'] ?? '');
    const numero = (campo) => { const m = new RegExp(`;\\s*${campo}=(\\d+)`).exec(bruto); return m === null ? null : Number(m[1]); };
    return { q: numero('q'), w: numero('w'), bruto };
  };
  const pedir = (metodo, caminho, ip) => {
    const r = request(app)[metodo](caminho).set('Origin', ORIGEM).set('X-Forwarded-For', `203.0.113.${ip}`);
    return ['get', 'head'].includes(metodo) ? r : r.send({});
  };

  test('LIM-ENT-05 — POST, PUT, PATCH e DELETE no caminho da entrega NÃO escapam do limite GERAL: os três primeiros são contados por ele (q=3) e o 4º é 429', async () => {
    const metodos = ['post', 'put', 'patch', 'delete'];
    const respostas = [];
    for (const metodo of metodos) respostas.push(await pedir(metodo, ENTREGA, 10));
    respostas.slice(0, 3).forEach((r, i) => {
      assert.notEqual(r.status, 429, `${metodos[i].toUpperCase()} já estourou o geral: ${contexto(r)}`);
      assert.equal(politica(r).q, LIMITE_GERAL, `${metodos[i].toUpperCase()} deve ser contado pelo limite geral, e não pelo da entrega: ${politica(r).bruto}`);
    });
    assert.deepEqual([respostas[3].status, respostas[3].body.codigo], [429, 'LIMITE_REQUISICOES_EXCEDIDO'], `4º pedido (DELETE): ${contexto(respostas[3])}`);
  });

  test('LIM-ENT-06 — o que NÃO é a forma exata da entrega continua sob o limite GERAL: origem ou variante fora da lista (inclusive "mestre") e segmento a mais são contados por ele (q=3) e o 4º pedido é 429', async () => {
    const foraDaForma = [
      '/api/imagens-material/mestre/1/miniatura',
      '/api/imagens-material/empresa/1/mestre',
      '/api/imagens-material/outra/1/exibicao',
      '/api/imagens-material/empresa/1/miniatura/extra',
    ];
    const respostas = [];
    for (const caminho of foraDaForma) respostas.push(await pedir('get', caminho, 20));
    respostas.slice(0, 3).forEach((r, i) => {
      assert.notEqual(r.status, 429, `${foraDaForma[i]} já estourou o geral: ${contexto(r)}`);
      assert.equal(politica(r).q, LIMITE_GERAL, `${foraDaForma[i]} deve ser contado pelo limite geral, e não pelo da entrega: ${politica(r).bruto}`);
    });
    assert.deepEqual([respostas[3].status, respostas[3].body.codigo], [429, 'LIMITE_REQUISICOES_EXCEDIDO'], `4º pedido: ${contexto(respostas[3])}`);
  });

  test('LIM-ENT-07 (controle) — a forma exata (GET e HEAD; empresa e padrão; miniatura e exibição) é governada só pelo limitador PRÓPRIO: cota 50 em janela de 60 s, nunca a do geral', async () => {
    const exatos = [
      ['get', '/api/imagens-material/empresa/1/miniatura'], ['get', '/api/imagens-material/empresa/1/exibicao'],
      ['get', '/api/imagens-material/padrao/1/miniatura'], ['get', '/api/imagens-material/padrao/1/exibicao'],
      ['head', '/api/imagens-material/empresa/1/miniatura'], ['head', '/api/imagens-material/padrao/1/exibicao'],
    ];
    for (const [metodo, caminho] of exatos) {
      const r = await pedir(metodo, caminho, 30);
      assert.equal(r.status, 401, `${metodo.toUpperCase()} ${caminho} sem sessão: ${contexto(r)}`);
      const { q, w, bruto } = politica(r);
      assert.deepEqual([q, w], [LIMITE_ENTREGA, 60], `${metodo.toUpperCase()} ${caminho}: ${bruto}`);
    }
  });
});
