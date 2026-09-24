'use strict';

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const EpiHttp = require('../js/api-http');
const Sessao = require('../js/sessao-empresarial');

/**
 * Sessão empresarial real nas páginas de frontend/pages/ (Bloco 9, Etapa C,
 * Parte C0), com `fetch` e `janela` injetados — sem navegador e sem banco.
 * O caminho ponta a ponta contra o backend real (cookies HttpOnly, CORS,
 * Origin, PostgreSQL) está em
 * backend/test/integracao/frontend-sessao-empresarial.integration.js.
 */

const BASE = 'http://localhost:3000/api';
const RAIZ = path.join(__dirname, '..');
const PAGINAS_INTEGRADAS = ['grupos-acesso', 'grupo-permissoes', 'grupo-usuarios', 'autorizacoes-individuais'];

const ME = {
  status: 'ok',
  usuario: { id: 7, nome: 'Master Demo', email: 'master@exemplo.com', perfil: 'MASTER' },
  empresa: { id: 3, nome: 'Empresa Demo', cnpj: '11222333000181' },
};

const resposta = (status, corpo) => ({ status, ok: status >= 200 && status < 300, text: async () => (corpo === undefined ? '' : JSON.stringify(corpo)) });

/** fetch que responde por "MÉTODO caminho"; o que não estiver mapeado é 404. */
function fetchPorRota(rotas) {
  const chamadas = [];
  const fn = async (url, opcoes) => {
    const chave = `${opcoes.method} ${url.replace(BASE, '')}`;
    chamadas.push({ chave, opcoes });
    const r = rotas[chave];
    if (r instanceof Error) throw r;
    return r || resposta(404, { status: 'error', codigo: 'NAO_ENCONTRADO', message: 'x' });
  };
  fn.chamadas = chamadas;
  return fn;
}

function armazenamentoFalso(inicial = {}) {
  const dados = new Map(Object.entries(inicial));
  const operacoes = [];
  return {
    operacoes,
    dados,
    getItem(k) { operacoes.push(['get', k]); return dados.has(k) ? dados.get(k) : null; },
    setItem(k, v) { operacoes.push(['set', k]); dados.set(k, String(v)); },
    removeItem(k) { operacoes.push(['remove', k]); dados.delete(k); },
  };
}

function janelaFalsa(url = 'http://localhost:5500/pages/grupos-acesso.html', { local = {}, sessao = {} } = {}) {
  const u = new URL(url);
  const j = {
    redirecionamentos: [],
    urlsSubstituidas: [],
    cookiesEscritos: [],
    location: { pathname: u.pathname, search: u.search, hash: u.hash, replace: (d) => j.redirecionamentos.push(d) },
    history: { replaceState: (_e, _t, nova) => j.urlsSubstituidas.push(nova) },
    localStorage: armazenamentoFalso(local),
    sessionStorage: armazenamentoFalso(sessao),
    document: {},
  };
  Object.defineProperty(j.document, 'cookie', { set(v) { j.cookiesEscritos.push(v); }, get() { return ''; } });
  return j;
}

function elementoFalso() {
  const ouvintes = {};
  return {
    style: { display: 'flex' },
    textContent: '',
    disabled: false,
    addEventListener(evento, fn) { ouvintes[evento] = fn; },
    clicar() { return ouvintes.click(); },
  };
}

let fetch;
function configurar(rotas) {
  fetch = fetchPorRota(rotas);
  EpiHttp.configurar({ baseUrl: BASE, fetch });
}

beforeEach(() => configurar({}));

