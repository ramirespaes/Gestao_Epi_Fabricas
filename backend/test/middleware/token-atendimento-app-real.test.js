'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const app = require('../../src/app');
const cookie = require('../../src/security/cookie');
const recursos = require('../../src/rbac/recursos');
const { authConfig } = require('../../src/config/auth');
const { httpConfig } = require('../../src/config/http');
const { gerarTokenSessao } = require('../../src/security/token');

/**
 * Atendimento Token — Etapa D (RED): contratos SEM banco. A identificação do funcionário reutiliza a autenticação do tablet da
 * Etapa C (cookie `gepi_tablet`); o atendimento é um segundo cookie, curto, de nome e Path próprios. Não há ação de RBAC nova:
 * quem atende é o tablet autenticado, nunca um usuário administrativo.
 */

const ORIGEM_PERMITIDA = httpConfig.cors.origens[0];
const BASE = '/api/atendimento-token/tablet/atendimento';
const CAMINHO_COOKIE = '/api/atendimento-token/tablet/atendimento';

function carregar(caminho) {
  try { return require(caminho); } catch (erro) {
    if (erro.code === 'MODULE_NOT_FOUND' && erro.message.includes(caminho.split('/').pop())) return null;
    throw erro;
  }
}

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

describe('D — módulos, configuração e cookie do atendimento', () => {
  test('D-U1 — os módulos da identificação existem: rotas (criarTokenAtendimentoRoutes), controller e serviço, separados dos da Etapa C congelada', () => {
    const rotas = carregar('../../src/routes/token-atendimento.routes');
    assert.ok(rotas, 'src/routes/token-atendimento.routes.js ainda não existe');
    assert.equal(typeof rotas.criarTokenAtendimentoRoutes, 'function');
    assert.ok(carregar('../../src/controllers/token-atendimento.controller'), 'controller ausente');
    assert.ok(carregar('../../src/services/token-atendimento.service'), 'serviço ausente');
    const tablet = require('../../src/routes/token-tablet.routes');
    assert.deepEqual(Object.keys(tablet).sort(), ['LIMITE_ATIVACAO_POR_IP', 'LIMITE_ESTADO_POR_IP', 'LIMITE_POR_DISPOSITIVO', 'chavePorDispositivo', 'criarTokenTabletRoutes', 'tokenTabletRoutes'], 'o contrato da Etapa C não mudou');
  });

  test('D-U2 — configuração própria do atendimento: cookie gepi_atendimento distinto dos cinco outros e inatividade de 60 segundos (decisão definitiva)', () => {
    assert.ok(authConfig.atendimento, 'authConfig.atendimento ainda não existe');
    assert.equal(authConfig.atendimento.cookieNome, 'gepi_atendimento');
    const outros = [authConfig.sessao.cookieNome, authConfig.sessao.cookieNomeAdmin, authConfig.sessao.cookieNomeGlobal, authConfig.desafioMfa.cookieNome, authConfig.dispositivo.cookieNome];
    assert.equal(outros.includes(authConfig.atendimento.cookieNome), false);
    assert.equal(authConfig.atendimento.inatividadeSegundos, 60);
  });

  test('D-U3 — a política do cookie do atendimento existe: HttpOnly, SameSite=Strict (D-D9, dedicado, independente do SameSite das sessões), Secure conforme a política, Path /api/atendimento-token/tablet/atendimento, curto (≤ 30 min), sem Domain, só token canônico; a remoção repete nome, Path e atributos com Max-Age=0', () => {
    assert.equal(typeof cookie.serializarCookieAtendimento, 'function', 'serializarCookieAtendimento ainda não existe');
    assert.equal(typeof cookie.serializarRemocaoCookieAtendimento, 'function', 'serializarRemocaoCookieAtendimento ainda não existe');
    assert.equal(cookie.CAMINHO_COOKIE_ATENDIMENTO, CAMINHO_COOKIE);
    const token = gerarTokenSessao();
    const texto = cookie.serializarCookieAtendimento(token);
    assert.match(texto, new RegExp(`^gepi_atendimento=${token};`));
    assert.match(texto, /; HttpOnly/);
    assert.match(texto, /; SameSite=Strict/, 'SameSite=Strict próprio do cookie do atendimento, qualquer que seja o SameSite global das sessões');
    assert.equal(/; Secure/.test(texto), authConfig.sessao.cookieSecure, 'Secure segue a política de sessão (obrigatório em produção)');
    assert.match(texto, new RegExp(`; Path=${CAMINHO_COOKIE}(;|$)`));
    assert.equal(/; Domain=/i.test(texto), false);
    const maxAge = Number(/Max-Age=(\d+)/.exec(texto)?.[1]);
    assert.ok(maxAge > 0 && maxAge <= 1800, `Max-Age ${maxAge}`);
    assert.throws(() => cookie.serializarCookieAtendimento('nao-canonico'), TypeError);
    assert.throws(() => cookie.serializarCookieAtendimento(`${token}; Path=/`), TypeError);
    const remocao = cookie.serializarRemocaoCookieAtendimento();
    assert.match(remocao, /^gepi_atendimento=;/);
    assert.match(remocao, new RegExp(`; Path=${CAMINHO_COOKIE}(;|$)`));
    assert.match(remocao, /; Max-Age=0/);
    assert.match(remocao, /; SameSite=Strict/);
    assert.match(remocao, /; HttpOnly/);
  });

  test('D-U4 — controles que valem desde já: o cookie do tablet da Etapa C segue com o seu Path e o catálogo de RBAC da Etapa C não ganha ação nova para a identificação (quem atende é o tablet)', () => {
    assert.equal(cookie.CAMINHO_COOKIE_DISPOSITIVO, '/api/atendimento-token/tablet');
    // Etapa H: a Central acrescentou, e só ela, as ações de gerenciar redes e da prévia; a Etapa D (identificação) continua sem ação própria.
    assert.deepEqual([...recursos.ESCOPO_PROVISIONAMENTO_MASTER.acoes].filter((x) => x.startsWith('TOKEN_')).sort(), ['TOKEN_GERAR_ATIVACAO', 'TOKEN_GERENCIAR_REDES', 'TOKEN_PREVIA_CATALOGO_REAL', 'TOKEN_REVOGAR_DISPOSITIVO']);
    assert.equal(recursos.ACOES_COM_EFEITO.filter((x) => x.startsWith('TOKEN_')).length, 4);
  });
});

