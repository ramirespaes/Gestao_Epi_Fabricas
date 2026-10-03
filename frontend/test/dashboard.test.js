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

// Contrato do servidor (12D-2): oito indicadores, cada um { permitido, valor } ou { permitido: false }.
const CHAVES_DO_CONTRATO = ['caVencido', 'comprometido', 'estoqueAbaixoMinimo', 'funcionariosAtivos', 'itensDisponiveis', 'necessidadeReposicao', 'saldoLivre', 'semCobertura'];
const TUDO = {
  itensDisponiveis: { permitido: true, valor: 1234 },
  estoqueAbaixoMinimo: { permitido: true, valor: 2 },
  saldoLivre: { permitido: true, valor: 1100 },
  comprometido: { permitido: true, valor: 134 },
  semCobertura: { permitido: true, valor: 9 },
  necessidadeReposicao: { permitido: true, valor: 21 },
  caVencido: { permitido: true, valor: 1, aVencer: 3, diasAlerta: 60 },
  funcionariosAtivos: { permitido: true, valor: 48 },
};
const NADA = Object.fromEntries(CHAVES_DO_CONTRATO.map((k) => [k, { permitido: false }]));
// Cartões da página e o indicador do servidor que cada um mostra.
const CARTOES = { disponiveis: 'kpiDisponiveis', saldoLivre: 'kpiSaldoLivre', comprometido: 'kpiComprometido', caVencido: 'kpiCaVencido', semCobertura: 'kpiSemCobertura', necessidade: 'kpiNecessidade', abaixoMinimo: 'kpiAbaixoMinimo', funcionarios: 'kpiFuncionarios' };

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
      disponiveis: { valor: '1.234', meta: 'Físico utilizável em estoque' },
      saldoLivre: { valor: '1.100', meta: 'Físico utilizável menos o comprometido' },
      comprometido: { valor: '134', meta: 'Reservado a solicitações aprovadas' },
      caVencido: { valor: '1', meta: '3 a vencer em 60 dias' },
      semCobertura: { valor: '9', meta: 'Aprovado sem estoque para cobrir' },
      necessidade: { valor: '21', meta: 'Sem cobertura mais déficit do mínimo' },
      abaixoMinimo: { valor: '2', meta: 'Itens (material × tamanho) abaixo do mínimo pelo saldo livre' },
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
    for (const k of ['saldoLivre', 'comprometido', 'semCobertura', 'necessidade']) assert.deepEqual(c[k], { valor: '—', meta: 'indisponível' }, k);
  });

  test('os indicadores novos: sem permissão nunca vira zero mascarado; zero real aparece como "0"; negativo e fracionado não passam', () => {
    const { render } = modulo();
    const novos = ['saldoLivre', 'comprometido', 'semCobertura', 'necessidade', 'abaixoMinimo', 'disponiveis'];
    const sem = render.cards({ ...TUDO, saldoLivre: { permitido: false }, comprometido: { permitido: false }, semCobertura: { permitido: false }, necessidadeReposicao: { permitido: false }, estoqueAbaixoMinimo: { permitido: false }, itensDisponiveis: { permitido: false } });
    for (const k of novos) assert.deepEqual(sem[k], { valor: '—', meta: 'sem permissão' }, `${k}: sem permissão não pode virar 0`);
    const zeros = render.cards({ ...TUDO, saldoLivre: { permitido: true, valor: 0 }, comprometido: { permitido: true, valor: 0 }, semCobertura: { permitido: true, valor: 0 }, necessidadeReposicao: { permitido: true, valor: 0 }, estoqueAbaixoMinimo: { permitido: true, valor: 0 } });
    for (const k of ['saldoLivre', 'comprometido', 'semCobertura', 'necessidade', 'abaixoMinimo']) assert.equal(zeros[k].valor, '0', `${k}: zero real é "0"`);
    for (const ruim of [-1, 1.5, '3', null, Infinity, NaN]) {
      const c = render.cards({ ...TUDO, saldoLivre: { permitido: true, valor: ruim }, semCobertura: { permitido: true, valor: ruim } });
      assert.deepEqual([c.saldoLivre.valor, c.semCobertura.valor], ['—', '—'], String(ruim));
    }
  });

  test('o frontend só mostra o que o servidor mediu: nenhum indicador é recalculado (livre, comprometido e necessidade independem um do outro)', () => {
    const c = modulo().render.cards({
      ...TUDO,
      itensDisponiveis: { permitido: true, valor: 10 },
      comprometido: { permitido: true, valor: 3 },
      saldoLivre: { permitido: true, valor: 5 }, // 10 − 3 seria 7: o servidor mandou 5 e é 5 que aparece
      semCobertura: { permitido: true, valor: 0 },
      necessidadeReposicao: { permitido: true, valor: 40 }, // maior que G + livre: aparece como veio
    });
    assert.deepEqual([c.disponiveis.valor, c.comprometido.valor, c.saldoLivre.valor, c.semCobertura.valor, c.necessidade.valor], ['10', '3', '5', '0', '40']);
  });

  test('o contrato não renomeado por acidente: os cartões leem exatamente os oito indicadores do servidor e nenhum outro', () => {
    const lidas = new Set();
    const espiao = new Proxy({}, {
      get(_alvo, nome) { if (typeof nome === 'string') lidas.add(nome); return TUDO[nome]; },
      has: () => true,
    });
    modulo().render.cards(espiao);
    assert.deepEqual([...lidas].sort(), CHAVES_DO_CONTRATO);
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
    assert.deepEqual(scripts, ['../js/tema.js', '../js/api-http.js', '../portal/config.js', '../js/sessao-empresarial.js', '../js/permissoes-efetivas.js', '../js/pagina-base.js', '../js/dashboard.js']);
    assert.match(codigo, /EpiSessaoEmpresarial\.montar\(/);
    assert.match(codigo, /EpiPermissoes\.prepararPagina\(\{\s*pagina: 'dashboard'/);
    for (const id of ['telaSessao', 'telaSessaoMensagem', 'telaSessaoPortal', 'contaNome', 'contaEmpresa', 'botaoEmpresa', 'menuEmpresa', 'botaoSair', 'botaoTrocarEmpresa', 'aviso', 'dashboardWelcomeUser']) assert.ok(ids.includes(id), id);
  });

  test('nenhum número fixo nem dado fictício: todos os valores nascem "—"', () => {
    assert.equal(/Fulano de Tal/.test(html), false);
    for (const valor of [...html.matchAll(/<div class="kpi-value"[^>]*>([^<]*)<\/div>/g)].map((m) => m[1])) assert.equal(valor, '—');
    for (const valor of [...html.matchAll(/<strong id="kpi[A-Za-z]+">([^<]*)<\/strong>/g)].map((m) => m[1])) assert.equal(valor, '—');
    for (const ficticio of ['152', '312', '+12 este mês', 'Produção</option>', 'Manutenção</option>', 'boas-vindas@empresa.com']) assert.equal(html.includes(ficticio), false, ficticio);
  });

  test('dez cards: oito reais (a 12D-3 acrescentou saldo livre, comprometido e necessidade, e ligou "Pendências sem estoque") e dois em integração; componentes sem backend em integração', () => {
    for (const prefixo of Object.values(CARTOES)) {
      for (const sufixo of ['Valor', 'Meta']) assert.ok(ids.includes(`${prefixo}${sufixo}`), `falta #${prefixo}${sufixo}`);
    }
    assert.equal((html.match(/<article class="kpi-card/g) || []).length, 10);
    for (const titulo of ['EPIs entregues', 'Próximo do vencimento de uso', 'Itens disponíveis', 'Saldo livre', 'Saldo comprometido', 'CA vencido', 'Pendências sem estoque', 'Necessidade de reposição', 'Estoque abaixo do mínimo', 'Funcionários ativos']) {
      assert.match(html, new RegExp(`<div class="kpi-title">${titulo}</div>`));
    }
    // "Pendências sem estoque" mostra a demanda sem cobertura; "EPIs entregues" continua fora (Bloco 13).
    assert.match(html, /<div class="kpi-title">Pendências sem estoque<\/div>[\s\S]*?id="kpiSemCoberturaValor"/);
    assert.match(html, /<div class="kpi-title">EPIs entregues<\/div>[\s\S]*?<div class="kpi-value">—<\/div>\s*<div class="kpi-meta">em integração<\/div>/);
    assert.equal((html.match(/<div class="kpi-meta">em integração<\/div>/g) || []).length, 2, 'só EPIs entregues e Próximo do vencimento de uso seguem em integração');
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
  const el = (id) => (mapa[id] = mapa[id] || {
    id, innerHTML: '', textContent: '', style: {}, listeners: {}, atributos: {}, focado: false,
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    setAttribute(k, v) { this.atributos[k] = String(v); }, removeAttribute(k) { delete this.atributos[k]; }, focus() { this.focado = true; },
  });
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

  test('os cartões da 12D-3 recebem cada um o seu indicador: livre, comprometido, sem cobertura e necessidade', async () => {
    const pg = montarPagina(resposta(200, { status: 'ok', indicadores: TUDO }));
    await pg.esperar();
    assert.deepEqual(
      ['kpiSaldoLivre', 'kpiComprometido', 'kpiSemCobertura', 'kpiNecessidade'].map((k) => pg.el(`${k}Valor`).textContent),
      ['1.100', '134', '9', '21'],
    );
    assert.equal(pg.el('kpiAbaixoMinimoMeta').textContent, 'Itens (material × tamanho) abaixo do mínimo pelo saldo livre');
  });

  test('zero real aparece como "0" em todos os cartões de estoque (nunca "—")', async () => {
    const zeros = { ...TUDO, itensDisponiveis: { permitido: true, valor: 0 }, saldoLivre: { permitido: true, valor: 0 }, comprometido: { permitido: true, valor: 0 }, semCobertura: { permitido: true, valor: 0 }, necessidadeReposicao: { permitido: true, valor: 0 }, estoqueAbaixoMinimo: { permitido: true, valor: 0 } };
    const pg = montarPagina(resposta(200, { status: 'ok', indicadores: zeros }));
    await pg.esperar();
    for (const k of ['kpiDisponiveis', 'kpiSaldoLivre', 'kpiComprometido', 'kpiSemCobertura', 'kpiNecessidade', 'kpiAbaixoMinimo']) assert.equal(pg.el(`${k}Valor`).textContent, '0', k);
  });

  test('sem permissão nas fontes: "—" e "sem permissão"', async () => {
    const pg = montarPagina(resposta(200, { status: 'ok', indicadores: NADA }));
    await pg.esperar();
    for (const k of Object.values(CARTOES)) {
      assert.equal(pg.el(`${k}Valor`).textContent, '—', k);
      assert.equal(pg.el(`${k}Meta`).textContent, 'sem permissão', k);
    }
  });

  test('permissão parcial: o que o perfil vê aparece, o resto fica "—" sem permissão (estoque liberado, validade e funcionários não)', async () => {
    const parcial = { ...TUDO, caVencido: { permitido: false }, funcionariosAtivos: { permitido: false } };
    const pg = montarPagina(resposta(200, { status: 'ok', indicadores: parcial }));
    await pg.esperar();
    assert.equal(pg.el('kpiSaldoLivreValor').textContent, '1.100');
    assert.equal(pg.el('kpiCaVencidoValor').textContent, '—');
    assert.equal(pg.el('kpiCaVencidoMeta').textContent, 'sem permissão');
    assert.equal(pg.el('kpiFuncionariosMeta').textContent, 'sem permissão');
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
    for (const k of Object.values(CARTOES)) assert.equal(pg.el(`${k}Valor`).textContent, '—', `${k}: nenhum número fica na tela depois do encerramento`);
    assert.equal(pg.el('dashboardWelcomeUser').textContent, '');
  });

  test('falha da consulta: os cartões novos também ficam "—" e "indisponível", sem número antigo', async () => {
    const pg = montarPagina(resposta(503, { status: 'erro', codigo: 'INDISPONIVEL' }));
    await pg.esperar();
    for (const k of Object.values(CARTOES)) {
      assert.equal(pg.el(`${k}Valor`).textContent, '—', k);
      assert.equal(pg.el(`${k}Meta`).textContent, 'indisponível', k);
    }
  });
});

describe('bloco de conta (DOM simulado)', () => {
  const disparar = async (pg, id, ev, evento = {}) => { for (const fn of (pg.el(id).listeners[ev] || [])) await fn(evento); };
  const estado = (pg) => [pg.el('menuEmpresa').style.display, pg.el('botaoEmpresa').atributos['aria-expanded']];

  test('o módulo de sessão recebe nome, empresa, Trocar e Sair do bloco; nenhuma identificação antiga', async () => {
    const pg = montarPagina(resposta(200, { status: 'ok', indicadores: TUDO }));
    await pg.esperar();
    const el = pg.sandbox.opcoesMontar.elementos;
    assert.deepEqual([el.usuario, el.empresa, el.botaoSair, el.botaoTrocar].map((e) => e && e.id), ['contaNome', 'contaEmpresa', 'botaoSair', 'botaoTrocarEmpresa']);
    assert.equal('identificacao' in el, false);
  });

  test('o menu da empresa começa fechado, abre e fecha pelo botão e fecha com Esc, devolvendo o foco', async () => {
    const pg = montarPagina(resposta(200, { status: 'ok', indicadores: TUDO }));
    await pg.esperar();
    assert.deepEqual(estado(pg), ['none', 'false']);
    await disparar(pg, 'botaoEmpresa', 'click');
    assert.deepEqual(estado(pg), ['', 'true']);
    await disparar(pg, 'botaoEmpresa', 'click');
    assert.deepEqual(estado(pg), ['none', 'false']);
    await disparar(pg, 'botaoEmpresa', 'click');
    await disparar(pg, 'menuEmpresa', 'keydown', { key: 'Escape' });
    assert.deepEqual(estado(pg), ['none', 'false']);
    assert.equal(pg.el('botaoEmpresa').focado, true);
  });
});