describe('iniciar: a sessão vem exclusivamente do servidor', () => {
  test('GET /auth/me válido: contexto com usuário, empresa e perfil do servidor; sem redirecionamento', async () => {
    configurar({ 'GET /auth/me': resposta(200, ME), 'GET /auth/global/me': resposta(200, { empresas: [{ id: 3 }], contexto: null }) });
    const j = janelaFalsa();
    const r = await Sessao.iniciar({ janela: j });
    assert.equal(r.autenticado, true);
    assert.deepEqual(r.contexto, { usuario: ME.usuario, empresa: ME.empresa });
    assert.equal(r.podeTrocar, false, 'uma empresa só: sem "Trocar de empresa"');
    assert.deepEqual(j.redirecionamentos, []);
    assert.equal(fetch.chamadas[0].chave, 'GET /auth/me');
    assert.equal(fetch.chamadas[0].opcoes.credentials, 'include');
    assert.deepEqual(Sessao.contexto(), r.contexto);
  });

  test('"Trocar de empresa" só com mais de uma empresa; falha no /auth/global/me não derruba a página', async () => {
    configurar({ 'GET /auth/me': resposta(200, ME), 'GET /auth/global/me': resposta(200, { empresas: [{ id: 3 }, { id: 4 }] }) });
    assert.equal((await Sessao.iniciar({ janela: janelaFalsa() })).podeTrocar, true);

    configurar({ 'GET /auth/me': resposta(200, ME), 'GET /auth/global/me': resposta(401, { codigo: 'SESSAO_INVALIDA' }) });
    const r = await Sessao.iniciar({ janela: janelaFalsa() });
    assert.deepEqual([r.autenticado, r.podeTrocar], [true, false]);

    configurar({ 'GET /auth/me': resposta(200, ME), 'GET /auth/global/me': new TypeError('rede') });
    const semRede = await Sessao.iniciar({ janela: janelaFalsa() });
    assert.deepEqual([semRede.autenticado, semRede.podeTrocar], [true, false]);
  });

  test('401 (sem sessão, expirada, revogada, empresa ou vínculo inativos): leva ao Portal e não pede mais nada', async () => {
    configurar({ 'GET /auth/me': resposta(401, { status: 'error', codigo: 'SESSAO_INVALIDA', message: 'x' }) });
    const j = janelaFalsa();
    const r = await Sessao.iniciar({ janela: j });
    assert.deepEqual(r, { autenticado: false, motivo: 'SEM_SESSAO' });
    assert.deepEqual(j.redirecionamentos, ['../portal/index.html']);
    assert.equal(fetch.chamadas.length, 1);
    assert.equal(Sessao.contexto(), null);
  });

  test('resposta 200 fora do formato (perfil desconhecido, sem empresa, id inválido): tratada como sem sessão', async () => {
    for (const corpo of [
      { usuario: { ...ME.usuario, perfil: 'ROOT' }, empresa: ME.empresa },
      { usuario: ME.usuario },
      { usuario: { ...ME.usuario, id: '7' }, empresa: ME.empresa },
      { usuario: ME.usuario, empresa: { ...ME.empresa, id: 0 } },
      null,
    ]) {
      configurar({ 'GET /auth/me': resposta(200, corpo) });
      const j = janelaFalsa();
      const r = await Sessao.iniciar({ janela: j });
      assert.deepEqual([r.autenticado, r.motivo, j.redirecionamentos], [false, 'RESPOSTA_INVALIDA', ['../portal/index.html']], JSON.stringify(corpo));
    }
  });

  test('falha de rede ou 5xx: não redireciona (a página mostra o aviso), contexto vazio', async () => {
    for (const r of [new TypeError('rede'), resposta(500, { codigo: 'ERRO_INTERNO', message: 'x' })]) {
      configurar({ 'GET /auth/me': r });
      const j = janelaFalsa();
      assert.deepEqual(await Sessao.iniciar({ janela: j }), { autenticado: false, motivo: 'FALHA' });
      assert.deepEqual(j.redirecionamentos, []);
    }
  });

  test('só campos de exibição saem do módulo: nada além de id/nome/email/perfil e id/nome/cnpj', async () => {
    configurar({ 'GET /auth/me': resposta(200, { usuario: { ...ME.usuario, senha_hash: 'x', identidadeId: 9 }, empresa: { ...ME.empresa, extra: 1 } }) });
    const r = await Sessao.iniciar({ janela: janelaFalsa() });
    assert.deepEqual(Object.keys(r.contexto.usuario).sort(), ['email', 'id', 'nome', 'perfil']);
    assert.deepEqual(Object.keys(r.contexto.empresa).sort(), ['cnpj', 'id', 'nome']);
  });
});

