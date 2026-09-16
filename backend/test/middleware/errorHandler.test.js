'use strict';

const { describe, test, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { HttpError } = require('../../src/errors/HttpError');
const { notFoundHandler, errorHandler } = require('../../src/middleware/errorHandler');
const { criarAppTeste } = require('../helpers/app-teste');
const { assertSemSensiveis } = require('../helpers/sensiveis');

const SENHA = 'MinhaSenha#2026';
const EMAIL = 'luis@empresa.com';
const CNPJ = '12345678000195';
const TOKEN = 'tokenSecretoABC123';
const SQL = "select senha_hash from usuarios where email = 'luis@empresa.com'";
const SENSIVEIS = [SENHA, EMAIL, CNPJ, TOKEN, 'Bearer', 'senha_hash', SQL];
const CABECALHOS = { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN, cookie: 'gepi_sessao=' + TOKEN };
const CORPO_500 = { status: 'error', codigo: 'ERRO_INTERNO', message: 'Erro interno do servidor' };

const app = criarAppTeste((a) => {
  a.post('/validacao', (req, res, next) => next(HttpError.validacao([{ campo: 'body.email', codigo: 'EMAIL_INVALIDO', mensagem: 'E-mail inválido' }])));
  a.get('/429', (req, res, next) => next(HttpError.tooManyRequests(undefined, undefined, { retryAfterSegundos: 900 })));
  a.get('/401', (req, res, next) => next(HttpError.unauthorized()));
  a.get('/500-comum', (req, res, next) => next(new Error(`erro no SQL: ${SQL} -- ${SENHA}`)));
  a.get('/500-http', (req, res, next) => next(HttpError.internal(new Error('causa interna com ' + CNPJ))));
  a.get('/500-http-descritivo', (req, res, next) => next(new HttpError(500, 'ERRO_X', 'texto interno descritivo', { detalhes: [{ interno: true }] })));
  a.get('/503', (req, res, next) => next(HttpError.serviceUnavailable()));
  a.get('/nao-erro', (req, res, next) => next('string lançada'));
  a.get('/throw', () => { throw new Error('exceção síncrona'); });
  a.get('/500-sensivel', (req, res, next) => {
    const causa = new RangeError(`causa com ${EMAIL} e ${TOKEN}`);
    const erro = new Error(`mensagem com ${SENHA}, ${EMAIL}, ${CNPJ}, ${TOKEN}\n    at forjado (/tmp/${SENHA}:1:1)`, { cause: causa });
    erro.body = `{"senha":"${SENHA}"}`;
    erro.detail = `Key (email)=(${EMAIL}) already exists`;
    erro.code = '23505';
    erro.headers = { authorization: 'Bearer ' + TOKEN };
    next(erro);
  });
  a.get('/500-http-sensivel', (req, res, next) => next(HttpError.internal(new Error(`pg: ${CNPJ} ${SENHA}`, { cause: new TypeError(`raiz ${EMAIL}`) }))));
  a.get('/500-nome-invalido', (req, res, next) => {
    const erro = new Error('x');
    Object.defineProperty(erro, 'name', { value: 'Nome com ' + SENHA });
    erro.codigo = 'COD ' + SENHA;
    erro.code = 'AB ' + TOKEN;
    erro.type = TOKEN + '!';
    next(erro);
  });
});

let logs;
beforeEach(() => {
  logs = [];
  mock.method(console, 'error', (...args) => logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')));
});
afterEach(() => mock.restoreAll());

const logLimpo = (rotulo) => {
  assert.equal(logs.length, 1, `${rotulo} deve logar uma linha`);
  assert.ok(logs[0].startsWith('[error]'), rotulo);
  assertSemSensiveis(logs[0], SENSIVEIS, `log ${rotulo}`);
  for (const proibido of ['"stack"', '"mensagem"', '"message"', '"body"', '"detail"', '"headers"', 'forjado', '/tmp/', 'cookie']) {
    assert.equal(logs[0].includes(proibido), false, `log ${rotulo} contém ${proibido}`);
  }
};

describe('JSON malformado', () => {
  test('resposta fixa JSON_INVALIDO, sem mensagem do parser, sem log', async () => {
    for (const corpo of [`{"senha": "${SENHA}", "email": `, `"${SENHA}"`, `{bad ${CNPJ}`, `[1, 2,`, `{"a": 1} extra ${SENHA}`]) {
      logs = [];
      const r = await request(app).post('/validacao').set(CABECALHOS).send(corpo);
      assert.equal(r.status, 400);
      assert.deepEqual(r.body, { status: 'error', codigo: 'JSON_INVALIDO', message: 'JSON inválido' });
      assertSemSensiveis(r.text, SENSIVEIS, 'resposta');
      assert.deepEqual(logs, []);
    }
  });
});

describe('HttpError público', () => {
  test('400 de validação sai com codigo e detalhes, sem log', async () => {
    const r = await request(app).post('/validacao').set(CABECALHOS).send({ senha: SENHA, email: EMAIL });
    assert.equal(r.status, 400);
    assert.deepEqual(r.body, { status: 'error', codigo: 'VALIDACAO', message: 'Dados inválidos', detalhes: [{ campo: 'body.email', codigo: 'EMAIL_INVALIDO', mensagem: 'E-mail inválido' }] });
    assertSemSensiveis(r.text, SENSIVEIS, 'resposta');
    assert.deepEqual(logs, []);
  });

  test('429 com Retry-After e sem detalhes; 401 simples', async () => {
    const r = await request(app).get('/429');
    assert.equal(r.status, 429);
    assert.equal(r.headers['retry-after'], '900');
    assert.deepEqual(r.body, { status: 'error', codigo: 'LIMITE_EXCEDIDO', message: 'Muitas tentativas. Tente novamente mais tarde' });
    const u = await request(app).get('/401');
    assert.deepEqual([u.status, u.body], [401, { status: 'error', codigo: 'NAO_AUTENTICADO', message: 'Autenticação necessária' }]);
    assert.deepEqual(logs, []);
  });
});

describe('erros internos', () => {
  test('Error comum com SQL e senha: corpo genérico, log só com metadados', async () => {
    const r = await request(app).get('/500-comum').set(CABECALHOS);
    assert.deepEqual([r.status, r.body], [500, CORPO_500]);
    assertSemSensiveis(r.text, SENSIVEIS, 'resposta');
    logLimpo('500-comum');
    assert.ok(logs[0].includes('"nome":"Error"'));
    assert.ok(logs[0].includes('"metodo":"GET"') && logs[0].includes('"rota":"/500-comum"'));
  });

  test('message, cause, stack forjado, body e detail sensíveis nunca chegam ao log', async () => {
    const r = await request(app).get('/500-sensivel').set(CABECALHOS);
    assert.deepEqual([r.status, r.body], [500, CORPO_500]);
    logLimpo('500-sensivel');
    assert.ok(logs[0].includes('"codigoBiblioteca":"23505"'));
    assert.ok(logs[0].includes('"causas":["RangeError"]'));
  });

  test('HttpError.internal com cadeia de causas: nomes apenas', async () => {
    const r = await request(app).get('/500-http-sensivel');
    assert.deepEqual([r.status, r.body], [500, CORPO_500]);
    logLimpo('500-http-sensivel');
    assert.ok(logs[0].includes('"nome":"HttpError"') && logs[0].includes('"codigo":"ERRO_INTERNO"') && logs[0].includes('"causas":["Error","TypeError"]'));
    const h = await request(app).get('/500-http');
    assert.deepEqual([h.status, h.body], [500, CORPO_500]);
    assertSemSensiveis(h.text, [CNPJ], 'resposta');
  });

  test('nome, codigo, code e type forjados são omitidos do log', async () => {
    const r = await request(app).get('/500-nome-invalido');
    assert.deepEqual([r.status, r.body], [500, CORPO_500]);
    logLimpo('500-nome-invalido');
    assert.ok(logs[0].includes('"nome":"Error"'));
    assert.equal(logs[0].includes('"codigo"') || logs[0].includes('"codigoBiblioteca"') || logs[0].includes('"tipo"'), false);
  });

  test('HttpError 5xx descritivo, 503, valor não Error e exceção síncrona: corpo genérico', async () => {
    const d = await request(app).get('/500-http-descritivo');
    assert.deepEqual([d.status, d.body], [500, { status: 'error', codigo: 'ERRO_X', message: 'Erro interno do servidor' }]);
    assert.equal(d.text.includes('descritivo') || d.text.includes('interno":true'), false);
    const s = await request(app).get('/503');
    assert.deepEqual([s.status, s.body], [503, { status: 'error', codigo: 'INDISPONIVEL', message: 'Erro interno do servidor' }]);
    logs = [];
    const n = await request(app).get('/nao-erro');
    assert.deepEqual([n.status, n.body], [500, CORPO_500]);
    assert.ok(logs[0].includes('"nome":"NaoErro"'));
    const t = await request(app).get('/throw');
    assert.deepEqual([t.status, t.body], [500, CORPO_500]);
  });
});

describe('delegação e 404', () => {
  test('com cabeçalhos já enviados delega ao Express sem responder nem logar', () => {
    const erro = new Error('depois de enviar ' + SENHA);
    const chamadas = [];
    const res = { headersSent: true, status: () => { throw new Error('não deve responder'); }, json: () => { throw new Error('não deve responder'); }, set: () => {} };
    errorHandler(erro, { method: 'GET' }, res, (e) => chamadas.push(e));
    assert.deepEqual(chamadas, [erro]);
    assert.deepEqual(logs, []);
  });

  test('erro inesperado com status inteiro e type seguro: 500 genérico e log só com esses metadados', () => {
    // type sintético: não é de biblioteca e não tem tradução específica.
    const res = { headersSent: false, status(codigo) { this.codigo = codigo; return this; }, json(corpo) { this.corpo = corpo; }, set() {} };
    const erro = new Error('mensagem interna com ' + SENHA);
    erro.status = 400;
    erro.type = 'teste.erro.inesperado';
    erro.body = 'CORPO_SENTINELA';
    errorHandler(erro, { method: 'post inválido', route: { path: 42 } }, res, () => {});
    assert.deepEqual([res.codigo, res.corpo], [500, CORPO_500]);
    assert.equal(logs.length, 1);
    assert.ok(logs[0].includes('"status":400') && logs[0].includes('"tipo":"teste.erro.inesperado"'));
    assert.equal(logs[0].includes('metodo') || logs[0].includes('rota'), false);
    assertSemSensiveis(logs[0], [SENHA, 'CORPO_SENTINELA', 'mensagem interna', '"message"', '"stack"', '"body"'], 'log');
  });

  test('notFoundHandler e health inalterados', async () => {
    const r = await request(app).get('/nao-existe');
    assert.deepEqual([r.status, r.body], [404, { status: 'error', message: 'Rota não encontrada: GET /nao-existe' }]);
    assert.equal(typeof notFoundHandler, 'function');
    assert.deepEqual(logs, []);
  });
});

describe('erros do body-parser traduzidos para respostas fixas', () => {
  // Reproduz só os campos observados nos erros reais do body-parser 2.3:
  // type, status, expose e, conforme o caso, length/limit, charset, encoding.
  const LENGTH = 987654321;
  const MENSAGEM_LIB = 'MENSAGEM_BIBLIOTECA_SENTINELA_2f8a';
  const CHARSET = 'CHARSET_SENTINELA_3c7d';
  const ENCODING = 'ENCODING_SENTINELA_8e4b';
  const erroBodyParser = (type, status, extras = {}) => Object.assign(new Error(MENSAGEM_LIB), { type, status, statusCode: status, expose: true, ...extras });
  const responder = (erro) => {
    const res = { headersSent: false, status(codigo) { this.codigo = codigo; return this; }, json(corpo) { this.corpo = corpo; }, set() {} };
    errorHandler(erro, { method: 'POST', route: { path: '/api/eco' } }, res, () => { throw new Error('não deve delegar'); });
    return res;
  };
  const semVazamento = (res, rotulo) => {
    const texto = JSON.stringify(res.corpo);
    assertSemSensiveis(texto, [MENSAGEM_LIB, CHARSET, ENCODING, String(LENGTH)], `resposta ${rotulo}`);
    assert.deepEqual(Object.keys(res.corpo).sort(), ['codigo', 'message', 'status'], rotulo);
    assert.deepEqual(logs, [], `${rotulo} não deve logar`);
  };

  test('entity.too.large: 413 PAYLOAD_MUITO_GRANDE sem length, limit ou mensagem da biblioteca', () => {
    const res = responder(erroBodyParser('entity.too.large', 413, { length: LENGTH, limit: 32768 }));
    assert.equal(res.codigo, 413);
    assert.deepEqual(res.corpo, { status: 'error', codigo: 'PAYLOAD_MUITO_GRANDE', message: 'Corpo da requisição excede o tamanho máximo permitido' });
    semVazamento(res, '413');
  });

  test('charset.unsupported: 415 CODIFICACAO_NAO_SUPORTADA sem o charset recebido', () => {
    const res = responder(erroBodyParser('charset.unsupported', 415, { charset: CHARSET }));
    assert.equal(res.codigo, 415);
    assert.deepEqual(res.corpo, { status: 'error', codigo: 'CODIFICACAO_NAO_SUPORTADA', message: 'Charset ou codificação do corpo não suportados: envie JSON em UTF-8 sem compressão' });
    semVazamento(res, '415 charset');
  });

  test('encoding.unsupported: 415 CODIFICACAO_NAO_SUPORTADA sem o encoding recebido', () => {
    const res = responder(erroBodyParser('encoding.unsupported', 415, { encoding: ENCODING }));
    assert.equal(res.codigo, 415);
    assert.equal(res.corpo.codigo, 'CODIFICACAO_NAO_SUPORTADA');
    semVazamento(res, '415 encoding');
  });

  test('entity.parse.failed continua 400 JSON_INVALIDO (regressão)', () => {
    const res = responder(Object.assign(erroBodyParser('entity.parse.failed', 400), { body: 'CORPO_SENTINELA' }));
    assert.equal(res.codigo, 400);
    assert.deepEqual(res.corpo, { status: 'error', codigo: 'JSON_INVALIDO', message: 'JSON inválido' });
    assert.deepEqual(logs, []);
  });

  test('erro com status 4xx mas sem type conhecido continua 500 genérico', () => {
    const res = responder(Object.assign(new Error(MENSAGEM_LIB), { status: 400, expose: true }));
    assert.equal(res.codigo, 500);
    assert.equal(res.corpo.codigo, 'ERRO_INTERNO');
    assertSemSensiveis(JSON.stringify(res.corpo), [MENSAGEM_LIB], 'resposta');
  });
});
