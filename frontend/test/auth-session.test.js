'use strict';

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const EpiHttp = require('../js/api-http');
const EpiAuth = require('../js/auth-session');

/**
 * Testes do módulo de autenticação real do frontend (Bloco 8, Incremento
 * 8, Etapa 5A, Subetapa 3R), com `fetch` injetado.
 *
 * O foco aqui são as propriedades de SEGURANÇA que distinguem este
 * módulo do login legado de js/main.js: a senha não fica em lugar
 * nenhum, a sessão não é persistida pelo cliente (vive só no cookie
 * HttpOnly do backend) e a identidade em memória nunca é tratada como
 * prova de autenticação.
 */

const BASE = 'http://localhost:3000/api';

function fetchFalso(respostas) {
  const chamadas = [];
  const fila = Array.isArray(respostas) ? respostas.slice() : [respostas];
  const fn = async (url, opcoes) => {
    chamadas.push({ url, opcoes });
    const proxima = fila.length > 1 ? fila.shift() : fila[0];
    if (proxima instanceof Error) throw proxima;
    return proxima;
  };
  fn.chamadas = chamadas;
  return fn;
}

const resposta = (status, corpo, { erroNaLeitura } = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  text: async () => {
    if (erroNaLeitura) throw erroNaLeitura;
    return corpo === undefined ? '' : JSON.stringify(corpo);
  },
});

const IDENTIDADE = {
  status: 'ok',
  usuario: { id: 5, nome: 'Tainara Alves', email: 't@demo.com.br', perfil: 'ADMINISTRADOR', ativo: true },
  empresa: { id: 1, nome: 'Empresa A', cnpj: '12345678000195' },
};

const CREDENCIAIS = { cnpj: '12.345.678/0001-95', email: 't@demo.com.br', senha: 'Senha-Secreta-123' };

beforeEach(async () => {
  EpiHttp.configurar({ baseUrl: BASE, fetch: fetchFalso(resposta(200, { status: 'ok' })) });
  await EpiAuth.sair(); // zera a identidade em memória entre os testes
});

describe('entrar', () => {
  test('envia cnpj, email e senha ao contrato real de /auth/login e guarda a identidade em memória', async () => {
    const fetch = fetchFalso(resposta(200, IDENTIDADE));
    EpiHttp.configurar({ fetch });

    const r = await EpiAuth.entrar(CREDENCIAIS);

    assert.equal(r.ok, true);
    assert.equal(fetch.chamadas[0].url, `${BASE}/auth/login`);
    assert.equal(fetch.chamadas[0].opcoes.method, 'POST');
    assert.deepEqual(JSON.parse(fetch.chamadas[0].opcoes.body), CREDENCIAIS);
    assert.equal(r.identidade.usuario.id, 5);
    assert.equal(EpiAuth.identidade().empresa.id, 1);
  });

  test('a senha não sobrevive ao login: não está na identidade nem em nenhum estado exposto pelo módulo', async () => {
    EpiHttp.configurar({ fetch: fetchFalso(resposta(200, IDENTIDADE)) });

    await EpiAuth.entrar(CREDENCIAIS);

    const exposto = JSON.stringify({ identidade: EpiAuth.identidade(), modulo: Object.keys(EpiAuth) });
    assert.equal(exposto.includes(CREDENCIAIS.senha), false, 'a senha não pode aparecer em nada que o módulo exponha');
  });

  test('credencial inválida (401) não guarda identidade e devolve a resposta do backend', async () => {
    EpiHttp.configurar({
      fetch: fetchFalso(resposta(401, { status: 'error', codigo: 'CREDENCIAIS_INVALIDAS', message: 'Credenciais inválidas' })),
    });

    const r = await EpiAuth.entrar(CREDENCIAIS);

    assert.equal(r.ok, false);
    assert.equal(r.identidade, null);
    assert.equal(EpiAuth.identidade(), null);
    assert.equal(r.resposta.codigo, 'CREDENCIAIS_INVALIDAS');
  });

  test('cooldown (429) chega à interface como está, sem ser confundido com credencial errada', async () => {
    EpiHttp.configurar({
      fetch: fetchFalso(resposta(429, { status: 'error', codigo: 'LIMITE_EXCEDIDO', message: 'Muitas tentativas' })),
    });

    const r = await EpiAuth.entrar(CREDENCIAIS);

    assert.equal(r.ok, false);
    assert.equal(r.resposta.status, 429);
    assert.equal(r.resposta.codigo, 'LIMITE_EXCEDIDO');
  });

  test('credenciais incompletas são erro de programação, antes de qualquer rede', async () => {
    const fetch = fetchFalso(resposta(200, IDENTIDADE));
    EpiHttp.configurar({ fetch });

    await assert.rejects(EpiAuth.entrar({ cnpj: 'x', email: 'y' }), TypeError);
    await assert.rejects(EpiAuth.entrar(), TypeError);
    assert.equal(fetch.chamadas.length, 0);
  });
});