describe('rastros do protótipo: nunca usados, sempre removidos', () => {
  test('?_s= sai da barra de endereço (outros parâmetros e o fragmento ficam); sem ?_s= nada é reescrito', async () => {
    configurar({ 'GET /auth/me': resposta(401, {}) });
    const j = janelaFalsa('http://localhost:5500/pages/grupos-acesso.html?x=1&_s=eyJpZCI6MX0%3D#topo');
    await Sessao.iniciar({ janela: j });
    assert.deepEqual(j.urlsSubstituidas, ['/pages/grupos-acesso.html?x=1#topo']);

    const limpa = janelaFalsa('http://localhost:5500/pages/grupos-acesso.html?x=1');
    await Sessao.iniciar({ janela: limpa });
    assert.deepEqual(limpa.urlsSubstituidas, []);
  });

  test('a "sessão" antiga (epi-session-user) em localStorage/sessionStorage NÃO autentica: sem cookie real -> Portal; e é removida das três camadas', async () => {
    const legado = JSON.stringify({ id: 1, nome: 'Luis Freitas', perfil: 'MASTER' });
    configurar({ 'GET /auth/me': resposta(401, {}) });
    const j = janelaFalsa(undefined, { local: { 'epi-session-user': legado, epi_db_v2: '{"banco":"simulado"}' }, sessao: { 'epi-session-user': legado } });

    const r = await Sessao.iniciar({ janela: j });

    assert.equal(r.autenticado, false);
    assert.deepEqual(j.redirecionamentos, ['../portal/index.html']);
    assert.equal(j.localStorage.dados.has('epi-session-user'), false);
    assert.equal(j.sessionStorage.dados.has('epi-session-user'), false);
    assert.deepEqual(j.cookiesEscritos, ['epi-session-user=; path=/; max-age=0']);
    assert.equal(j.localStorage.dados.get('epi_db_v2'), '{"banco":"simulado"}', 'o banco simulado das páginas não integradas não é tocado');
  });

  test('o módulo nunca GRAVA nem LÊ armazenamento do navegador — só remove a chave legada', async () => {
    configurar({ 'GET /auth/me': resposta(200, ME), 'GET /auth/global/me': resposta(200, { empresas: [] }) });
    const j = janelaFalsa();
    await Sessao.iniciar({ janela: j });
    for (const armazenamento of [j.localStorage, j.sessionStorage]) {
      assert.deepEqual(armazenamento.operacoes, [['remove', 'epi-session-user']]);
    }
  });
});

