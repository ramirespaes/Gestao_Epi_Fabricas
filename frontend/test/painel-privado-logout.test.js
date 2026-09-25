'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const EpiHttp = require('../js/api-http');

/**
 * Painel Privado — logout e restauração pelo navegador (correção de
 * 25/09/2026, após validação manual): ao clicar em Sair, os dados
 * administrativos somem ANTES da requisição de logout e da navegação;
 * empresas.html só revela o conteúdo depois de confirmar a sessão; página
 * restaurada pelo histórico revalida antes de revelar qualquer coisa; os
 * scripts das duas páginas levam versão na URL para que o navegador não
 * reutilize cópias antigas durante a validação manual.
 */

const RAIZ = path.join(__dirname, '..');
const BASE = 'http://localhost:3000/api/plataforma';
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const resposta = (status, corpo) => ({ status, ok: status >= 200 && status < 300, text: async () => (corpo === undefined ? '' : JSON.stringify(corpo)) });
const OK = resposta(200, { status: 'ok' });
const NAO_AUTENTICADO = resposta(401, { status: 'erro', codigo: 'NAO_AUTENTICADO' });
const ADMIN = resposta(200, { status: 'ok', administrador: { id: 1, email: 'admin@safework.local' } });
const EMPRESAS = resposta(200, { status: 'ok', empresas: [{ id: 1, razaoSocial: 'Empresa Demonstração SafeWork', nomeFantasia: null, cnpj: '11222333000181', ativo: true }], total: 1 });

let chamadas;
function servidor(rotas) {
  chamadas = [];
  EpiHttp.configurar({
    baseUrl: BASE,
    fetch: async (url, opcoes) => {
      const chave = `${opcoes.method} ${new URL(url).pathname.replace(/^\/api\/plataforma/, '')}`;
      chamadas.push(chave);
      let r = rotas[chave];
      if (typeof r === 'function') r = r();
      if (r === undefined) return resposta(404, { status: 'erro', codigo: 'NAO_ENCONTRADO' });
      if (r instanceof Error) throw r;
      return r;
    },
  });
}

function elemento(id) {
  const listeners = {};
  return {
    id, textContent: '', innerHTML: '', value: '', className: '', disabled: false, style: { display: id === 'conteudo' || id === 'detalhe' || id === 'entrega' ? 'none' : '' }, listeners,
    addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    reset() { this.resetado = (this.resetado || 0) + 1; },
    classList: { add() {}, remove() {}, contains: () => false },
  };
}

function pagina(arquivo) {
  const mapa = {};
  const el = (id) => (mapa[id] = mapa[id] || elemento(id));
  const eventos = {};
  const janela = { EpiHttp, SAFEWORK_PLATAFORMA_API_BASE_URL: BASE, location: { href: `http://localhost:5501/${arquivo.replace(/\.js$/, '.html')}` }, addEventListener(ev, fn) { (eventos[ev] = eventos[ev] || []).push(fn); } };
  const sandbox = { window: janela, document: { getElementById: el }, console, setTimeout, Promise, Number, String, Array, Object, JSON, Date };
  vm.runInNewContext(ler(arquivo), sandbox);
  const esperar = async () => { for (let i = 0; i < 30; i += 1) await new Promise((r) => setImmediate(r)); };
  const clicar = async (id) => { for (const fn of (el(id).listeners.click || [])) await fn({ preventDefault() {} }); };
  const pageshow = async (persisted) => { for (const fn of (eventos.pageshow || [])) await fn({ persisted }); await esperar(); };
  return { el, janela, esperar, clicar, pageshow, hrefInicial: janela.location.href };
}

describe('painel.js — Sair limpa antes de sair', () => {
  test('ao clicar em Sair, e-mail e conteúdo somem ANTES de o logout responder; a navegação ao login vem só depois da resposta', async () => {
    let liberarLogout;
    servidor({ 'GET /painel': ADMIN, 'POST /auth/logout': () => new Promise((res) => { liberarLogout = () => res(OK); }) });
    const pg = pagina('painel-privado/painel.js');
    await pg.esperar();
    assert.deepEqual([pg.el('conteudo').style.display, pg.el('email-administrador').textContent], ['block', 'admin@safework.local']);
    const clique = pg.clicar('sair');
    await new Promise((r) => setImmediate(r));
    assert.deepEqual([pg.el('conteudo').style.display, pg.el('email-administrador').textContent], ['none', ''], 'limpo imediatamente, com o logout ainda pendente');
    assert.equal(pg.janela.location.href, pg.hrefInicial, 'ainda não navegou');
    liberarLogout();
    await clique; await pg.esperar();
    assert.equal(pg.janela.location.href, 'index.html');
    assert.deepEqual(chamadas, ['GET /painel', 'POST /auth/logout']);
  });
});

