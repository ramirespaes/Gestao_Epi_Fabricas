'use strict';

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const EpiHttp = require('../js/api-http');
const EpiPortal = require('../js/portal-cliente');
const Config = require('../portal/config');

const { acoes, decisao, render, mensagens } = EpiPortal;

/**
 * Portal do Cliente (Pacote 4), com `fetch` injetado — sem navegador e sem
 * banco. O caminho ponta a ponta contra o backend real (CORS, Origin,
 * cookies HttpOnly, PostgreSQL) está em
 * backend/test/integracao/frontend-portal-cliente.integration.js.
 */

const BASE = 'http://localhost:3000/api';

function fetchFalso(respostas) {
  const chamadas = [];
  const fila = Array.isArray(respostas) ? respostas.slice() : [respostas];
  const fn = async (url, opcoes) => {
    chamadas.push({ url, opcoes });
    return fila.length > 1 ? fila.shift() : fila[0];
  };
  fn.chamadas = chamadas;
  return fn;
}
const resposta = (status, corpo) => ({ status, ok: status >= 200 && status < 300, text: async () => (corpo === undefined ? '' : JSON.stringify(corpo)) });

let fetch;
beforeEach(() => {
  fetch = fetchFalso(resposta(200, { status: 'ok' }));
  EpiHttp.configurar({ baseUrl: BASE, fetch });
});

describe('acoes: contratos do backend', () => {
  test('entrar: POST /auth/global/login só com e-mail e senha (sem CNPJ), com credentials', async () => {
    await acoes.entrar({ email: 'p@x.com', senha: 'segredo-qualquer' });
    const [c] = fetch.chamadas;
    assert.equal(c.url, `${BASE}/auth/global/login`);
    assert.equal(c.opcoes.method, 'POST');
    assert.equal(c.opcoes.credentials, 'include');
    assert.deepEqual(JSON.parse(c.opcoes.body), { email: 'p@x.com', senha: 'segredo-qualquer' });
  });

  test('entrar sem e-mail/senha é recusado antes de qualquer rede', async () => {
    await assert.rejects(() => acoes.entrar({ email: 'p@x.com' }), TypeError);
    assert.equal(fetch.chamadas.length, 0);
  });

  test('selecionar: a empresa vai no CAMINHO, sem corpo; id inválido nunca sai', async () => {
    await acoes.selecionar(7);
    const [c] = fetch.chamadas;
    assert.equal(c.url, `${BASE}/auth/global/empresas/7/selecionar`);
    assert.equal(c.opcoes.method, 'POST');
    assert.equal(c.opcoes.body, undefined);
    for (const ruim of ['7', 0, -1, 1.5, NaN, null]) {
      await assert.rejects(() => acoes.selecionar(ruim), TypeError);
    }
    assert.equal(fetch.chamadas.length, 1);
  });

  test('sessao, sairDaEmpresa e sairCompletamente usam os caminhos certos', async () => {
    await acoes.sessao();
    await acoes.sairDaEmpresa();
    await acoes.sairCompletamente();
    assert.deepEqual(fetch.chamadas.map((c) => [c.opcoes.method, c.url.replace(BASE, '')]), [
      ['GET', '/auth/global/me'],
      ['POST', '/auth/logout'],
      ['POST', '/auth/global/logout'],
    ]);
  });

  test('o console registra método e caminho, nunca a senha', async (t) => {
    const logs = [];
    t.mock.method(console, 'log', (...a) => logs.push(a.join(' ')));
    await acoes.entrar({ email: 'p@x.com', senha: 'SenhaSentinela-9f3a' });
    assert.ok(logs.some((l) => l.includes('/auth/global/login')));
    assert.equal(logs.join('\n').includes('SenhaSentinela-9f3a'), false);
  });
});

