'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const recuperacaoSenhaService = require('../../src/services/recuperacao-senha.service');
const cookies = require('../../src/security/cookie');
const sessaoGlobalRepo = require('../../src/repositories/sessao-global.repository');
const sessaoRepo = require('../../src/repositories/sessao.repository');
const sessaoPlataformaRepo = require('../../src/repositories/sessao-plataforma.repository');
const { HttpError } = require('../../src/errors/HttpError');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * Controller HTTP da recuperação de senha (Bloco 11D), sem Express e sem
 * banco: o service é substituído e a resposta é um objeto falso. O controller
 * só traduz: fixa o escopo, repassa o que a rota validou, devolve o status e
 * remove os cookies obsoletos depois de um reset bem-sucedido. Nenhuma regra
 * de negócio é decidida aqui.
 */

const controllers = () => exigirModulo('src/controllers/recuperacao-senha.controller');

const POOL = Object.freeze({ nome: 'pool-de-teste' });
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE';
const SENHA = 'girassol-quartzo-bussola-58';
const EMAIL = '  Pessoa@Example.INVALID ';
const IP = '203.0.113.7';
const AGENTE = 'Agente de Teste';

function requisicao(body, extra = {}) {
  return { validado: { body }, ip: IP, headers: { 'user-agent': AGENTE }, ...extra };
}

function resposta() {
  return {
    statusCode: null,
    corpo: undefined,
    cabecalhos: [],
    status(codigo) { this.statusCode = codigo; return this; },
    json(corpo) { this.corpo = corpo; return this; },
    append(nome, valor) { this.cabecalhos.push([nome, valor]); return this; },
  };
}

function proibirSessaoNova(t) {
  for (const repo of [sessaoGlobalRepo, sessaoRepo, sessaoPlataformaRepo]) {
    t.mock.method(repo, 'criar', async () => { throw new Error('o controller não pode criar sessão'); });
  }
}

const ESCOPOS = [
  { escopo: 'PORTAL', remocoes: () => [cookies.serializarRemocaoCookieSessaoGlobal(), cookies.serializarRemocaoCookieSessao()] },
  { escopo: 'PLATAFORMA', remocoes: () => [cookies.serializarRemocaoCookieSessaoPlataforma(), cookies.serializarRemocaoCookieDesafioMfa()] },
];

