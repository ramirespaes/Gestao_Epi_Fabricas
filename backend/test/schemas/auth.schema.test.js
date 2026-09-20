'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { login, trocaSenha } = require('../../src/schemas/auth.schema');
const { assertSemSensiveis } = require('../helpers/sensiveis');

// Contrato público: lista de { code, path, codigo } por issue. path é
// contrato da nossa API (campo apontado); codigo é params.codigo.
const issues = (r) => r.error.issues.map((i) => ({ code: i.code, path: i.path.join('.'), codigo: i.params && i.params.codigo }));
const SENSIVEIS = ['MinhaSenha', 'luis@empresa', '12345678', 'E08G'];
const semSensiveis = (r) => {
  for (const issue of r.error.issues) {
    assertSemSensiveis(issue.message, SENSIVEIS, 'mensagem');
    assert.equal('input' in issue, false);
  }
};

describe('login', () => {
  const base = { cnpj: '12.345.678/0001-95', email: '  Luis@Empresa.COM ', senha: '  MinhaSenha 2026  ' };

  test('válido: CNPJ e e-mail normalizados, senha byte a byte', () => {
    assert.deepEqual(login.body.parse(base), { cnpj: '12345678000195', email: 'luis@empresa.com', senha: '  MinhaSenha 2026  ' });
    assert.equal(login.body.parse({ ...base, cnpj: '12345678000195' }).cnpj, '12345678000195');
    assert.equal(login.body.parse({ ...base, cnpj: '00.000.000/e08g-12' }).cnpj, '00000000E08G12');
    const nfd = 'Coração 2026 x'.normalize('NFD');
    const senha = login.body.parse({ ...base, senha: nfd }).senha;
    assert.equal(senha, nfd);
    assert.notEqual(senha, nfd.normalize('NFC'));
  });

  test('CNPJ estrutural com DV inválido é aceito; política de senha não roda', () => {
    assert.equal(login.body.parse({ ...base, cnpj: '12345678000196' }).cnpj, '12345678000196');
    assert.equal(login.body.parse({ ...base, cnpj: '00000000E08G13' }).cnpj, '00000000E08G13');
    assert.equal(login.body.parse({ ...base, senha: 'abc' }).senha, 'abc');
  });

  test('campo ausente: um invalid_type por campo, nada mais', () => {
    for (const campo of ['cnpj', 'email', 'senha']) {
      const { [campo]: _, ...sem } = base;
      const r = login.body.safeParse(sem);
      assert.deepEqual(issues(r), [{ code: 'invalid_type', path: campo, codigo: undefined }]);
      semSensiveis(r);
    }
    assert.deepEqual(issues(login.body.safeParse({})).map((i) => i.path).sort(), ['cnpj', 'email', 'senha']);
  });

  test('campos inválidos apontam o próprio campo com o código de campos.schema', () => {
    const casos = [
      [{ ...base, cnpj: '00000000E08GA2' }, { code: 'custom', path: 'cnpj', codigo: 'CNPJ_INVALIDO' }],
      [{ ...base, email: 'josé@empresa.com' }, { code: 'custom', path: 'email', codigo: 'EMAIL_INVALIDO' }],
      [{ ...base, senha: '' }, { code: 'custom', path: 'senha', codigo: 'SENHA_VAZIA' }],
      [{ ...base, senha: 'x'.repeat(1025) }, { code: 'custom', path: 'senha', codigo: 'SENHA_MUITO_LONGA' }],
      [{ ...base, senha: 123 }, { code: 'invalid_type', path: 'senha', codigo: undefined }],
    ];
    for (const [entrada, esperado] of casos) {
      const r = login.body.safeParse(entrada);
      assert.deepEqual(issues(r), [esperado]);
      semSensiveis(r);
    }
  });

  test('corpo estrito: chaves extras e corpo não objeto', () => {
    const extra = login.body.safeParse({ ...base, manterConectado: true });
    assert.deepEqual(issues(extra), [{ code: 'unrecognized_keys', path: '', codigo: undefined }]);
    assert.deepEqual(extra.error.issues[0].keys, ['manterConectado']);
    assert.equal(login.body.safeParse({ ...base, empresa_id: 1, usuario_id: 2 }).error.issues[0].keys.length, 2);
    for (const corpo of [[], 'texto', null, undefined, 42]) {
      assert.deepEqual(issues(login.body.safeParse(corpo)), [{ code: 'invalid_type', path: '', codigo: undefined }]);
    }
  });

  test('códigos não dependem da existência de empresa ou usuário', () => {
    const cenarios = [['12345678000195', 'luis@empresa.com'], ['99999999999999', 'ninguem@nada.com'], ['00000000E08G12', 'x@y.zz'], ['00000000E08G13', 'a@b.cc']];
    for (const [cnpj, email] of cenarios) {
      assert.equal(login.body.safeParse({ cnpj, email, senha: 'qualquer' }).success, true);
      assert.deepEqual(issues(login.body.safeParse({ cnpj, email, senha: '' })), [{ code: 'custom', path: 'senha', codigo: 'SENHA_VAZIA' }]);
      assert.deepEqual(issues(login.body.safeParse({ cnpj, email })), [{ code: 'invalid_type', path: 'senha', codigo: undefined }]);
    }
  });
});