describe('sair, trocar de empresa e sessão encerrada', () => {
  const comLogout = (respostaLogout) => ({ 'GET /auth/me': resposta(200, ME), 'GET /auth/global/me': resposta(200, { empresas: [] }), 'POST /auth/global/logout': respostaLogout });

  test('sair com SUCESSO (2xx confirmado pelo servidor): { ok: true }, contexto zerado e só então o Portal', async () => {
    configurar(comLogout(resposta(200, { status: 'ok' })));
    const j = janelaFalsa();
    await Sessao.iniciar({ janela: j });
    assert.deepEqual(await Sessao.sair(), { ok: true });
    assert.ok(fetch.chamadas.some((c) => c.chave === 'POST /auth/global/logout' && c.opcoes.body === undefined && c.opcoes.credentials === 'include'));
    assert.deepEqual(j.redirecionamentos, ['../portal/index.html']);
    assert.equal(Sessao.contexto(), null);
  });

  test('sair com FALHA DE REDE: não confirma nada — sem redirecionamento, contexto preservado, mensagem de falha', async () => {
    configurar(comLogout(new TypeError('Failed to fetch')));
    const j = janelaFalsa();
    await Sessao.iniciar({ janela: j });
    const r = await Sessao.sair();
    assert.deepEqual(r, { ok: false, motivo: 'REDE', status: 0, mensagem: Sessao.MENSAGENS.FALHA_SAIDA });
    assert.deepEqual(j.redirecionamentos, [], 'não vai ao Portal como se tivesse saído');
    assert.equal(Sessao.contexto().empresa.id, 3, 'a sessão pode continuar ativa: o contexto não é descartado');
    assert.doesNotMatch(r.mensagem, /encerrad|revogad/i, 'a mensagem não afirma revogação');
  });

  test('sair com ERRO HTTP (500, 403 de origem, 503): não confirma nada — sem redirecionamento, contexto preservado', async () => {
    for (const status of [500, 403, 503]) {
      configurar(comLogout(resposta(status, { status: 'error', codigo: 'X', message: 'falha' })));
      const j = janelaFalsa();
      await Sessao.iniciar({ janela: j });
      const r = await Sessao.sair();
      assert.deepEqual([r.ok, r.motivo, r.status, r.mensagem], [false, 'HTTP', status, Sessao.MENSAGENS.FALHA_SAIDA], String(status));
      assert.deepEqual(j.redirecionamentos, [], String(status));
      assert.notEqual(Sessao.contexto(), null, String(status));
    }
  });

  test('nova tentativa depois da falha: quando o servidor confirma, a saída se conclui', async () => {
    const logout = [new TypeError('rede'), resposta(200, { status: 'ok' })];
    const f = fetchPorRota(comLogout(null));
    const fn = async (url, opcoes) => {
      if (opcoes.method === 'POST' && url.endsWith('/auth/global/logout')) {
        const proxima = logout.shift();
        if (proxima instanceof Error) throw proxima;
        return proxima;
      }
      return f(url, opcoes);
    };
    EpiHttp.configurar({ baseUrl: BASE, fetch: fn });
    const j = janelaFalsa();
    await Sessao.iniciar({ janela: j });
    assert.equal((await Sessao.sair()).ok, false);
    assert.deepEqual(j.redirecionamentos, []);
    assert.equal((await Sessao.sair()).ok, true);
    assert.deepEqual(j.redirecionamentos, ['../portal/index.html']);
  });

  test('trocar de empresa vai à seleção do Portal; 401 durante o uso volta ao login do Portal', async () => {
    configurar({ 'GET /auth/me': resposta(200, ME), 'GET /auth/global/me': resposta(200, { empresas: [] }) });
    const j = janelaFalsa();
    await Sessao.iniciar({ janela: j });
    Sessao.trocarEmpresa();
    Sessao.sessaoEncerrada();
    assert.deepEqual(j.redirecionamentos, ['../portal/empresas.html', '../portal/index.html']);
    assert.equal(Sessao.contexto(), null);
  });
});

