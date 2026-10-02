'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { criarAppTeste } = require('../helpers/app-teste');
const rateLimit = require('../../src/middleware/rate-limit');
const { criarConviteUsuarioRoutes } = require('../../src/routes/convite-usuario.routes');
const { criarConviteMasterRoutes } = require('../../src/routes/convite-master.routes');
const { HttpError } = require('../../src/errors/HttpError');

/**
 * Rotas de criação e reenvio de convite (Bloco 11H), sem banco: controller e
 * sessão são falsos; validação, limitador e tratamento de erro são os reais.
 * Cadeia fixa: limitador de envio, sessão, validação, controller. O 429 vem
 * antes do 401 e o 401 antes de qualquer leitura de corpo. Criar e reenviar
 * dividem o mesmo contador por IP, então cancelar e criar de novo não escapa.
 */

const limitadorDe = (limite) => rateLimit.criarLimitador({ limite, janelaSegundos: 60 });
const SESSAO_INVALIDA = () => HttpError.unauthorized('SESSAO_INVALIDA', 'Sessão inválida ou expirada');

function sessaoFalsa({ valida = true } = {}) {
  const chamadas = [];
  const middleware = (req, res, next) => {
    chamadas.push(req.path);
    if (!valida) { next(SESSAO_INVALIDA()); return; }
    req.empresa = { id: 3, nome: 'Empresa' };
    req.usuario = { id: 5 };
    req.administradorPlataforma = { id: 1 };
    next();
  };
  return { middleware, chamadas };
}

function controllerFalso() {
  const chamadas = [];
  const metodo = (nome) => (req, res) => {
    chamadas.push({ nome, validado: req.validado });
    res.status(nome === 'criar' || nome === 'reenviar' ? 201 : 200).json({ status: 'ok', nome });
  };
  const controller = Object.fromEntries(['criar', 'reenviar', 'listar', 'buscar', 'cancelar', 'consultar', 'aceitar'].map((n) => [n, metodo(n)]));
  return { controller, chamadas };
}

describe('limitadores de envio de convite', () => {
  test('existem um limitador do Portal e um do Painel, instâncias distintas das demais', () => {
    for (const nome of ['limitadorEnvioConviteUsuario', 'limitadorPlataformaEnvioConvite']) {
      assert.equal(typeof rateLimit[nome], 'function', nome);
    }
    const todos = Object.entries(rateLimit).filter(([, v]) => typeof v === 'function').map(([, v]) => v);
    assert.equal(new Set(todos).size, todos.length, 'cada limitador é uma instância própria, com contador próprio');
  });
});

describe('convite de usuário — rotas de envio', () => {
  function montar({ valida = true, limite = 100 } = {}) {
    const sessao = sessaoFalsa({ valida });
    const { controller, chamadas } = controllerFalso();
    const app = criarAppTeste((a) => a.use('/api', criarConviteUsuarioRoutes({
      controller, exigirSessao: sessao.middleware, limitador: limitadorDe(1000), limitadorEnvio: limitadorDe(limite),
    })));
    return { app, chamadas, sessao };
  }

  test('POST /administracao/convites-usuario/:conviteId/reenviar chega ao controller com o id validado como string', async () => {
    const { app, chamadas } = montar();
    const r = await request(app).post('/api/administracao/convites-usuario/40/reenviar').send({});
    assert.equal(r.status, 201);
    assert.equal(chamadas.length, 1);
    assert.equal(chamadas[0].nome, 'reenviar');
    assert.deepEqual(chamadas[0].validado.params, { conviteId: '40' });
  });

  test('identificador inválido ou corpo com campo extra: 400 e o controller não é chamado', async () => {
    const { app, chamadas } = montar();
    for (const id of ['0', 'abc', '01', '1234567890123456789', '4%200']) {
      const r = await request(app).post(`/api/administracao/convites-usuario/${id}/reenviar`).send({});
      assert.equal(r.status, 400, id);
    }
    const extra = await request(app).post('/api/administracao/convites-usuario/40/reenviar').send({ empresaId: 9 });
    assert.equal(extra.status, 400);
    assert.deepEqual(chamadas, []);
  });

  test('sem sessão: 401 antes da validação e sem chamar o controller', async () => {
    const { app, chamadas } = montar({ valida: false });
    const r = await request(app).post('/api/administracao/convites-usuario/abc/reenviar').send({ qualquer: 1 });
    assert.equal(r.status, 401);
    assert.deepEqual(chamadas, []);
  });

  test('o limitador vem antes da sessão: esgotado o limite, o 429 chega mesmo sem sessão válida, sem tocar a sessão', async () => {
    const { app, sessao } = montar({ valida: false, limite: 1 });
    assert.equal((await request(app).post('/api/administracao/convites-usuario/40/reenviar').send({})).status, 401);
    const r = await request(app).post('/api/administracao/convites-usuario/40/reenviar').send({});
    assert.equal(r.status, 429);
    assert.equal(r.body.codigo, 'LIMITE_REQUISICOES_EXCEDIDO');
    assert.equal(sessao.chamadas.length, 1, 'a segunda requisição não chegou à sessão');
  });

  test('criar e reenviar dividem o mesmo contador por IP', async () => {
    const { app, chamadas } = montar({ limite: 2 });
    const corpoCriar = { email: 'pessoa@exemplo-cliente.com.br', nome: 'Ana Souza', tipoConta: 'USUARIO' };
    assert.equal((await request(app).post('/api/administracao/convites-usuario').send(corpoCriar)).status, 201);
    assert.equal((await request(app).post('/api/administracao/convites-usuario/40/reenviar').send({})).status, 201);
    assert.equal((await request(app).post('/api/administracao/convites-usuario').send(corpoCriar)).status, 429);
    assert.equal((await request(app).post('/api/administracao/convites-usuario/40/reenviar').send({})).status, 429);
    assert.equal(chamadas.length, 2);
  });

  test('listar, cancelar e as rotas públicas não consomem o contador de envio', async () => {
    const { app } = montar({ limite: 1 });
    assert.equal((await request(app).get('/api/administracao/convites-usuario')).status, 200);
    assert.equal((await request(app).post('/api/administracao/convites-usuario/40/cancelar').send({})).status, 200);
    assert.equal((await request(app).post('/api/convite-usuario/consultar').send({ token: 'A'.repeat(43) })).status, 200);
    assert.equal((await request(app).post('/api/administracao/convites-usuario/40/reenviar').send({})).status, 201);
  });
});

