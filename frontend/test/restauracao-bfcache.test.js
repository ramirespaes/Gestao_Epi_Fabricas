'use strict';

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const EpiHttp = require('../js/api-http');
const EpiPortal = require('../js/portal-cliente');
const EpiPermissoes = require('../js/permissoes-efetivas');
const Sessao = require('../js/sessao-empresarial');

/**
 * Página protegida restaurada pelo navegador (BFCache) depois do logout:
 * o evento `pageshow` com `persisted=true` deve esconder o conteúdo
 * protegido e revalidar a sessão no servidor. Sessão encerrada -> login;
 * válida -> conteúdo da sessão ATUAL (identidade/empresa podem ter mudado
 * em outra aba); falha de comunicação -> nada revelado. `pageshow` sem
 * restauração não gera trabalho extra, e o carregamento inicial continua
 * igual. Nada de history.back/forward, unload ou beforeunload.
 */

const RAIZ = path.join(__dirname, '..');
const BASE = 'http://localhost:3000/api';
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const resposta = (status, corpo) => ({ status, ok: status >= 200 && status < 300, text: async () => (corpo === undefined ? '' : JSON.stringify(corpo)) });

const ADMIN = (email) => ({ status: 'ok', administrador: { id: 1, email } });
const CONTEXTO = (usuarioId, empresaId, extra = {}) => ({
  usuario: { id: usuarioId, nome: `Pessoa ${usuarioId}`, email: `p${usuarioId}@exemplo-cliente.com.br`, perfil: 'MASTER', ...extra },
  empresa: { id: empresaId, nome: `Empresa ${empresaId}`, cnpj: '11222333000181' },
});
const GLOBAL_ME = (usuarioId, empresaId) => ({ status: 'ok', identidade: { id: 9, email: `p${usuarioId}@exemplo-cliente.com.br` }, empresas: [{ id: empresaId, nome: `Empresa ${empresaId}`, perfil: 'MASTER' }], contexto: CONTEXTO(usuarioId, empresaId) });
const PERMISSOES = (usuarioId, empresaId) => ({ status: 'ok', empresaId, usuarioId, perfil: 'MASTER', recursos: {}, acoes: {}, administracao: { gruposAcesso: { consultar: true, alterar: true }, permissoesGrupo: { consultar: true, alterar: true }, vinculosGrupo: { consultar: true, alterar: true }, autorizacoesIndividuais: { consultar: true, concederDireta: true, delegar: true } } });

