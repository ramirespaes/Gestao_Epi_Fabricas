'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { authConfig } = require('../../src/config/auth');
const { pool: poolGlobal } = require('../../src/config/database');
const token = require('../../src/security/token');
const sessaoGlobalRepo = require('../../src/repositories/sessao-global.repository');
const sessaoRepo = require('../../src/repositories/sessao.repository');
const sessaoPlataformaRepo = require('../../src/repositories/sessao-plataforma.repository');
const { HttpError } = require('../../src/errors/HttpError');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * Controllers da troca de senha autenticada (Bloco 11E), sem Express e sem
 * banco: o service é substituído e a resposta é um objeto falso. O controller
 * só traduz. Quem age vem do que o middleware de sessão já provou (nunca do
 * corpo), os tokens saem dos cookies da própria requisição e a resposta de
 * sucesso é sempre a mesma, sem cookie algum: a sessão atual continua como
 * está, e nenhuma sessão nova nasce.
 */

const controllers = () => exigirModulo('src/controllers/troca-senha.controller');
const servicoGlobal = () => exigirModulo('src/services/troca-senha-global.service');
const servicoPlataforma = () => exigirModulo('src/services/troca-senha-plataforma.service');

const POOL = Object.freeze({ nome: 'pool-de-teste' });
const SENHA_ATUAL = 'planeta-nebulosa-ozonio-42';
const SENHA_NOVA = 'girassol-quartzo-bussola-58';
const CODIGO = '123456';
const IP = '203.0.113.7';
const AGENTE = 'Agente de Teste';
const { cookieNomeGlobal: NOME_GLOBAL, cookieNome: NOME_EMPRESA, cookieNomeAdmin: NOME_ADMIN } = authConfig.sessao;
const TOKEN_GLOBAL = token.gerarTokenSessao();
const TOKEN_EMPRESARIAL = token.gerarTokenSessao();
const TOKEN_ADMIN = token.gerarTokenSessao();

const cookieDe = (...pares) => pares.map(([nome, valor]) => `${nome}=${valor}`).join('; ');

function resposta() {
  const r = {
    statusCode: null,
    corpo: undefined,
    cabecalhos: [],
    status(codigo) { r.statusCode = codigo; return r; },
    json(corpo) { r.corpo = corpo; return r; },
  };
  // Qualquer forma de mexer em cookie ou cabeçalho fica registrada.
  for (const metodo of ['append', 'setHeader', 'set', 'cookie', 'clearCookie', 'header']) {
    r[metodo] = (...argumentos) => { r.cabecalhos.push([metodo, ...argumentos]); return r; };
  }
  return r;
}

function requisicaoGlobal({ body = { senhaAtual: SENHA_ATUAL, novaSenha: SENHA_NOVA }, cookie = cookieDe([NOME_GLOBAL, TOKEN_GLOBAL], [NOME_EMPRESA, TOKEN_EMPRESARIAL]), agente = AGENTE } = {}) {
  return {
    validado: { body },
    identidade: { id: 42, email: 'pessoa@example.invalid' },
    sessaoGlobal: { id: '7' },
    ip: IP,
    headers: { ...(agente === null ? {} : { 'user-agent': agente }), ...(cookie === null ? {} : { cookie }) },
  };
}

function requisicaoPlataforma({ body = { senhaAtual: SENHA_ATUAL, novaSenha: SENHA_NOVA, codigo: CODIGO }, cookie = cookieDe([NOME_ADMIN, TOKEN_ADMIN]) } = {}) {
  return {
    validado: { body },
    administradorPlataforma: { id: 9, email: 'admin@example.invalid' },
    sessaoPlataforma: { id: '5' },
    ip: IP,
    headers: { 'user-agent': AGENTE, ...(cookie === null ? {} : { cookie }) },
  };
}

function proibirSessaoNova(t) {
  const espias = [sessaoGlobalRepo, sessaoRepo, sessaoPlataformaRepo].map((repo) => t.mock.method(repo, 'criar', async () => { throw new Error('o controller não pode criar sessão'); }));
  return () => espias.reduce((total, espia) => total + espia.mock.calls.length, 0);
}

const ERROS_DO_SERVICE = [
  HttpError.unauthorized('SESSAO_INVALIDA', 'Sessão inválida ou expirada'),
  HttpError.unauthorized('SENHA_ATUAL_INVALIDA', 'Senha atual incorreta'),
  HttpError.unauthorized('REAUTENTICACAO_INVALIDA', 'Senha ou código inválidos'),
  HttpError.tooManyRequests('LOGIN_EM_COOLDOWN', 'Muitas tentativas. Tente novamente mais tarde', { retryAfterSegundos: 30 }),
  HttpError.badRequest('SENHA_IGUAL_A_ATUAL', 'A nova senha deve ser diferente da senha atual'),
  HttpError.validacao([{ campo: 'body.novaSenha', codigo: 'SENHA_CURTA', mensagem: 'A senha deve ter pelo menos 12 caracteres' }]),
  Object.assign(new Error('falha simulada'), { code: '57P01' }),
];