describe('montar: ligação com os elementos da página', () => {
  const elementos = () => ({
    tela: elementoFalso(), mensagem: elementoFalso(), linkPortal: elementoFalso(),
    identificacao: elementoFalso(), botaoSair: elementoFalso(), botaoTrocar: elementoFalso(),
  });

  test('sessão válida: esconde a verificação, identifica usuário · empresa · perfil, liga Sair e Trocar (com limpeza da tela antes)', async () => {
    configurar({ 'GET /auth/me': resposta(200, ME), 'GET /auth/global/me': resposta(200, { empresas: [{}, {}] }), 'POST /auth/global/logout': resposta(200, {}) });
    const el = elementos();
    el.linkPortal.style.display = 'none';
    const j = janelaFalsa();
    const encerrou = [];

    const ctx = await Sessao.montar({ elementos: el, janela: j, aoEncerrar: () => encerrou.push('limpou') });

    assert.equal(ctx.empresa.id, 3);
    assert.equal(el.tela.style.display, 'none');
    assert.equal(el.identificacao.textContent, 'Master Demo · Empresa Demo · Master');
    assert.equal(el.botaoTrocar.style.display, '');
    el.botaoTrocar.clicar();
    assert.deepEqual([encerrou, j.redirecionamentos], [['limpou'], ['../portal/empresas.html']]);
    el.botaoSair.clicar();
    await new Promise((r) => { setImmediate(r); });
    assert.equal(el.botaoSair.disabled, true);
    assert.deepEqual(encerrou, ['limpou', 'limpou']);
    assert.equal(j.redirecionamentos.at(-1), '../portal/index.html');
  });

  test('Sair sem confirmação do servidor: a tela NÃO é limpa, o aviso aparece e o botão volta a funcionar; a nova tentativa confirmada conclui', async () => {
    const logout = [resposta(500, { status: 'error', codigo: 'ERRO_INTERNO', message: 'x' }), new TypeError('rede'), resposta(200, { status: 'ok' })];
    const base = fetchPorRota({ 'GET /auth/me': resposta(200, ME), 'GET /auth/global/me': resposta(200, { empresas: [] }) });
    EpiHttp.configurar({
      baseUrl: BASE,
      fetch: async (url, opcoes) => {
        if (opcoes.method === 'POST' && url.endsWith('/auth/global/logout')) {
          const r = logout.shift();
          if (r instanceof Error) throw r;
          return r;
        }
        return base(url, opcoes);
      },
    });
    const el = elementos();
    const j = janelaFalsa();
    const encerrou = [];
    const avisos = [];
    await Sessao.montar({ elementos: el, janela: j, aoEncerrar: () => encerrou.push('limpou'), aoFalharSaida: (m) => avisos.push(m) });

    await el.botaoSair.clicar();                      // 500
    assert.deepEqual([encerrou, avisos, j.redirecionamentos, el.botaoSair.disabled], [[], [Sessao.MENSAGENS.FALHA_SAIDA], [], false]);
    await el.botaoSair.clicar();                      // rede
    assert.deepEqual([encerrou, avisos.length, j.redirecionamentos, el.botaoSair.disabled], [[], 2, [], false]);
    await el.botaoSair.clicar();                      // confirmado
    assert.deepEqual([encerrou, avisos.length, j.redirecionamentos, el.botaoSair.disabled], [['limpou'], 2, ['../portal/index.html'], true]);
  });

  test('Sair: cliques repetidos enquanto a resposta não chega não disparam dois logouts', async () => {
    let liberar;
    let chamadasLogout = 0;
    const base = fetchPorRota({ 'GET /auth/me': resposta(200, ME), 'GET /auth/global/me': resposta(200, { empresas: [] }) });
    EpiHttp.configurar({
      baseUrl: BASE,
      fetch: async (url, opcoes) => {
        if (opcoes.method === 'POST' && url.endsWith('/auth/global/logout')) {
          chamadasLogout += 1;
          await new Promise((r) => { liberar = r; });
          return resposta(200, { status: 'ok' });
        }
        return base(url, opcoes);
      },
    });
    const el = elementos();
    await Sessao.montar({ elementos: el, janela: janelaFalsa() });
    const primeiro = el.botaoSair.clicar();
    await new Promise((r) => { setImmediate(r); });
    el.botaoSair.clicar();
    liberar();
    await primeiro;
    assert.equal(chamadasLogout, 1);
  });

  test('sem sessão: a verificação continua cobrindo a página (nada é exibido) e o destino é o Portal', async () => {
    configurar({ 'GET /auth/me': resposta(401, {}) });
    const el = elementos();
    const j = janelaFalsa();
    assert.equal(await Sessao.montar({ elementos: el, janela: j }), null);
    assert.equal(el.tela.style.display, 'flex');
    assert.equal(el.identificacao.textContent, '');
    assert.deepEqual(j.redirecionamentos, ['../portal/index.html']);
  });

  test('falha de rede: mensagem de falha e link para o Portal, sem redirecionar', async () => {
    configurar({ 'GET /auth/me': new TypeError('rede') });
    const el = elementos();
    el.linkPortal.style.display = 'none';
    const j = janelaFalsa();
    assert.equal(await Sessao.montar({ elementos: el, janela: j }), null);
    assert.equal(el.mensagem.textContent, Sessao.MENSAGENS.FALHA);
    assert.equal(el.linkPortal.style.display, '');
    assert.equal(el.tela.style.display, 'flex');
    assert.deepEqual(j.redirecionamentos, []);
  });
});

