'use strict';

const { describe, test, mock } = require('node:test');
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
