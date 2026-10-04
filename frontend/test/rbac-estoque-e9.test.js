'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const EpiHttp = require('../js/api-http');
const P = require('../js/permissoes-efetivas');
const G = require('../js/grupo-permissoes');
const { ESCOPO_PROVISIONAMENTO_MASTER, RECURSOS_CONHECIDOS } = require('../../backend/src/rbac/recursos');

/**
 * E9 — RBAC das áreas de estoque no frontend: Validade (stockValidity) e
 * Operações (operations) abrem pela permissão própria; menus, Portal e
 * Dashboard seguem o que o servidor decidiu; a tela de Permissões do Grupo
 * só oferece o que tem efeito. A prova no servidor está em
 * backend/test/integracao/rbac-estoque-e9.integration.js.
 */

const BASE = 'http://localhost:3000/api';
const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const resposta = (status, corpo) => ({ status, ok: status >= 200 && status < 300, text: async () => (corpo === undefined ? '' : JSON.stringify(corpo)) });
const ATAQUE = '<img src=x onerror=alert(1)>';

const NENHUMA = { visualizar: false, criar: false, editar: false, excluir: false };
const SO_VER = { visualizar: true, criar: false, editar: false, excluir: false };
function permissoesCom(recursos, acoes = {}) {
  const todos = {};
  for (const r of RECURSOS_CONHECIDOS) todos[r] = { ...NENHUMA };
  const area = { consultar: false, alterar: false };
  const administracao = {
    gruposAcesso: area, permissoesGrupo: area, vinculosGrupo: area, usuarios: area, autorizacoesIndividuais: { consultar: true, concederDireta: false, delegar: false }, vinculosSst: area,
  };
  return { empresaId: 3, usuarioId: 7, perfil: 'USUARIO', recursos: { ...todos, ...recursos }, acoes, administracao };
}
const SO_MATERIALS = permissoesCom({ materials: SO_VER });
const SO_VALIDADE = permissoesCom({ stockValidity: SO_VER });
const SO_OPERACOES = permissoesCom({ operations: SO_VER });

const linkFalso = (pagina) => ({ style: { display: 'none' }, getAttribute: (k) => (k === 'data-pagina' ? pagina : null) });

