'use strict';

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const EpiHttp = require('../js/api-http');
const P = require('../js/permissoes-efetivas');

/**
 * Dashboard (Bloco 9, Etapa C, Parte C6): módulo js/dashboard.js com
 * `fetch` injetado, entrada `dashboard` no mapa de páginas, inspeção
 * estática de pages/dashboard.html (nenhum número fixo nem dado fictício)
 * e a página sobre um DOM simulado. Somente GET /api/dashboard/indicadores.
 */

const BASE = 'http://localhost:3000/api';
const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const semComentarios = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const modulo = () => require('../js/dashboard'); // eslint-disable-line global-require
const resposta = (status, corpo) => ({ status, ok: status >= 200 && status < 300, text: async () => (corpo === undefined ? '' : JSON.stringify(corpo)) });

const TUDO = {
  itensDisponiveis: { permitido: true, valor: 1234 },
  estoqueAbaixoMinimo: { permitido: true, valor: 2 },
  caVencido: { permitido: true, valor: 1, aVencer: 3, diasAlerta: 60 },
  funcionariosAtivos: { permitido: true, valor: 48 },
};
const NADA = { itensDisponiveis: { permitido: false }, estoqueAbaixoMinimo: { permitido: false }, caVencido: { permitido: false }, funcionariosAtivos: { permitido: false } };

let chamadas;
function servidor(responder) {
  chamadas = [];
  EpiHttp.configurar({
    baseUrl: BASE,
    fetch: async (url, opcoes) => {
      const u = new URL(url);
      chamadas.push(`${opcoes.method} ${u.pathname}${u.search}`);
      const r = typeof responder === 'function' ? responder(u) : responder;
      if (r instanceof Error) throw r;
      return r;
    },
  });
}
beforeEach(() => servidor(resposta(200, { status: 'ok', indicadores: TUDO })));

describe('acoes e render', () => {
  test('consulta somente GET /dashboard/indicadores, sem empresa nem usuário na URL', async () => {
    const r = await modulo().acoes.consultar();
    assert.equal(r.ok, true);
    assert.deepEqual(chamadas, ['GET /api/dashboard/indicadores']);
  });

  test('cards reais: número formatado quando permitido; "—" e "sem permissão" sem número; "—" e "em integração" nos demais', () => {
    const { render } = modulo();
    assert.deepEqual(render.cards(TUDO), {
      disponiveis: { valor: '1.234', meta: 'Saldo em estoque' },
      abaixoMinimo: { valor: '2', meta: 'Itens (material × tamanho) abaixo do mínimo' },
      caVencido: { valor: '1', meta: '3 a vencer em 60 dias' },
      funcionarios: { valor: '48', meta: 'Funcionários ativos cadastrados' },
    });
    const sem = render.cards(NADA);
    for (const c of Object.values(sem)) assert.deepEqual(c, { valor: '—', meta: 'sem permissão' });
    assert.deepEqual(render.EM_INTEGRACAO, { valor: '—', meta: 'em integração' });
    assert.equal(render.cards({ caVencido: { permitido: true, valor: 0, aVencer: 1, diasAlerta: 60 } }).caVencido.meta, '1 a vencer em 60 dias');
  });

  test('indicador ausente ou malformado nunca vira número', () => {
    const c = modulo().render.cards({ itensDisponiveis: { permitido: true, valor: 'x' } });
    assert.deepEqual(c.disponiveis, { valor: '—', meta: 'indisponível' });
    assert.deepEqual(c.funcionarios, { valor: '—', meta: 'indisponível' });
  });

  test('mensagens de erro: rede, 401, 403 e demais', () => {
    const { mensagens } = modulo();
    assert.match(mensagens.erro({ ok: false, status: 0 }), /rede/i);
    assert.match(mensagens.erro({ ok: false, status: 403 }), /perfil/i);
    assert.match(mensagens.erro({ ok: false, status: 500 }), /Não foi possível carregar os indicadores/);
    assert.equal(mensagens.exigeNovoLogin({ status: 401 }), true);
  });
});

describe('permissões: página dashboard', () => {
  test('abrir exige dashboard.visualizar; página somente leitura', () => {
    assert.deepEqual(P.PAGINAS.dashboard, { abrir: [{ recurso: 'dashboard', operacao: 'visualizar' }], alterar: [] });
    const p = (v) => ({ recursos: { dashboard: { visualizar: v, criar: false, editar: false, excluir: false } }, acoes: {}, administracao: {} });
    assert.equal(P.podeAbrir(p(true), 'dashboard'), true);
    assert.equal(P.podeAbrir(p(false), 'dashboard'), false);
    assert.equal(P.podeAlterar(p(true), 'dashboard'), false);
  });
});

