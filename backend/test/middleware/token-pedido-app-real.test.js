'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const app = require('../../src/app');
const { httpConfig } = require('../../src/config/http');
const { gerarTokenSessao } = require('../../src/security/token');

/**
 * Atendimento Token — Etapa F (RED): contratos SEM banco do pedido no app REAL. Duas rotas sob o prefixo do atendimento da Etapa D (o cookie
 * `gepi_atendimento` chega a elas): POST .../atendimento/pedido (finalizar) e GET .../atendimento/pedidos/:chave (resultado). Nenhum verbo novo
 * além de GET e POST (CORS inalterado). Nenhum nome de módulo é prescrito aqui: só o comportamento do app montado.
 */

const ORIGEM_PERMITIDA = httpConfig.cors.origens[0];
const PEDIDO = '/api/atendimento-token/tablet/atendimento/pedido';
const PEDIDOS = '/api/atendimento-token/tablet/atendimento/pedidos';
const CHAVE = '3b2d1e7a-5c8f-4a61-9d0e-2f4b6a8c1d3e';
const CORPO = { chaveIdempotencia: CHAVE, itens: [{ materialId: 1, tamanho: null, quantidade: 1, motivo: 'SUBSTITUICAO_PRAZO' }] };

function rotasDoPortal() {
  const rotas = [];
  const coletar = (pilha) => {
    for (const c of pilha) {
      if (c.route) for (const [m, ativo] of Object.entries(c.route.methods)) { if (ativo) rotas.push(`${m.toUpperCase()} ${c.route.path}`); }
      else if (c.handle && Array.isArray(c.handle.stack)) coletar(c.handle.stack);
    }
  };
  app.router.stack.filter((c) => c.handle && Array.isArray(c.handle.stack) && c.match('/api/x')).forEach((c) => coletar(c.handle.stack));
  return rotas;
}

