'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');

const app = require('../../src/app');
const tabletService = require('../../src/services/token-tablet.service');
const monitoramentoService = require('../../src/services/token-monitoramento.service');
const cookie = require('../../src/security/cookie');
const { authConfig } = require('../../src/config/auth');
const { httpConfig } = require('../../src/config/http');
const { gerarTokenSessao } = require('../../src/security/token');
const { HttpError } = require('../../src/errors/HttpError');

/**
 * Atendimento Token — Ciclo 2, K3 (backend): o app REAL monta POST /api/atendimento-token/tablet/heartbeat. Sem banco: as
 * respostas dos casos abaixo vêm antes de qualquer consulta, ou os serviços de autenticação e de registro do contato são
 * substituídos NA FRONTEIRA DO SERVIÇO (o middleware, a rota, a validação, os limitadores, a verificação de Origin e o controller
 * seguem reais). A prova com credencial verdadeira e PostgreSQL é a da suíte token-j-heartbeat (CI); aqui se prova a composição.
 */

const ORIGEM_PERMITIDA = httpConfig.cors.origens[0];
const CAMINHO = '/api/atendimento-token/tablet/heartbeat';
const COOKIE = authConfig.dispositivo.cookieNome;
const RAIZ = path.join(__dirname, '..', '..');

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

const batida = (credencial, extra = {}) => {
  let r = request(app).post(CAMINHO).set('Origin', ORIGEM_PERMITIDA);
  if (credencial !== undefined) r = r.set('Cookie', `${COOKIE}=${credencial}`);
  for (const [nome, valor] of Object.entries(extra.cabecalhos ?? {})) r = r.set(nome, valor);
  return r.send(extra.corpo ?? {});
};
const aviso = (r) => `${r.status} ${JSON.stringify(r.body)}`;

