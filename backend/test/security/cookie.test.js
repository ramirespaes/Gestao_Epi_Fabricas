'use strict';

const { describe, test, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { criarPoliticaCookie, serializarCookieSessao, serializarRemocaoCookieSessao } = require('../../src/security/cookie');
const { authConfig, carregarConfigAuth } = require('../../src/config/auth');
const { gerarTokenSessao } = require('../../src/security/token');
const { assertSemSensiveis } = require('../helpers/sensiveis');

const TOKEN = gerarTokenSessao();

/**
 * Quebra a string Set-Cookie em nome, valor e atributos, sem depender da
 * ordem textual: nomes de atributo em minúsculas, presença booleana como
 * true. O valor é decodificado para comparar com o token original.
 */
function analisarSetCookie(texto) {
  const [primeiro, ...resto] = texto.split(';').map((parte) => parte.trim());
  const separador = primeiro.indexOf('=');
  const atributos = {};
  for (const parte of resto) {
    const igual = parte.indexOf('=');
    if (igual === -1) {
      atributos[parte.toLowerCase()] = true;
    } else {
      atributos[parte.slice(0, igual).trim().toLowerCase()] = parte.slice(igual + 1).trim();
    }
  }
  return {
    nome: primeiro.slice(0, separador),
    valor: decodeURIComponent(primeiro.slice(separador + 1)),
    valorBruto: primeiro.slice(separador + 1),
    atributos,
  };
}

// Atributos que definem a identidade do cookie: precisam coincidir entre
// emissão e remoção, senão o navegador cria um segundo cookie.
const estruturais = (cookie) => ({
  nome: cookie.nome,
  path: cookie.atributos.path,
  httponly: cookie.atributos.httponly ?? false,
  secure: cookie.atributos.secure ?? false,
  samesite: cookie.atributos.samesite,
  temDomain: 'domain' in cookie.atributos,
});

let logs;
beforeEach(() => {
  logs = [];
  mock.method(console, 'error', (...args) => logs.push(args.map(String).join(' ')));
  mock.method(console, 'log', (...args) => logs.push(args.map(String).join(' ')));
});
afterEach(() => mock.restoreAll());

describe('serializarCookieSessao: política real de authConfig', () => {
  test('nome, token, HttpOnly, Path, SameSite e Max-Age vindos da configuração', () => {
    const cookie = analisarSetCookie(serializarCookieSessao(TOKEN));
    assert.equal(cookie.nome, authConfig.sessao.cookieNome);
    assert.equal(cookie.valor, TOKEN);
    assert.equal(cookie.atributos.httponly, true);
    assert.equal(cookie.atributos.path, '/');
    assert.equal(cookie.atributos.samesite, 'Lax');
    assert.equal(cookie.atributos['max-age'], String(authConfig.sessao.expiracaoMinutos * 60));
  });

  test('sem Domain, sem Expires, sem Priority e sem Partitioned', () => {
    const { atributos } = analisarSetCookie(serializarCookieSessao(TOKEN));
    for (const indesejado of ['domain', 'expires', 'priority', 'partitioned']) {
      assert.equal(indesejado in atributos, false, indesejado);
    }
  });

  test('Secure ausente no ambiente de teste, conforme authConfig.sessao.cookieSecure', () => {
    const { atributos } = analisarSetCookie(serializarCookieSessao(TOKEN));
    assert.equal(authConfig.sessao.cookieSecure, false);
    assert.equal('secure' in atributos, false);
  });

  test('token canônico do projeto faz round-trip exato no valor do cookie', () => {
    for (let i = 0; i < 20; i += 1) {
      const token = gerarTokenSessao();
      const cookie = analisarSetCookie(serializarCookieSessao(token));
      assert.equal(cookie.valor, token);
      assert.equal(cookie.valorBruto, token, 'token canônico não deve sofrer escape');
    }
  });
});

describe('criarPoliticaCookie: configurações explícitas', () => {
  const politica = (extra) => criarPoliticaCookie({
    nome: 'gepi_sessao',
    secure: false,
    sameSite: 'lax',
    expiracaoMinutos: 720,
    ...extra,
  });

  test('secure true adiciona Secure; secure false o omite', () => {
    assert.equal(analisarSetCookie(politica({ secure: true }).serializarSessao(TOKEN)).atributos.secure, true);
    assert.equal('secure' in analisarSetCookie(politica({ secure: false }).serializarSessao(TOKEN)).atributos, false);
  });

  test('sameSite é refletido: lax, strict e none com secure', () => {
    assert.equal(analisarSetCookie(politica({ sameSite: 'lax' }).serializarSessao(TOKEN)).atributos.samesite, 'Lax');
    assert.equal(analisarSetCookie(politica({ sameSite: 'strict' }).serializarSessao(TOKEN)).atributos.samesite, 'Strict');
    const none = analisarSetCookie(politica({ sameSite: 'none', secure: true }).serializarSessao(TOKEN));
    assert.equal(none.atributos.samesite, 'None');
    assert.equal(none.atributos.secure, true);
  });

  test('Max-Age em segundos, derivado de expiracaoMinutos', () => {
    assert.equal(analisarSetCookie(politica({ expiracaoMinutos: 720 }).serializarSessao(TOKEN)).atributos['max-age'], '43200');
    assert.equal(analisarSetCookie(politica({ expiracaoMinutos: 5 }).serializarSessao(TOKEN)).atributos['max-age'], '300');
  });

  test('nome do cookie vem da política', () => {
    assert.equal(analisarSetCookie(politica({ nome: '__Host-gepi_sessao', secure: true }).serializarSessao(TOKEN)).nome, '__Host-gepi_sessao');
  });
});

describe('serializarRemocaoCookieSessao', () => {
  test('valor vazio, Max-Age=0 e Expires no passado', () => {
    const cookie = analisarSetCookie(serializarRemocaoCookieSessao());
    assert.equal(cookie.valorBruto, '');
    assert.equal(cookie.atributos['max-age'], '0');
    assert.ok('expires' in cookie.atributos, 'remoção deve trazer Expires');
    assert.ok(new Date(cookie.atributos.expires).getTime() < Date.now(), 'Expires deve estar no passado');
  });

  test('atributos estruturais idênticos aos da emissão', () => {
    const emissao = analisarSetCookie(serializarCookieSessao(TOKEN));
    const remocao = analisarSetCookie(serializarRemocaoCookieSessao());
    assert.deepEqual(estruturais(remocao), estruturais(emissao));
    assert.equal(remocao.atributos.temDomain, undefined);
  });

  test('a política explícita também preserva os atributos estruturais na remoção', () => {
    const politica = criarPoliticaCookie({ nome: 'gepi_sessao', secure: true, sameSite: 'none', expiracaoMinutos: 60 });
    assert.deepEqual(
      estruturais(analisarSetCookie(politica.serializarRemocao())),
      estruturais(analisarSetCookie(politica.serializarSessao(TOKEN))),
    );
  });
});

describe('validação do token e segurança', () => {
  test('token inválido lança TypeError com mensagem fixa, sem ecoar o valor', () => {
    const sentinela = 'TOKEN_SENTINELA_9c4f';
    const invalidos = ['', null, undefined, 123, {}, [], sentinela, `${sentinela} com espaço`];
    for (const invalido of invalidos) {
      assert.throws(() => serializarCookieSessao(invalido), (erro) => {
        assert.ok(erro instanceof TypeError, String(invalido));
        assert.equal(erro.message, 'token de sessão inválido');
        assertSemSensiveis(erro.message, [sentinela], 'mensagem');
        return true;
      });
    }
  });

  test('nenhuma função escreve em console', () => {
    serializarCookieSessao(TOKEN);
    serializarRemocaoCookieSessao();
    criarPoliticaCookie({ nome: 'x', secure: true, sameSite: 'lax', expiracaoMinutos: 1 }).serializarSessao(TOKEN);
    try {
      serializarCookieSessao('');
    } catch {
      // esperado
    }
    assert.deepEqual(logs, []);
  });
});

describe('regras que pertencem à configuração, não ao helper', () => {
  test('SameSite=None sem Secure é rejeitado por carregarConfigAuth', () => {
    const segredo = process.env.LOGIN_COOLDOWN_HMAC_SECRET;
    assert.throws(
      () => carregarConfigAuth({ LOGIN_COOLDOWN_HMAC_SECRET: segredo, SESSAO_COOKIE_SAMESITE: 'none' }),
      /SESSAO_COOKIE_SAMESITE: SameSite=None exige cookie Secure/,
    );
    assert.doesNotThrow(() => carregarConfigAuth({ LOGIN_COOLDOWN_HMAC_SECRET: segredo, SESSAO_COOKIE_SAMESITE: 'none', SESSAO_COOKIE_SECURE: 'true' }));
  });
});
