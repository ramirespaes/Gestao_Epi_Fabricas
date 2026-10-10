'use strict';

const { describe, test, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const express = require('express');
const rateLimit = require('../../src/middleware/rate-limit');
const { notFoundHandler, errorHandler } = require('../../src/middleware/errorHandler');

/**
 * Revelação do CPF (RED) — limite próprio: 10 revelações por minuto por USUÁRIO AUTENTICADO + EMPRESA (nunca só por IP:
 * várias pessoas da empresa compartilham o IP/NAT). O limitador roda DEPOIS da sessão e da autorização, então só conta
 * quem já pode revelar. O 429 segue o formato padrão da API (corpo fixo, Retry-After da biblioteca), sem CPF e sem log.
 */

const CORPO_429 = { status: 'error', codigo: 'LIMITE_REQUISICOES_EXCEDIDO', message: 'Muitas requisições. Tente novamente mais tarde' };

// "Sessão" de teste: empresa e usuário vêm de cabeçalhos x-e e x-u, como se a autenticação real os tivesse preenchido.
function app(limitador) {
  const a = express();
  a.use(express.json());
  a.post('/revelar', (req, res, next) => {
    req.empresa = { id: Number(req.headers['x-e']) };
    req.usuario = { id: Number(req.headers['x-u']) };
    next();
  }, limitador, (req, res) => res.json({ status: 'ok', cpf: '52998224725' }));
  a.use(notFoundHandler);
  a.use(errorHandler);
  return a;
}
const novoLimitador = () => {
  assert.equal(typeof rateLimit.criarLimitadorRevelacaoCpf, 'function', 'criarLimitadorRevelacaoCpf ainda não existe');
  return rateLimit.criarLimitadorRevelacaoCpf();
};
const chamar = (a, e, u, ip = '203.0.113.1') => request(a).post('/revelar').set('x-e', String(e)).set('x-u', String(u)).set('X-Forwarded-For', ip).send({});

let logs;
beforeEach(() => { logs = []; mock.method(console, 'error', (...args) => logs.push(args.map(String).join(' '))); });
afterEach(() => mock.restoreAll());

describe('limitador da revelação do CPF', () => {
  test('o contrato fixa 10 por minuto, e a chave é empresa + usuário', () => {
    assert.deepEqual(rateLimit.LIMITE_REVELACAO_CPF, { limite: 10, janelaSegundos: 60 });
    assert.equal(typeof rateLimit.criarLimitadorRevelacaoCpf, 'function');
    assert.equal(typeof rateLimit.limitadorRevelacaoCpf, 'function', 'instância compartilhada usada pelas rotas reais');
  });

  test('10 passam e a 11ª recebe 429 padrão com Retry-After, sem CPF e sem log', async () => {
    const a = app(novoLimitador());
    for (let i = 0; i < 10; i += 1) assert.equal((await chamar(a, 1, 7)).status, 200, `chamada ${i + 1}`);
    const bloqueada = await chamar(a, 1, 7);
    assert.equal(bloqueada.status, 429);
    assert.deepEqual(bloqueada.body, CORPO_429);
    const espera = Number(bloqueada.headers['retry-after']);
    assert.ok(Number.isInteger(espera) && espera >= 1 && espera <= 60, `Retry-After ${bloqueada.headers['retry-after']}`);
    assert.equal(JSON.stringify(bloqueada.body).includes('52998224725'), false);
    assert.deepEqual(logs, []);
    assert.equal((await chamar(a, 1, 7)).status, 429, 'segue bloqueado dentro da janela');
  });

  test('a chave NÃO é o IP: outro usuário da mesma empresa e do mesmo IP não é afetado pelo bloqueio do primeiro', async () => {
    const a = app(novoLimitador());
    for (let i = 0; i < 11; i += 1) await chamar(a, 1, 7);
    assert.equal((await chamar(a, 1, 7)).status, 429);
    assert.equal((await chamar(a, 1, 8)).status, 200, 'colega no mesmo IP');
  });

  test('o mesmo usuário em outra empresa tem contador próprio (empresa faz parte da chave); trocar de IP não zera o contador', async () => {
    const a = app(novoLimitador());
    for (let i = 0; i < 10; i += 1) await chamar(a, 1, 7, '203.0.113.1');
    assert.equal((await chamar(a, 1, 7, '198.51.100.20')).status, 429, 'mudar de IP não contorna o limite');
    assert.equal((await chamar(a, 2, 7)).status, 200, 'mesma pessoa numérica em outra empresa');
  });

  test('instâncias criadas pela fábrica não compartilham contador', async () => {
    const um = app(novoLimitador());
    const dois = app(novoLimitador());
    for (let i = 0; i < 11; i += 1) await chamar(um, 1, 7);
    assert.equal((await chamar(um, 1, 7)).status, 429);
    assert.equal((await chamar(dois, 1, 7)).status, 200);
  });

  test('criarLimitador aceita uma chave própria e continua por IP quando ela não é informada (os limitadores existentes não mudam)', async () => {
    const porChave = express();
    porChave.post('/x', rateLimit.criarLimitador({ limite: 1, janelaSegundos: 60, chave: (req) => req.headers['x-k'] }), (req, res) => res.json({ ok: true }));
    porChave.use(notFoundHandler); porChave.use(errorHandler);
    assert.equal((await request(porChave).post('/x').set('x-k', 'a')).status, 200);
    assert.equal((await request(porChave).post('/x').set('x-k', 'b')).status, 200);
    assert.equal((await request(porChave).post('/x').set('x-k', 'a')).status, 429);

    const porIp = express();
    porIp.post('/x', rateLimit.criarLimitador({ limite: 1, janelaSegundos: 60 }), (req, res) => res.json({ ok: true }));
    porIp.use(notFoundHandler); porIp.use(errorHandler);
    assert.equal((await request(porIp).post('/x')).status, 200);
    assert.equal((await request(porIp).post('/x')).status, 429);
  });
});
