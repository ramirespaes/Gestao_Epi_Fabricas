'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const app = require('../../src/app');
const { gerarTokenSessao } = require('../../src/security/token');

/**
 * Atendimento Token — Etapa E (RED): contratos SEM banco do catálogo, no app REAL. O catálogo é uma leitura (GET) sob o prefixo do
 * atendimento da Etapa D, o que faz o cookie `gepi_atendimento` (Path = /api/atendimento-token/tablet/atendimento) chegar a ele.
 * Nenhum verbo novo no CORS (o namespace /api já anuncia GET). Nenhum nome de módulo é prescrito: só o comportamento no app montado.
 */

const CAMINHO = '/api/atendimento-token/tablet/atendimento/catalogo';

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

describe('E — catálogo no app real (sem banco)', () => {
  test('CE-A1 — o app monta o catálogo só com GET e as quatro rotas do atendimento da Etapa D continuam montadas (não regressão)', () => {
    const rotas = rotasDoPortal();
    for (const d of ['POST /atendimento-token/tablet/atendimento', 'GET /atendimento-token/tablet/atendimento', 'POST /atendimento-token/tablet/atendimento/atividade', 'POST /atendimento-token/tablet/atendimento/encerrar']) {
      assert.ok(rotas.includes(d), `rota da Etapa D ausente: ${d}`);
    }
    const doCatalogo = rotas.filter((r) => r.endsWith('/atendimento/catalogo'));
    assert.deepEqual(doCatalogo, ['GET /atendimento-token/tablet/atendimento/catalogo'], 'catálogo ainda não montado ou com verbo a mais');
  });

  test('CE-A2 — sem a credencial do tablet o catálogo é 401 DISPOSITIVO_NAO_AUTORIZADO no app real; o cookie do atendimento sozinho não autentica nada', async () => {
    const sem = await request(app).get(CAMINHO);
    assert.deepEqual([sem.status, sem.body.codigo], [401, 'DISPOSITIVO_NAO_AUTORIZADO'], `${sem.status} ${JSON.stringify(sem.body)}`);
    const soAtendimento = await request(app).get(CAMINHO).set('Cookie', `gepi_atendimento=${gerarTokenSessao()}`);
    assert.deepEqual([soAtendimento.status, soAtendimento.body.codigo], [401, 'DISPOSITIVO_NAO_AUTORIZADO']);
  });

  test('CE-A3 — qualquer parâmetro de query (empresa, GHE, funcionário, material, paginação, busca) é 400 VALIDACAO ANTES de consultar o banco; o catálogo não aceita filtro do navegador', async () => {
    for (const query of ['empresaId=1', 'gheId=1', 'funcionarioId=1', 'materialId=1', 'limite=1000', 'pagina=2', 'busca=x', 'todos=true']) {
      const r = await request(app).get(`${CAMINHO}?${query}`);
      assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], `${query}: ${r.status} ${JSON.stringify(r.body)}`);
    }
  });

  test('CE-A4 — o catálogo é só leitura: POST/PUT/PATCH/DELETE no caminho nunca são aceitos (a verificação de origem e a rota inexistente recusam)', async () => {
    for (const metodo of ['post', 'put', 'patch', 'delete']) {
      const r = await request(app)[metodo](CAMINHO).send({});
      assert.ok(r.status >= 400, `${metodo}: ${r.status}`);
    }
  });
});