describe('as quatro páginas integradas (inspeção estática)', () => {
  const ler = (p) => fs.readFileSync(path.join(RAIZ, 'pages', `${p}.html`), 'utf8');
  const semComentarios = (html) => html.replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const scripts = (html) => [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);

  for (const pagina of PAGINAS_INTEGRADAS) {
    test(`${pagina}: sem banco simulado, sem login simulado, sem login por CNPJ; sessão comum carregada na ordem certa`, () => {
      const html = ler(pagina);
      const codigo = semComentarios(html);
      const s = scripts(html);
      for (const proibido of ['../js/db-api.js', '../js/main.js', '../js/auth-session.js']) {
        assert.equal(s.includes(proibido), false, `${pagina} carrega ${proibido}`);
      }
      assert.ok(s.indexOf('../js/api-http.js') < s.indexOf('../portal/config.js'));
      assert.ok(s.indexOf('../portal/config.js') < s.indexOf('../js/sessao-empresarial.js'));
      for (const proibido of [/cnpj/i, /telaLogin/, /formLogin/, /EpiAuth/, /EpiAPI/, /CURRENT_USER/, /doLogin/, /localStorage/, /sessionStorage/, /document\.cookie/, /_s=/, /localhost:3000/, /epi_db_v2/]) {
        assert.equal(proibido.test(codigo), false, `${pagina} contém ${proibido}`);
      }
      assert.match(codigo, /EpiSessaoEmpresarial\.montar\(/);
      assert.match(codigo, /aoFalharSaida: function \(mensagem\) \{ (mostrarAviso|ui\.aviso)\(mensagem, 'erro'\); \}/, 'a falha de saída aparece no aviso da própria página');
      assert.match(codigo, /EpiHttp\.configurar\(\{ baseUrl: window\.SAFEWORK_PORTAL_API_BASE_URL \}\)/);
      assert.match(html, /id="telaSessao"/);
      assert.match(html, /id="botaoTrocarEmpresa"/);
    });

    test(`${pagina}: navegação só entre páginas integradas e o Portal — nenhum link para o protótipo`, () => {
      const hrefs = [...ler(pagina).matchAll(/href="([^"]+)"/g)].map((m) => m[1]).filter((h) => !h.startsWith('http') && !h.startsWith('../css/') && h !== 'javascript:void(0)');
      const permitidos = new Set(['grupos-acesso.html', 'grupo-permissoes.html', 'grupo-usuarios.html', 'autorizacoes-individuais.html', '../portal/index.html', '../portal/inicio.html']);
      for (const h of hrefs) assert.ok(permitidos.has(h), `${pagina} aponta para ${h}`);
    });
  }

  test('o módulo de sessão não lê nem grava armazenamento, cookie legível ou URL com sessão', () => {
    const codigo = semComentarios(fs.readFileSync(path.join(RAIZ, 'js', 'sessao-empresarial.js'), 'utf8'));
    assert.equal(/\.setItem\(|\.getItem\(/.test(codigo), false);
    assert.equal(/EpiAPI|CURRENT_USER|db-api|epi_db_v2/.test(codigo), false);
    assert.equal(/location\.href\s*=|\?_s=/.test(codigo), false);
  });
});