describe('K3 — montagem do heartbeat no app real', () => {
  test('K3-A1 — o app monta POST /atendimento-token/tablet/heartbeat no namespace /api (portal) e só com POST', () => {
    const rotas = rotasDoPortal();
    assert.ok(rotas.includes('POST /atendimento-token/tablet/heartbeat'), 'rota do heartbeat ausente');
    for (const proibida of ['GET', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal(rotas.includes(`${proibida} /atendimento-token/tablet/heartbeat`), false, `${proibida} não deve existir`);
    }
  });

  test('K3-A2 — sem credencial do tablet o heartbeat é 401 DISPOSITIVO_NAO_AUTORIZADO (recusa antes de qualquer consulta ao banco)', async () => {
    const r = await batida(undefined);
    assert.deepEqual([r.status, r.body.codigo], [401, 'DISPOSITIVO_NAO_AUTORIZADO'], aviso(r));
  });

  test('K3-A3 — credencial fora do formato canônico e cookie duplicado são recusados como ausentes (401), sem consulta ao banco', async () => {
    const malformada = await batida('nao-canonica');
    assert.deepEqual([malformada.status, malformada.body.codigo], [401, 'DISPOSITIVO_NAO_AUTORIZADO'], aviso(malformada));
    const token = gerarTokenSessao();
    const duplicada = await request(app).post(CAMINHO).set('Origin', ORIGEM_PERMITIDA).set('Cookie', `${COOKIE}=${token}; ${COOKIE}=${token}`).send({});
    assert.deepEqual([duplicada.status, duplicada.body.codigo], [401, 'DISPOSITIVO_NAO_AUTORIZADO'], aviso(duplicada));
  });

  test('K3-A4 — corpo e query são vazios e estritos: campo extra (inclusive empresa e tablet) é 400 VALIDACAO, antes da autenticação', async () => {
    for (const corpo of [{ empresaId: 1 }, { dispositivoId: 1 }, { qualquer: true }]) {
      const r = await batida(undefined, { corpo });
      assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], aviso(r));
    }
    const comQuery = await request(app).post(`${CAMINHO}?empresaId=1`).set('Origin', ORIGEM_PERMITIDA).send({});
    assert.deepEqual([comQuery.status, comQuery.body.codigo], [400, 'VALIDACAO'], aviso(comQuery));
  });

  test('K3-A5 — a verificação de Origin do app real vale para o heartbeat: sem Origin é 403 ORIGEM_AUSENTE e origem de fora é 403 ORIGEM_NAO_PERMITIDA', async () => {
    const sem = await request(app).post(CAMINHO).send({});
    assert.deepEqual([sem.status, sem.body.codigo], [403, 'ORIGEM_AUSENTE'], aviso(sem));
    const fora = await request(app).post(CAMINHO).set('Origin', 'https://atacante.example').send({});
    assert.deepEqual([fora.status, fora.body.codigo], [403, 'ORIGEM_NAO_PERMITIDA'], aviso(fora));
  });

  test('K3-A6 — credencial válida (autenticação substituída na fronteira do serviço) alcança o controller e recebe 200 { status: "ok" }; empresa e tablet vêm só de req.dispositivo', async (t) => {
    const chamadas = [];
    t.mock.method(tabletService, 'autenticar', async (_pool, { credencial }) => {
      assert.match(credencial, /^[A-Za-z0-9_-]{43}$/, 'o middleware entrega a credencial lida do cookie do tablet');
      return { dispositivo: { id: 7, empresaId: 3, nome: 'Tablet A', unidade: null, setor: null, localInstalacao: null }, novaCredencial: null };
    });
    t.mock.method(monitoramentoService, 'registrarContato', async (_pool, dados) => { chamadas.push(dados); });
    const r = await batida(gerarTokenSessao(), { cabecalhos: { 'X-Empresa-Id': '99', 'X-Dispositivo-Id': '99' } });
    assert.equal(r.status, 200, aviso(r));
    assert.deepEqual(r.body, { status: 'ok' });
    assert.deepEqual(chamadas, [{ empresaId: 3, dispositivoId: 7 }], 'nada que o cliente envie escolhe empresa ou tablet');
    assert.equal(r.headers['set-cookie'], undefined, 'sem rotação nesta requisição, nenhum Set-Cookie');
  });

  test('K3-A7 — se a requisição rotacionou a credencial, a nova vai em Set-Cookie pela política EXISTENTE do tablet (a montagem não altera cookies)', async (t) => {
    const nova = gerarTokenSessao();
    t.mock.method(tabletService, 'autenticar', async () => ({ dispositivo: { id: 7, empresaId: 3, nome: 'Tablet A', unidade: null, setor: null, localInstalacao: null }, novaCredencial: nova }));
    t.mock.method(monitoramentoService, 'registrarContato', async () => {});
    const r = await batida(gerarTokenSessao());
    assert.equal(r.status, 200, aviso(r));
    assert.deepEqual(r.headers['set-cookie'], [cookie.serializarCookieDispositivo(nova)]);
  });

  test('K3-A8 — falha do serviço de contato vira o erro padrão (sem vazar), e a autenticação recusada não chega ao registro do contato', async (t) => {
    const registro = t.mock.method(monitoramentoService, 'registrarContato', async () => { throw new Error('falha interna sensível'); });
    t.mock.method(tabletService, 'autenticar', async () => { throw HttpError.unauthorized('DISPOSITIVO_NAO_AUTORIZADO', 'Dispositivo não autorizado'); });
    const recusada = await batida(gerarTokenSessao());
    assert.equal(recusada.status, 401, aviso(recusada));
    assert.equal(registro.mock.callCount(), 0, 'sem autenticação o contato nunca é registrado');
    t.mock.restoreAll(); // o mesmo método não é substituído duas vezes: cada parte do teste começa de um estado limpo
    t.mock.method(monitoramentoService, 'registrarContato', async () => { throw new Error('falha interna sensível'); });
    t.mock.method(tabletService, 'autenticar', async () => ({ dispositivo: { id: 7, empresaId: 3, nome: 'T', unidade: null, setor: null, localInstalacao: null }, novaCredencial: null }));
    const falha = await batida(gerarTokenSessao());
    assert.equal(falha.status, 500, aviso(falha));
    assert.equal(JSON.stringify(falha.body).includes('sensível'), false, 'a mensagem interna não vai ao cliente');
  });
});

