'use strict';

const { describe, test, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { criarAppTeste } = require('./helpers/app-teste');
const { assertSemSensiveis } = require('./helpers/sensiveis');

describe('infraestrutura de testes', () => {
  test('setup fornece segredo HMAC em memória e NODE_ENV=test', () => {
    assert.equal(process.env.NODE_ENV, 'test');
    assert.match(process.env.LOGIN_COOLDOWN_HMAC_SECRET, /^[0-9a-f]{64}$/);
  });

  test('assertSemSensiveis detecta e ignora conforme o contrato', () => {
    assertSemSensiveis('resposta limpa', ['SegredoXYZ', '', 'ab']);
    assert.throws(() => assertSemSensiveis('contém SegredoXYZ aqui', ['SegredoXYZ']), /valor sensível/);
    assert.throws(() => assertSemSensiveis(undefined, ['x']), /esperado string/);
  });
});

describe('app.js', () => {
  const app = require('../src/app');

  test('carrega sem importar a configuração de autenticação', () => {
    const carregados = Object.keys(require.cache);
    assert.equal(carregados.some((caminho) => caminho.endsWith('/src/config/auth.js')), false);
    assert.equal(carregados.some((caminho) => caminho.endsWith('/src/app.js')), true);
  });

  test('GET /api/health responde 200 com identificação do serviço', async () => {
    const resposta = await request(app).get('/api/health');
    assert.equal(resposta.status, 200);
    assert.deepEqual(resposta.body, { status: 'ok', service: 'gestao-epi-api' });
  });

  test('rota inexistente responde 404 em JSON', async () => {
    const resposta = await request(app).get('/api/nao-existe');
    assert.equal(resposta.status, 404);
    assert.equal(resposta.body.status, 'error');
    assert.match(resposta.body.message, /^Rota não encontrada: GET /);
  });
});

describe('helper criarAppTeste', () => {
  test('monta express.json e os handlers reais de 404 e erro', async () => {
    const logErro = mock.method(console, 'error', () => {});
    const app = criarAppTeste((a) => {
      a.post('/eco', (req, res) => res.json({ recebido: req.body }));
      a.get('/falha', () => { throw new Error('interno com dado SegredoXYZ'); });
    });
    const eco = await request(app).post('/eco').send({ a: 1 });
    assert.deepEqual([eco.status, eco.body], [200, { recebido: { a: 1 } }]);

    const quatro = await request(app).get('/nada');
    assert.equal(quatro.status, 404);

    const falha = await request(app).get('/falha');
    assert.deepEqual([falha.status, falha.body], [500, { status: 'error', codigo: 'ERRO_INTERNO', message: 'Erro interno do servidor' }]);
    assertSemSensiveis(falha.text, ['SegredoXYZ'], 'resposta 500');
    assert.equal(logErro.mock.callCount(), 1);
    assertSemSensiveis(JSON.stringify(logErro.mock.calls[0].arguments), ['SegredoXYZ'], 'log do 500');
    logErro.mock.restore();
  });
});

describe('módulos de src', () => {
  // Carrega todo arquivo de src/ (exceto server.js, entrypoint que abre porta)
  // para que a cobertura conte cada módulo com seu percentual real: o Node
  // só relata arquivos carregados, e um módulo nunca importado ficaria
  // invisível ao piso de 75%.
  const fs = require('node:fs');
  const path = require('node:path');
  const raiz = path.join(__dirname, '..', 'src');
  const listar = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entrada) => {
    const caminho = path.join(dir, entrada.name);
    return entrada.isDirectory() ? listar(caminho) : [caminho];
  });
  const modulos = listar(raiz).filter((c) => c.endsWith('.js') && path.relative(raiz, c) !== 'server.js').sort();

  test('todos os módulos carregam sem erro', () => {
    assert.ok(modulos.length >= 15, `esperado ao menos 15 módulos, encontrados ${modulos.length}`);
    for (const modulo of modulos) {
      assert.doesNotThrow(() => require(modulo), path.relative(raiz, modulo));
    }
  });
});