describe('páginas, menus e Portal pela permissão própria', () => {
  test('Validade abre com stockValidity.visualizar e Operações com operations.visualizar; nenhuma depende de materials', () => {
    assert.deepEqual(P.PAGINAS.stockValidity, { abrir: [{ recurso: 'stockValidity', operacao: 'visualizar' }], alterar: [] });
    assert.deepEqual(P.PAGINAS.operations, { abrir: [{ recurso: 'operations', operacao: 'visualizar' }], alterar: [] });
  });

  test('só materials.visualizar: as duas áreas ficam fechadas; cada permissão abre só a sua', () => {
    assert.deepEqual([P.podeAbrir(SO_MATERIALS, 'stockValidity'), P.podeAbrir(SO_MATERIALS, 'operations'), P.podeAbrir(SO_MATERIALS, 'materials')], [false, false, true]);
    assert.deepEqual([P.podeAbrir(SO_VALIDADE, 'stockValidity'), P.podeAbrir(SO_VALIDADE, 'operations')], [true, false]);
    assert.deepEqual([P.podeAbrir(SO_OPERACOES, 'stockValidity'), P.podeAbrir(SO_OPERACOES, 'operations')], [false, true]);
  });

  test('15. menu: o link aparece só com a permissão da própria área', () => {
    const casos = [[SO_MATERIALS, ['', 'none', 'none']], [SO_VALIDADE, ['none', '', 'none']], [SO_OPERACOES, ['none', 'none', '']], [null, ['none', 'none', 'none']]];
    for (const [permissoes, esperado] of casos) {
      const links = ['materials', 'stockValidity', 'operations'].map(linkFalso);
      P.aplicarMenu(permissoes, links);
      assert.deepEqual(links.map((l) => l.style.display), esperado);
    }
  });

  test('13 e 14. Portal: os módulos Validade e Operações nascem ocultos e seguem a mesma regra do menu', () => {
    const inicio = ler('portal/inicio.html');
    const links = [...inicio.matchAll(/<a href="\.\.\/pages\/([^"]+)" data-pagina="([^"]+)" style="display:none">/g)].map((m) => ({ arquivo: m[1], pagina: m[2] }));
    assert.deepEqual(links.filter((l) => ['stockValidity', 'operations'].includes(l.pagina)), [
      { arquivo: 'stock-validity.html', pagina: 'stockValidity' }, { arquivo: 'operations.html', pagina: 'operations' },
    ]);
    const falsos = links.map((l) => linkFalso(l.pagina));
    P.aplicarMenu(SO_MATERIALS, falsos);
    const visiveis = links.filter((l, i) => falsos[i].style.display === '').map((l) => l.pagina);
    assert.deepEqual(visiveis.filter((pagina) => ['materials', 'stockValidity', 'operations'].includes(pagina)), ['materials']);
    assert.match(ler('portal/inicio.js'), /EpiPermissoes\.aplicarMenu\(p\.ok \? p\.permissoes : null, links\)/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// URL direta: a página consulta as permissões reais e não abre sem elas
// ═══════════════════════════════════════════════════════════════════
const CONTEXTO = { empresa: { id: 3, nome: 'Empresa' }, usuario: { id: 7, nome: 'Pessoa', perfil: 'USUARIO' } };

function abrirPagina(arquivo, globais, permissoes) {
  const chamadas = [];
  EpiHttp.configurar({
    baseUrl: BASE,
    fetch: async (url, opcoes) => {
      const u = new URL(url);
      chamadas.push(`${opcoes.method} ${u.pathname}`);
      if (u.pathname === '/api/auth/permissoes') return resposta(200, permissoes);
      return resposta(200, { status: 'ok', lotes: [], operacoes: [], indicadores: {}, total: 0, pagina: 1, limite: 50, paginas: 0 });
    },
  });
  const html = ler(arquivo);
  const script = html.slice(html.lastIndexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));
  const mapa = {};
  const el = (id) => (mapa[id] = mapa[id] || {
    id, value: '', textContent: '', innerHTML: '', disabled: false, style: {}, atributos: {}, listeners: {},
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    setAttribute(k, v) { this.atributos[k] = String(v); }, removeAttribute(k) { delete this.atributos[k]; }, focus() {},
  });
  const sandbox = {
    document: { getElementById: el, querySelectorAll: () => [] },
    window: { SAFEWORK_PORTAL_API_BASE_URL: BASE, location: { search: '' } },
    EpiHttp, EpiPermissoes: P,
    EpiSessaoEmpresarial: { montar: async () => CONTEXTO, sessaoEncerrada() {} },
    showToast() {}, console, Promise, String, Number, Array, Object, JSON, crypto: globalThis.crypto,
    ...globais,
  };
  vm.runInNewContext(script, sandbox);
  const esperar = async () => { for (let i = 0; i < 40; i += 1) await new Promise((r) => setImmediate(r)); };
  return { el, chamadas, esperar };
}

describe('12. URL direta não contorna o RBAC no frontend', () => {
  test('Validade de estoque com só materials.visualizar: aviso de acesso e nenhuma consulta de lotes', async () => {
    const pg = abrirPagina('pages/stock-validity.html', { EpiMateriais: require('../js/materiais'), EpiValidadeEstoque: require('../js/validade-estoque') }, SO_MATERIALS); // eslint-disable-line global-require
    await pg.esperar();
    assert.deepEqual(pg.chamadas, ['GET /api/auth/permissoes']);
    assert.match(pg.el('aviso').innerHTML, /não tem acesso a este módulo/);
  });

  test('Operações de estoque com só materials.visualizar: aviso de acesso e nenhuma consulta de operações', async () => {
    const pg = abrirPagina('pages/operations.html', { EpiOperacoesEstoque: require('../js/operacoes-estoque') }, SO_MATERIALS); // eslint-disable-line global-require
    await pg.esperar();
    assert.deepEqual(pg.chamadas, ['GET /api/auth/permissoes']);
    assert.match(pg.el('aviso').innerHTML, /não tem acesso a este módulo/);
  });

  test('com a permissão própria as páginas consultam; a Validade sem MOVIMENTAR_ESTOQUE não oferece baixa', async () => {
    const validade = abrirPagina('pages/stock-validity.html', { EpiMateriais: require('../js/materiais'), EpiValidadeEstoque: require('../js/validade-estoque') }, SO_VALIDADE); // eslint-disable-line global-require
    await validade.esperar();
    assert.deepEqual(validade.chamadas, ['GET /api/auth/permissoes', 'GET /api/estoque/validade']);
    const operacoes = abrirPagina('pages/operations.html', { EpiOperacoesEstoque: require('../js/operacoes-estoque') }, SO_OPERACOES); // eslint-disable-line global-require
    await operacoes.esperar();
    assert.deepEqual(operacoes.chamadas, ['GET /api/auth/permissoes', 'GET /api/estoque/operacoes']);
    const V = require('../js/validade-estoque'); // eslint-disable-line global-require
    const html = V.render.linhas([{ loteId: 1, material: 'Botina', fisico: 3, bloqueado: 3, situacaoCa: 'VENCIDO', materialAtivo: true }], { podeBaixar: P.acao(SO_VALIDADE, 'MOVIMENTAR_ESTOQUE') });
    assert.equal(/data-baixa-lote/.test(html), false);
  });
});

describe('18. Validade: lote de material inativo aparece identificado', () => {
  const V = require('../js/validade-estoque'); // eslint-disable-line global-require
  const lote = (extra) => ({ loteId: 5, material: 'Luva antiga', tamanho: 'M', caNumero: '123', caValidade: '2026-09-01', fisico: 4, bloqueado: 4, situacaoCa: 'VENCIDO', ...extra });

  test('material inativo leva a marca "Material inativo"; o ativo não; a baixa continua possível com permissão', () => {
    const inativo = V.render.linhas([lote({ materialAtivo: false })], { podeBaixar: true });
    assert.match(inativo, /<span class="tag-inativo">Material inativo<\/span>/);
    assert.match(inativo, /data-baixa-lote="5"/);
    assert.equal(/Material inativo/.test(V.render.linhas([lote({ materialAtivo: true })], { podeBaixar: true })), false);
  });

  test('o nome do material inativo continua escapado', () => {
    const html = V.render.linhas([lote({ material: ATAQUE, materialAtivo: false })], { podeBaixar: false });
    assert.equal(html.includes('<img'), false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Dashboard: o atalho para a Validade só existe com a permissão da Validade
// ═══════════════════════════════════════════════════════════════════
function abrirDashboard(indicadores) {
  EpiHttp.configurar({ baseUrl: BASE, fetch: async () => resposta(200, { status: 'ok', indicadores }) });
  const html = ler('pages/dashboard.html');
  const script = html.slice(html.lastIndexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));
  const mapa = {};
  const el = (id) => (mapa[id] = mapa[id] || {
    id, innerHTML: '', textContent: '', style: {}, listeners: {}, atributos: {},
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    setAttribute(k, v) { this.atributos[k] = String(v); }, removeAttribute(k) { delete this.atributos[k]; }, focus() {},
  });
  const sandbox = {
    document: { getElementById: el, querySelectorAll: () => [] },
    window: { SAFEWORK_PORTAL_API_BASE_URL: BASE },
    EpiHttp, EpiDashboard: require('../js/dashboard'), // eslint-disable-line global-require
    EpiPermissoes: { prepararPagina: async () => ({ permissoes: {}, podeAlterar: false }) },
    EpiSessaoEmpresarial: { montar: async () => ({ ...CONTEXTO, usuario: { ...CONTEXTO.usuario, email: 'p@exemplo-cliente.com.br' } }), sessaoEncerrada() {} },
    console, Promise, String, Number, Object, JSON,
  };
  vm.runInNewContext(script, sandbox);
  const esperar = async () => { for (let i = 0; i < 40; i += 1) await new Promise((r) => setImmediate(r)); };
  return { el, esperar };
}
const NEGADO = { permitido: false };

describe('22. Dashboard coerente com a Validade', () => {
  test('os atalhos do CA vencido nascem sem destino no HTML', () => {
    const html = ler('pages/dashboard.html');
    assert.match(html, /<a id="linkCaVencidos" class="kpi-link">/);
    assert.match(html, /<a id="linkCaAVencer" class="kpi-link">/);
    assert.equal(/class="kpi-link" href=/.test(html), false);
  });

  test('com o indicador liberado pelo servidor, os atalhos abrem a Validade filtrada', async () => {
    const pg = abrirDashboard({ itensDisponiveis: NEGADO, estoqueAbaixoMinimo: NEGADO, funcionariosAtivos: NEGADO, caVencido: { permitido: true, valor: 2, aVencer: 1, diasAlerta: 60 } });
    await pg.esperar();
    assert.equal(pg.el('linkCaVencidos').atributos.href, 'stock-validity.html?situacao=VENCIDO');
    assert.equal(pg.el('linkCaAVencer').atributos.href, 'stock-validity.html?situacao=VENCIMENTO_PROXIMO');
  });

  test('sem a permissão da Validade: nenhum atalho para uma página que não abriria', async () => {
    const pg = abrirDashboard({ itensDisponiveis: NEGADO, estoqueAbaixoMinimo: NEGADO, funcionariosAtivos: NEGADO, caVencido: NEGADO });
    await pg.esperar();
    assert.equal('href' in pg.el('linkCaVencidos').atributos, false);
    assert.equal('href' in pg.el('linkCaAVencer').atributos, false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Permissões do Grupo: só o que tem efeito real
// ═══════════════════════════════════════════════════════════════════
const PARA_FLAG = { visualizar: 'podeVisualizar', criar: 'podeCriar', editar: 'podeEditar', excluir: 'podeExcluir' };

describe('Permissões do Grupo sem controle decorativo', () => {
  const porId = Object.fromEntries(G.RECURSOS.map((r) => [r.id, r]));

  test('Validade e Operações de estoque oferecem só "Visualizar"; as outras operações aparecem como "não se aplica"', () => {
    for (const id of ['stockValidity', 'operations']) {
      assert.deepEqual(porId[id].operacoes, ['podeVisualizar'], id);
      const html = G.render.linhaRecurso(porId[id], null);
      assert.equal((html.match(/<select/g) || []).length, 1, id);
      assert.match(html, /data-campo="podeVisualizar"/);
      assert.equal((html.match(/class="nao-se-aplica"/g) || []).length, 3, id);
      assert.match(html, /data-acao="salvar-recurso"/);
    }
    assert.equal(porId.stockValidity.nome, 'Validade de estoque');
    assert.equal(porId.operations.nome, 'Operações de estoque');
  });

  // 12G-1: `request` é exigido pelas rotas da solicitação (minhas = visualizar,
  // criar, cancelar = editar), mas fica fora do escopo do MASTER (12E/12F): só
  // vale o que for concedido por perfil, grupo ou exceção individual.
  const FORA_DO_ESCOPO_DO_MASTER = { request: ['podeVisualizar', 'podeCriar', 'podeEditar'] };

  test('cada operação oferecida na tela é exatamente uma que alguma rota do servidor exige (o escopo do MASTER e o request, concedido explicitamente)', () => {
    const escopo = {
      ...Object.fromEntries(ESCOPO_PROVISIONAMENTO_MASTER.recursos.map((r) => [r.recurso, r.operacoes.map((o) => PARA_FLAG[o])])),
      ...FORA_DO_ESCOPO_DO_MASTER,
    };
    for (const recurso of G.RECURSOS) {
      assert.deepEqual(recurso.operacoes, escopo[recurso.id] || [], recurso.id);
    }
    for (const id of Object.keys(escopo)) assert.ok(porId[id], `${id} precisa estar na tela`);
    assert.equal(ESCOPO_PROVISIONAMENTO_MASTER.recursos.some((r) => Object.hasOwn(FORA_DO_ESCOPO_DO_MASTER, r.recurso)), false, 'o MASTER não recebe request automaticamente');
  });

  test('GHE e EPIs (employeeGroups) entra na tela: o servidor já protege o GHE com ele', () => {
    assert.deepEqual(porId.employeeGroups, { id: 'employeeGroups', nome: 'GHE e EPIs', operacoes: ['podeVisualizar', 'podeCriar', 'podeEditar'] });
    assert.deepEqual(G.RECURSOS.map((r) => r.id).sort(), [...RECURSOS_CONHECIDOS].sort());
  });

  test('página ainda sem efeito não mostra seletor nem "Salvar": mostra o motivo', () => {
    for (const id of ['reports', 'purchases', 'config']) {
      const html = G.render.linhaRecurso(porId[id], { podeVisualizar: true });
      assert.equal(/<select|data-acao=/.test(html), false, id);
      assert.match(html, /Em integração: ainda sem efeito/, id);
    }
    const importar = G.render.linhaRecurso(porId.importEmployees, null);
    assert.equal(/<select|data-acao=/.test(importar), false);
    assert.match(importar, /Controlado pela permissão Criar de Histórico de Funcionários/);
  });

  test('recurso sem lista de operações continua com as quatro (compatível com a tela atual) e o HTML segue escapado', () => {
    assert.equal((G.render.linhaRecurso({ id: 'materials', nome: 'Materiais' }, null).match(/<select/g) || []).length, 4);
    const html = G.render.linhaRecurso({ id: ATAQUE, nome: ATAQUE, operacoes: [], nota: ATAQUE }, null);
    assert.equal(html.includes('<img'), false);
  });
});