describe('sessaoAtual', () => {
  test('confirma a sessão no servidor e atualiza a identidade', async () => {
    const fetch = fetchFalso(resposta(200, IDENTIDADE));
    EpiHttp.configurar({ fetch });

    const r = await EpiAuth.sessaoAtual();

    assert.equal(fetch.chamadas[0].url, `${BASE}/auth/me`);
    assert.equal(fetch.chamadas[0].opcoes.method, 'GET');
    assert.equal(r.autenticado, true);
    assert.equal(EpiAuth.identidade().usuario.perfil, 'ADMINISTRADOR');
  });

  test('401 zera a identidade em memória — sessão expirada não deixa resíduo na tela', async () => {
    EpiHttp.configurar({ fetch: fetchFalso(resposta(200, IDENTIDADE)) });
    await EpiAuth.entrar(CREDENCIAIS);
    assert.ok(EpiAuth.identidade());

    EpiHttp.configurar({ fetch: fetchFalso(resposta(401, { status: 'error', codigo: 'SESSAO_INVALIDA', message: 'Sessão inválida ou expirada' })) });
    const r = await EpiAuth.sessaoAtual();

    assert.equal(r.autenticado, false);
    assert.equal(EpiAuth.identidade(), null);
  });

  // Correção pós-auditoria da 3R: uma leitura de corpo interrompida no
  // /auth/me chegava como Promise rejeitada, não como envelope — e
  // teria escapado do tratamento de sessão aqui.
  test('conexão que cai durante a leitura do /auth/me não é sessão válida e zera a identidade', async () => {
    EpiHttp.configurar({ fetch: fetchFalso(resposta(200, IDENTIDADE)) });
    await EpiAuth.entrar(CREDENCIAIS);
    assert.ok(EpiAuth.identidade());

    EpiHttp.configurar({
      fetch: fetchFalso(resposta(200, undefined, { erroNaLeitura: new TypeError('terminated') })),
    });
    const r = await EpiAuth.sessaoAtual();

    assert.equal(r.autenticado, false, 'status 200 com corpo perdido não autentica ninguém');
    assert.equal(r.resposta.codigo, 'FALHA_DE_REDE');
    assert.equal(EpiAuth.identidade(), null);
  });

  test('falha de rede não é tratada como sessão válida', async () => {
    EpiHttp.configurar({ fetch: fetchFalso(resposta(200, IDENTIDADE)) });
    await EpiAuth.entrar(CREDENCIAIS);

    EpiHttp.configurar({ fetch: fetchFalso(new TypeError('Failed to fetch')) });
    const r = await EpiAuth.sessaoAtual();

    assert.equal(r.autenticado, false);
    assert.equal(r.resposta.codigo, 'FALHA_DE_REDE');
    assert.equal(EpiAuth.identidade(), null);
  });
});

describe('sair', () => {
  test('chama o logout real e descarta a identidade', async () => {
    EpiHttp.configurar({ fetch: fetchFalso(resposta(200, IDENTIDADE)) });
    await EpiAuth.entrar(CREDENCIAIS);

    const fetch = fetchFalso(resposta(200, { status: 'ok' }));
    EpiHttp.configurar({ fetch });
    const r = await EpiAuth.sair();

    assert.equal(fetch.chamadas[0].url, `${BASE}/auth/logout`);
    assert.equal(fetch.chamadas[0].opcoes.method, 'POST');
    assert.equal(r.ok, true);
    assert.equal(EpiAuth.identidade(), null);
  });

  test('mesmo com falha de rede a identidade local é descartada', async () => {
    EpiHttp.configurar({ fetch: fetchFalso(resposta(200, IDENTIDADE)) });
    await EpiAuth.entrar(CREDENCIAIS);

    EpiHttp.configurar({ fetch: fetchFalso(new TypeError('Failed to fetch')) });
    const r = await EpiAuth.sair();

    assert.equal(r.ok, false);
    assert.equal(EpiAuth.identidade(), null);
  });
});

describe('a sessão não é persistida pelo cliente (diferença central em relação ao login legado)', () => {
  test('nenhum armazenamento do navegador é tocado no login, na consulta ou no logout', async () => {
    const escritas = [];
    const armazenamentoEspiao = () => ({
      setItem: (chave, valor) => escritas.push({ chave, valor }),
      getItem: () => null,
      removeItem: (chave) => escritas.push({ chave, valor: null }),
    });

    const original = {
      localStorage: globalThis.localStorage,
      sessionStorage: globalThis.sessionStorage,
      document: globalThis.document,
    };
    globalThis.localStorage = armazenamentoEspiao();
    globalThis.sessionStorage = armazenamentoEspiao();
    let cookieEscrito = null;
    globalThis.document = { set cookie(v) { cookieEscrito = v; }, get cookie() { return ''; } };

    try {
      EpiHttp.configurar({ fetch: fetchFalso(resposta(200, IDENTIDADE)) });
      await EpiAuth.entrar(CREDENCIAIS);
      await EpiAuth.sessaoAtual();
      await EpiAuth.sair();
    } finally {
      globalThis.localStorage = original.localStorage;
      globalThis.sessionStorage = original.sessionStorage;
      globalThis.document = original.document;
    }

    assert.deepEqual(escritas, [], 'nada foi gravado em localStorage/sessionStorage');
    assert.equal(cookieEscrito, null, 'nenhum cookie legível foi escrito pelo JavaScript');
  });

  test('identidade() devolve cópia: alterar o retorno não altera o estado do módulo', async () => {
    EpiHttp.configurar({ fetch: fetchFalso(resposta(200, IDENTIDADE)) });
    await EpiAuth.entrar(CREDENCIAIS);

    const copia = EpiAuth.identidade();
    copia.usuario = { id: 999, perfil: 'MASTER' };

    assert.equal(EpiAuth.identidade().usuario.id, 5);
    assert.equal(EpiAuth.identidade().usuario.perfil, 'ADMINISTRADOR');
  });
});
