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
    const r = await request(app).post('/api/health').set('Origin', 'http://localhost:5500').set('content-type', 'application/json').send(corpo);
    assert.equal(r.status, 404);
  });

  test('JSON de 32769 bytes responde 413 PAYLOAD_MUITO_GRANDE antes do roteamento, sem log', async () => {
    const corpo = corpoComBytes(32769);
    const r = await request(app).post('/api/health').set('Origin', 'http://localhost:5500').set('content-type', 'application/json').send(corpo);
    assert.deepEqual([r.status, r.body], [413, { status: 'error', codigo: 'PAYLOAD_MUITO_GRANDE', message: 'Corpo da requisição excede o tamanho máximo permitido' }]);
    assert.equal(logErro.mock.callCount(), 0);
  });

  test('text/plain com corpo responde 415 TIPO_CONTEUDO_NAO_SUPORTADO antes do roteamento', async () => {
    const r = await request(app).post('/api/health').set('Origin', 'http://localhost:5500').set('content-type', 'text/plain').send(CORPO);
    assert.deepEqual([r.status, r.body.codigo], [415, 'TIPO_CONTEUDO_NAO_SUPORTADO']);
    assertSemSensiveis(r.text, SENSIVEIS, 'resposta 415');
    assert.equal(logErro.mock.callCount(), 0);
  });

  test('JSON válido declarado como UTF-16 responde 415 CODIFICACAO_NAO_SUPORTADA, sem charset nem corpo na resposta e sem log', async () => {
    const json = `{"senha":"${CORPO}"}`;
    const r = await request(app).post('/api/health').set('Origin', 'http://localhost:5500').set('content-type', 'application/json; charset=utf-16').set('cookie', 'gepi_sessao=COOKIE_SENTINELA').serialize((bytes) => bytes).send(Buffer.from(json, 'utf16le'));
    assert.deepEqual([r.status, r.body], [415, { status: 'error', codigo: 'CODIFICACAO_NAO_SUPORTADA', message: 'Charset ou codificação do corpo não suportados: envie JSON em UTF-8 sem compressão' }]);
    assertSemSensiveis(r.text, [...SENSIVEIS, 'utf-16', 'COOKIE_SENTINELA'], 'resposta 415 utf-16');
    assert.equal(logErro.mock.callCount(), 0);
  });

  test('charset iso-8859-1 e corpo gzip respondem 415 CODIFICACAO_NAO_SUPORTADA, sem log', async () => {
    const charset = await request(app).post('/api/health').set('Origin', 'http://localhost:5500').set('content-type', 'application/json; charset=iso-8859-1').send(Buffer.from(`{"senha":"${CORPO}"}`, 'latin1'));
    assert.deepEqual([charset.status, charset.body.codigo], [415, 'CODIFICACAO_NAO_SUPORTADA']);
    const gzip = await request(app).post('/api/health').set('Origin', 'http://localhost:5500').set('content-type', 'application/json').set('content-encoding', 'gzip').send(require('node:zlib').gzipSync(`{"senha":"${CORPO}"}`));
    assert.deepEqual([gzip.status, gzip.body.codigo], [415, 'CODIFICACAO_NAO_SUPORTADA']);
    assertSemSensiveis(charset.text + gzip.text, SENSIVEIS, 'respostas 415');
    assert.equal(logErro.mock.callCount(), 0);
  });
});

describe('app.js: cabeçalhos HTTP de segurança', () => {
  const app = require('../src/app');
  const ESPERADOS = {
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'origin-agent-cluster': '?1',
    'x-permitted-cross-domain-policies': 'none',
    'x-dns-prefetch-control': 'off',
    'x-download-options': 'noopen',
    'x-xss-protection': '0',
  };
  const CSP_ESPERADA = new Set(["default-src 'none'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'"]);
  const diretivasCsp = (valor) => new Set(String(valor).split(';').map((d) => d.trim().replace(/\s+/g, ' ')).filter((d) => d !== ''));
  const conferir = (headers, rotulo) => {
    for (const [nome, valor] of Object.entries(ESPERADOS)) {
      assert.equal(headers[nome], valor, `${rotulo}: ${nome}`);
    }
    assert.deepEqual(diretivasCsp(headers['content-security-policy']), CSP_ESPERADA, `${rotulo}: CSP`);
    assert.equal('cross-origin-embedder-policy' in headers, false, `${rotulo}: COEP`);
    assert.equal('strict-transport-security' in headers, false, `${rotulo}: HSTS ausente fora de production`);
  };
  test('X-Powered-By ausente em qualquer resposta (app.disable)', async () => {
    for (const caminho of ['/api/health', '/api/inexistente', '/fora']) {
      const r = await request(app).get(caminho);
      assert.equal('x-powered-by' in r.headers, false, caminho);
    }
  });

  test('GET /api/health: cabeçalhos de segurança com valores exatos e Cache-Control: no-store', async () => {
    const r = await request(app).get('/api/health');
    assert.equal(r.status, 200);
    conferir(r.headers, '/api/health');
    assert.equal(r.headers['cache-control'], 'no-store');
  });

  test('respostas de erro dentro de /api (404 e 415) mantêm os cabeçalhos e no-store', async () => {
    const naoEncontrado = await request(app).get('/api/inexistente');
    assert.equal(naoEncontrado.status, 404);
    conferir(naoEncontrado.headers, '404 em /api');
    assert.equal(naoEncontrado.headers['cache-control'], 'no-store');
    const tipoErrado = await request(app).post('/api/health').set('Origin', 'http://localhost:5500').set('content-type', 'text/plain').send('x');
    assert.equal(tipoErrado.status, 415);
    conferir(tipoErrado.headers, '415 em /api');
    assert.equal(tipoErrado.headers['cache-control'], 'no-store');
  });

  test('fora de /api: cabeçalhos de segurança presentes, sem Cache-Control automático', async () => {
    const r = await request(app).get('/fora');
    assert.equal(r.status, 404);
    conferir(r.headers, '/fora');
    assert.equal('cache-control' in r.headers, false);
  });
});