describe('empresas.js — conteúdo protegido só com sessão confirmada', () => {
  const rotas = (estado) => ({
    'GET /auth/me': () => (estado.logado ? OK : NAO_AUTENTICADO),
    'GET /empresas': () => (estado.logado ? EMPRESAS : NAO_AUTENTICADO),
    'POST /auth/logout': () => { estado.logado = false; return OK; },
  });

  test('carga inicial: o conteúdo nasce oculto e só aparece depois do /auth/me; a lista é carregada; pageshow sem restauração não consulta de novo', async () => {
    const estado = { logado: true };
    servidor(rotas(estado));
    const pg = pagina('painel-privado/empresas.js');
    assert.equal(pg.el('conteudo').style.display, 'none', 'oculto antes da confirmação');
    await pg.esperar();
    assert.equal(pg.el('conteudo').style.display, 'block');
    assert.match(pg.el('lista').innerHTML, /Empresa Demonstração SafeWork/);
    const antes = chamadas.length;
    await pg.pageshow(false);
    assert.equal(chamadas.length, antes);
  });

  test('sem sessão na carga: nada é revelado e vai ao login', async () => {
    servidor(rotas({ logado: false }));
    const pg = pagina('painel-privado/empresas.js');
    await pg.esperar();
    assert.deepEqual([pg.el('conteudo').style.display, pg.el('lista').innerHTML, pg.janela.location.href], ['none', '', 'index.html']);
    assert.deepEqual(chamadas, ['GET /auth/me'], 'a lista nem é pedida');
  });

  test('Sair: lista, formulário, detalhe e convites são limpos ANTES do logout responder; depois vai ao login', async () => {
    const estado = { logado: true };
    let liberar;
    const r = rotas(estado);
    r['POST /auth/logout'] = () => new Promise((res) => { liberar = () => { estado.logado = false; res(OK); }; });
    servidor(r);
    const pg = pagina('painel-privado/empresas.js');
    await pg.esperar();
    pg.el('detalhe').style.display = 'block'; pg.el('convites').innerHTML = '<tr><td>x@y</td></tr>'; pg.el('situacao').textContent = 'ATIVA'; pg.el('link-aceite').textContent = 'http://link';
    const clique = pg.clicar('sair');
    await new Promise((res) => setImmediate(res));
    assert.deepEqual([pg.el('conteudo').style.display, pg.el('lista').innerHTML, pg.el('convites').innerHTML, pg.el('detalhe').style.display, pg.el('situacao').textContent, pg.el('link-aceite').textContent], ['none', '', '', 'none', '', '']);
    assert.ok(pg.el('form-empresa').resetado >= 1, 'formulário limpo');
    assert.equal(pg.janela.location.href, pg.hrefInicial, 'ainda não navegou');
    liberar(); await clique; await pg.esperar();
    assert.equal(pg.janela.location.href, 'index.html');
  });

  test('restaurada pelo histórico após logout: oculta, revalida, recebe 401 e vai ao login sem mostrar a lista antiga', async () => {
    const estado = { logado: true };
    servidor(rotas(estado));
    const pg = pagina('painel-privado/empresas.js');
    await pg.esperar();
    estado.logado = false;
    await pg.pageshow(true);
    assert.deepEqual([pg.el('conteudo').style.display, pg.el('lista').innerHTML, pg.janela.location.href], ['none', '', 'index.html']);
    assert.deepEqual(chamadas.slice(-1), ['GET /auth/me']);
  });

  test('restaurada com sessão válida: lista atual reaparece; com falha de comunicação: nada é revelado e há aviso', async () => {
    const estado = { logado: true };
    const r = rotas(estado); let cair = false; const original = r['GET /auth/me'];
    r['GET /auth/me'] = () => (cair ? new TypeError('Failed to fetch') : original());
    servidor(r);
    const pg = pagina('painel-privado/empresas.js');
    await pg.esperar();
    await pg.pageshow(true);
    assert.deepEqual([pg.el('conteudo').style.display, /Empresa Demonstração/.test(pg.el('lista').innerHTML)], ['block', true]);
    cair = true;
    await pg.pageshow(true);
    assert.deepEqual([pg.el('conteudo').style.display, pg.el('lista').innerHTML, pg.janela.location.href], ['none', '', pg.hrefInicial]);
    assert.match(pg.el('msg-lista').textContent, /servidor/i);
  });
});

describe('páginas do Painel Privado: scripts versionados e conteúdo protegido oculto na marcação', () => {
  test('painel.html e empresas.html referenciam os scripts com versão na URL (o navegador não reutiliza cópias antigas) e não usam history.back', () => {
    for (const arquivo of ['painel-privado/painel.html', 'painel-privado/empresas.html']) {
      const html = ler(arquivo);
      const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
      assert.equal(scripts.length, 3, arquivo);
      for (const s of scripts) assert.match(s, /\?v=\d{8,}/, `${arquivo}: ${s} sem versão`);
      assert.equal(/history\.(back|forward|go)\b/.test(html), false, arquivo);
    }
    assert.match(ler('painel-privado/empresas.html'), /<main id="conteudo" style="display:none;?">/);
  });
});
