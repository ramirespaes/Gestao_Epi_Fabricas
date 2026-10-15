'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const app = require('../../src/app');
const { gerarTokenSessao } = require('../../src/security/token');

/**
 * Atendimento Token — Etapa G (RED): contratos SEM banco da consulta das solicitações existentes, no app REAL. Uma rota só, GET, sob o prefixo do
 * atendimento da Etapa D (o cookie `gepi_atendimento` chega a ela): GET /api/atendimento-token/tablet/atendimento/solicitacoes. O caminho NÃO é
 * `/pedidos`: a consulta posterior após a identificação é outra operação, distinta da recuperação da resposta original da Etapa F.
 * Nenhum verbo novo (CORS inalterado). Nenhum nome de módulo é prescrito aqui: só o comportamento do app montado.
 */

const SOLICITACOES = '/api/atendimento-token/tablet/atendimento/solicitacoes';

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

describe('G — consulta das solicitações existentes no app real (sem banco)', () => {
  test('CG-A1 — o app monta a consulta só com GET; as rotas das Etapas D, E e F continuam montadas e nenhuma rota de aprovação, entrega ou escrita foi criada no prefixo do atendimento', () => {
    const rotas = rotasDoPortal();
    for (const existente of [
      'POST /atendimento-token/tablet/atendimento', 'GET /atendimento-token/tablet/atendimento', 'POST /atendimento-token/tablet/atendimento/atividade',
      'POST /atendimento-token/tablet/atendimento/encerrar', 'GET /atendimento-token/tablet/atendimento/catalogo',
      'POST /atendimento-token/tablet/atendimento/pedido', 'GET /atendimento-token/tablet/atendimento/pedidos/:chave',
    ]) assert.ok(rotas.includes(existente), `rota anterior ausente: ${existente}`);
    assert.deepEqual(rotas.filter((r) => r.endsWith('/atendimento/solicitacoes')), ['GET /atendimento-token/tablet/atendimento/solicitacoes'], 'consulta ainda não montada ou com verbo a mais');
    const doAtendimento = rotas.filter((r) => r.includes('/atendimento-token/tablet/atendimento'));
    assert.equal(doAtendimento.some((r) => /aprov|entreg|estoque|ficha/i.test(r)), false, 'nenhuma rota de aprovação, entrega, estoque ou ficha');
  });

  test('CG-A2 — sem a credencial do tablet a consulta é 401 DISPOSITIVO_NAO_AUTORIZADO; o cookie do atendimento sozinho não autentica nada', async () => {
    const sem = await request(app).get(SOLICITACOES);
    assert.deepEqual([sem.status, sem.body.codigo], [401, 'DISPOSITIVO_NAO_AUTORIZADO'], `${sem.status} ${JSON.stringify(sem.body)}`);
    const soAtendimento = await request(app).get(SOLICITACOES).set('Cookie', `gepi_atendimento=${gerarTokenSessao()}`);
    assert.deepEqual([soAtendimento.status, soAtendimento.body.codigo], [401, 'DISPOSITIVO_NAO_AUTORIZADO']);
  });

  test('CG-A3 — a consulta aceita SÓ a requisição vazia: qualquer parâmetro de query (empresa, funcionário, cpf, matrícula, GHE, atendimento, filtros, paginação) é 400 VALIDACAO antes de qualquer consulta ao banco', async () => {
    for (const query of ['empresaId=1', 'funcionarioId=1', 'cpf=12345678909', 'matricula=1', 'gheId=1', 'atendimentoId=1', 'status=ENTREGUE', 'incluirEntregues=true', 'pagina=1', 'limite=10', 'x=']) {
      const r = await request(app).get(`${SOLICITACOES}?${query}`);
      assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], `${query}: ${r.status} ${JSON.stringify(r.body)}`);
    }
  });

  test('CG-A4 — a consulta só existe como GET: POST, PUT, PATCH e DELETE nunca são aceitos', async () => {
    for (const metodo of ['post', 'put', 'patch', 'delete']) {
      const r = await request(app)[metodo](SOLICITACOES).send({});
      assert.ok(r.status >= 400, `${metodo}: ${r.status}`);
    }
  });

  test('CG-A5 — a resposta de erro da consulta nunca é guardada em cache (política do app para /api)', async () => {
    const r = await request(app).get(SOLICITACOES);
    assert.match(String(r.headers['cache-control'] ?? ''), /no-store/);
  });
});