describe('decisao: para onde ir', () => {
  const empresa = (id) => ({ id, nome: `E${id}`, cnpj: '11222333000181', perfil: 'MASTER' });

  test('cenários A, B e C, e sessão inválida', () => {
    assert.equal(decisao.destino({ empresas: [empresa(1)], contexto: { empresa: { id: 1 } } }), 'inicio');
    assert.equal(decisao.destino({ empresas: [empresa(1), empresa(2)], contexto: null }), 'selecionar');
    assert.equal(decisao.destino({ empresas: [empresa(1)], contexto: null }), 'selecionar', 'após "sair da empresa"');
    assert.equal(decisao.destino({ empresas: [], contexto: null }), 'semEmpresa');
    assert.equal(decisao.destinoDaSessao({ ok: false, status: 401 }), 'login');
    assert.equal(decisao.destinoDaSessao({ ok: true, dados: { empresas: [], contexto: null } }), 'semEmpresa');
  });

  test('páginas e "trocar de empresa" só com mais de uma empresa', () => {
    assert.equal(decisao.pagina('inicio'), 'inicio.html');
    assert.equal(decisao.pagina('selecionar'), 'empresas.html');
    assert.equal(decisao.pagina('semEmpresa'), 'empresas.html');
    assert.equal(decisao.pagina('login'), 'index.html');
    assert.equal(decisao.pagina('qualquer-coisa'), 'index.html');
    assert.equal(decisao.podeTrocar({ empresas: [empresa(1)] }), false);
    assert.equal(decisao.podeTrocar({ empresas: [empresa(1), empresa(2)] }), true);
  });
});

describe('render e mensagens', () => {
  test('lista de empresas: HTML escapado, id numérico, empresa atual marcada, CNPJ formatado', () => {
    const html = render.listaEmpresas([
      { id: 3, nome: '<script>x</script>', cnpj: '11222333000181', perfil: 'MASTER' },
      { id: 4, nome: 'Empresa "B"', cnpj: '22333444000100', perfil: 'USUARIO' },
    ], 4);
    assert.equal(html.includes('<script>'), false);
    assert.ok(html.includes('&lt;script&gt;'));
    assert.ok(html.includes('data-empresa-id="3"'));
    assert.ok(html.includes('11.222.333/0001-81'));
    assert.match(html, /class="empresa atual" data-empresa-id="4"/);
    assert.ok(html.includes('Usuário'));
  });

  test('mensagem de empresa não autorizada é específica; demais vêm do servidor', () => {
    assert.match(mensagens.deErro({ status: 403, codigo: 'EMPRESA_NAO_AUTORIZADA' }), /não está mais disponível/);
    assert.equal(mensagens.deErro({ status: 500, mensagem: 'x' }), 'x');
  });
});

describe('config do Portal', () => {
  test('desenvolvimento usa http://localhost:3000/api; produção usa a própria origem + /api; nunca /api/plataforma', () => {
    assert.equal(Config.resolverApiBaseUrl({ hostname: 'localhost', origin: 'http://localhost:5500' }), 'http://localhost:3000/api');
    assert.equal(Config.resolverApiBaseUrl({ hostname: 'app.exemplo.com.br', origin: 'https://app.exemplo.com.br' }), 'https://app.exemplo.com.br/api');
    assert.equal(Config.resolverApiBaseUrl({ hostname: 'app.exemplo.com.br', origin: 'https://app.exemplo.com.br' }).includes('plataforma'), false);
    assert.throws(() => Config.resolverApiBaseUrl({}), TypeError);
  });
});

describe('sem persistência de sessão no navegador', () => {
  const raiz = path.join(__dirname, '..');
  const arquivos = ['js/portal-cliente.js', 'portal/config.js', 'portal/login.js', 'portal/empresas.js', 'portal/inicio.js'];

  test('nenhum arquivo do Portal usa localStorage, sessionStorage, document.cookie, indexedDB ou db-api.js', () => {
    for (const arquivo of arquivos) {
      const codigo = fs.readFileSync(path.join(raiz, arquivo), 'utf8').replace(/^\s*(\*|\/\/).*$/gm, '');
      for (const proibido of ['localStorage', 'sessionStorage', 'document.cookie', 'indexedDB', 'EpiAPI']) {
        assert.equal(codigo.includes(proibido), false, `${arquivo} usa ${proibido}`);
      }
    }
  });

  test('as páginas do Portal não carregam o simulador legado (db-api.js / main.js) nem pedem CNPJ', () => {
    for (const pagina of ['portal/index.html', 'portal/empresas.html', 'portal/inicio.html']) {
      const html = fs.readFileSync(path.join(raiz, pagina), 'utf8');
      assert.equal(/db-api\.js|main\.js/.test(html), false, pagina);
      assert.equal(/cnpj/i.test(html.replace(/id="empresa-cnpj"/g, '')), false, `${pagina} não pede CNPJ`);
      assert.match(html, /<meta name="referrer" content="no-referrer">/);
    }
  });
});
