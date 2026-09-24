'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const schemas = require('../../src/schemas/auth-global.schema');

describe('auth-global.schema (Pacote 4)', () => {
  test('login: só e-mail (normalizado) e senha; cnpj ou qualquer campo extra é recusado', () => {
    const ok = schemas.login.body.safeParse({ email: '  Pessoa@Exemplo.com.br ', senha: 'uma-senha-qualquer' });
    assert.equal(ok.success, true);
    assert.equal(ok.data.email, 'pessoa@exemplo.com.br');
    assert.equal(schemas.login.body.safeParse({ email: 'p@x.com', senha: 's', cnpj: '11222333000181' }).success, false);
    assert.equal(schemas.login.body.safeParse({ email: 'p@x.com' }).success, false);
    assert.equal(schemas.login.body.safeParse({ email: 'p@x.com', senha: '' }).success, false);
  });

  test('selecionarEmpresa: id numérico positivo no PATH (nunca empresaId em corpo)', () => {
    assert.equal(schemas.selecionarEmpresa.params.safeParse({ id: '3' }).data.id, 3);
    for (const ruim of ['0', '-1', 'abc', '3.5', '']) {
      assert.equal(schemas.selecionarEmpresa.params.safeParse({ id: ruim }).success, false, ruim);
    }
    assert.equal('body' in schemas.selecionarEmpresa, false);
  });
});
