'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const EpiHttp = require('../js/api-http');
const EpiUsuarios = require('../js/usuarios');
const P = require('../js/permissoes-efetivas');

/**
 * Parte F — páginas: Administração de usuários (pages/user-admin.html),
 * Novo usuário (pages/new-user.html) e o aceite público do convite
 * (portal/aceitar-convite.html). Scripts embutidos em DOM simulado,
 * inspeção estática, menus, Portal, Permissões do Grupo e publicação.
 */

const BASE = 'http://localhost:3000/api';
const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const semComentarios = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const resposta = (status, corpo) => ({ status, ok: status >= 200 && status < 300, text: async () => (corpo === undefined ? '' : JSON.stringify(corpo)) });
const ATAQUE = '<img src=x onerror=alert(1)>';
const TOKEN = 'Zm9ybWF0b2Jhc2U2NHVybGRldG9rZW5jb21fNDNjaGFy'.slice(0, 43);
const LINK = `http://localhost:5500/portal/aceitar-convite.html#token=${TOKEN}`;

let chamadas;
function servidor(responder) {
  chamadas = [];
  EpiHttp.configurar({
    baseUrl: BASE,
    fetch: async (url, opcoes) => {
      const u = new URL(url);
      const corpo = opcoes.body === undefined ? undefined : JSON.parse(opcoes.body);
      chamadas.push({ metodo: opcoes.method, caminho: u.pathname + u.search, corpo });
      const r = responder(opcoes.method, u, corpo);
      if (r instanceof Error) throw r;
      return r;
    },
  });
}
const ultima = () => chamadas.at(-1);

function criarElemento(id) {
  const classes = new Set();
  return {
    id, value: '', textContent: '', innerHTML: '', className: '', disabled: false, readOnly: false, style: {}, atributos: {}, listeners: {},
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    setAttribute(k, v) { this.atributos[k] = String(v); }, removeAttribute(k) { delete this.atributos[k]; }, getAttribute(k) { return this.atributos[k] ?? null; },
    focus() {}, select() { this.selecionado = true; },
  };
}

function montarDom() {
  const mapa = {};
  const el = (id) => (mapa[id] = mapa[id] || criarElemento(id));
  const esperar = async () => { for (let i = 0; i < 40; i += 1) await new Promise((r) => setImmediate(r)); };
  const disparar = async (id, ev = 'click', evento = {}) => {
    for (const fn of (el(id).listeners[ev] || [])) await fn({ preventDefault() {}, ...evento });
    await esperar();
  };
  // Clique numa linha: o alvo tem closest('[data-acao]') que devolve o botão.
  const clicarAcao = (corpoId, acao, id, desabilitado = false) => disparar(corpoId, 'click', {
    target: { closest: () => ({ disabled: desabilitado, getAttribute: (k) => ({ 'data-acao': acao, 'data-id': String(id) })[k] ?? null }) },
  });
  return { el, mapa, esperar, disparar, clicarAcao };
}

function scriptEmbutido(arquivo) {
  const html = ler(arquivo);
  return html.slice(html.lastIndexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));
}

const CONTEXTO = { empresa: { id: 3, nome: 'Empresa' }, usuario: { id: 7, nome: 'Marta', perfil: 'MASTER' } };

function rodarPagina(arquivo, { pagina, acesso = { permissoes: {}, podeAlterar: true }, clipboard } = {}) {
  const dom = montarDom();
  const sandbox = {
    document: { getElementById: dom.el, querySelectorAll: () => [] },
    window: { SAFEWORK_PORTAL_API_BASE_URL: BASE, location: { search: '' } },
    navigator: clipboard ? { clipboard } : {},
    EpiHttp, EpiUsuarios,
    EpiPermissoes: { prepararPagina: async (o) => { sandbox.opcoesPagina = o; return acesso; }, somenteLeitura: P.somenteLeitura },
    EpiSessaoEmpresarial: { montar: async (o) => { sandbox.opcoesSessao = o; return CONTEXTO; }, sessaoEncerrada() { sandbox.encerrada = true; } },
    console, Promise, String, Number, Array, Object, JSON,
  };
  vm.runInNewContext(scriptEmbutido(arquivo), sandbox);
  assert.ok(pagina);
  return { ...dom, sandbox };
}