describe('app.js: CORS restrito ao namespace /api', () => {
  const app = require('../src/app');
  const PERMITIDA = 'http://localhost:5500';
  const cors = (r) => Object.fromEntries(Object.entries(r.headers).filter(([k]) => k.startsWith('access-control-')));

  test('origem permitida recebe a própria origem e credentials; nunca *', async () => {
    const r = await request(app).get('/api/health').set('Origin', PERMITIDA);
    assert.equal(r.status, 200);
    assert.equal(r.headers['access-control-allow-origin'], PERMITIDA);
    assert.equal(r.headers['access-control-allow-credentials'], 'true');
    assert.ok(String(r.headers.vary || '').includes('Origin'));
  });

  test('origem estranha, Origin: null e ausência de Origin não recebem cabeçalhos CORS', async () => {
    for (const origem of ['http://mal.test', 'null', undefined]) {
      const req = request(app).get('/api/health');
      const r = origem === undefined ? await req : await req.set('Origin', origem);
      assert.equal(r.status, 200, String(origem));
      assert.deepEqual(cors(r), {}, String(origem));
      assert.notEqual(r.headers['access-control-allow-origin'], '*');
    }
  });

  test('preflight permitido: 204, métodos e headers restritos, Max-Age 600, Helmet presente, sem no-store', async () => {
    const r = await request(app).options('/api/health').set('Origin', PERMITIDA).set('Access-Control-Request-Method', 'POST').set('Access-Control-Request-Headers', 'content-type');
    assert.equal(r.status, 204);
    assert.equal(r.headers['access-control-allow-origin'], PERMITIDA);
    assert.deepEqual(r.headers['access-control-allow-methods'].split(',').map((m) => m.trim()).sort(), ['GET', 'HEAD', 'PATCH', 'POST']);
    assert.equal(r.headers['access-control-allow-headers'], 'Content-Type');
    assert.equal(r.headers['access-control-max-age'], '600');
    assert.equal(r.headers['x-frame-options'], 'DENY');
    assert.equal('cache-control' in r.headers, false);
  });

  test('415 e 404 dentro de /api com origem permitida mantêm cabeçalhos CORS e no-store', async () => {
    const tipoErrado = await request(app).post('/api/health').set('Origin', PERMITIDA).set('content-type', 'text/plain').send('x');
    assert.equal(tipoErrado.status, 415);
    assert.equal(tipoErrado.headers['access-control-allow-origin'], PERMITIDA);
    assert.equal(tipoErrado.headers['cache-control'], 'no-store');
    const naoEncontrado = await request(app).get('/api/inexistente').set('Origin', PERMITIDA);
    assert.equal(naoEncontrado.status, 404);
    assert.equal(naoEncontrado.headers['access-control-allow-origin'], PERMITIDA);
    assert.equal(naoEncontrado.headers['cache-control'], 'no-store');
  });

  test('GET /fora com origem permitida: sem CORS, sem no-store, com Helmet', async () => {
    const r = await request(app).get('/fora').set('Origin', PERMITIDA);
    assert.equal(r.status, 404);
    assert.equal('access-control-allow-origin' in r.headers, false);
    assert.equal('access-control-allow-credentials' in r.headers, false);
    assert.equal('cache-control' in r.headers, false);
    assert.equal(r.headers['x-frame-options'], 'DENY');
    assert.equal(String(r.headers.vary || '').split(',').map((v) => v.trim()).includes('Origin'), false, 'Vary não deve conter Origin fora de /api');
  });
});