describe('K3 — o heartbeat não consome o limitador geral nem altera as demais rotas do Token', () => {
  test('K3-A9 — no app REAL, o limitador GERAL por IP não se aplica ao heartbeat (vários tablets no mesmo NAT) mas continua valendo para o resto de /api', () => {
    const script = `
      process.env.RATE_LIMIT_GERAL_LIMITE = '3';
      const request = require('supertest');
      const app = require('./src/app');
      const { httpConfig } = require('./src/config/http');
      (async () => {
        const origem = httpConfig.cors.origens[0];
        const geral = []; const heartbeat = [];
        for (let i = 0; i < 6; i += 1) geral.push((await request(app).get('/api/rota-inexistente-do-teste')).status);
        for (let i = 0; i < 6; i += 1) heartbeat.push((await request(app).post('/api/atendimento-token/tablet/heartbeat').set('Origin', origem).send({})).status);
        console.log(JSON.stringify({ geral, heartbeat }));
        process.exit(0);
      })();`;
    const r = spawnSync(process.execPath, ['--require', './test/setup.js', '-e', script], { cwd: RAIZ, encoding: 'utf8', env: process.env });
    assert.equal(r.status, 0, r.stderr);
    const { geral, heartbeat } = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.deepEqual(geral, [404, 404, 404, 429, 429, 429], 'o resto de /api segue limitado a 3 por janela');
    assert.deepEqual(heartbeat, [401, 401, 401, 401, 401, 401], 'o heartbeat tem os limitadores próprios e não consome a cota geral');
  });

  test('K3-A12 — a cota por tablet do heartbeat (120 por minuto) é só dele: esgotá-la devolve 429 ao heartbeat e não consome a cota do /estado do mesmo tablet', async (t) => {
    t.mock.method(tabletService, 'autenticar', async () => ({ dispositivo: { id: 71, empresaId: 31, nome: 'Tablet K3-A12', unidade: null, setor: null, localInstalacao: null }, novaCredencial: null }));
    t.mock.method(monitoramentoService, 'registrarContato', async () => {});
    const credencial = gerarTokenSessao();
    const status = [];
    for (let i = 0; i < 122; i += 1) status.push((await batida(credencial)).status);
    assert.deepEqual(status.slice(0, 120), Array(120).fill(200));
    assert.deepEqual(status.slice(120), [429, 429], 'passou de 120 no minuto: o limite fino do heartbeat vale');
    const estado = await request(app).get('/api/atendimento-token/tablet/estado').set('Cookie', `${COOKIE}=${credencial}`);
    assert.equal(estado.status, 200, aviso(estado));
  });

  test('K3-A13 — o limite por IP do heartbeat (600 por minuto) é próprio: a 601ª batida do mesmo IP é 429 LIMITE_REQUISICOES_EXCEDIDO, sem depender do limitador geral', () => {
    const script = `
      const request = require('supertest');
      const app = require('./src/app');
      const { httpConfig } = require('./src/config/http');
      (async () => {
        const origem = httpConfig.cors.origens[0];
        const statusDe = [];
        for (let i = 0; i < 602; i += 1) {
          const r = await request(app).post('/api/atendimento-token/tablet/heartbeat').set('Origin', origem).send({});
          statusDe.push([r.status, r.body.codigo]);
        }
        console.log(JSON.stringify({ primeiras: statusDe.slice(0, 600).every(([s]) => s === 401), depois: statusDe.slice(600) }));
        process.exit(0);
      })();`;
    const r = spawnSync(process.execPath, ['--require', './test/setup.js', '-e', script], { cwd: RAIZ, encoding: 'utf8', env: process.env });
    assert.equal(r.status, 0, r.stderr);
    const { primeiras, depois } = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.equal(primeiras, true, 'as 600 primeiras chegam à autenticação (401)');
    assert.deepEqual(depois, [[429, 'LIMITE_REQUISICOES_EXCEDIDO'], [429, 'LIMITE_REQUISICOES_EXCEDIDO']]);
  });

  test('K3-A10 — as rotas do tablet e as demais rotas do Token montadas antes continuam presentes e com o mesmo comportamento', async () => {
    const rotas = rotasDoPortal();
    for (const existente of [
      'POST /atendimento-token/tablet/ativar', 'GET /atendimento-token/tablet/estado', 'POST /atendimento-token/tablet/atendimento',
      'GET /atendimento-token/tablet/atendimento/catalogo', 'POST /atendimento-token/tablet/atendimento/pedido', 'GET /atendimento-token/tablet/atendimento/solicitacoes',
      'GET /atendimento-token/dispositivos', 'GET /atendimento-token/visao-geral',
    ]) assert.ok(rotas.includes(existente), `rota ausente: ${existente}`);
    const estado = await request(app).get('/api/atendimento-token/tablet/estado');
    assert.deepEqual([estado.status, estado.body.codigo], [401, 'DISPOSITIVO_NAO_AUTORIZADO'], aviso(estado));
    const ativar = await request(app).post('/api/atendimento-token/tablet/ativar').set('Origin', ORIGEM_PERMITIDA).send({ campoExtra: 1 });
    assert.deepEqual([ativar.status, ativar.body.codigo], [400, 'VALIDACAO'], aviso(ativar));
  });

  test('K3-A11 — contrato do módulo: a fábrica criarTokenHeartbeatRoutes segue exportada com os mesmos limites e há uma instância pronta para o app, sem temporizador nem tocar em atendimento', () => {
    const modulo = require('../../src/routes/token-heartbeat.routes');
    assert.equal(typeof modulo.criarTokenHeartbeatRoutes, 'function');
    assert.deepEqual({ ...modulo.LIMITE_POR_IP }, { limite: 600, janelaSegundos: 60 });
    assert.deepEqual({ ...modulo.LIMITE_POR_DISPOSITIVO }, { limite: 120, janelaSegundos: 60 });
    assert.equal(typeof modulo.tokenHeartbeatRoutes, 'function', 'instância (router) para montar no app ainda não existe');
    // Só o código: os comentários de app.js também citam o router e não podem satisfazer a asserção.
    const fonte = fs.readFileSync(path.join(RAIZ, 'src/app.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    assert.ok(/require\('\.\/routes\/token-heartbeat\.routes'\)/.test(fonte), 'app.js deve carregar o módulo do heartbeat');
    assert.ok(/tokenTabletRoutes, tokenHeartbeatRoutes, tokenAtendimentoRoutes/.test(fonte), 'o router deve estar na cadeia de /api, depois do tablet e antes do atendimento');
  });
});