describe('inspeção estática: pages/dashboard.html', () => {
  const html = ler('pages/dashboard.html');
  const codigo = semComentarios(html);
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);

  test('sessão real; sem protótipo (login simulado, quiosque, biometria, xlsx, db-api, main.js, Cobresul, armazenamento local)', () => {
    for (const proibido of [/loginScreen/, /doLogin/, /biometric/i, /kiosk/i, /xlsx/, /db-api\.js/, /main\.js/, /Cobresul/i, /localStorage/, /sessionStorage/, /document\.cookie/, /showView\(/, /setActiveNav/, /data-page=/, /_s=/, /localhost:3000/, /onclick=/]) {
      // Únicos onclick permitidos: os do menu móvel do layout comum (pagina-base.js).
      const semMenuMovel = codigo.replace(/onclick="(closeMobileMenu|toggleSidebar)\(\)"/g, '');
      assert.equal(proibido.test(semMenuMovel), false, `dashboard.html contém ${proibido}`);
    }
    const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
    assert.deepEqual(scripts, ['../js/api-http.js', '../portal/config.js', '../js/sessao-empresarial.js', '../js/permissoes-efetivas.js', '../js/pagina-base.js', '../js/dashboard.js']);
    assert.match(codigo, /EpiSessaoEmpresarial\.montar\(/);
    assert.match(codigo, /EpiPermissoes\.prepararPagina\(\{\s*pagina: 'dashboard'/);
    for (const id of ['telaSessao', 'telaSessaoMensagem', 'telaSessaoPortal', 'identidade', 'botaoSair', 'botaoTrocarEmpresa', 'aviso', 'dashboardWelcomeUser']) assert.ok(ids.includes(id), id);
  });

  test('nenhum número fixo nem dado fictício: todos os valores nascem "—"', () => {
    assert.equal(/Luis Freitas/.test(html), false);
    for (const valor of [...html.matchAll(/<div class="kpi-value"[^>]*>([^<]*)<\/div>/g)].map((m) => m[1])) assert.equal(valor, '—');
    for (const valor of [...html.matchAll(/<strong id="kpi[A-Za-z]+">([^<]*)<\/strong>/g)].map((m) => m[1])) assert.equal(valor, '—');
    for (const ficticio of ['152', '312', '+12 este mês', 'Produção</option>', 'Manutenção</option>', 'boas-vindas@empresa.com']) assert.equal(html.includes(ficticio), false, ficticio);
  });

  test('sete cards: quatro reais (dois acrescentados) e três em integração; componentes sem backend em integração', () => {
    for (const id of ['kpiDisponiveisValor', 'kpiDisponiveisMeta', 'kpiAbaixoMinimoValor', 'kpiAbaixoMinimoMeta', 'kpiCaVencidoValor', 'kpiCaVencidoMeta', 'kpiFuncionariosValor', 'kpiFuncionariosMeta']) {
      assert.ok(ids.includes(id), `falta #${id}`);
    }
    assert.equal((html.match(/<article class="kpi-card/g) || []).length, 7);
    for (const titulo of ['EPIs entregues', 'Próximo do vencimento de uso', 'Itens disponíveis', 'CA vencido', 'Pendências sem estoque', 'Estoque abaixo do mínimo', 'Funcionários ativos']) {
      assert.match(html, new RegExp(`<div class="kpi-title">${titulo}</div>`));
    }
    assert.ok((html.match(/em integração/g) || []).length >= 8, 'cards, gráficos, alertas, prévia de e-mails e tabela sem backend');
    assert.match(html, /<select id="dashSetor" class="select" disabled>\s*<option>Todos<\/option>\s*<\/select>/);
    assert.match(html, /<select id="dashStatus" class="select" disabled>\s*<option>Todos<\/option>\s*<\/select>/);
  });

  test('menu: Dashboard ativo; páginas integradas por permissão; o Portal e as páginas integradas oferecem o Dashboard', () => {
    assert.match(html, /<a class="active" href="javascript:void\(0\)" data-pagina="dashboard" style="display:none"><div class="nav-icon blue">dashboard<\/div>Dashboard<\/a>/);
    for (const arquivo of ['pages/materials.html', 'pages/available-items.html', 'pages/employee-history.html', 'pages/import-employees.html', 'pages/employee-groups.html']) {
      assert.match(ler(arquivo), /<a href="dashboard\.html" data-pagina="dashboard" style="display:none"><div class="nav-icon blue">dashboard<\/div>Dashboard<\/a>/, arquivo);
    }
    assert.match(ler('portal/inicio.html'), /<a href="\.\.\/pages\/dashboard\.html" data-pagina="dashboard" style="display:none">Dashboard<\/a>/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Página em DOM simulado: o script embutido de dashboard.html
// ═══════════════════════════════════════════════════════════════════
const CONTEXTO = { empresa: { id: 3, nome: 'Empresa Demonstração SafeWork' }, usuario: { id: 7, nome: 'Pessoa Teste', email: 'p@exemplo-cliente.com.br', perfil: 'MASTER' } };
const ACESSO = { permissoes: { recursos: { dashboard: { visualizar: true, criar: false, editar: false, excluir: false } }, acoes: {}, administracao: {} }, podeAlterar: false };

function montarPagina(responder, { acesso = ACESSO } = {}) {
  servidor(responder);
  const html = ler('pages/dashboard.html');
  const script = html.slice(html.lastIndexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));
  const mapa = {};
  const el = (id) => (mapa[id] = mapa[id] || { id, innerHTML: '', textContent: '', style: {}, listeners: {}, addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); } });
  const sandbox = {
    document: { getElementById: el, querySelectorAll: () => [] },
    window: { SAFEWORK_PORTAL_API_BASE_URL: BASE },
    EpiHttp, EpiDashboard: modulo(),
    EpiPermissoes: { prepararPagina: async () => acesso },
    EpiSessaoEmpresarial: { montar: async (o) => { sandbox.opcoesMontar = o; return CONTEXTO; }, sessaoEncerrada() { sandbox.encerrada = true; } },
    console, Promise, String, Number, Object, JSON,
  };
  vm.runInNewContext(script, sandbox);
  const esperar = async () => { for (let i = 0; i < 40; i += 1) await new Promise((r) => setImmediate(r)); };
  return { el, sandbox, esperar };
}

describe('página (DOM simulado)', () => {
  test('carrega os indicadores reais e cumprimenta o usuário da sessão', async () => {
    const pg = montarPagina(resposta(200, { status: 'ok', indicadores: TUDO }));
    assert.equal(pg.el('kpiDisponiveisMeta').textContent, 'Carregando…');
    await pg.esperar();
    assert.deepEqual(chamadas, ['GET /api/dashboard/indicadores']);
    assert.equal(pg.el('kpiDisponiveisValor').textContent, '1.234');
    assert.equal(pg.el('kpiAbaixoMinimoValor').textContent, '2');
    assert.equal(pg.el('kpiCaVencidoValor').textContent, '1');
    assert.equal(pg.el('kpiCaVencidoMeta').textContent, '3 a vencer em 60 dias');
    assert.equal(pg.el('kpiFuncionariosValor').textContent, '48');
    assert.equal(pg.el('dashboardWelcomeUser').textContent, 'Olá, Pessoa Teste.');
  });

  test('sem permissão nas fontes: "—" e "sem permissão"', async () => {
    const pg = montarPagina(resposta(200, { status: 'ok', indicadores: NADA }));
    await pg.esperar();
    for (const k of ['kpiDisponiveis', 'kpiAbaixoMinimo', 'kpiCaVencido', 'kpiFuncionarios']) {
      assert.equal(pg.el(`${k}Valor`).textContent, '—');
      assert.equal(pg.el(`${k}Meta`).textContent, 'sem permissão');
    }
  });

  test('falha (403 ou rede): cards "—" e aviso; nunca número antigo', async () => {
    const pg = montarPagina(resposta(403, { status: 'erro', codigo: 'PERMISSAO_NEGADA' }));
    await pg.esperar();
    assert.equal(pg.el('kpiDisponiveisValor').textContent, '—');
    assert.match(pg.el('aviso').innerHTML, /perfil/i);
    const rede = montarPagina(new TypeError('Failed to fetch'));
    await rede.esperar();
    assert.equal(rede.el('kpiFuncionariosValor').textContent, '—');
    assert.match(rede.el('aviso').innerHTML, /rede/i);
  });

  test('401 devolve ao Portal; sem acesso à página, nada é consultado', async () => {
    const pg = montarPagina(resposta(401, { status: 'erro', codigo: 'SESSAO_INVALIDA' }));
    await pg.esperar();
    assert.equal(pg.sandbox.encerrada, true);
    const semAcesso = montarPagina(resposta(200, { status: 'ok', indicadores: TUDO }), { acesso: null });
    await semAcesso.esperar();
    assert.deepEqual(chamadas, []);
    assert.equal(semAcesso.el('kpiDisponiveisValor').textContent, '—');
  });

  test('encerramento da sessão limpa os números exibidos', async () => {
    const pg = montarPagina(resposta(200, { status: 'ok', indicadores: TUDO }));
    await pg.esperar();
    pg.sandbox.opcoesMontar.aoEncerrar();
    assert.equal(pg.el('kpiDisponiveisValor').textContent, '—');
    assert.equal(pg.el('dashboardWelcomeUser').textContent, '');
  });
});
