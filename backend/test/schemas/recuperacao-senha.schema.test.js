'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * Schemas HTTP da recuperação de senha (Bloco 11D). Só estrutura: tipo e
 * tamanho. O e-mail NÃO é normalizado nem validado como endereço aqui: um
 * e-mail que não normaliza tem de chegar ao service e receber a mesma
 * resposta de um e-mail inexistente. O token também segue como veio: quem
 * decide se ele vale é o service, com o erro genérico.
 */

const schemas = () => exigirModulo('src/schemas/recuperacao-senha.schema');

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE';
const TURNSTILE = 'token-do-widget.abc_DEF-123';
const SENHA = 'girassol-quartzo-bussola-58';

const aceita = (schema, dado) => {
  const r = schema.safeParse(dado);
  assert.equal(r.success, true, JSON.stringify(r.error?.issues));
  return r.data;
};
const recusa = (schema, dado, rotulo) => {
  const r = schema.safeParse(dado);
  assert.equal(r.success, false, rotulo ?? JSON.stringify(dado));
  return r.error.issues;
};

describe('solicitação — corpo', () => {
  const casos = () => [
    ['solicitarPortal', schemas().solicitarPortal.body, { turnstileToken: TURNSTILE }],
    ['solicitarPlataforma', schemas().solicitarPlataforma.body, {}],
  ];

  test('o e-mail passa como veio, sem aparar, sem trocar a caixa e sem exigir formato de endereço', () => {
    for (const [nome, schema, base] of casos()) {
      for (const email of ['pessoa@example.invalid', '  Pessoa@Example.INVALID ', 'sem-arroba', 'a@b', 'duas@@example.invalid', 'com espaço@example.invalid', '']) {
        assert.equal(aceita(schema, { ...base, email }).email, email, `${nome} ${JSON.stringify(email)}`);
      }
    }
  });

  test('limite estrutural: e-mail é texto de até 200 caracteres', () => {
    for (const [nome, schema, base] of casos()) {
      aceita(schema, { ...base, email: 'a'.repeat(200) });
      recusa(schema, { ...base, email: 'a'.repeat(201) }, `${nome} 201`);
      for (const ruim of [undefined, null, 42, true, ['pessoa@example.invalid'], { valor: 'pessoa@example.invalid' }]) {
        recusa(schema, { ...base, email: ruim }, `${nome} ${JSON.stringify(ruim)}`);
      }
      recusa(schema, base, `${nome} sem e-mail`);
    }
  });

  test('campo a mais é recusado: escopo, ator, CNPJ e senha nunca vêm do cliente', () => {
    for (const [nome, schema, base] of casos()) {
      for (const extra of [{ escopo: 'PLATAFORMA' }, { atorTipo: 'SISTEMA' }, { cnpj: '11222333000181' }, { senha: SENHA }, { token: TOKEN }]) {
        recusa(schema, { ...base, email: 'pessoa@example.invalid', ...extra }, `${nome} ${JSON.stringify(extra)}`);
      }
    }
  });

  test('Portal exige o token do Turnstile; o Painel Privado não o aceita', () => {
    const { solicitarPortal, solicitarPlataforma } = schemas();
    assert.deepEqual(aceita(solicitarPortal.body, { email: 'pessoa@example.invalid', turnstileToken: `  ${TURNSTILE}  ` }), {
      email: 'pessoa@example.invalid', turnstileToken: TURNSTILE,
    });
    recusa(solicitarPortal.body, { email: 'pessoa@example.invalid' }, 'Portal sem Turnstile');
    recusa(solicitarPortal.body, { email: 'pessoa@example.invalid', turnstileToken: '' }, 'Portal com Turnstile vazio');
    recusa(solicitarPortal.body, { email: 'pessoa@example.invalid', turnstileToken: 'x'.repeat(2049) }, 'Portal com Turnstile longo demais');
    assert.deepEqual(aceita(solicitarPlataforma.body, { email: 'admin@example.invalid' }), { email: 'admin@example.invalid' });
    recusa(solicitarPlataforma.body, { email: 'admin@example.invalid', turnstileToken: TURNSTILE }, 'Painel com Turnstile');
  });
});