// ═══════════════════════════════════════════════════════════════════
// Aceite público do convite (portal/aceitar-convite.js)
// ═══════════════════════════════════════════════════════════════════
function paginaAceite({ hash = `#token=${TOKEN}`, responder } = {}) {
  servidor(responder || ((m, u) => (u.pathname.endsWith('/consultar')
    ? resposta(200, { status: 'ok', situacao: 'PENDENTE', empresa: { razaoSocial: 'Empresa Alfa' }, emailConvite: 'nova@exemplo-cliente.com.br', nome: 'Nova Pessoa', perfil: 'SUPERVISOR', expiraEm: '2026-09-30T13:05:00.000Z', identidadeExistente: false })
    : resposta(201, { status: 'ok', empresa: { razaoSocial: 'Empresa Alfa' }, usuario: { nome: 'Nova Pessoa', perfil: 'SUPERVISOR' }, identidadeCriada: true }))));
  const dom = montarDom();
  const historico = [];
  const janela = {
    location: { hash, pathname: '/portal/aceitar-convite.html', search: '' },
    history: { replaceState: (...a) => historico.push(a) },
    SAFEWORK_PORTAL_API_BASE_URL: BASE, EpiHttp, EpiUsuarios,
  };
  delete require.cache[require.resolve('../portal/aceitar-convite')];
  const A = require('../portal/aceitar-convite'); // eslint-disable-line global-require
  const pronto = A.iniciar(janela, { getElementById: dom.el, title: 'Aceitar convite' });
  return { ...dom, historico, pronto };
}