describe('app.js: verificação de origem em métodos inseguros', () => {
  const app = require('../src/app');
  const PERMITIDA = 'http://localhost:5500';
  const MALICIOSA = 'http://mal.test';
  const CORPO = 'CORPO_SENTINELA_5b2a';
  const SENSIVEIS = [MALICIOSA, CORPO, 'text/plain', 'mal.test'];
  let logErro;
  beforeEach(() => { logErro = mock.method(console, 'error', () => {}); });
  afterEach(() => mock.restoreAll());

  test('POST com origem não permitida: 403 ORIGEM_NAO_PERMITIDA, sem CORS, com no-store e sem log', async () => {
    const r = await request(app).post('/api/health').set('Origin', MALICIOSA).set('content-type', 'application/json').send({ a: 1 });
    assert.deepEqual([r.status, r.body], [403, { status: 'error', codigo: 'ORIGEM_NAO_PERMITIDA', message: 'Origem da requisição não permitida' }]);
    assert.equal('access-control-allow-origin' in r.headers, false);
    assert.equal(r.headers['cache-control'], 'no-store');
    assertSemSensiveis(r.text, SENSIVEIS, 'resposta 403');
    assert.equal(logErro.mock.callCount(), 0);
  });

  test('POST sem Origin nem Referer: 403 ORIGEM_AUSENTE', async () => {
    const r = await request(app).post('/api/health').set('content-type', 'application/json').send({ a: 1 });
    assert.deepEqual([r.status, r.body.codigo], [403, 'ORIGEM_AUSENTE']);
  });

  test('verificação de origem ocorre ANTES de Content-Type: text/plain com origem inválida dá 403, não 415', async () => {
    const naoPermitida = await request(app).post('/api/health').set('Origin', MALICIOSA).set('content-type', 'text/plain').send(CORPO);
    assert.deepEqual([naoPermitida.status, naoPermitida.body.codigo], [403, 'ORIGEM_NAO_PERMITIDA']);
    assert.equal(naoPermitida.headers['cache-control'], 'no-store');
    assert.equal('access-control-allow-origin' in naoPermitida.headers, false);
    assertSemSensiveis(naoPermitida.text, SENSIVEIS, 'resposta 403 antes do 415');

    const semOrigem = await request(app).post('/api/health').set('content-type', 'text/plain').send(CORPO);
    assert.deepEqual([semOrigem.status, semOrigem.body.codigo], [403, 'ORIGEM_AUSENTE']);
    assertSemSensiveis(semOrigem.text, SENSIVEIS, 'resposta 403 sem origem');
    assert.equal(logErro.mock.callCount(), 0);
  });

  test('POST com origem permitida atravessa a verificação e chega à camada seguinte', async () => {
    const r = await request(app).post('/api/health').set('Origin', PERMITIDA).set('content-type', 'application/json').send({ a: 1 });
    assert.equal(r.status, 404);
    assert.equal(r.headers['access-control-allow-origin'], PERMITIDA);
  });

  test('POST sem Origin e com Referer de origem permitida chega à camada seguinte', async () => {
    const r = await request(app).post('/api/health').set('Referer', `${PERMITIDA}/app/login?x=1`).set('content-type', 'application/json').send({ a: 1 });
    assert.equal(r.status, 404);
  });

  test('métodos seguros não são bloqueados por origem não permitida', async () => {
    const r = await request(app).get('/api/health').set('Origin', MALICIOSA);
    assert.deepEqual([r.status, r.body], [200, { status: 'ok', service: 'gestao-epi-api' }]);
    assert.equal('access-control-allow-origin' in r.headers, false);
    const preflight = await request(app).options('/api/health').set('Origin', PERMITIDA).set('Access-Control-Request-Method', 'POST');
    assert.equal(preflight.status, 204);
  });

  test('POST fora de /api não recebe a política de origem', async () => {
    const r = await request(app).post('/fora');
    assert.equal(r.status, 404);
    assert.notEqual(r.body.codigo, 'ORIGEM_AUSENTE');
  });
});