describe('convite do MASTER — rotas de envio', () => {
  function montar({ valida = true, limite = 100 } = {}) {
    const sessao = sessaoFalsa({ valida });
    const { controller, chamadas } = controllerFalso();
    const app = criarAppTeste((a) => a.use('/api/plataforma', criarConviteMasterRoutes({
      controller, exigirSessaoPlataforma: sessao.middleware, limitador: limitadorDe(1000), limitadorEnvio: limitadorDe(limite),
    })));
    return { app, chamadas, sessao };
  }

  test('POST /convites-master/:id/:conviteId/reenviar chega ao controller com os dois ids validados', async () => {
    const { app, chamadas } = montar();
    const r = await request(app).post('/api/plataforma/convites-master/3/40/reenviar').send({});
    assert.equal(r.status, 201);
    assert.equal(chamadas[0].nome, 'reenviar');
    assert.deepEqual(chamadas[0].validado.params, { id: 3, conviteId: '40' });
  });

  test('identificadores inválidos ou corpo com campo extra: 400 e o controller não é chamado', async () => {
    const { app, chamadas } = montar();
    for (const caminho of ['/0/40', '/abc/40', '/3/0', '/3/abc', '/3/01']) {
      const r = await request(app).post(`/api/plataforma/convites-master${caminho}/reenviar`).send({});
      assert.equal(r.status, 400, caminho);
    }
    assert.equal((await request(app).post('/api/plataforma/convites-master/3/40/reenviar').send({ email: 'x@y.com' })).status, 400);
    assert.deepEqual(chamadas, []);
  });

  test('sem sessão de plataforma: 401 e o controller não é chamado', async () => {
    const { app, chamadas } = montar({ valida: false });
    assert.equal((await request(app).post('/api/plataforma/convites-master/3/40/reenviar').send({})).status, 401);
    assert.deepEqual(chamadas, []);
  });

  test('o limitador vem antes da sessão e criar e reenviar dividem o mesmo contador', async () => {
    const { app, chamadas } = montar({ limite: 2 });
    assert.equal((await request(app).post('/api/plataforma/empresas/3/convites-master').send({ email: 'pessoa@exemplo-cliente.com.br' })).status, 201);
    assert.equal((await request(app).post('/api/plataforma/convites-master/3/40/reenviar').send({})).status, 201);
    assert.equal((await request(app).post('/api/plataforma/convites-master/3/40/reenviar').send({})).status, 429);
    assert.equal((await request(app).post('/api/plataforma/empresas/3/convites-master').send({ email: 'pessoa@exemplo-cliente.com.br' })).status, 429);
    assert.equal(chamadas.length, 2);

    const semSessao = montar({ valida: false, limite: 1 });
    assert.equal((await request(semSessao.app).post('/api/plataforma/convites-master/3/40/reenviar').send({})).status, 401);
    assert.equal((await request(semSessao.app).post('/api/plataforma/convites-master/3/40/reenviar').send({})).status, 429);
    assert.equal(semSessao.sessao.chamadas.length, 1);
  });

  test('cancelar, listar, buscar e as rotas públicas não consomem o contador de envio', async () => {
    const { app } = montar({ limite: 1 });
    assert.equal((await request(app).get('/api/plataforma/empresas/3/convites-master')).status, 200);
    assert.equal((await request(app).get('/api/plataforma/convites-master/3/40')).status, 200);
    assert.equal((await request(app).post('/api/plataforma/convites-master/3/40/cancelar').send({})).status, 200);
    assert.equal((await request(app).post('/api/plataforma/convite-master/consultar').send({ token: 'A'.repeat(43) })).status, 200);
    assert.equal((await request(app).post('/api/plataforma/convites-master/3/40/reenviar').send({})).status, 201);
  });
});
