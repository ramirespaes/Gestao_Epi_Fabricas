'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const app = require('../../src/app');
const cookie = require('../../src/security/cookie');
const { httpConfig } = require('../../src/config/http');
const { gerarTokenSessao } = require('../../src/security/token');

/**
 * Atendimento Token — Etapa C (RED): o app REAL monta as rotas do tablet atrás do CORS, da verificação de Origin e do limitador
 * do namespace /api, e a política de cookie do tablet existe. Sem banco: as rotas usadas aqui respondem antes de consultá-lo.
 */

const ORIGEM_PERMITIDA = httpConfig.cors.origens[0];
const CAMINHO_COOKIE = '/api/atendimento-token/tablet';

function rotasDoPortal() {
  const camadas = app.router.stack.filter((c) => c.handle && Array.isArray(c.handle.stack) && c.match('/api/x'));
  const rotas = [];
  const coletar = (pilha) => {
    for (const c of pilha) {
      if (c.route) for (const [m, ativo] of Object.entries(c.route.methods)) { if (ativo) rotas.push(`${m.toUpperCase()} ${c.route.path}`); }
      else if (c.handle && Array.isArray(c.handle.stack)) coletar(c.handle.stack);
    }
  };
  camadas.forEach((c) => coletar(c.handle.stack));
  return rotas;
}

describe('C — montagem no app real', () => {
  test('C-A1 — o app monta as três rotas da Etapa C no namespace /api (portal): geração de ativação, ativar e estado do tablet', () => {
    const rotas = rotasDoPortal();
    for (const esperada of ['POST /atendimento-token/dispositivos/:id/ativacao', 'POST /atendimento-token/tablet/ativar', 'GET /atendimento-token/tablet/estado']) {
      assert.ok(rotas.includes(esperada), `rota ausente: ${esperada}`);
    }
  });

  test('C-A2 — as rotas administrativas congeladas da Etapa B continuam montadas (não regressão)', () => {
    const rotas = rotasDoPortal();
    for (const existente of ['GET /atendimento-token/dispositivos', 'GET /atendimento-token/dispositivos/:id', 'POST /atendimento-token/dispositivos', 'PATCH /atendimento-token/dispositivos/:id', 'POST /atendimento-token/dispositivos/:id/revogar']) {
      assert.ok(rotas.includes(existente), existente);
    }
  });

  test('C-A3 — o ativar passa pela verificação de Origin do app real: origem permitida + corpo inválido é 400 VALIDACAO (a validação roda antes de qualquer consulta ao banco)', async () => {
    const r = await request(app).post('/api/atendimento-token/tablet/ativar').set('Origin', ORIGEM_PERMITIDA).send({ campoExtra: 1 });
    assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], `${r.status} ${JSON.stringify(r.body)}`);
  });

  test('C-A4 — controles que valem desde já: sem Origin/Referer a mutação é 403 ORIGEM_AUSENTE e com origem de fora é 403 ORIGEM_NAO_PERMITIDA', async () => {
    const sem = await request(app).post('/api/atendimento-token/tablet/ativar').send({ codigo: gerarTokenSessao() });
    assert.deepEqual([sem.status, sem.body.codigo], [403, 'ORIGEM_AUSENTE']);
    const fora = await request(app).post('/api/atendimento-token/tablet/ativar').set('Origin', 'https://atacante.example').send({ codigo: gerarTokenSessao() });
    assert.deepEqual([fora.status, fora.body.codigo], [403, 'ORIGEM_NAO_PERMITIDA']);
  });

  test('C-A5 — o estado do tablet sem credencial é 401 DISPOSITIVO_NAO_AUTORIZADO no app real (sem tocar no banco: sem cookie, a autenticação recusa antes)', async () => {
    const r = await request(app).get('/api/atendimento-token/tablet/estado');
    assert.deepEqual([r.status, r.body.codigo], [401, 'DISPOSITIVO_NAO_AUTORIZADO'], `${r.status} ${JSON.stringify(r.body)}`);
  });
});

describe('C — política do cookie do tablet', () => {
  test('C-P1 — security/cookie.js expõe a política do tablet: caminho restrito, serialização e remoção', () => {
    assert.equal(typeof cookie.serializarCookieDispositivo, 'function', 'serializarCookieDispositivo ainda não existe');
    assert.equal(typeof cookie.serializarRemocaoCookieDispositivo, 'function', 'serializarRemocaoCookieDispositivo ainda não existe');
    assert.equal(cookie.CAMINHO_COOKIE_DISPOSITIVO, CAMINHO_COOKIE);
  });

  test('C-P2 — o cookie emitido é HttpOnly, de nome gepi_tablet, Path restrito, persistente (≥ 30 dias), sem Domain nem Expires, e só aceita credencial canônica', () => {
    assert.equal(typeof cookie.serializarCookieDispositivo, 'function');
    const token = gerarTokenSessao();
    const texto = cookie.serializarCookieDispositivo(token);
    assert.match(texto, new RegExp(`^gepi_tablet=${token};`));
    assert.match(texto, /; HttpOnly/);
    assert.match(texto, new RegExp(`; Path=${CAMINHO_COOKIE}(;|$)`));
    assert.match(texto, /; SameSite=(Lax|Strict|None)/);
    assert.equal(/; Domain=/i.test(texto), false);
    assert.equal(/; Expires=/i.test(texto), false);
    assert.ok(Number(/Max-Age=(\d+)/.exec(texto)?.[1]) >= 30 * 24 * 3600);
    assert.throws(() => cookie.serializarCookieDispositivo('nao-canonico'), TypeError);
    assert.throws(() => cookie.serializarCookieDispositivo(`${token}; Path=/`), TypeError, 'nunca injeta atributos');
  });

  test('C-P3 — a remoção repete os atributos estruturais (nome e Path) com Max-Age=0, para o navegador substituir em vez de duplicar', () => {
    assert.equal(typeof cookie.serializarRemocaoCookieDispositivo, 'function');
    const texto = cookie.serializarRemocaoCookieDispositivo();
    assert.match(texto, /^gepi_tablet=;/);
    assert.match(texto, new RegExp(`; Path=${CAMINHO_COOKIE}(;|$)`));
    assert.match(texto, /; Max-Age=0/);
    assert.match(texto, /; HttpOnly/);
  });

  test('C-P4 — controle que vale desde já: os cookies de sessão existentes seguem em Path=/ e sem o nome do tablet (a política nova não os altera)', () => {
    const token = gerarTokenSessao();
    for (const texto of [cookie.serializarCookieSessao(token), cookie.serializarCookieSessaoGlobal(token), cookie.serializarCookieSessaoPlataforma(token)]) {
      assert.match(texto, /; Path=\/(;|$)/);
      assert.equal(texto.startsWith('gepi_tablet='), false);
    }
  });
});
