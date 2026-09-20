'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const request = require('supertest');
const { Test: TesteSupertest } = require('supertest');

/**
 * Contrato de infraestrutura da suíte: o servidor efêmero que o supertest abre
 * sozinho precisa ficar em 127.0.0.1/IPv4.
 *
 * Supertest conecta esses servidores por 127.0.0.1. No macOS, listen(0) sem
 * host abre :: em dual-stack e pode receber uma porta que já está ocupada
 * especificamente em IPv4 por outro processo; a conexão é então entregue ao
 * socket mais específico, ou seja, ao processo errado. Quem impõe este
 * contrato é test/setup.js, que adapta apenas serverAddress e end do supertest
 * e não modifica http.Server.prototype.listen.
 */

const esperarListening = (servidor) =>
  new Promise((resolve, reject) => {
    if (servidor.address() !== null) return resolve();
    servidor.once('listening', resolve);
    servidor.once('error', reject);
  });

const fechar = (servidor) => new Promise((resolve) => servidor.close(resolve));

test('o servidor que o supertest abre sozinho escuta em 127.0.0.1/IPv4', async () => {
  const servidor = http.createServer((req, res) => res.end('ok'));
  const teste = new TesteSupertest(servidor, 'GET', '/');
  try {
    assert.equal(teste._server, servidor, 'o supertest deve ligar o servidor recebido');
    await esperarListening(servidor);
    const endereco = servidor.address();
    assert.equal(endereco.address, '127.0.0.1', `endereço real ${endereco.address}`);
    assert.equal(endereco.family, 'IPv4', `family real ${endereco.family}`);
  } finally {
    await fechar(servidor);
  }
});

test('request(app) continua entregando a requisição ao app', async () => {
  const app = (req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ metodo: req.method, rota: req.url }));
  };

  const r = await request(app).get('/infra/eco');

  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { metodo: 'GET', rota: '/infra/eco' });
});

test('servidor já ouvindo é reutilizado, sem novo bind', async () => {
  const servidor = http.createServer((req, res) => res.end('reutilizado'));
  await new Promise((resolve) => servidor.listen(0, '127.0.0.1', resolve));
  const porta = servidor.address().port;

  try {
    const teste = new TesteSupertest(servidor, 'GET', '/');
    assert.equal(teste._server, undefined, 'não deve abrir um segundo servidor');
    assert.equal(teste.url, `http://127.0.0.1:${porta}/`, 'a URL deve vir do servidor existente');

    const r = await request(servidor).get('/');

    assert.equal(r.text, 'reutilizado');
    assert.equal(servidor.address().port, porta, 'a porta não deve mudar');
  } finally {
    await fechar(servidor);
  }
});