describe('D — montagem no app real', () => {
  test('D-A1 — o app monta as quatro rotas do atendimento no namespace /api, só com GET e POST (nenhum verbo novo no CORS): identificar, consultar, atividade e encerrar', () => {
    const rotas = rotasDoPortal();
    for (const esperada of [
      'POST /atendimento-token/tablet/atendimento', 'GET /atendimento-token/tablet/atendimento',
      'POST /atendimento-token/tablet/atendimento/atividade', 'POST /atendimento-token/tablet/atendimento/encerrar',
    ]) assert.ok(rotas.includes(esperada), `rota ausente: ${esperada}`);
    const doAtendimento = rotas.filter((r) => r.includes('/atendimento-token/tablet/atendimento'));
    assert.equal(doAtendimento.every((r) => r.startsWith('GET ') || r.startsWith('POST ')), true, doAtendimento.join(', '));
  });

  test('D-A2 — as rotas da Etapa C continuam montadas (não regressão)', () => {
    const rotas = rotasDoPortal();
    for (const existente of ['POST /atendimento-token/tablet/ativar', 'GET /atendimento-token/tablet/estado', 'POST /atendimento-token/dispositivos/:id/ativacao']) assert.ok(rotas.includes(existente), existente);
  });

  test('D-A3 — a identificação passa pela verificação de Origin do app real e valida o corpo ANTES de qualquer consulta ao banco: origem permitida + corpo fora do contrato é 400 VALIDACAO', async () => {
    const r = await request(app).post(BASE).set('Origin', ORIGEM_PERMITIDA).send({ tipo: 'CPF', valor: '52998224725', empresaId: 1 });
    assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], `${r.status} ${JSON.stringify(r.body)}`);
  });

  test('D-A4 — controles que valem desde já: sem Origin/Referer a mutação é 403 ORIGEM_AUSENTE e com origem de fora é 403 ORIGEM_NAO_PERMITIDA', async () => {
    const sem = await request(app).post(BASE).send({ tipo: 'CPF', valor: '52998224725' });
    assert.deepEqual([sem.status, sem.body.codigo], [403, 'ORIGEM_AUSENTE']);
    const fora = await request(app).post(`${BASE}/encerrar`).set('Origin', 'https://atacante.example').send({});
    assert.deepEqual([fora.status, fora.body.codigo], [403, 'ORIGEM_NAO_PERMITIDA']);
  });

  test('D-A5 — sem a credencial do tablet o estado do atendimento é 401 DISPOSITIVO_NAO_AUTORIZADO no app real (a autenticação do tablet vem ANTES do cookie do atendimento e não toca no banco sem cookie)', async () => {
    const r = await request(app).get(BASE);
    assert.deepEqual([r.status, r.body.codigo], [401, 'DISPOSITIVO_NAO_AUTORIZADO'], `${r.status} ${JSON.stringify(r.body)}`);
    const soAtendimento = await request(app).get(BASE).set('Cookie', `gepi_atendimento=${gerarTokenSessao()}`);
    assert.deepEqual([soAtendimento.status, soAtendimento.body.codigo], [401, 'DISPOSITIVO_NAO_AUTORIZADO'], 'o cookie do atendimento sozinho não autentica o tablet');
  });
});