describe('trocaSenha', () => {
  const atual = 'Senha Antiga 2025!';
  const nova = 'Coração Novo 2026!'.normalize('NFC');
  const novaNfd = nova.normalize('NFD');

  test('válida: saída preserva as strings originais', () => {
    assert.notEqual(nova, novaNfd);
    assert.deepEqual(trocaSenha.body.parse({ senhaAtual: atual, novaSenha: nova, confirmacaoNovaSenha: nova }), { senhaAtual: atual, novaSenha: nova, confirmacaoNovaSenha: nova });
  });

  test('confirmação em NFD e nova em NFC coincidem, cada campo preservado byte a byte', () => {
    const r1 = trocaSenha.body.parse({ senhaAtual: atual, novaSenha: nova, confirmacaoNovaSenha: novaNfd });
    assert.equal(r1.novaSenha, nova);
    assert.equal(r1.confirmacaoNovaSenha, novaNfd);
    const r2 = trocaSenha.body.parse({ senhaAtual: atual, novaSenha: novaNfd, confirmacaoNovaSenha: nova });
    assert.equal(r2.novaSenha, novaNfd);
  });

  test('caixa e espaços são diferenças reais; NFKC não é aplicado', () => {
    for (const confirmacao of [nova + ' ', nova.toLowerCase(), ' ' + nova]) {
      assert.deepEqual(issues(trocaSenha.body.safeParse({ senhaAtual: atual, novaSenha: nova, confirmacaoNovaSenha: confirmacao })), [{ code: 'custom', path: 'confirmacaoNovaSenha', codigo: 'SENHAS_NAO_CONFEREM' }]);
    }
    assert.equal(trocaSenha.body.safeParse({ senhaAtual: atual, novaSenha: 'ﬁm de tarde 2026', confirmacaoNovaSenha: 'fim de tarde 2026' }).success, false);
  });

  test('nova igual à atual em NFC ou NFD é rejeitada; caixa diferente é senha diferente', () => {
    assert.deepEqual(issues(trocaSenha.body.safeParse({ senhaAtual: nova, novaSenha: nova, confirmacaoNovaSenha: nova })), [{ code: 'custom', path: 'novaSenha', codigo: 'SENHA_IGUAL_ATUAL' }]);
    assert.deepEqual(issues(trocaSenha.body.safeParse({ senhaAtual: nova, novaSenha: novaNfd, confirmacaoNovaSenha: novaNfd })), [{ code: 'custom', path: 'novaSenha', codigo: 'SENHA_IGUAL_ATUAL' }]);
    assert.equal(trocaSenha.body.safeParse({ senhaAtual: nova, novaSenha: nova.toUpperCase(), confirmacaoNovaSenha: nova.toUpperCase() }).success, true);
    assert.deepEqual(issues(trocaSenha.body.safeParse({ senhaAtual: nova, novaSenha: nova, confirmacaoNovaSenha: 'outra' })).map((i) => i.codigo).sort(), ['SENHAS_NAO_CONFEREM', 'SENHA_IGUAL_ATUAL']);
  });

  test('campo filho inválido ou ausente não gera issues cruzados', () => {
    assert.deepEqual(issues(trocaSenha.body.safeParse({ senhaAtual: atual, novaSenha: nova })), [{ code: 'invalid_type', path: 'confirmacaoNovaSenha', codigo: undefined }]);
    assert.deepEqual(issues(trocaSenha.body.safeParse({ senhaAtual: atual, novaSenha: '', confirmacaoNovaSenha: nova })), [{ code: 'custom', path: 'novaSenha', codigo: 'SENHA_VAZIA' }]);
    assert.deepEqual(issues(trocaSenha.body.safeParse({ senhaAtual: 5, novaSenha: nova, confirmacaoNovaSenha: 'x' })), [{ code: 'invalid_type', path: 'senhaAtual', codigo: undefined }]);
    assert.deepEqual(issues(trocaSenha.body.safeParse({ senhaAtual: atual, novaSenha: 'x'.repeat(1025), confirmacaoNovaSenha: 'y' })), [{ code: 'custom', path: 'novaSenha', codigo: 'SENHA_MUITO_LONGA' }]);
    assert.deepEqual(issues(trocaSenha.body.safeParse({})).map((i) => i.path).sort(), ['confirmacaoNovaSenha', 'novaSenha', 'senhaAtual']);
  });

  test('política completa não roda aqui; corpo estrito; mensagens sem senhas', () => {
    assert.equal(trocaSenha.body.safeParse({ senhaAtual: atual, novaSenha: 'abc', confirmacaoNovaSenha: 'abc' }).success, true);
    assert.deepEqual(issues(trocaSenha.body.safeParse({ senhaAtual: atual, novaSenha: nova, confirmacaoNovaSenha: nova, usuario_id: 7 })), [{ code: 'unrecognized_keys', path: '', codigo: undefined }]);
    assert.deepEqual(issues(trocaSenha.body.safeParse('texto')), [{ code: 'invalid_type', path: '', codigo: undefined }]);
    semSensiveis(trocaSenha.body.safeParse({ senhaAtual: 'MinhaSenhaAtual', novaSenha: 'MinhaSenhaNova', confirmacaoNovaSenha: 'MinhaSenhaOutra' }));
    semSensiveis(trocaSenha.body.safeParse({ senhaAtual: 'MinhaSenha', novaSenha: 'MinhaSenha', confirmacaoNovaSenha: 'MinhaSenha' }));
  });
});