for (const { escopo, remocoes } of ESCOPOS) {
  describe(`recuperacao-senha.controller — ${escopo}`, () => {
    const criar = () => controllers().criarRecuperacaoSenhaController({ pool: POOL, escopo });

    test('solicitar: repassa o e-mail como veio, com o escopo fixo, e responde 202 com o corpo do service', async (t) => {
      const solicitar = t.mock.method(recuperacaoSenhaService, 'solicitar', async () => recuperacaoSenhaService.RESPOSTA_SOLICITACAO);
      const res = resposta();
      await criar().solicitar(requisicao({ email: EMAIL, turnstileToken: 'token-do-widget' }), res);

      assert.equal(solicitar.mock.calls.length, 1);
      assert.equal(solicitar.mock.calls[0].arguments[0], POOL);
      assert.deepEqual(solicitar.mock.calls[0].arguments[1], { escopo, email: EMAIL, ip: IP, dispositivo: AGENTE });
      assert.equal(res.statusCode, 202);
      assert.deepEqual(res.corpo, { status: 'SOLICITACAO_RECEBIDA' });
      assert.deepEqual(res.cabecalhos, [], 'a solicitação não mexe em cookie');
    });

    test('solicitar: o escopo é o do controller, nunca um valor vindo da requisição', async (t) => {
      const solicitar = t.mock.method(recuperacaoSenhaService, 'solicitar', async () => recuperacaoSenhaService.RESPOSTA_SOLICITACAO);
      const outro = escopo === 'PORTAL' ? 'PLATAFORMA' : 'PORTAL';
      await criar().solicitar(requisicao({ email: EMAIL, escopo: outro }, { query: { escopo: outro }, params: { escopo: outro } }), resposta());
      assert.equal(solicitar.mock.calls[0].arguments[1].escopo, escopo);
    });

    test('solicitar: a resposta não leva e-mail, token, link nem identificador', async (t) => {
      t.mock.method(recuperacaoSenhaService, 'solicitar', async () => recuperacaoSenhaService.RESPOSTA_SOLICITACAO);
      const res = resposta();
      await criar().solicitar(requisicao({ email: 'pessoa@example.invalid' }), res);
      assert.deepEqual(Object.keys(res.corpo), ['status']);
      assert.equal(JSON.stringify(res.corpo).includes('example.invalid'), false);
    });

    test('redefinir: repassa token e nova senha do corpo validado, responde 200 e remove os cookies obsoletos deste portal', async (t) => {
      proibirSessaoNova(t);
      const redefinir = t.mock.method(recuperacaoSenhaService, 'redefinir', async () => ({ status: 'SENHA_REDEFINIDA' }));
      const res = resposta();
      await criar().redefinir(requisicao({ token: TOKEN, novaSenha: SENHA }), res);

      assert.equal(redefinir.mock.calls[0].arguments[0], POOL);
      assert.deepEqual(redefinir.mock.calls[0].arguments[1], { escopo, token: TOKEN, novaSenha: SENHA, ip: IP, dispositivo: AGENTE });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.corpo, { status: 'SENHA_REDEFINIDA' });
      assert.deepEqual(res.cabecalhos.map(([nome]) => nome), ['Set-Cookie', 'Set-Cookie']);
      assert.deepEqual(res.cabecalhos.map(([, valor]) => valor).sort(), remocoes().sort());
    });

    test('redefinir: os cookies da resposta só removem; nenhum cria sessão nem carrega o token ou a senha', async (t) => {
      proibirSessaoNova(t);
      t.mock.method(recuperacaoSenhaService, 'redefinir', async () => ({ status: 'SENHA_REDEFINIDA' }));
      const res = resposta();
      await criar().redefinir(requisicao({ token: TOKEN, novaSenha: SENHA }), res);
      for (const [, valor] of res.cabecalhos) {
        assert.match(valor, /^[A-Za-z0-9_-]+=;/, 'valor vazio');
        assert.match(valor, /(Max-Age=0|Expires=Thu, 01 Jan 1970)/);
        for (const sensivel of [TOKEN, SENHA]) assert.equal(valor.includes(sensivel), false);
      }
      const texto = JSON.stringify(res.corpo);
      for (const sensivel of [TOKEN, SENHA, '#token=', 'redefinir-senha.html']) assert.equal(texto.includes(sensivel), false);
    });

    test('redefinir: quando o service recusa, o erro segue como veio e nenhum cookie é tocado', async (t) => {
      proibirSessaoNova(t);
      const casos = [
        HttpError.badRequest('REDEFINICAO_INVALIDA', 'Link de redefinição inválido ou expirado'),
        HttpError.badRequest('SENHA_IGUAL_A_ATUAL', 'A nova senha deve ser diferente da senha atual'),
        HttpError.validacao([{ campo: 'body.novaSenha', codigo: 'SENHA_CURTA', mensagem: 'A senha deve ter pelo menos 12 caracteres' }]),
        Object.assign(new Error('falha simulada'), { code: '57P01' }),
      ];
      for (const erro of casos) {
        t.mock.method(recuperacaoSenhaService, 'redefinir', async () => { throw erro; });
        const res = resposta();
        await assert.rejects(() => criar().redefinir(requisicao({ token: TOKEN, novaSenha: SENHA }), res), (recebido) => recebido === erro);
        assert.deepEqual([res.statusCode, res.corpo, res.cabecalhos], [null, undefined, []]);
        t.mock.restoreAll();
        proibirSessaoNova(t);
      }
    });

    test('nada do controller depende de sessão, cookie ou cabeçalho de autorização da requisição', async (t) => {
      t.mock.method(recuperacaoSenhaService, 'solicitar', async () => recuperacaoSenhaService.RESPOSTA_SOLICITACAO);
      t.mock.method(recuperacaoSenhaService, 'redefinir', async () => ({ status: 'SENHA_REDEFINIDA' }));
      const semNada = (body) => ({ validado: { body }, ip: IP, headers: {} });
      const a = resposta();
      await criar().solicitar(semNada({ email: 'pessoa@example.invalid' }), a);
      const b = resposta();
      await criar().redefinir(semNada({ token: TOKEN, novaSenha: SENHA }), b);
      assert.deepEqual([a.statusCode, b.statusCode], [202, 200]);
      assert.equal(recuperacaoSenhaService.solicitar.mock.calls[0].arguments[1].dispositivo, undefined);
    });
  });
}

describe('recuperacao-senha.controller — fábrica e instâncias', () => {
  test('a fábrica exige pool e um escopo conhecido', () => {
    const { criarRecuperacaoSenhaController } = controllers();
    assert.throws(() => criarRecuperacaoSenhaController({ pool: POOL, escopo: 'OUTRO' }), TypeError);
    assert.throws(() => criarRecuperacaoSenhaController({ pool: POOL }), TypeError);
    assert.throws(() => criarRecuperacaoSenhaController({ escopo: 'PORTAL' }), TypeError);
  });

  test('as instâncias da aplicação têm o escopo do próprio portal e só as duas operações', async (t) => {
    const solicitar = t.mock.method(recuperacaoSenhaService, 'solicitar', async () => recuperacaoSenhaService.RESPOSTA_SOLICITACAO);
    const modulo = controllers();
    assert.deepEqual(Object.keys(modulo).sort(), ['criarRecuperacaoSenhaController', 'recuperacaoSenhaPlataformaController', 'recuperacaoSenhaPortalController']);
    for (const [instancia, escopo] of [[modulo.recuperacaoSenhaPortalController, 'PORTAL'], [modulo.recuperacaoSenhaPlataformaController, 'PLATAFORMA']]) {
      assert.deepEqual(Object.keys(instancia).sort(), ['redefinir', 'solicitar']);
      await instancia.solicitar(requisicao({ email: 'pessoa@example.invalid' }), resposta());
      assert.equal(solicitar.mock.calls.at(-1).arguments[1].escopo, escopo);
    }
  });
});
