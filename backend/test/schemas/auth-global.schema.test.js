'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const schemas = require('../../src/schemas/auth-global.schema');
const { validar } = require('../../src/middleware/validar');

const TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';

describe('auth-global.schema (Pacote 4)', () => {
  test('login: só e-mail (normalizado), senha e turnstileToken; cnpj ou qualquer campo extra é recusado', () => {
    const ok = schemas.login.body.safeParse({ email: '  Pessoa@Exemplo.com.br ', senha: 'uma-senha-qualquer', turnstileToken: TOKEN });
    assert.equal(ok.success, true);
    assert.equal(ok.data.email, 'pessoa@exemplo.com.br');
    assert.equal(schemas.login.body.safeParse({ email: 'p@x.com', senha: 's', turnstileToken: TOKEN, cnpj: '11222333000181' }).success, false);
    assert.equal(schemas.login.body.safeParse({ email: 'p@x.com', turnstileToken: TOKEN }).success, false);
    assert.equal(schemas.login.body.safeParse({ email: 'p@x.com', senha: '', turnstileToken: TOKEN }).success, false);
  });

  test('selecionarEmpresa: id numérico positivo no PATH (nunca empresaId em corpo)', () => {
    assert.equal(schemas.selecionarEmpresa.params.safeParse({ id: '3' }).data.id, 3);
    for (const ruim of ['0', '-1', 'abc', '3.5', '']) {
      assert.equal(schemas.selecionarEmpresa.params.safeParse({ id: ruim }).success, false, ruim);
    }
    assert.equal('body' in schemas.selecionarEmpresa, false);
  });
});

describe('login: turnstileToken', () => {
  const corpo = (turnstileToken) => ({ email: 'p@x.com', senha: 'uma-senha-qualquer', turnstileToken });

  function detalhesDaRecusa(body) {
    let erro;
    validar({ body: schemas.login.body })({ body }, {}, (e) => { erro = e; });
    assert.ok(erro, 'a validação precisa recusar');
    assert.equal(erro.status, 400);
    return erro.detalhes;
  }

  test('ausente, vazio ou só espaços: recusado no campo turnstileToken', () => {
    const { turnstileToken, ...semToken } = corpo(TOKEN);
    assert.equal(turnstileToken, TOKEN);
    for (const body of [semToken, corpo(''), corpo('   ')]) {
      const detalhes = detalhesDaRecusa(body);
      assert.ok(detalhes.some((d) => d.campo === 'body.turnstileToken'), JSON.stringify(detalhes));
    }
  });

  test('tipo que não é texto é recusado: array, objeto, número, booleano e null', () => {
    for (const ruim of [[TOKEN], { token: TOKEN }, 123, true, null]) {
      const detalhes = detalhesDaRecusa(corpo(ruim));
      assert.ok(detalhes.some((d) => d.campo === 'body.turnstileToken' && d.codigo === 'TIPO_INVALIDO'), JSON.stringify(detalhes));
    }
  });

  test('até 2048 caracteres é aceito (sem os espaços das pontas); 2049 é recusado', () => {
    const limite = 'a'.repeat(2048);
    const ok = schemas.login.body.safeParse(corpo(`  ${limite}  `));
    assert.equal(ok.success, true);
    assert.equal(ok.data.turnstileToken, limite);
    assert.ok(detalhesDaRecusa(corpo('a'.repeat(2049))).some((d) => d.campo === 'body.turnstileToken'));
  });

  test('o token recusado nunca aparece no erro', () => {
    const sentinela = `SENTINELA-${'b'.repeat(2100)}`;
    for (const recusado of [sentinela, 'SENTINELA\u0000token']) {
      const detalhes = detalhesDaRecusa(corpo(recusado));
      assert.deepEqual(detalhes.map((d) => [d.campo, d.codigo]), [['body.turnstileToken', 'VERIFICACAO_SEGURANCA_MALFORMADA']]);
      assert.equal(JSON.stringify(detalhes).includes('SENTINELA'), false);
    }
  });
});