describe('aceite público do convite', () => {
  test('token só do fragmento, apagado da barra; consulta mostra empresa, e-mail, nome e tipo como texto', async () => {
    const pg = paginaAceite();
    await pg.pronto;
    await pg.esperar();
    assert.deepEqual(pg.historico, [[null, 'Aceitar convite', '/portal/aceitar-convite.html']]);
    assert.deepEqual(chamadas.map((c) => [c.metodo, c.caminho, c.corpo]), [['POST', '/api/convite-usuario/consultar', { token: TOKEN }]]);
    assert.deepEqual(['empresa', 'email', 'nomeConvite', 'tipoConta'].map((id) => pg.el(id).textContent), ['Empresa Alfa', 'nova@exemplo-cliente.com.br', 'Nova Pessoa', 'Supervisor']);
    assert.equal(pg.el('blocoConfirmacao').style.display, '', 'conta nova confirma a senha');
    assert.equal(pg.el('formAceite').style.display, 'block');
  });

  test('conta nova: confirmação diferente não envia; senha aceita cria o acesso e os campos são limpos', async () => {
    const pg = paginaAceite();
    await pg.pronto;
    Object.assign(pg.el('senha'), { value: 'Correnteza-Azul-Pedra-7319' });
    Object.assign(pg.el('senhaConfirmacao'), { value: 'outra' });
    await pg.disparar('formAceite', 'submit');
    assert.equal(chamadas.some((c) => c.caminho.endsWith('/aceitar')), false);
    assert.match(pg.el('mensagem').textContent, /confirmação/);
    Object.assign(pg.el('senha'), { value: 'Correnteza-Azul-Pedra-7319' });
    Object.assign(pg.el('senhaConfirmacao'), { value: 'Correnteza-Azul-Pedra-7319' });
    await pg.disparar('formAceite', 'submit');
    assert.deepEqual(ultima().corpo, { token: TOKEN, senha: 'Correnteza-Azul-Pedra-7319' });
    assert.deepEqual([pg.el('senha').value, pg.el('senhaConfirmacao').value], ['', '']);
    assert.equal(pg.el('sucesso').style.display, 'block');
    assert.equal(pg.el('empresaOk').textContent, 'Empresa Alfa');
  });

  test('conta existente: pede a senha atual, sem confirmação', async () => {
    const pg = paginaAceite({ responder: () => resposta(200, { status: 'ok', situacao: 'PENDENTE', empresa: { razaoSocial: 'E' }, emailConvite: 'a@b.com', nome: 'A', perfil: 'USUARIO', identidadeExistente: true }) });
    await pg.pronto;
    assert.equal(pg.el('rotuloSenha').textContent, 'Senha atual');
    assert.equal(pg.el('blocoConfirmacao').style.display, 'none');
  });

  test('sem token, token malformado ou convite expirado: mensagem própria e nenhum formulário', async () => {
    for (const hash of ['', '#token=curto', '#outra=1']) {
      const pg = paginaAceite({ hash });
      await pg.pronto;
      assert.deepEqual(chamadas, [], hash);
      assert.match(pg.el('mensagem').textContent, /Link de convite/);
    }
    const expirado = paginaAceite({ responder: () => resposta(409, { status: 'error', codigo: 'CONVITE_EXPIRADO', message: 'SEGREDO-INTERNO' }) });
    await expirado.pronto;
    assert.match(expirado.el('mensagem').textContent, /expirou/);
    assert.notEqual(expirado.el('formAceite').style.display, 'block');
  });

  test('XSS: dados do convite só por textContent', async () => {
    const pg = paginaAceite({ responder: () => resposta(200, { status: 'ok', situacao: 'PENDENTE', empresa: { razaoSocial: ATAQUE }, emailConvite: ATAQUE, nome: ATAQUE, perfil: ATAQUE, identidadeExistente: false }) });
    await pg.pronto;
    assert.equal(pg.el('empresa').textContent, ATAQUE);
    for (const e of Object.values(pg.mapa)) assert.equal(String(e.innerHTML).includes('<img'), false, e.id);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Telas aposentadas (fechamento da Gestão de Usuários) e o que continua
// ═══════════════════════════════════════════════════════════════════
const APOSENTADAS = [
  ['pages/new-user.html', 'Novo Usuário'],
  ['pages/user-admin.html', 'Administração de Usuários'],
];

describe('Novo Usuário e Administração de Usuários: telas aposentadas', () => {
  for (const [arquivo, titulo] of APOSENTADAS) {
    test(`${arquivo}: sem módulo, sem API, sem controle administrativo e com redirecionamento para a Gestão de Usuários`, () => {
      const html = ler(arquivo);
      const codigo = semComentarios(html);
      const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
      assert.deepEqual(scripts, ['../js/tema.js'], 'só o tema');
      assert.equal(/EpiHttp|EpiUsuarios|EpiPermissoes|EpiSessaoEmpresarial|requisitar|fetch\(|XMLHttpRequest|localStorage|sessionStorage|innerHTML/.test(codigo), false);
      assert.match(html, new RegExp(`<title>${titulo} — tela substituída</title>`));
      assert.match(html, /http-equiv="refresh" content="0; url=gestao-usuarios\.html"/);
      assert.match(codigo, /window\.location\.replace\(/);
      assert.match(html, /<a href="gestao-usuarios\.html" id="destino">Gestão de Usuários<\/a>/);
      assert.equal(/<form|<input|<button|<table|<select|data-pagina=/.test(codigo), false);
    });
  }

  test('o módulo de usuários continua existindo (reutilizado pela Gestão de Usuários) e o aceite público de convites já enviados segue publicado', () => {
    const arquivos = JSON.parse(ler('publicacao/allowlist.json')).arquivos;
    for (const f of ['js/usuarios.js', 'portal/aceitar-convite.html', 'portal/aceitar-convite.js']) assert.ok(arquivos.includes(f), f);
  });
});

describe('aceite público do convite: página estática', () => {
  test('aceite público: sem referrer, token nunca na query, scripts do Portal, tema pelas variáveis', () => {
    const html = ler('portal/aceitar-convite.html');
    assert.match(html, /<meta name="referrer" content="no-referrer">/);
    const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
    assert.deepEqual(scripts, ['../js/api-http.js', 'config.js', '../js/usuarios.js', 'aceitar-convite.js']);
    assert.match(html, /color-scheme: light dark/);
    assert.match(html, /@media \(prefers-color-scheme: dark\)/);
    const js = semComentarios(ler('portal/aceitar-convite.js'));
    assert.match(js, /location\.hash/);
    assert.equal(/location\.search\)\.get\('token'\)|searchParams\.get\('token'\)|localStorage|sessionStorage|console\.log|innerHTML/.test(js), false);
    assert.match(html, /<a href="index\.html"[^>]*>Entrar no Portal<\/a>/);
  });
});

describe('menus, Portal e Permissões do Grupo', () => {
  test('o Portal e o catálogo de permissões do grupo continuam coerentes com as páginas aposentadas (links ocultos, sem permissão por grupo)', () => {
    const inicio = ler('portal/inicio.html');
    const paginas = [...inicio.matchAll(/<a href="\.\.\/pages\/[^"]+" data-pagina="([^"]+)" style="display:none">/g)].map((m) => m[1]);
    assert.deepEqual(paginas.slice(-4), ['importEmployees', 'newUser', 'userAdmin', 'config']);
    const G = require('../js/grupo-permissoes'); // eslint-disable-line global-require
    for (const id of ['newUser', 'userAdmin']) {
      const r = G.RECURSOS.find((x) => x.id === id);
      assert.deepEqual(r.operacoes, [], id);
    }
  });
});
