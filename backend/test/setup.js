'use strict';

// Carregado via --require antes de qualquer módulo de teste ou de src/.
// O segredo do HMAC existe SOMENTE em memória durante a execução: gerado a
// cada rodada, nunca lido do .env real nem gravado em disco. Cada arquivo de
// teste roda em processo próprio e herda este ambiente.
const crypto = require('node:crypto');

process.env.NODE_ENV = 'test';
process.env.LOGIN_COOLDOWN_HMAC_SECRET = crypto.randomBytes(32).toString('hex');

// Rate limit praticamente desligado para o app real: a suíte faz muitas
// requisições a /api e o MemoryStore vive enquanto o processo do arquivo de
// teste existir. O contrato do limitador é exercitado com factories de
// limite pequeno em test/middleware/rate-limit.test.js. Infraestrutura da
// suíte apenas: nenhum desvio no código de produção.
process.env.RATE_LIMIT_GERAL_LIMITE = '100000';
process.env.RATE_LIMIT_AUTH_LIMITE = '100000';

// ---------------------------------------------------------------------------
// Loopback IPv4 no servidor efêmero que o supertest cria.
//
// Supertest conecta seus servidores efêmeros por 127.0.0.1. No macOS,
// listen(0) sem host pode abrir :: em dual-stack e receber uma porta que já
// está ocupada especificamente em IPv4 por outro processo. Forçar IPv4 nesse
// servidor impede que a requisição seja entregue ao processo errado.
//
// O ajuste é restrito ao servidor que o próprio supertest abre quando recebe
// um app ainda não ligado: http.Server.prototype.listen não é tocado, qualquer
// outro servidor mantém o comportamento nativo do Node e node_modules fica
// intacto. Um servidor já ouvindo segue pelo caminho original, sem novo bind.
//
// Informar um host faz o Node resolver o endereço antes de ligar, então
// address() só existe a partir do evento 'listening', enquanto o supertest o
// lê de forma síncrona logo depois do listen. Por isso a montagem da URL é
// adiada para o envio da requisição. Quem a constrói continua sendo o
// serverAddress original, que já distingue HTTP de HTTPS.
// ---------------------------------------------------------------------------
const { Test: TesteSupertest } = require('supertest');

const LOOPBACK_IPV4 = '127.0.0.1';
const serverAddressOriginal = TesteSupertest.prototype.serverAddress;
const endOriginal = TesteSupertest.prototype.end;

TesteSupertest.prototype.serverAddress = function serverAddress(app, caminho) {
  if (typeof app !== 'string' && app.address() === null) {
    this._server = app.listen(0, LOOPBACK_IPV4);
    this._caminhoPendente = caminho;
    return null;
  }
  return serverAddressOriginal.call(this, app, caminho);
};

TesteSupertest.prototype.end = function end(callback) {
  if (this._caminhoPendente === undefined) {
    return endOriginal.call(this, callback);
  }

  const servidor = this._server;
  const caminho = this._caminhoPendente;
  this._caminhoPendente = undefined;

  if (servidor.address() !== null) {
    this.url = serverAddressOriginal.call(this, servidor, caminho);
    return endOriginal.call(this, callback);
  }

  servidor.once('listening', () => {
    this.url = serverAddressOriginal.call(this, servidor, caminho);
    endOriginal.call(this, callback);
  });
  return this;
};