let chamadas;
/** Servidor falso por rota; `rotas` mapeia "METODO caminho" -> resposta | Error | função(). */
function servidor(rotas) {
  chamadas = [];
  EpiHttp.configurar({
    baseUrl: BASE,
    fetch: async (url, opcoes) => {
      const chave = `${opcoes.method} ${new URL(url).pathname.replace(/^\/api/, '')}`;
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
  const classes = new Set(id === 'conteudo' || id === 'acoes' || id === 'selecao' || id === 'sem-empresa' || id === 'modulos-mensagem' || id === 'botao-trocar' || id === 'botao-sair' ? ['oculto'] : []);
  const listeners = {};
  return {
    id, textContent: '', innerHTML: '', className: '', disabled: false, style: { display: id === 'conteudo' ? 'none' : '' }, listeners,
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
    addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    querySelectorAll: () => [],
  };
}

/** Executa um script de página (IIFE sobre window/document) num DOM mínimo. */
function pagina(arquivo) {
  const mapa = {};
  const el = (id) => (mapa[id] = mapa[id] || elemento(id));
  const eventosJanela = {};
  const janela = {
    EpiHttp, EpiPortal, EpiPermissoes, SAFEWORK_PORTAL_API_BASE_URL: BASE, SAFEWORK_PLATAFORMA_API_BASE_URL: `${BASE}/plataforma`,
    location: { href: `http://localhost:5500/${arquivo.replace(/\.js$/, '.html')}`, pathname: `/${arquivo.replace(/\.js$/, '.html')}`, search: '' },
    addEventListener(ev, fn) { (eventosJanela[ev] = eventosJanela[ev] || []).push(fn); },
  };
  const sandbox = { window: janela, document: { getElementById: el, querySelectorAll: () => [] }, console, setTimeout, Promise, Number, String, Array, Object, JSON };
  vm.runInNewContext(ler(arquivo), sandbox);
  const esperar = async () => { for (let i = 0; i < 30; i += 1) await new Promise((r) => setImmediate(r)); };
  const pageshow = async (persisted) => { for (const fn of (eventosJanela.pageshow || [])) await fn({ persisted }); await esperar(); };
  return { el, janela, esperar, pageshow, eventosJanela, hrefInicial: janela.location.href };
}

const LOGIN_PAINEL = 'http://localhost:5500/painel-privado/index.html';
const LOGIN_PORTAL = 'http://localhost:5500/portal/index.html';

describe('Painel Privado (painel.js): restauração pelo BFCache', () => {
  const rotasOk = (email) => ({ 'GET /plataforma/painel': resposta(200, ADMIN(email)) });

  test('carregamento inicial inalterado: conteúdo e e-mail aparecem uma vez; pageshow sem restauração não consulta de novo', async () => {
    servidor(rotasOk('admin@safework.local'));
    const pg = pagina('painel-privado/painel.js');
    await pg.esperar();
    assert.deepEqual([pg.el('conteudo').style.display, pg.el('email-administrador').textContent], ['block', 'admin@safework.local']);
    assert.ok(pg.eventosJanela.pageshow && pg.eventosJanela.pageshow.length === 1, 'um único ouvinte de pageshow');
    await pg.pageshow(false);
    assert.deepEqual(chamadas, ['GET /plataforma/painel']);
    assert.equal(pg.el('conteudo').style.display, 'block');
  });

  test('sessão revogada após logout: ao restaurar, o conteúdo some, o e-mail é limpo e a página vai ao login', async () => {
    let logado = true;
    servidor({ 'GET /plataforma/painel': () => (logado ? resposta(200, ADMIN('admin@safework.local')) : resposta(401, { status: 'erro', codigo: 'NAO_AUTENTICADO' })) });
    const pg = pagina('painel-privado/painel.js');
    await pg.esperar();
    logado = false; // logout feito (nesta ou noutra aba); o navegador restaura a página antiga
    await pg.pageshow(true);
    assert.deepEqual([pg.el('conteudo').style.display, pg.el('email-administrador').textContent], ['none', '']);
    assert.equal(pg.janela.location.href, 'index.html');
    assert.deepEqual(chamadas, ['GET /plataforma/painel', 'GET /plataforma/painel']);
  });

  test('sessão válida de OUTRA identidade (troca em outra aba): o conteúdo volta com o e-mail atual, não o antigo', async () => {
    let email = 'primeiro@safework.local';
    servidor({ 'GET /plataforma/painel': () => resposta(200, ADMIN(email)) });
    const pg = pagina('painel-privado/painel.js');
    await pg.esperar();
    email = 'segundo@safework.local';
    await pg.pageshow(true);
    assert.deepEqual([pg.el('conteudo').style.display, pg.el('email-administrador').textContent], ['block', 'segundo@safework.local']);
    assert.equal(pg.janela.location.href, pg.hrefInicial);
  });

  test('falha de comunicação na revalidação: nada é revelado, aviso de erro, sem redirecionar', async () => {
    let cair = false;
    servidor({ 'GET /plataforma/painel': () => (cair ? new TypeError('Failed to fetch') : resposta(200, ADMIN('admin@safework.local'))) });
    const pg = pagina('painel-privado/painel.js');
    await pg.esperar();
    cair = true;
    await pg.pageshow(true);
    assert.deepEqual([pg.el('conteudo').style.display, pg.el('email-administrador').textContent], ['none', '']);
    assert.match(pg.el('erro').textContent, /servidor|conexão/i);
    assert.equal(pg.janela.location.href, pg.hrefInicial);
  });
});

describe('Portal do Cliente — início (inicio.js): restauração pelo BFCache', () => {
  const rotas = (estado) => ({
    'GET /auth/global/me': () => (estado.logado ? resposta(200, GLOBAL_ME(estado.usuario, estado.empresa)) : resposta(401, { status: 'erro', codigo: 'NAO_AUTENTICADO' })),
    'GET /auth/permissoes': () => resposta(200, PERMISSOES(estado.usuario, estado.empresa)),
  });

  test('carregamento inicial inalterado; pageshow sem restauração não consulta de novo', async () => {
    const estado = { logado: true, usuario: 7, empresa: 3 };
    servidor(rotas(estado));
    const pg = pagina('portal/inicio.js');
    await pg.esperar();
    assert.deepEqual([pg.el('conteudo').classList.contains('oculto'), pg.el('usuario-email').textContent, pg.el('empresa-ativa').textContent], [false, 'p7@exemplo-cliente.com.br', 'Empresa 3']);
    const antes = chamadas.length;
    await pg.pageshow(false);
    assert.equal(chamadas.length, antes);
  });

  test('sessão encerrada: ao restaurar, dados de usuário e empresa são limpos, conteúdo e ações ocultos, e vai ao login', async () => {
    const estado = { logado: true, usuario: 7, empresa: 3 };
    servidor(rotas(estado));
    const pg = pagina('portal/inicio.js');
    await pg.esperar();
    estado.logado = false;
    await pg.pageshow(true);
    for (const id of ['usuario-nome', 'usuario-email', 'usuario-perfil', 'empresa-ativa', 'empresa-cnpj']) assert.equal(pg.el(id).textContent, '', id);
    assert.deepEqual([pg.el('conteudo').classList.contains('oculto'), pg.el('acoes').classList.contains('oculto')], [true, true]);
    assert.equal(pg.janela.location.href, 'index.html');
  });

  test('troca de empresa em outra aba: ao restaurar, o início mostra a empresa e o usuário da sessão ATUAL', async () => {
    const estado = { logado: true, usuario: 7, empresa: 3 };
    servidor(rotas(estado));
    const pg = pagina('portal/inicio.js');
    await pg.esperar();
    estado.usuario = 8; estado.empresa = 4;
    await pg.pageshow(true);
    assert.deepEqual([pg.el('empresa-ativa').textContent, pg.el('usuario-email').textContent, pg.el('conteudo').classList.contains('oculto')], ['Empresa 4', 'p8@exemplo-cliente.com.br', false]);
    assert.equal(pg.janela.location.href, pg.hrefInicial);
  });

  test('falha de comunicação na revalidação: conteúdo permanece oculto, aviso de erro, sem redirecionar', async () => {
    const estado = { logado: true, usuario: 7, empresa: 3 };
    const r = rotas(estado);
    let cair = false;
    const original = r['GET /auth/global/me'];
    r['GET /auth/global/me'] = () => (cair ? new TypeError('Failed to fetch') : original());
    servidor(r);
    const pg = pagina('portal/inicio.js');
    await pg.esperar();
    cair = true;
    await pg.pageshow(true);
    assert.deepEqual([pg.el('conteudo').classList.contains('oculto'), pg.el('usuario-email').textContent], [true, '']);
    assert.match(pg.el('mensagem').textContent, /servidor|conexão/i);
    assert.equal(pg.janela.location.href, pg.hrefInicial);
  });
});

describe('Portal do Cliente — seleção de empresa (empresas.js): restauração pelo BFCache', () => {
  test('sessão encerrada: ao restaurar, identificação e lista são limpas e vai ao login; sessão válida: lista atual reaparece', async () => {
    let logado = true;
    servidor({ 'GET /auth/global/me': () => (logado ? resposta(200, GLOBAL_ME(7, 3)) : resposta(401, { status: 'erro', codigo: 'NAO_AUTENTICADO' })) });
    const pg = pagina('portal/empresas.js');
    await pg.esperar();
    assert.match(pg.el('lista-empresas').innerHTML, /Empresa 3/);
    assert.equal(pg.el('identificacao').textContent, 'p7@exemplo-cliente.com.br');
    await pg.pageshow(true);
    assert.match(pg.el('lista-empresas').innerHTML, /Empresa 3/, 'sessão válida: lista atual');
    logado = false;
    await pg.pageshow(true);
    assert.deepEqual([pg.el('identificacao').textContent, pg.el('lista-empresas').innerHTML, pg.el('selecao').classList.contains('oculto')], ['', '', true]);
    assert.equal(pg.janela.location.href, 'index.html');
  });

  test('falha de comunicação na revalidação: lista não reaparece, aviso de erro', async () => {
    let cair = false;
    servidor({ 'GET /auth/global/me': () => (cair ? new TypeError('Failed to fetch') : resposta(200, GLOBAL_ME(7, 3))) });
    const pg = pagina('portal/empresas.js');
    await pg.esperar();
    cair = true;
    await pg.pageshow(true);
    assert.deepEqual([pg.el('lista-empresas').innerHTML, pg.el('identificacao').textContent], ['', '']);
    assert.match(pg.el('mensagem').textContent, /servidor|conexão/i);
  });
});

describe('Páginas integradas (js/sessao-empresarial.js, montar): restauração pelo BFCache', () => {
  function janelaFalsa() {
    const eventos = {};
    const j = {
      redirecionamentos: [], eventos,
      location: { pathname: '/pages/materials.html', search: '', hash: '', replace: (d) => j.redirecionamentos.push(d) },
      history: { replaceState() {} },
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      document: { set cookie(_v) {} },
      addEventListener(ev, fn) { (eventos[ev] = eventos[ev] || []).push(fn); },
    };
    return j;
  }
  function elementos() {
    const e = (extra = {}) => ({ textContent: '', style: { display: '' }, disabled: false, addEventListener() {}, ...extra });
    return { tela: e(), mensagem: e(), linkPortal: e({ style: { display: 'none' } }), identificacao: e(), botaoSair: e(), botaoTrocar: e() };
  }
  const rotas = (estado) => ({
    'GET /auth/me': () => (estado.logado ? resposta(200, CONTEXTO(estado.usuario, estado.empresa)) : resposta(401, { status: 'erro', codigo: 'NAO_AUTENTICADO' })),
    'GET /auth/global/me': () => resposta(200, GLOBAL_ME(estado.usuario, estado.empresa)),
  });
  const pageshow = async (j, persisted) => { for (const fn of (j.eventos.pageshow || [])) await fn({ persisted }); };

  test('montar registra um ouvinte de pageshow; sem restauração nada acontece; a tela de sessão continua oculta', async () => {
    const estado = { logado: true, usuario: 7, empresa: 3 };
    servidor(rotas(estado));
    const j = janelaFalsa(); const el = elementos();
    const ctx = await Sessao.montar({ elementos: el, janela: j });
    assert.equal(ctx.usuario.id, 7);
    assert.equal((j.eventos.pageshow || []).length, 1);
    const antes = chamadas.length;
    await pageshow(j, false);
    assert.deepEqual([chamadas.length, el.tela.style.display], [antes, 'none']);
  });

  test('sessão encerrada (logout): ao restaurar, a tela de verificação cobre a página, a identificação é limpa, aoEncerrar limpa os dados e vai ao Portal', async () => {
    const estado = { logado: true, usuario: 7, empresa: 3 };
    servidor(rotas(estado));
    const j = janelaFalsa(); const el = elementos(); const encerrou = [];
    await Sessao.montar({ elementos: el, janela: j, aoEncerrar: () => encerrou.push('limpou') });
    estado.logado = false;
    await pageshow(j, true);
    assert.deepEqual([el.tela.style.display, el.identificacao.textContent, encerrou, j.redirecionamentos], ['', '', ['limpou'], ['../portal/index.html']]);
    assert.equal(Sessao.contexto(), null);
  });

  test('sessão válida e MESMO contexto: a tela some de novo e a identificação é reapresentada', async () => {
    const estado = { logado: true, usuario: 7, empresa: 3 };
    servidor(rotas(estado));
    const j = janelaFalsa(); const el = elementos(); const encerrou = [];
    await Sessao.montar({ elementos: el, janela: j, aoEncerrar: () => encerrou.push('limpou') });
    el.identificacao.textContent = 'X';
    await pageshow(j, true);
    assert.deepEqual([el.tela.style.display, encerrou, j.redirecionamentos], ['none', [], []]);
    assert.equal(el.identificacao.textContent, Sessao.rotuloIdentificacao(CONTEXTO(7, 3)));
  });

  test('sessão válida de OUTRA empresa ou usuário (troca em outra aba): dados antigos são limpos e a página é recarregada para o contexto atual, sem history.back', async () => {
    const estado = { logado: true, usuario: 7, empresa: 3 };
    servidor(rotas(estado));
    const j = janelaFalsa(); const el = elementos(); const encerrou = [];
    await Sessao.montar({ elementos: el, janela: j, aoEncerrar: () => encerrou.push('limpou') });
    estado.empresa = 4;
    await pageshow(j, true);
    assert.deepEqual([encerrou, j.redirecionamentos], [['limpou'], ['/pages/materials.html']]);
    assert.equal(el.tela.style.display, '', 'a tela continua cobrindo a página até o recarregamento');
  });

  test('falha de comunicação na revalidação: a tela permanece com o aviso e o link para o Portal; nada é revelado nem redirecionado', async () => {
    const estado = { logado: true, usuario: 7, empresa: 3 };
    const r = rotas(estado); let cair = false; const original = r['GET /auth/me'];
    r['GET /auth/me'] = () => (cair ? new TypeError('Failed to fetch') : original());
    servidor(r);
    const j = janelaFalsa(); const el = elementos();
    await Sessao.montar({ elementos: el, janela: j });
    cair = true;
    await pageshow(j, true);
    assert.deepEqual([el.tela.style.display, el.mensagem.textContent, el.linkPortal.style.display, el.identificacao.textContent, j.redirecionamentos], ['', Sessao.MENSAGENS.FALHA, '', '', []]);
  });

  test('janela sem addEventListener (testes antigos da C0) continua aceita', async () => {
    const estado = { logado: true, usuario: 7, empresa: 3 };
    servidor(rotas(estado));
    const j = janelaFalsa(); delete j.addEventListener;
    const ctx = await Sessao.montar({ elementos: elementos(), janela: j });
    assert.equal(ctx.empresa.id, 3);
  });
});

describe('nenhuma solução baseada em bloquear o histórico', () => {
  test('os arquivos alterados não usam history.back/forward/go, unload ou beforeunload', () => {
    for (const arquivo of ['painel-privado/painel.js', 'portal/inicio.js', 'portal/empresas.js', 'js/sessao-empresarial.js']) {
      const codigo = ler(arquivo).replace(/^\s*(\*|\/\/).*$/gm, '');
      assert.equal(/history\.(back|forward|go)\b|['"](unload|beforeunload)['"]/.test(codigo), false, arquivo);
      assert.match(codigo, /pageshow/, `${arquivo} trata pageshow`);
    }
  });
});