describe('troca-senha.controller — Portal (sessão global)', () => {
  const criar = () => controllers().criarTrocaSenhaGlobalController({ pool: POOL });

  test('repassa a identidade e a sessão da sessão autenticada, os dois tokens dos cookies e as senhas, com a origem da requisição, e responde 200 sem cookie', async (t) => {
    const trocar = t.mock.method(servicoGlobal(), 'trocar', async () => ({ status: 'SENHA_ALTERADA' }));
    const res = resposta();
    await criar().trocar(requisicaoGlobal(), res);

    assert.equal(trocar.mock.calls.length, 1);
    assert.equal(trocar.mock.calls[0].arguments[0], POOL);
    assert.deepEqual(trocar.mock.calls[0].arguments[1], {
      identidadeId: 42,
      sessaoGlobalId: '7',
      tokenSessaoGlobal: TOKEN_GLOBAL,
      tokenSessaoEmpresarial: TOKEN_EMPRESARIAL,
      senhaAtual: SENHA_ATUAL,
      novaSenha: SENHA_NOVA,
      ip: IP,
      dispositivo: AGENTE,
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.corpo, { status: 'SENHA_ALTERADA' });
    assert.deepEqual(res.cabecalhos, [], 'nenhum cookie emitido, trocado ou removido');
  });

  test('a identidade e a sessão vêm só do middleware: o que o corpo trouxer a mais é ignorado', async (t) => {
    const trocar = t.mock.method(servicoGlobal(), 'trocar', async () => ({ status: 'SENHA_ALTERADA' }));
    const intruso = { senhaAtual: SENHA_ATUAL, novaSenha: SENHA_NOVA, identidadeId: 999, sessaoGlobalId: '999', sessaoId: '999', email: 'outra@example.invalid', escopo: 'PLATAFORMA' };
    await criar().trocar(requisicaoGlobal({ body: intruso }), resposta());

    const dados = trocar.mock.calls[0].arguments[1];
    assert.deepEqual([dados.identidadeId, dados.sessaoGlobalId], [42, '7']);
    assert.deepEqual(Object.keys(dados).sort(), ['dispositivo', 'identidadeId', 'ip', 'novaSenha', 'senhaAtual', 'sessaoGlobalId', 'tokenSessaoEmpresarial', 'tokenSessaoGlobal']);
    assert.equal(JSON.stringify(dados).includes('outra@example.invalid'), false);
  });

  test('cookie empresarial ausente ou duplicado vira null; cookie global ausente também; o valor presente vai como veio', async (t) => {
    const trocar = t.mock.method(servicoGlobal(), 'trocar', async () => ({ status: 'SENHA_ALTERADA' }));
    const outro = token.gerarTokenSessao();
    const casos = [
      [cookieDe([NOME_GLOBAL, TOKEN_GLOBAL]), TOKEN_GLOBAL, null],
      [cookieDe([NOME_GLOBAL, TOKEN_GLOBAL], [NOME_EMPRESA, TOKEN_EMPRESARIAL], [NOME_EMPRESA, outro]), TOKEN_GLOBAL, null],
      [cookieDe([NOME_EMPRESA, TOKEN_EMPRESARIAL]), null, TOKEN_EMPRESARIAL],
      [null, null, null],
      [cookieDe([NOME_GLOBAL, TOKEN_GLOBAL], [NOME_EMPRESA, 'formato-invalido']), TOKEN_GLOBAL, 'formato-invalido'],
    ];
    for (const [cookie, global, empresarial] of casos) {
      await criar().trocar(requisicaoGlobal({ cookie }), resposta());
      const dados = trocar.mock.calls.at(-1).arguments[1];
      assert.deepEqual([dados.tokenSessaoGlobal, dados.tokenSessaoEmpresarial], [global, empresarial], String(cookie));
    }
  });

  test('o cookie do Painel Privado e qualquer outro cookie nunca chegam ao service', async (t) => {
    const trocar = t.mock.method(servicoGlobal(), 'trocar', async () => ({ status: 'SENHA_ALTERADA' }));
    const cookie = cookieDe([NOME_GLOBAL, TOKEN_GLOBAL], [NOME_ADMIN, TOKEN_ADMIN], ['outro', 'valor-qualquer-de-outro-cookie']);
    await criar().trocar(requisicaoGlobal({ cookie }), resposta());
    const texto = JSON.stringify(trocar.mock.calls[0].arguments[1]);
    for (const alheio of [TOKEN_ADMIN, 'valor-qualquer-de-outro-cookie']) assert.equal(texto.includes(alheio), false);
  });

  test('sem User-Agent o dispositivo vai como undefined; a origem nunca é inventada', async (t) => {
    const trocar = t.mock.method(servicoGlobal(), 'trocar', async () => ({ status: 'SENHA_ALTERADA' }));
    await criar().trocar(requisicaoGlobal({ agente: null }), resposta());
    assert.equal(trocar.mock.calls[0].arguments[1].dispositivo, undefined);
    assert.equal(trocar.mock.calls[0].arguments[1].ip, IP);
  });

  test('a resposta é sempre a mesma: nada do que o service devolver além do status chega ao cliente', async (t) => {
    t.mock.method(servicoGlobal(), 'trocar', async () => ({ status: 'SENHA_ALTERADA', token: 'x', senha_hash: 'y', email: 'pessoa@example.invalid' }));
    const res = resposta();
    await criar().trocar(requisicaoGlobal(), res);
    assert.deepEqual(res.corpo, { status: 'SENHA_ALTERADA' });
    assert.deepEqual(Object.keys(res.corpo), ['status']);
  });

  test('quando o service recusa, o erro segue como veio e a resposta e os cookies não são tocados', async (t) => {
    const sessoesCriadas = proibirSessaoNova(t);
    let erroDaVez;
    t.mock.method(servicoGlobal(), 'trocar', async () => { throw erroDaVez; });
    for (const erro of ERROS_DO_SERVICE) {
      erroDaVez = erro;
      const res = resposta();
      await assert.rejects(() => criar().trocar(requisicaoGlobal(), res), (recebido) => recebido === erro);
      assert.deepEqual([res.statusCode, res.corpo, res.cabecalhos], [null, undefined, []]);
    }
    assert.equal(sessoesCriadas(), 0);
  });

  test('o controller não cria sessão nem emite cookie, em sucesso ou em recusa', async (t) => {
    const sessoesCriadas = proibirSessaoNova(t);
    t.mock.method(servicoGlobal(), 'trocar', async () => ({ status: 'SENHA_ALTERADA' }));
    const res = resposta();
    await criar().trocar(requisicaoGlobal(), res);
    assert.equal(sessoesCriadas(), 0);
    assert.deepEqual(res.cabecalhos, []);
    assert.equal(JSON.stringify(res.corpo).includes(TOKEN_GLOBAL), false);
  });

  test('a fábrica exige o pool e devolve só a operação trocar', () => {
    const { criarTrocaSenhaGlobalController } = controllers();
    assert.throws(() => criarTrocaSenhaGlobalController({}), TypeError);
    assert.throws(() => criarTrocaSenhaGlobalController(), TypeError);
    const controller = criarTrocaSenhaGlobalController({ pool: POOL });
    assert.deepEqual(Object.keys(controller), ['trocar']);
    assert.equal(typeof controller.trocar, 'function');
  });
});

describe('troca-senha.controller — Painel Privado (sessão administrativa plena)', () => {
  const criar = () => controllers().criarTrocaSenhaPlataformaController({ pool: POOL });

  test('repassa o administrador e a sessão da sessão autenticada, o token do cookie administrativo, as senhas e o TOTP, e responde 200 sem cookie', async (t) => {
    const trocar = t.mock.method(servicoPlataforma(), 'trocar', async () => ({ status: 'SENHA_ALTERADA' }));
    const res = resposta();
    await criar().trocar(requisicaoPlataforma(), res);

    assert.equal(trocar.mock.calls.length, 1);
    assert.equal(trocar.mock.calls[0].arguments[0], POOL);
    assert.deepEqual(trocar.mock.calls[0].arguments[1], {
      administradorId: 9,
      sessaoId: '5',
      tokenSessao: TOKEN_ADMIN,
      senhaAtual: SENHA_ATUAL,
      novaSenha: SENHA_NOVA,
      codigo: CODIGO,
      ip: IP,
      dispositivo: AGENTE,
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.corpo, { status: 'SENHA_ALTERADA' });
    assert.deepEqual(res.cabecalhos, [], 'a sessão atual fica como está: nenhum cookie emitido, trocado ou removido');
  });

  test('o administrador e a sessão vêm só do middleware: o que o corpo trouxer a mais é ignorado', async (t) => {
    const trocar = t.mock.method(servicoPlataforma(), 'trocar', async () => ({ status: 'SENHA_ALTERADA' }));
    const intruso = { senhaAtual: SENHA_ATUAL, novaSenha: SENHA_NOVA, codigo: CODIGO, administradorId: 999, sessaoId: '999', email: 'outra@example.invalid' };
    await criar().trocar(requisicaoPlataforma({ body: intruso }), resposta());
    const dados = trocar.mock.calls[0].arguments[1];
    assert.deepEqual([dados.administradorId, dados.sessaoId], [9, '5']);
    assert.deepEqual(Object.keys(dados).sort(), ['administradorId', 'codigo', 'dispositivo', 'ip', 'novaSenha', 'senhaAtual', 'sessaoId', 'tokenSessao']);
  });

  test('cookie administrativo ausente ou duplicado vira null; os cookies do Portal e do desafio MFA nunca chegam ao service', async (t) => {
    const trocar = t.mock.method(servicoPlataforma(), 'trocar', async () => ({ status: 'SENHA_ALTERADA' }));
    const global = token.gerarTokenSessao();
    const desafio = token.gerarTokenSessao();
    const casos = [
      [null, null],
      [cookieDe([NOME_GLOBAL, global]), null],
      [cookieDe([NOME_ADMIN, TOKEN_ADMIN], [NOME_ADMIN, global]), null],
      [cookieDe([NOME_ADMIN, TOKEN_ADMIN], [NOME_GLOBAL, global], [authConfig.desafioMfa.cookieNome, desafio]), TOKEN_ADMIN],
    ];
    for (const [cookie, esperado] of casos) {
      await criar().trocar(requisicaoPlataforma({ cookie }), resposta());
      const dados = trocar.mock.calls.at(-1).arguments[1];
      assert.equal(dados.tokenSessao, esperado, String(cookie));
      for (const alheio of [global, desafio]) assert.equal(JSON.stringify(dados).includes(alheio), false);
    }
  });

  test('a resposta é sempre a mesma: nada do que o service devolver além do status chega ao cliente', async (t) => {
    t.mock.method(servicoPlataforma(), 'trocar', async () => ({ status: 'SENHA_ALTERADA', codigosRecuperacao: ['A'], segredo: 'x' }));
    const res = resposta();
    await criar().trocar(requisicaoPlataforma(), res);
    assert.deepEqual(res.corpo, { status: 'SENHA_ALTERADA' });
  });

  test('quando o service recusa, o erro segue como veio e a resposta e os cookies não são tocados', async (t) => {
    const sessoesCriadas = proibirSessaoNova(t);
    let erroDaVez;
    t.mock.method(servicoPlataforma(), 'trocar', async () => { throw erroDaVez; });
    for (const erro of ERROS_DO_SERVICE) {
      erroDaVez = erro;
      const res = resposta();
      await assert.rejects(() => criar().trocar(requisicaoPlataforma(), res), (recebido) => recebido === erro);
      assert.deepEqual([res.statusCode, res.corpo, res.cabecalhos], [null, undefined, []]);
    }
    assert.equal(sessoesCriadas(), 0);
  });

  test('a fábrica exige o pool e devolve só a operação trocar', () => {
    const { criarTrocaSenhaPlataformaController } = controllers();
    assert.throws(() => criarTrocaSenhaPlataformaController({}), TypeError);
    assert.throws(() => criarTrocaSenhaPlataformaController(), TypeError);
    const controller = criarTrocaSenhaPlataformaController({ pool: POOL });
    assert.deepEqual(Object.keys(controller), ['trocar']);
  });
});

describe('troca-senha.controller — módulo e instâncias da aplicação', () => {
  test('exporta só as duas fábricas e as duas instâncias, cada uma com a operação trocar', () => {
    const modulo = controllers();
    assert.deepEqual(Object.keys(modulo).sort(), [
      'criarTrocaSenhaGlobalController', 'criarTrocaSenhaPlataformaController', 'trocaSenhaGlobalController', 'trocaSenhaPlataformaController',
    ]);
    for (const instancia of [modulo.trocaSenhaGlobalController, modulo.trocaSenhaPlataformaController]) {
      assert.deepEqual(Object.keys(instancia), ['trocar']);
    }
  });

  test('as instâncias da aplicação chamam o service do próprio portal com o pool do projeto', async (t) => {
    const modulo = controllers();
    const global = t.mock.method(servicoGlobal(), 'trocar', async () => ({ status: 'SENHA_ALTERADA' }));
    const plataforma = t.mock.method(servicoPlataforma(), 'trocar', async () => ({ status: 'SENHA_ALTERADA' }));
    await modulo.trocaSenhaGlobalController.trocar(requisicaoGlobal(), resposta());
    await modulo.trocaSenhaPlataformaController.trocar(requisicaoPlataforma(), resposta());
    assert.deepEqual([global.mock.calls.length, plataforma.mock.calls.length], [1, 1]);
    assert.equal(global.mock.calls[0].arguments[0], poolGlobal);
    assert.equal(plataforma.mock.calls[0].arguments[0], poolGlobal);
  });
});