describe('redefinição — corpo', () => {
  test('token e nova senha passam como vieram; o token não é validado aqui', () => {
    const { redefinir } = schemas();
    assert.deepEqual(aceita(redefinir.body, { token: TOKEN, novaSenha: SENHA }), { token: TOKEN, novaSenha: SENHA });
    for (const token of ['token-malformado', '', 'x'.repeat(256), ` ${TOKEN} `]) {
      assert.equal(aceita(redefinir.body, { token, novaSenha: SENHA }).token, token, JSON.stringify(token.slice(0, 20)));
    }
    assert.equal(aceita(redefinir.body, { token: TOKEN, novaSenha: `  ${SENHA}  ` }).novaSenha, `  ${SENHA}  `, 'espaços fazem parte da senha');
  });

  test('limites estruturais: token é texto de até 256 caracteres; senha é texto não vazio de até 1024', () => {
    const { redefinir } = schemas();
    recusa(redefinir.body, { token: 'x'.repeat(257), novaSenha: SENHA }, 'token longo');
    for (const ruim of [undefined, null, 42, [TOKEN], { valor: TOKEN }]) recusa(redefinir.body, { token: ruim, novaSenha: SENHA }, `token ${JSON.stringify(ruim)}`);
    for (const ruim of [undefined, null, 42, '', 'x'.repeat(1025)]) recusa(redefinir.body, { token: TOKEN, novaSenha: ruim }, `senha ${typeof ruim}`);
    recusa(redefinir.body, { novaSenha: SENHA }, 'sem token');
    recusa(redefinir.body, { token: TOKEN }, 'sem senha');
  });

  test('campo a mais é recusado: e-mail, escopo, confirmação e Turnstile não fazem parte da redefinição', () => {
    const { redefinir } = schemas();
    for (const extra of [{ email: 'pessoa@example.invalid' }, { escopo: 'PORTAL' }, { confirmacao: SENHA }, { turnstileToken: TURNSTILE }, { senha: SENHA }]) {
      recusa(redefinir.body, { token: TOKEN, novaSenha: SENHA, ...extra }, JSON.stringify(extra));
    }
  });

  test('nenhuma mensagem de validação traz o valor recebido', () => {
    const { redefinir, solicitarPortal } = schemas();
    const valores = ['valorSecretoNoToken', 'valorSecretoNaSenha', 'valorSecretoNoEmail'];
    const issues = [
      ...recusa(redefinir.body, { token: ['valorSecretoNoToken'], novaSenha: { v: 'valorSecretoNaSenha' } }),
      ...recusa(solicitarPortal.body, { email: ['valorSecretoNoEmail'], turnstileToken: TURNSTILE }),
    ];
    const texto = JSON.stringify(issues.map((i) => ({ message: i.message, params: i.params })));
    for (const valor of valores) assert.equal(texto.includes(valor), false, valor);
  });
});

describe('query string', () => {
  test('as três rotas não aceitam parâmetro algum na query: o token nunca viaja na URL', () => {
    const { solicitarPortal, solicitarPlataforma, redefinir } = schemas();
    for (const [nome, schema] of [['solicitarPortal', solicitarPortal.query], ['solicitarPlataforma', solicitarPlataforma.query], ['redefinir', redefinir.query]]) {
      assert.deepEqual(aceita(schema, {}), {}, nome);
      for (const ruim of [{ token: TOKEN }, { email: 'pessoa@example.invalid' }, { qualquer: '1' }]) recusa(schema, ruim, `${nome} ${JSON.stringify(Object.keys(ruim))}`);
    }
  });

  test('o módulo exporta só os três contratos', () => {
    assert.deepEqual(Object.keys(schemas()).sort(), ['redefinir', 'solicitarPlataforma', 'solicitarPortal']);
  });
});