describe('F — pedido do tablet no app real (sem banco)', () => {
  test('CF-A1 — o app monta o pedido só com POST e o resultado só com GET; as rotas das Etapas D e E continuam montadas (não regressão)', () => {
    const rotas = rotasDoPortal();
    for (const existente of ['POST /atendimento-token/tablet/atendimento', 'GET /atendimento-token/tablet/atendimento', 'POST /atendimento-token/tablet/atendimento/atividade', 'POST /atendimento-token/tablet/atendimento/encerrar', 'GET /atendimento-token/tablet/atendimento/catalogo']) {
      assert.ok(rotas.includes(existente), `rota anterior ausente: ${existente}`);
    }
    assert.deepEqual(rotas.filter((r) => r.endsWith('/atendimento/pedido')), ['POST /atendimento-token/tablet/atendimento/pedido'], 'pedido ainda não montado ou com verbo a mais');
    assert.deepEqual(rotas.filter((r) => r.includes('/atendimento/pedidos/')), ['GET /atendimento-token/tablet/atendimento/pedidos/:chave'], 'resultado ainda não montado ou com verbo a mais');
  });

  test('CF-A2 — sem a credencial do tablet o pedido e o resultado são 401 DISPOSITIVO_NAO_AUTORIZADO; o cookie do atendimento sozinho não autentica nada', async () => {
    const pedido = await request(app).post(PEDIDO).set('Origin', ORIGEM_PERMITIDA).send(CORPO);
    assert.deepEqual([pedido.status, pedido.body.codigo], [401, 'DISPOSITIVO_NAO_AUTORIZADO'], `${pedido.status} ${JSON.stringify(pedido.body)}`);
    const resultado = await request(app).get(`${PEDIDOS}/${CHAVE}`);
    assert.deepEqual([resultado.status, resultado.body.codigo], [401, 'DISPOSITIVO_NAO_AUTORIZADO'], `${resultado.status} ${JSON.stringify(resultado.body)}`);
    const soAtendimento = await request(app).post(PEDIDO).set('Origin', ORIGEM_PERMITIDA).set('Cookie', `gepi_atendimento=${gerarTokenSessao()}`).send(CORPO);
    assert.deepEqual([soAtendimento.status, soAtendimento.body.codigo], [401, 'DISPOSITIVO_NAO_AUTORIZADO']);
  });

  test('CF-A3 — o corpo é validado ANTES de qualquer consulta ao banco: campo de identidade extra (empresa, funcionário, GHE, tablet, atendimento, origem…), corpo sem chave, chave malformada, item fora do contrato e query são 400 VALIDACAO', async () => {
    const invalidos = [
      { ...CORPO, empresaId: 1 }, { ...CORPO, funcionarioId: 1 }, { ...CORPO, gheId: 1 }, { ...CORPO, dispositivoId: 1 }, { ...CORPO, atendimentoId: 1 }, { ...CORPO, origemSolicitacao: 'USUARIO_INTERNO' }, { ...CORPO, status: 'APROVADA' },
      { itens: CORPO.itens }, { ...CORPO, chaveIdempotencia: 'nao-e-uuid' }, { ...CORPO, itens: [] }, { ...CORPO, itens: 'x' },
      { ...CORPO, itens: [{ materialId: 'a', tamanho: null, quantidade: 1, motivo: 'SUBSTITUICAO_PRAZO' }] },
      { ...CORPO, itens: [{ materialId: 1, tamanho: null, quantidade: 0, motivo: 'SUBSTITUICAO_PRAZO' }] },
      { ...CORPO, itens: [{ materialId: 1, tamanho: null, quantidade: 1, motivo: 'SUBSTITUICAO_PRAZO', empresaId: 2 }] },
      // D-F2: ADMISSAO e OUTRO não são oferecidos no Totem; sem texto livre (justificativa) nem observação.
      { ...CORPO, itens: [{ materialId: 1, tamanho: null, quantidade: 1, motivo: 'ADMISSAO' }] },
      { ...CORPO, itens: [{ materialId: 1, tamanho: null, quantidade: 1, motivo: 'OUTRO', justificativa: 'texto' }] },
      { ...CORPO, itens: [{ materialId: 1, tamanho: null, quantidade: 1, motivo: 'PERDA_EXTRAVIO', justificativa: 'texto livre' }] },
      { ...CORPO, observacao: 'texto livre' },
    ];
    for (const corpo of invalidos) {
      const r = await request(app).post(PEDIDO).set('Origin', ORIGEM_PERMITIDA).send(corpo);
      assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], `${JSON.stringify(corpo).slice(0, 80)} → ${r.status} ${JSON.stringify(r.body)}`);
    }
    const comQuery = await request(app).post(`${PEDIDO}?empresaId=1`).set('Origin', ORIGEM_PERMITIDA).send(CORPO);
    assert.deepEqual([comQuery.status, comQuery.body.codigo], [400, 'VALIDACAO']);
    for (const ruim of ['nao-e-uuid', '123', `${CHAVE}x`]) {
      const r = await request(app).get(`${PEDIDOS}/${ruim}`);
      assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], `${ruim}: ${r.status} ${JSON.stringify(r.body)}`);
    }
    const resultadoComQuery = await request(app).get(`${PEDIDOS}/${CHAVE}?empresaId=1`);
    assert.deepEqual([resultadoComQuery.status, resultadoComQuery.body.codigo], [400, 'VALIDACAO']);
  });

  test('CF-A4 — controles que valem desde já: sem Origin a finalização é 403 ORIGEM_AUSENTE e com origem de fora é 403 ORIGEM_NAO_PERMITIDA; PUT/PATCH/DELETE nos dois caminhos nunca são aceitos', async () => {
    const sem = await request(app).post(PEDIDO).send(CORPO);
    assert.deepEqual([sem.status, sem.body.codigo], [403, 'ORIGEM_AUSENTE']);
    const fora = await request(app).post(PEDIDO).set('Origin', 'https://atacante.example').send(CORPO);
    assert.deepEqual([fora.status, fora.body.codigo], [403, 'ORIGEM_NAO_PERMITIDA']);
    for (const metodo of ['put', 'patch', 'delete']) {
      for (const caminho of [PEDIDO, `${PEDIDOS}/${CHAVE}`]) {
        const r = await request(app)[metodo](caminho).send({});
        assert.ok(r.status >= 400, `${metodo} ${caminho}: ${r.status}`);
      }
    }
  });
});
