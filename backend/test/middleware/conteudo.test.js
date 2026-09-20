'use strict';

const { describe, test, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const express = require('express');
const zlib = require('node:zlib');
const { exigirJson, parserJson } = require('../../src/middleware/conteudo');
const { notFoundHandler, errorHandler } = require('../../src/middleware/errorHandler');
const { assertSemSensiveis } = require('../helpers/sensiveis');

const CORPO = 'CORPO_SENTINELA_9f3a';
const COOKIE = 'COOKIE_SENTINELA_7b1c';
const AUTH = 'AUTH_SENTINELA_5d2e';
const CT_PARAM = 'CTPARAM_SENTINELA_1a9f';
const CHARSET = 'CHARSET_SENTINELA_3c7d';
const ENCODING = 'ENCODING_SENTINELA_8e4b';
const SENSIVEIS = [CORPO, COOKIE, AUTH, CT_PARAM, CHARSET, ENCODING, 'Bearer', 'text/plain', 'iso-8859-1', 'request entity', 'unsupported'];
const CABECALHOS = { cookie: `gepi_sessao=${COOKIE}`, authorization: `Bearer ${AUTH}` };

// Cadeia equivalente à do app real dentro de /api: exigirJson -> parser -> rotas.
const app = express();
app.use('/api', exigirJson, parserJson);
for (const metodo of ['post', 'put', 'patch']) {
  app[metodo]('/api/eco', (req, res) => res.json({ metodo, tipo: typeof req.body, body: req.body }));
}
app.get('/api/eco', (req, res) => res.json({ metodo: 'get' }));
app.options('/api/eco', (req, res) => res.status(204).end());
app.post('/fora', (req, res) => res.json({ tipo: typeof req.body }));
app.use(notFoundHandler);
app.use(errorHandler);

const JSON_LIMITE_BYTES = 32768;
// JSON válido com exatamente N bytes: {"senha":"<k caracteres a>"} tem k + 12 bytes.
const corpoComBytes = (bytes) => `{"senha":"${'a'.repeat(bytes - 12)}"}`;

let logs;
beforeEach(() => {
  logs = [];
  mock.method(console, 'error', (...args) => logs.push(args.map(String).join(' ')));
});
afterEach(() => mock.restoreAll());

const esperar415 = (r, codigo, rotulo) => {
  assert.equal(r.status, 415, rotulo);
  assert.deepEqual(Object.keys(r.body).sort(), ['codigo', 'message', 'status'], rotulo);
  assert.equal(r.body.codigo, codigo, rotulo);
  assertSemSensiveis(r.text, SENSIVEIS, `resposta ${rotulo}`);
  assert.deepEqual(logs, [], `${rotulo} não deve logar`);
};

describe('exigirJson: tipo de mídia em POST, PUT e PATCH', () => {
  const incompativeis = [
    ['text/plain', CORPO],
    [`text/plain; charset=${CT_PARAM}`, CORPO],
    ['application/x-www-form-urlencoded', `senha=${CORPO}`],
    ['multipart/form-data; boundary=x', `--x\r\nContent-Disposition: form-data; name="senha"\r\n\r\n${CORPO}\r\n--x--`],
    ['application/vnd.api+json', `{"senha":"${CORPO}"}`],
    ['application/jsonx', `{"senha":"${CORPO}"}`],
  ];

  for (const metodo of ['post', 'put', 'patch']) {
    test(`${metodo.toUpperCase()} com corpo e tipo incompatível: 415 TIPO_CONTEUDO_NAO_SUPORTADO`, async () => {
      for (const [tipo, corpo] of incompativeis) {
        logs = [];
        const r = await request(app)[metodo]('/api/eco').set(CABECALHOS).set('content-type', tipo).send(corpo);
        esperar415(r, 'TIPO_CONTEUDO_NAO_SUPORTADO', `${metodo} ${tipo}`);
        assert.equal(r.body.message, 'Content-Type deve ser application/json');
      }
      logs = [];
      // Buffer não recebe Content-Type automático do superagent; unset deixa a ausência explícita.
      const semTipo = await request(app)[metodo]('/api/eco').set(CABECALHOS).send(Buffer.from(`{"senha":"${CORPO}"}`)).unset('Content-Type');
      esperar415(semTipo, 'TIPO_CONTEUDO_NAO_SUPORTADO', `${metodo} sem content-type`);
    });

    test(`${metodo.toUpperCase()} com application/json e parâmetros válidos passa`, async () => {
      for (const tipo of ['application/json', 'application/json; charset=utf-8', 'APPLICATION/JSON', 'Application/Json;charset=UTF-8']) {
        const r = await request(app)[metodo]('/api/eco').set('content-type', tipo).send('{"a":1}');
        assert.deepEqual([r.status, r.body], [200, { metodo, tipo: 'object', body: { a: 1 } }], tipo);
      }
    });

    test(`${metodo.toUpperCase()} sem corpo passa, mesmo com Content-Type incompatível e Content-Length: 0`, async () => {
      const semNada = await request(app)[metodo]('/api/eco');
      assert.equal(semNada.status, 200, 'sem corpo e sem content-type');
      const zeroTextPlain = await request(app)[metodo]('/api/eco').set('content-type', 'text/plain').set('content-length', '0');
      assert.equal(zeroTextPlain.status, 200, 'Content-Length: 0 com text/plain');
      assert.deepEqual(logs, []);
    });
  }

  test('GET, HEAD e OPTIONS não exigem JSON', async () => {
    const get = await request(app).get('/api/eco').set('content-type', 'text/plain');
    assert.deepEqual([get.status, get.body], [200, { metodo: 'get' }]);
    const head = await request(app).head('/api/eco').set('content-type', 'text/plain');
    assert.equal(head.status, 200);
    const options = await request(app).options('/api/eco').set('content-type', 'text/plain');
    assert.equal(options.status, 204);
  });

  test('a política vale só dentro de /api', async () => {
    const r = await request(app).post('/fora').set('content-type', 'text/plain').send(CORPO);
    assert.deepEqual([r.status, r.body], [200, { tipo: 'undefined' }]);
  });
});

describe('exigirJson: Transfer-Encoding indica possibilidade de corpo, sem ler o stream', () => {
  // Requisição controlada com o protótipo de req do Express (para req.is),
  // sem socket nem chunks: a decisão usa apenas método e cabeçalhos.
  const requisicao = (headers) => Object.assign(Object.create(express.request), { method: 'POST', headers });
  const executar = (headers) => {
    const chamadas = [];
    exigirJson(requisicao(headers), {}, (erro) => chamadas.push(erro));
    return chamadas;
  };

  test('chunked com text/plain: 415 TIPO_CONTEUDO_NAO_SUPORTADO', () => {
    const [erro] = executar({ 'transfer-encoding': 'chunked', 'content-type': `text/plain; charset=${CT_PARAM}` });
    assert.equal(erro.status, 415);
    assert.deepEqual(erro.corpoResposta(), { status: 'error', codigo: 'TIPO_CONTEUDO_NAO_SUPORTADO', message: 'Content-Type deve ser application/json' });
    assertSemSensiveis(JSON.stringify(erro.corpoResposta()), [CT_PARAM, 'text/plain'], 'erro 415');
  });

  test('chunked com application/json: next() sem erro', () => {
    assert.deepEqual(executar({ 'transfer-encoding': 'chunked', 'content-type': 'application/json; charset=utf-8' }), [undefined]);
  });

  test('chunked sem Content-Type: 415; sem cabeçalho algum: passa', () => {
    assert.equal(executar({ 'transfer-encoding': 'chunked' })[0].status, 415);
    assert.deepEqual(executar({}), [undefined]);
  });
});

describe('parserJson: limite de 32 KiB medido no corpo HTTP bruto', () => {
  test('corpo de exatamente 32768 bytes é aceito', async () => {
    const corpo = corpoComBytes(JSON_LIMITE_BYTES);
    assert.equal(Buffer.byteLength(corpo), JSON_LIMITE_BYTES);
    const r = await request(app).post('/api/eco').set('content-type', 'application/json').send(corpo);
    assert.equal(r.status, 200);
    assert.equal(r.body.body.senha.length, JSON_LIMITE_BYTES - 12);
  });

  test('corpo de 32769 bytes é rejeitado com 413 PAYLOAD_MUITO_GRANDE, sem conteúdo e sem log', async () => {
    const corpo = corpoComBytes(JSON_LIMITE_BYTES + 1).replace('aaaa', `${CORPO}`.slice(0, 4));
    assert.equal(Buffer.byteLength(corpo), JSON_LIMITE_BYTES + 1);
    const r = await request(app).post('/api/eco').set(CABECALHOS).set('content-type', 'application/json').send(corpo);
    assert.equal(r.status, 413);
    assert.deepEqual(r.body, { status: 'error', codigo: 'PAYLOAD_MUITO_GRANDE', message: 'Corpo da requisição excede o tamanho máximo permitido' });
    assertSemSensiveis(r.text, [...SENSIVEIS, '32768', '32769'], 'resposta 413');
    assert.deepEqual(logs, []);
  });
});

describe('exigirJson: charset declarado só pode ser utf-8', () => {
  const json = `{"senha":"${CORPO}","n":1}`;
  // .serialize((bytes) => bytes) nos envios abaixo: sem isso o superagent aplicaria
  // JSON.stringify ao Buffer e o servidor receberia UTF-8, não os bytes codificados.
  const utf16le = Buffer.from(json, 'utf16le');
  const utf16be = Buffer.from(json, 'utf16le').swap16();
  const utf32le = (() => { const cps = [...json].map((c) => c.codePointAt(0)); const b = Buffer.alloc(cps.length * 4); cps.forEach((cp, i) => b.writeUInt32LE(cp, i * 4)); return b; })();

  test('sem charset, utf-8 e UTF-8 passam', async () => {
    for (const tipo of ['application/json', 'application/json; charset=utf-8', 'application/json; charset=UTF-8', 'application/json;charset=Utf-8', 'application/json; charset="utf-8"']) {
      const r = await request(app).post('/api/eco').set('content-type', tipo).send(json);
      assert.deepEqual([r.status, r.body.body], [200, { senha: CORPO, n: 1 }], tipo);
    }
  });

  test('UTF-16 e UTF-32 válidos são rejeitados com 415 antes do parser, sem ecoar o charset', async () => {
    // Corpos realmente codificados: o parser os aceitaria; a política deve barrar antes.
    const casos = [['utf-16', utf16le], ['utf-16le', utf16le], ['utf-16be', utf16be], ['UTF-16', utf16le], ['utf-32', utf32le]];
    for (const [charset, corpo] of casos) {
      logs = [];
      const r = await request(app).post('/api/eco').set(CABECALHOS).set('content-type', `application/json; charset=${charset}`).serialize((bytes) => bytes).send(corpo);
      esperar415(r, 'CODIFICACAO_NAO_SUPORTADA', charset);
      assert.equal(r.body.message, 'Charset ou codificação do corpo não suportados: envie JSON em UTF-8 sem compressão');
      assertSemSensiveis(r.text, ['utf-16', 'utf-32', 'UTF-16'], `charset ${charset}`);
    }
  });

  test('PUT e PATCH seguem a mesma regra', async () => {
    for (const metodo of ['put', 'patch']) {
      logs = [];
      const r = await request(app)[metodo]('/api/eco').set(CABECALHOS).set('content-type', 'application/json; charset=utf-16le').serialize((bytes) => bytes).send(utf16le);
      esperar415(r, 'CODIFICACAO_NAO_SUPORTADA', metodo);
    }
  });
});

describe('exigirJson: contrato estreito de parâmetros do Content-Type', () => {
  const requisicao = (contentType) => Object.assign(Object.create(express.request), { method: 'POST', headers: { 'content-length': '7', 'content-type': contentType } });
  const resultado = (contentType) => {
    let erro;
    exigirJson(requisicao(contentType), {}, (e) => { erro = e; });
    return erro ? `${erro.status} ${erro.codigo}` : 'passa';
  };

  test('zero parâmetros ou exatamente charset=utf-8 passam', () => {
    for (const tipo of ['application/json', 'application/json; charset=utf-8', 'application/json; charset=UTF-8', 'application/json; charset="utf-8"', 'application/json;charset=Utf-8', 'application/json; CHARSET=utf-8']) {
      assert.equal(resultado(tipo), 'passa', tipo);
    }
  });

  test('qualquer outra combinação de parâmetros é 415 CODIFICACAO_NAO_SUPORTADA', () => {
    const rejeitados = [
      'application/json; charset=',
      'application/json; charset',
      'application/json; charset=utf-8; charset=utf-8',
      'application/json; charset=utf-8; charset=utf-16',
      'application/json; charset=utf-16; charset=utf-8',
      'application/json; charset=utf-16',
      'application/json; charset=iso-8859-1',
      'application/json; boundary=x',
      'application/json; foo=bar',
      'application/json; charset=utf-8; foo=bar',
    ];
    for (const tipo of rejeitados) {
      assert.equal(resultado(tipo), '415 CODIFICACAO_NAO_SUPORTADA', tipo);
    }
  });

  test('via HTTP: parâmetro desconhecido e charset duplicado dão 415 sem ecoar o parâmetro', async () => {
    for (const tipo of [`application/json; boundary=${CT_PARAM}`, 'application/json; charset=utf-8; charset=utf-8']) {
      logs = [];
      const r = await request(app).post('/api/eco').set(CABECALHOS).set('content-type', tipo).send(`{"senha":"${CORPO}"}`);
      esperar415(r, 'CODIFICACAO_NAO_SUPORTADA', tipo);
      assertSemSensiveis(r.text, ['boundary', 'charset=utf-8; charset'], tipo);
    }
  });
});

describe('parserJson: charset e Content-Encoding', () => {
  test('charset não suportado: 415 CODIFICACAO_NAO_SUPORTADA sem o charset recebido', async () => {
    for (const charset of ['iso-8859-1', CHARSET]) {
      logs = [];
      const r = await request(app).post('/api/eco').set(CABECALHOS).set('content-type', `application/json; charset=${charset}`).send(Buffer.from(`{"senha":"${CORPO}"}`));
      esperar415(r, 'CODIFICACAO_NAO_SUPORTADA', charset);
      assert.equal(r.body.message, 'Charset ou codificação do corpo não suportados: envie JSON em UTF-8 sem compressão');
    }
  });

  test('corpo comprimido é rejeitado com 415 CODIFICACAO_NAO_SUPORTADA: gzip, br, deflate e desconhecido', async () => {
    const json = `{"senha":"${CORPO}"}`;
    const casos = [['gzip', zlib.gzipSync(json)], ['br', zlib.brotliCompressSync(json)], ['deflate', zlib.deflateSync(json)], [ENCODING, Buffer.from(json)]];
    for (const [encoding, corpo] of casos) {
      logs = [];
      const r = await request(app).post('/api/eco').set(CABECALHOS).set('content-type', 'application/json').set('content-encoding', encoding).send(corpo);
      esperar415(r, 'CODIFICACAO_NAO_SUPORTADA', encoding);
    }
  });
});