describe('app.js: payload e Content-Type dentro de /api', () => {
  const app = require('../src/app');
  const CORPO = 'CORPO_SENTINELA_9f3a';
  const SENSIVEIS = [CORPO, 'text/plain', 'iso-8859-1', 'request entity', 'unsupported'];
  const corpoComBytes = (bytes) => `{"senha":"${'a'.repeat(bytes - 12)}"}`;
  let logErro;
  beforeEach(() => { logErro = mock.method(console, 'error', () => {}); });
  afterEach(() => mock.restoreAll());

  test('JSON válido de 32768 bytes atravessa o parser e chega ao roteamento (404 da rota inexistente)', async () => {
    const corpo = corpoComBytes(32768);
    assert.equal(Buffer.byteLength(corpo), 32768);
    const r = await request(app).post('/api/health').set('content-type', 'application/json').send(corpo);
    assert.equal(r.status, 404);
  });

  test('JSON de 32769 bytes responde 413 PAYLOAD_MUITO_GRANDE antes do roteamento, sem log', async () => {
    const corpo = corpoComBytes(32769);
    const r = await request(app).post('/api/health').set('content-type', 'application/json').send(corpo);
    assert.deepEqual([r.status, r.body], [413, { status: 'error', codigo: 'PAYLOAD_MUITO_GRANDE', message: 'Corpo da requisição excede o tamanho máximo permitido' }]);
    assert.equal(logErro.mock.callCount(), 0);
  });

  test('text/plain com corpo responde 415 TIPO_CONTEUDO_NAO_SUPORTADO antes do roteamento', async () => {
    const r = await request(app).post('/api/health').set('content-type', 'text/plain').send(CORPO);
    assert.deepEqual([r.status, r.body.codigo], [415, 'TIPO_CONTEUDO_NAO_SUPORTADO']);
    assertSemSensiveis(r.text, SENSIVEIS, 'resposta 415');
    assert.equal(logErro.mock.callCount(), 0);
  });

  test('JSON válido declarado como UTF-16 responde 415 CODIFICACAO_NAO_SUPORTADA, sem charset nem corpo na resposta e sem log', async () => {
    const json = `{"senha":"${CORPO}"}`;
    const r = await request(app).post('/api/health').set('content-type', 'application/json; charset=utf-16').set('cookie', 'gepi_sessao=COOKIE_SENTINELA').serialize((bytes) => bytes).send(Buffer.from(json, 'utf16le'));
    assert.deepEqual([r.status, r.body], [415, { status: 'error', codigo: 'CODIFICACAO_NAO_SUPORTADA', message: 'Charset ou codificação do corpo não suportados: envie JSON em UTF-8 sem compressão' }]);
    assertSemSensiveis(r.text, [...SENSIVEIS, 'utf-16', 'COOKIE_SENTINELA'], 'resposta 415 utf-16');
    assert.equal(logErro.mock.callCount(), 0);
  });

  test('charset iso-8859-1 e corpo gzip respondem 415 CODIFICACAO_NAO_SUPORTADA, sem log', async () => {
    const charset = await request(app).post('/api/health').set('content-type', 'application/json; charset=iso-8859-1').send(Buffer.from(`{"senha":"${CORPO}"}`, 'latin1'));
    assert.deepEqual([charset.status, charset.body.codigo], [415, 'CODIFICACAO_NAO_SUPORTADA']);
    const gzip = await request(app).post('/api/health').set('content-type', 'application/json').set('content-encoding', 'gzip').send(require('node:zlib').gzipSync(`{"senha":"${CORPO}"}`));
    assert.deepEqual([gzip.status, gzip.body.codigo], [415, 'CODIFICACAO_NAO_SUPORTADA']);
    assertSemSensiveis(charset.text + gzip.text, SENSIVEIS, 'respostas 415');
    assert.equal(logErro.mock.callCount(), 0);
  });
});
