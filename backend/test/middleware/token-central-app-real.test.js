'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const app = require('../../src/app');
const { gerarTokenSessao } = require('../../src/security/token');
const { ESCOPO_PROVISIONAMENTO_MASTER, ACOES_COM_EFEITO } = require('../../src/rbac/recursos');

/**
 * Atendimento Token — Etapa H (RED): contratos SEM banco da Central Administrativa no app REAL. A Central reutiliza as cinco rotas da Etapa B e a
 * da Etapa C e ganha, nesta etapa, três leituras (todas GET, sob a mesma sessão administrativa): visão geral, estado da ativação e prévia com
 * catálogo real. Nada de monitoramento nem histórico (Etapa J). Nenhum verbo novo além de GET (CORS inalterado).
 */

const RAIZ = '/api/atendimento-token';
const NOVAS = Object.freeze(['GET /atendimento-token/visao-geral', 'GET /atendimento-token/dispositivos/:id/ativacao', 'GET /atendimento-token/previa/catalogo']);

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

describe('H — Central Administrativa no app real (sem banco)', () => {
  test('CH-A1 — as rotas administrativas das Etapas B e C continuam montadas, com os mesmos verbos (controle)', () => {
    const rotas = rotasDoPortal();
    for (const esperada of ['GET /atendimento-token/dispositivos', 'GET /atendimento-token/dispositivos/:id', 'POST /atendimento-token/dispositivos',
      'PATCH /atendimento-token/dispositivos/:id', 'POST /atendimento-token/dispositivos/:id/revogar', 'POST /atendimento-token/dispositivos/:id/ativacao']) {
      assert.ok(rotas.includes(esperada), `rota ausente: ${esperada}`);
    }
    assert.equal(rotas.some((r) => /^(PUT|DELETE) \/atendimento-token\/dispositivos/.test(r)), false, 'o dispositivo nunca é apagado nem substituído');
  });

  test('CH-A2 — a Central ganha as três leituras GET e, por decisão D5, SÓ o gerenciamento mínimo de redes (listar, cadastrar, desativar), sem outra escrita nova e sem nada da Etapa J (monitoramento, heartbeat, alertas, histórico)', () => {
    const rotas = rotasDoPortal();
    for (const nova of NOVAS) assert.ok(rotas.includes(nova), `rota da Central ainda não montada: ${nova}`);
    const doToken = rotas.filter((r) => r.includes('/atendimento-token/') && !r.includes('/atendimento-token/tablet'));
    assert.deepEqual(doToken.filter((r) => /\/redes/.test(r)).sort(), ['GET /atendimento-token/redes', 'POST /atendimento-token/redes', 'POST /atendimento-token/redes/:id/desativar'],
      'redes: exatamente listar, cadastrar e desativar (nada de exclusão nem edição)');
    assert.deepEqual(doToken.filter((r) => !r.startsWith('GET ') && !/dispositivos|\/redes/.test(r)), [], 'nenhuma escrita nova fora das rotas B/C e das redes');
    assert.equal(doToken.some((r) => /monitoramento|heartbeat|alerta|historico|eventos|carrinho/i.test(r)), false, 'nada da Etapa J');
  });

  test('CH-A3 — sem sessão administrativa as rotas EXISTENTES são 401 (controle); o cookie do tablet sozinho não autentica nenhuma', async () => {
    for (const caminho of ['/dispositivos', '/dispositivos/1']) {
      const sem = await request(app).get(`${RAIZ}${caminho}`);
      assert.equal(sem.status, 401, `${caminho}: ${sem.status} ${JSON.stringify(sem.body)}`);
      const comTablet = await request(app).get(`${RAIZ}${caminho}`).set('Cookie', `gepi_tablet=${gerarTokenSessao()}`);
      assert.equal(comTablet.status, 401, `${caminho} com cookie de tablet`);
    }
  });

  test('CH-A4 — sem sessão administrativa as rotas NOVAS também são 401, e o cookie do tablet ou do atendimento não as autentica (nenhuma autenticação paralela)', async () => {
    for (const caminho of ['/visao-geral', '/dispositivos/1/ativacao', '/previa/catalogo?funcionarioId=1']) {
      const sem = await request(app).get(`${RAIZ}${caminho}`);
      assert.equal(sem.status, 401, `${caminho}: ${sem.status} ${JSON.stringify(sem.body)}`);
      assert.equal(sem.body.codigo !== 'ROTA_NAO_ENCONTRADA', true, caminho);
      const comCookies = await request(app).get(`${RAIZ}${caminho}`).set('Cookie', `gepi_tablet=${gerarTokenSessao()}; gepi_atendimento=${gerarTokenSessao()}`);
      assert.equal(comCookies.status, 401, `${caminho} com cookies do tablet e do atendimento`);
    }
  });

  test('CH-A5 — as superfícies novas só existem como GET: POST, PUT, PATCH e DELETE nelas nunca são aceitos', async () => {
    for (const metodo of ['post', 'put', 'patch', 'delete']) {
      for (const caminho of ['/visao-geral', '/previa/catalogo']) {
        const r = await request(app)[metodo](`${RAIZ}${caminho}`).send({});
        assert.ok(r.status >= 400, `${metodo} ${caminho}: ${r.status}`);
      }
    }
    const dasNovas = rotasDoPortal().filter((r) => /\/atendimento-token\/(visao-geral|previa)/.test(r));
    assert.deepEqual(dasNovas.sort(), ['GET /atendimento-token/previa/catalogo', 'GET /atendimento-token/visao-geral'], 'montadas e só como GET');
  });

  test('CH-A6 — RBAC real: as ações da prévia e de gerenciar redes entram no escopo do MASTER e entre as ações com efeito junto com as rotas que as aplicam; Monitoramento e Histórico NÃO entram nesta etapa (sem rota)', () => {
    for (const acao of ['TOKEN_PREVIA_CATALOGO_REAL', 'TOKEN_GERENCIAR_REDES']) {
      assert.ok(ESCOPO_PROVISIONAMENTO_MASTER.acoes.includes(acao), `${acao}: escopo do MASTER`);
      assert.ok(ACOES_COM_EFEITO.includes(acao), `${acao}: ação com efeito`);
    }
    for (const acao of ['TOKEN_VISUALIZAR_MONITORAMENTO', 'TOKEN_VISUALIZAR_HISTORICO']) {
      assert.equal(ESCOPO_PROVISIONAMENTO_MASTER.acoes.includes(acao) || ACOES_COM_EFEITO.includes(acao), false, `${acao} é da Etapa J`);
    }
  });

  test('CH-A7 — controle: o escopo atual do MASTER já tem o recurso atendimentoToken (visualizar, criar, editar; nunca excluir) e as ações de revogar e gerar ativação', () => {
    const recurso = ESCOPO_PROVISIONAMENTO_MASTER.recursos.find((r) => r.recurso === 'atendimentoToken');
    assert.deepEqual([...recurso.operacoes], ['visualizar', 'criar', 'editar']);
    for (const acao of ['TOKEN_REVOGAR_DISPOSITIVO', 'TOKEN_GERAR_ATIVACAO']) {
      assert.ok(ESCOPO_PROVISIONAMENTO_MASTER.acoes.includes(acao), acao);
      assert.ok(ACOES_COM_EFEITO.includes(acao), acao);
    }
  });
});