describe('app.js: rate limit por IP no namespace /api', () => {
  const app = require('../src/app');
  const PERMITIDA = 'http://localhost:5500';
  const parametros = (valor) => Object.fromEntries(String(valor).split(';').slice(1).map((parte) => {
    const [nome, conteudo] = parte.split('=');
    return [nome.trim(), (conteudo ?? '').trim()];
  }));

  test('GET /api/health traz RateLimit e RateLimit-Policy no formato draft-8, sem legados', async () => {
    const r = await request(app).get('/api/health');
    assert.equal(r.status, 200);
    const rateLimit = parametros(r.headers.ratelimit);
    assert.ok(/^[0-9]+$/.test(rateLimit.r ?? ''), 'RateLimit deve trazer r=');
    assert.ok(/^[0-9]+$/.test(rateLimit.t ?? ''), 'RateLimit deve trazer t=');
    const policy = parametros(r.headers['ratelimit-policy']);
    assert.ok(/^[0-9]+$/.test(policy.q ?? ''), 'RateLimit-Policy deve trazer q=');
    assert.equal(policy.w, '60');
    for (const legado of ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset']) {
      assert.equal(legado in r.headers, false, legado);
    }
    assert.equal('retry-after' in r.headers, false);
  });

  test('GET /fora não recebe cabeçalhos de rate limit', async () => {
    const r = await request(app).get('/fora');
    assert.equal(r.status, 404);
    assert.equal('ratelimit' in r.headers, false);
    assert.equal('ratelimit-policy' in r.headers, false);
  });

  test('POST com origem inválida é rejeitado antes do limitador: 403 sem cabeçalhos de rate limit', async () => {
    const r = await request(app).post('/api/health').set('Origin', 'http://mal.test').set('content-type', 'application/json').send({ a: 1 });
    assert.deepEqual([r.status, r.body.codigo], [403, 'ORIGEM_NAO_PERMITIDA']);
    assert.equal('ratelimit' in r.headers, false, 'verificarOrigem vem antes de limitadorGeral');
  });

  test('requisição legítima com origem permitida atravessa o limitador', async () => {
    const r = await request(app).post('/api/health').set('Origin', PERMITIDA).set('content-type', 'application/json').send({ a: 1 });
    assert.equal(r.status, 404, 'chega ao roteamento');
    assert.ok('ratelimit' in r.headers, 'passou pelo limitador');
  });
});

describe('app.js: integração do pipeline de segurança', () => {
  // Regressão do pipeline já implementado nas Subetapas 1 a 7: comprova a
  // precedência entre camadas e a preservação de cabeçalhos nas respostas de
  // erro. Não introduz comportamento novo.
  const app = require('../src/app');
  const PERMITIDA = 'http://localhost:5500';
  const MALICIOSA = 'http://mal.test';
  const corsDe = (resposta) => Object.fromEntries(Object.entries(resposta.headers).filter(([nome]) => nome.startsWith('access-control-')));
  let logErro;
  beforeEach(() => { logErro = mock.method(console, 'error', () => {}); });
  afterEach(() => mock.restoreAll());

  test('preflight de origem não permitida não recebe cabeçalhos CORS nem 403', async () => {
    const r = await request(app).options('/api/health').set('Origin', MALICIOSA).set('Access-Control-Request-Method', 'POST');
    assert.deepEqual(corsDe(r), {}, 'nenhum Access-Control-* para origem fora da allowlist');
    assert.notEqual(r.status, 403);
    assert.notEqual(r.body.codigo, 'ORIGEM_NAO_PERMITIDA');
    // OPTIONS é método seguro: não é barrado pela verificação de origem, então
    // o preflight não permitido atravessa o CORS e alcança o limitador.
    assert.ok('ratelimit' in r.headers, 'preflight não permitido não termina no CORS');
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers['x-frame-options'], 'DENY');
    assert.equal(logErro.mock.callCount(), 0);
  });

  test('413 integrado: payload acima do limite preserva CORS, no-store, Helmet e RateLimit', async () => {
    const corpo = JSON.stringify({ senha: 'a'.repeat(40000) });
    assert.ok(Buffer.byteLength(corpo) > 32768);
    const r = await request(app).post('/api/health').set('Origin', PERMITIDA).set('content-type', 'application/json').send(corpo);
    assert.deepEqual([r.status, r.body.codigo], [413, 'PAYLOAD_MUITO_GRANDE']);
    assert.equal(r.headers['access-control-allow-origin'], PERMITIDA);
    assert.equal(r.headers['access-control-allow-credentials'], 'true');
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers['x-frame-options'], 'DENY');
    assert.ok('ratelimit' in r.headers, 'a cota foi consumida antes do parser');
    assert.equal('retry-after' in r.headers, false);
    assert.equal(logErro.mock.callCount(), 0);
  });

  test('400 integrado: JSON malformado preserva CORS, no-store, Helmet e RateLimit', async () => {
    const r = await request(app).post('/api/health').set('Origin', PERMITIDA).set('content-type', 'application/json').send('{"senha": ');
    assert.deepEqual([r.status, r.body.codigo], [400, 'JSON_INVALIDO']);
    assert.equal(r.headers['access-control-allow-origin'], PERMITIDA);
    assert.equal(r.headers['access-control-allow-credentials'], 'true');
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers['x-frame-options'], 'DENY');
    assert.ok('ratelimit' in r.headers);
    assert.equal('retry-after' in r.headers, false);
    assert.equal(logErro.mock.callCount(), 0);
  });
});
