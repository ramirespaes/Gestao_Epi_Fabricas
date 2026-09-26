'use strict';

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const EpiHttp = require('../js/api-http');
const P = require('../js/permissoes-efetivas');
require('../js/materiais'); // regra de situação do estoque (C2), reutilizada

/**
 * Itens Disponíveis (Bloco 9, Etapa C, Parte C3): módulo
 * js/itens-disponiveis.js com `fetch` injetado, entrada `availableItems`
 * no mapa de páginas, inspeção estática de pages/available-items.html e
 * comportamento da página sobre um DOM simulado. Somente leitura.
 */

const BASE = 'http://localhost:3000/api';
const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const semComentarios = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const modulo = () => require('../js/itens-disponiveis'); // eslint-disable-line global-require
const resposta = (status, corpo) => ({ status, ok: status >= 200 && status < 300, text: async () => (corpo === undefined ? '' : JSON.stringify(corpo)) });

const item = (extra = {}) => ({
  materialId: 1, material: 'Botina de segurança', codigoInterno: 'EPI-001', categoria: 'EPI', tipo: 'Sapatão / Botina',
  tamanho: '40', saldo: 12, disponivel: 12, unidade: 'par', estoqueMinimo: 5, caValidade: '2027-01-31', validade: 'ok', ...extra,
});
const pagina = (itens, extra = {}) => ({ status: 'ok', itens, total: itens.length, pagina: 1, limite: 50, filtros: { categorias: ['EPI'], tipos: ['Sapatão / Botina'], tamanhos: ['40'] }, ...extra });

let chamadas;
function servidor(responder) {
  chamadas = [];
  EpiHttp.configurar({
    baseUrl: BASE,
    fetch: async (url, opcoes) => {
      const u = new URL(url);
      chamadas.push({ metodo: opcoes.method, caminho: u.pathname + u.search });
      const r = typeof responder === 'function' ? responder(u) : responder;
      if (r instanceof Error) throw r;
      return r;
    },
  });
}
beforeEach(() => servidor(resposta(200, pagina([item()]))));

describe('acoes: GET /estoque/itens-disponiveis', () => {
  test('sem filtros: só página e limite; nunca empresaId', async () => {
    const r = await modulo().acoes.listar({});
    assert.equal(r.ok, true);
    assert.deepEqual(chamadas.map((c) => c.caminho), ['/api/estoque/itens-disponiveis?pagina=1&limite=50']);
  });

  test('com filtros: só os preenchidos, codificados; valores "Todos" (vazios) são omitidos', async () => {
    await modulo().acoes.listar({ categoria: 'EPI', tipo: 'Sapatão / Botina', tamanho: 'Único', validade: 'expiring', pagina: 2, limite: 20 });
    assert.equal(chamadas[0].caminho, '/api/estoque/itens-disponiveis?categoria=EPI&tipo=Sapat%C3%A3o%20%2F%20Botina&tamanho=%C3%9Anico&validade=expiring&pagina=2&limite=20');
    await modulo().acoes.listar({ categoria: '', tipo: '', tamanho: '', validade: '' });
    assert.equal(chamadas[1].caminho, '/api/estoque/itens-disponiveis?pagina=1&limite=50');
    assert.equal(chamadas.some((c) => /empresaId|usuarioId/.test(c.caminho)), false);
  });

  test('listarTodos (exportação): páginas de 100 até o total, com os mesmos filtros; falha em qualquer página devolve a falha', async () => {
    const todos = Array.from({ length: 230 }, (_, i) => item({ materialId: i + 1, tamanho: String(i) }));
    servidor((u) => {
      const p = Number(u.searchParams.get('pagina')); const l = Number(u.searchParams.get('limite'));
      return resposta(200, pagina(todos.slice((p - 1) * l, p * l), { total: todos.length, pagina: p, limite: l }));
    });
    const r = await modulo().acoes.listarTodos({ categoria: 'EPI' });
    assert.deepEqual([r.ok, r.dados.itens.length, r.dados.total, r.dados.completo], [true, 230, 230, true]);
    assert.deepEqual(chamadas.map((c) => c.caminho), [1, 2, 3].map((p) => `/api/estoque/itens-disponiveis?categoria=EPI&pagina=${p}&limite=100`));

    servidor((u) => (u.searchParams.get('pagina') === '2' ? resposta(500, { status: 'erro', codigo: 'ERRO_INTERNO' }) : resposta(200, pagina(todos.slice(0, 100), { total: 230 }))));
    const falha = await modulo().acoes.listarTodos({});
    assert.deepEqual([falha.ok, falha.status], [false, 500]);
  });
});

describe('render: tabela com as sete colunas originais', () => {
  test('linha: categoria, tipo, material (com código interno), tamanho, quantidade disponível, unidade, status — tudo escapado', () => {
    const html = modulo().render.linhas([item({ material: '<b>x</b>', codigoInterno: 'C&D' })]);
    const tds = [...html.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
    assert.equal(tds.length, 7);
    assert.equal(tds[0], 'EPI');
    assert.equal(tds[1], 'Sapatão / Botina');
    assert.match(tds[2], /^&lt;b&gt;x&lt;\/b&gt;/);
    assert.match(tds[2], /C&amp;D/);
    assert.deepEqual([tds[3], tds[4], tds[5]], ['40', '12', 'Par']);
    assert.match(tds[6], /<span class="badge status-active">Disponível<\/span>/);
  });

  test('status pela regra da C2 (reutilizada): 0 → Sem estoque; abaixo do mínimo → Baixo; demais → Disponível; usa disponivel, não outro campo', () => {
    const { render } = modulo();
    assert.match(render.linhas([item({ saldo: 0, disponivel: 0 })]), /badge status-inactive">Sem estoque/);
    assert.match(render.linhas([item({ saldo: 3, disponivel: 3 })]), /badge role-supervisor">Baixo/);
    assert.match(render.linhas([item({ saldo: 5, disponivel: 5 })]), /badge status-active">Disponível/);
    assert.match(render.linhas([item({ saldo: 1, disponivel: 1, estoqueMinimo: 0 })]), /Disponível/);
    assert.match(render.linhas([item({ categoria: null, tipo: null, codigoInterno: null })]), /<td>—<\/td><td>—<\/td>/);
  });

  test('opções dos filtros: rótulo "Todos/Todas" com valor vazio primeiro, valores reais escapados, seleção preservada quando ainda existe', () => {
    const { render } = modulo();
    const html = render.opcoes(['EPI', 'A"B'], 'Todas', 'EPI');
    assert.equal(html, '<option value="">Todas</option><option value="EPI" selected>EPI</option><option value="A&quot;B">A&quot;B</option>');
    assert.equal(render.opcoes([], 'Todos', 'X'), '<option value="">Todos</option>');
  });

  test('paginação: texto e limites', () => {
    const { render } = modulo();
    assert.deepEqual(render.paginacao(120, 1, 50), { texto: 'Itens 1–50 de 120 · página 1 de 3', anterior: false, proxima: true });
    assert.deepEqual(render.paginacao(120, 3, 50), { texto: 'Itens 101–120 de 120 · página 3 de 3', anterior: true, proxima: false });
    assert.deepEqual(render.paginacao(0, 1, 50), { texto: 'Nenhum item', anterior: false, proxima: false });
  });

  test('estado vazio distinto de falha; com filtros a mensagem sugere Limpar', () => {
    const { render, mensagens } = modulo();
    assert.match(render.estado('Nenhum item'), /<tr><td colspan="7"[^>]*>Nenhum item<\/td><\/tr>/);
    assert.match(mensagens.vazio(false), /Nenhum material ativo com tamanho cadastrado nesta empresa/);
    assert.match(mensagens.vazio(true), /Limpar/);
    assert.match(mensagens.erroConsulta({ ok: false, status: 0 }), /rede/i);
    assert.match(mensagens.erroConsulta({ ok: false, status: 403, codigo: 'PERMISSAO_NEGADA' }), /não pode consultar os itens disponíveis/i);
    assert.match(mensagens.erroConsulta({ ok: false, status: 400, codigo: 'VALIDACAO' }), /filtros/i);
    assert.match(mensagens.erroConsulta({ ok: false, status: 503 }), /Não foi possível consultar/i);
    assert.equal(mensagens.exigeNovoLogin({ status: 401 }), true);
  });
});

describe('csv: exportação com as sete colunas', () => {
  test('cabeçalho e linhas correspondem à tabela; BOM; aspas; fórmulas neutralizadas', () => {
    const { csv } = modulo();
    const texto = csv.gerar([item(), item({ material: '=HYPERLINK("x")', tamanho: '41', saldo: 3, disponivel: 3, codigoInterno: null }), item({ tamanho: '42', saldo: 0, disponivel: 0 })]);
    assert.equal(texto.charCodeAt(0), 0xFEFF);
    const linhas = texto.slice(1).split('\r\n');
    assert.equal(linhas[0], '"Categoria";"Tipo";"Material";"Tamanho";"Quantidade disponível";"Unidade";"Status"');
    assert.equal(linhas[1], '"EPI";"Sapatão / Botina";"Botina de segurança (EPI-001)";"40";"12";"Par";"Disponível"');
    assert.equal(linhas[2], '"EPI";"Sapatão / Botina";"\'=HYPERLINK(""x"")";"41";"3";"Par";"Baixo"');
    assert.equal(linhas[3], '"EPI";"Sapatão / Botina";"Botina de segurança (EPI-001)";"42";"0";"Par";"Sem estoque"');
    assert.equal(linhas.length, 4);
    assert.equal(csv.NOME_ARQUIVO, 'itens_disponiveis.csv');
  });
});

describe('permissões: availableItems independente de materials', () => {
  const p = (itens, materials) => ({ recursos: { availableItems: { visualizar: itens, criar: false, editar: false, excluir: false }, materials: { visualizar: materials, criar: materials, editar: false, excluir: false } }, acoes: {}, administracao: {} });
  test('abrir exige availableItems.visualizar; materials não basta; página somente leitura', () => {
    assert.deepEqual(P.PAGINAS.availableItems, { abrir: [{ recurso: 'availableItems', operacao: 'visualizar' }], alterar: [] });
    assert.equal(P.podeAbrir(p(true, false), 'availableItems'), true);
    assert.equal(P.podeAbrir(p(false, true), 'availableItems'), false);
    assert.equal(P.podeAlterar(p(true, true), 'availableItems'), false);
    assert.equal(P.podeAbrir(p(true, false), 'materials'), false, 'o inverso também vale');
  });
});

describe('inspeção estática: pages/available-items.html integrada, interface original preservada', () => {
  const html = ler('pages/available-items.html');
  const codigo = semComentarios(html);
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);

  test('sessão real (C0/C1); sem protótipo: login simulado, quiosque, xlsx, db-api, main.js, Cobresul, armazenamento local, funções de itens entregues', () => {
    for (const proibido of [/loginScreen/, /doLogin/, /biometric/i, /kiosk/i, /db-api\.js/, /main\.js/, /xlsx/, /Cobresul/i, /localStorage/, /sessionStorage/, /document\.cookie/,
      /renderDeliveredTable/, /clearDeliveredFilters/, /exportAvailableItems/, /showView\(/, /setActiveNav/, /data-page=/, /_s=/, /localhost:3000/]) {
      assert.equal(proibido.test(codigo), false, `available-items.html contém ${proibido}`);
    }
    const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
    assert.deepEqual(scripts, ['../js/api-http.js', '../portal/config.js', '../js/sessao-empresarial.js', '../js/permissoes-efetivas.js', '../js/pagina-base.js', '../js/materiais.js', '../js/itens-disponiveis.js']);
    assert.match(codigo, /EpiSessaoEmpresarial\.montar\(/);
    assert.match(codigo, /EpiPermissoes\.prepararPagina\(\{\s*pagina: 'availableItems'/);
    assert.match(codigo, /aoFalharSaida: function \(mensagem\) \{ mostrarAviso\(mensagem, 'erro'\); \}/);
    for (const id of ['telaSessao', 'telaSessaoMensagem', 'telaSessaoPortal', 'identidade', 'botaoSair', 'botaoTrocarEmpresa', 'aviso']) assert.ok(ids.includes(id), id);
  });

  test('filtros, botões, tabela e exportação originais preservados; linhas fictícias removidas; paginação acrescentada', () => {
    for (const id of ['availableItemsView', 'availableCategory', 'availableType', 'availableSize', 'deliveredStatus', 'botaoLimpar', 'botaoFiltrar', 'botaoExportar', 'itensDisponiveisCorpo', 'paginaAnterior', 'paginacaoTexto', 'paginaProxima']) {
      assert.ok(ids.includes(id), `falta #${id}`);
    }
    for (const th of ['Categoria', 'Tipo', 'Material', 'Tamanho', 'Quantidade disponível', 'Unidade', 'Status']) assert.match(html, new RegExp(`<th>${th}</th>`));
    assert.match(html, /<option value="">Todas<\/option>/);
    assert.match(html, /<option value="ok">Dentro do prazo<\/option>/);
    assert.match(html, /<option value="expiring">Próximo do vencimento<\/option>/);
    assert.match(html, /<option value="expired">Vencido<\/option>/);
    assert.match(html, /Exportar itens disponíveis/);
    assert.match(html, /<tbody id="itensDisponiveisCorpo"><\/tbody>/);
    for (const ficticio of ['Botina de segurança', 'Óculos incolor antiembaçante', 'Camiseta manga longa', 'Luva nitrílica', 'Protetor auricular silicone', 'Roupa</option>']) {
      assert.equal(html.includes(ficticio), false, `dado fictício: ${ficticio}`);
    }
    assert.match(html, /Validade do CA/i, 'rótulo esclarece que a validade é a do CA');
  });

  test('menu: estrutura preservada; Itens Disponíveis ativo; integrados por permissão; demais sem link', () => {
    const links = [...html.matchAll(/<a [^>]*data-pagina="([^"]+)"[^>]*>/g)];
    assert.deepEqual(links.map((m) => m[1]).sort(), ['autorizacoes-individuais', 'availableItems', 'dashboard', 'employeeGroups', 'employeeHistory', 'grupo-permissoes', 'grupo-usuarios', 'grupos-acesso', 'importEmployees', 'materials']);
    for (const m of links) assert.match(m[0], /style="display:none"/);
    assert.match(html, /<a class="active" href="javascript:void\(0\)" data-pagina="availableItems"/);
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]).filter((h) => !h.startsWith('http') && !h.startsWith('../css/') && h !== 'javascript:void(0)');
    const permitidos = new Set(['materials.html', 'dashboard.html', 'employee-groups.html', 'employee-history.html', 'import-employees.html', 'grupos-acesso.html', 'grupo-permissoes.html', 'grupo-usuarios.html', 'autorizacoes-individuais.html', '../portal/index.html', '../portal/inicio.html']);
    for (const h of hrefs) assert.ok(permitidos.has(h), h);
    // 20 na C3; a C4 integrou Histórico e Importar Funcionários (D9): restam 18.
    assert.ok([...html.matchAll(/<a class="nav-pendente"/g)].length >= 17); // C6: Dashboard integrado
  });

  test('materials.html e o início do Portal passam a oferecer Itens Disponíveis (ocultos até a permissão)', () => {
    assert.match(ler('pages/materials.html'), /<a href="available-items\.html" data-pagina="availableItems" style="display:none"><div class="nav-icon green">checklist<\/div>Itens Disponíveis<\/a>/);
    assert.match(ler('portal/inicio.html'), /<a href="\.\.\/pages\/available-items\.html" data-pagina="availableItems" style="display:none">Itens disponíveis<\/a>/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Página em DOM simulado: o script embutido de available-items.html
// ═══════════════════════════════════════════════════════════════════
const PERMISSOES_OK = { recursos: { availableItems: { visualizar: true, criar: false, editar: false, excluir: false } }, acoes: {}, administracao: {} };
const CONTEXTO = { empresa: { id: 3, nome: 'Empresa Demonstração SafeWork' }, usuario: { id: 7, nome: 'Pessoa', email: 'p@exemplo-cliente.com.br', perfil: 'MASTER' } };

function montarPagina(responder, { acesso = { permissoes: PERMISSOES_OK, podeAlterar: false } } = {}) {
  servidor(responder);
  const html = ler('pages/available-items.html');
  const script = html.slice(html.lastIndexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));
  const SELECTS = new Set(['availableCategory', 'availableType', 'availableSize', 'deliveredStatus']);
  const mapa = {};
  const el = (id) => (mapa[id] = mapa[id] || {
    id, value: '', innerHTML: '', textContent: '', disabled: false, style: {}, listeners: {}, tagName: SELECTS.has(id) ? 'SELECT' : 'DIV',
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
  });
  const downloads = [];
  const sandbox = {
    document: {
      getElementById: el, querySelectorAll: () => [],
      createElement: () => ({ click() { downloads.push({ nome: this.download, href: this.href }); }, remove() {} }),
      body: { appendChild() {} },
    },
    window: { SAFEWORK_PORTAL_API_BASE_URL: BASE },
    URL: { createObjectURL: (b) => { downloads.push({ blob: b }); return 'blob:x'; }, revokeObjectURL() {} },
    Blob: class { constructor(partes, opcoes) { this.partes = partes; this.tipo = opcoes && opcoes.type; } },
    EpiHttp, EpiMateriais: globalThis.EpiMateriais, EpiItensDisponiveis: modulo(),
    EpiPermissoes: { prepararPagina: async () => acesso },
    EpiSessaoEmpresarial: { montar: async (o) => { sandbox.opcoesMontar = o; return CONTEXTO; }, sessaoEncerrada() { sandbox.encerrada = true; } },
    console, setTimeout, Promise, String, Number, Array, Object, JSON,
  };
  vm.runInNewContext(script, sandbox);
  const esperar = async () => { for (let i = 0; i < 40; i += 1) await new Promise((r) => setImmediate(r)); };
  const clicar = async (id) => { for (const fn of (el(id).listeners.click || [])) await fn(); await esperar(); };
  const disparar = (id) => { for (const fn of (el(id).listeners.click || [])) fn(); }; // sem aguardar a resposta
  return { el, sandbox, esperar, clicar, disparar, downloads };
}

describe('página (DOM simulado)', () => {
  test('ao abrir: consulta sem filtros, preenche as opções reais dos filtros e a tabela; paginação atualizada', async () => {
    const pg = montarPagina(resposta(200, pagina([item(), item({ tamanho: '41', saldo: 0, disponivel: 0 })], { total: 2, filtros: { categorias: ['EPI', 'Uniforme'], tipos: ['Luva'], tamanhos: ['40', '41'] } })));
    await pg.esperar();
    assert.deepEqual(chamadas.map((c) => c.caminho), ['/api/estoque/itens-disponiveis?pagina=1&limite=50']);
    assert.equal(pg.el('availableCategory').innerHTML, '<option value="">Todas</option><option value="EPI">EPI</option><option value="Uniforme">Uniforme</option>');
    assert.equal(pg.el('availableType').innerHTML, '<option value="">Todos</option><option value="Luva">Luva</option>');
    assert.equal(pg.el('availableSize').innerHTML, '<option value="">Todos</option><option value="40">40</option><option value="41">41</option>');
    assert.equal((pg.el('itensDisponiveisCorpo').innerHTML.match(/<tr>/g) || []).length, 2);
    assert.match(pg.el('itensDisponiveisCorpo').innerHTML, /Sem estoque/);
    assert.equal(pg.el('paginacaoTexto').textContent, 'Itens 1–2 de 2 · página 1 de 1');
    assert.deepEqual([pg.el('paginaAnterior').disabled, pg.el('paginaProxima').disabled], [true, true]);
  });

  test('Filtrar envia os quatro filtros na página 1; Limpar zera e consulta de novo sem filtros', async () => {
    const pg = montarPagina(resposta(200, pagina([item()])));
    await pg.esperar();
    Object.assign(pg.el('availableCategory'), { value: 'EPI' }); Object.assign(pg.el('availableType'), { value: 'Luva' });
    Object.assign(pg.el('availableSize'), { value: 'M' }); Object.assign(pg.el('deliveredStatus'), { value: 'expired' });
    await pg.clicar('botaoFiltrar');
    assert.equal(chamadas.at(-1).caminho, '/api/estoque/itens-disponiveis?categoria=EPI&tipo=Luva&tamanho=M&validade=expired&pagina=1&limite=50');
    await pg.clicar('botaoLimpar');
    assert.deepEqual(['availableCategory', 'availableType', 'availableSize', 'deliveredStatus'].map((id) => pg.el(id).value), ['', '', '', '']);
    assert.equal(chamadas.at(-1).caminho, '/api/estoque/itens-disponiveis?pagina=1&limite=50');
  });

  test('paginação: Próxima e Anterior mantêm os filtros aplicados', async () => {
    const pg = montarPagina((u) => resposta(200, pagina([item()], { total: 120, pagina: Number(u.searchParams.get('pagina')), limite: 50 })));
    await pg.esperar();
    Object.assign(pg.el('availableCategory'), { value: 'EPI' });
    await pg.clicar('botaoFiltrar');
    await pg.clicar('paginaProxima');
    assert.equal(chamadas.at(-1).caminho, '/api/estoque/itens-disponiveis?categoria=EPI&pagina=2&limite=50');
    assert.equal(pg.el('paginacaoTexto').textContent, 'Itens 51–51 de 120 · página 2 de 3');
    await pg.clicar('paginaAnterior');
    assert.equal(chamadas.at(-1).caminho, '/api/estoque/itens-disponiveis?categoria=EPI&pagina=1&limite=50');
  });

  test('estado vazio real (sem linhas fictícias) e vazio com filtros', async () => {
    const pg = montarPagina(resposta(200, pagina([], { total: 0, filtros: { categorias: [], tipos: [], tamanhos: [] } })));
    await pg.esperar();
    assert.match(pg.el('itensDisponiveisCorpo').innerHTML, /Nenhum material ativo com tamanho cadastrado nesta empresa/);
    Object.assign(pg.el('availableType'), { value: 'Luva' });
    await pg.clicar('botaoFiltrar');
    assert.match(pg.el('itensDisponiveisCorpo').innerHTML, /Limpar/);
  });

  test('falha de rede e 5xx: estado de falha na tabela e aviso, nunca "vazio"; 401 devolve ao Portal', async () => {
    const rede = montarPagina(new TypeError('Failed to fetch'));
    await rede.esperar();
    assert.match(rede.el('itensDisponiveisCorpo').innerHTML, /rede/i);
    assert.equal(/Nenhum material/.test(rede.el('itensDisponiveisCorpo').innerHTML), false);
    const erro = montarPagina(resposta(503, { status: 'erro', codigo: 'INDISPONIVEL' }));
    await erro.esperar();
    assert.match(erro.el('itensDisponiveisCorpo').innerHTML, /Não foi possível consultar/);
    const sessao = montarPagina(resposta(401, { status: 'erro', codigo: 'SESSAO_INVALIDA' }));
    await sessao.esperar();
    assert.equal(sessao.sandbox.encerrada, true);
  });

  test('sem permissão na página: nada é consultado', async () => {
    const pg = montarPagina(resposta(200, pagina([item()])), { acesso: null });
    await pg.esperar();
    assert.deepEqual(chamadas, []);
  });

  test('Exportar: busca TODAS as páginas do filtro aplicado e baixa itens_disponiveis.csv com as sete colunas', async () => {
    const todos = Array.from({ length: 150 }, (_, i) => item({ tamanho: String(i) }));
    const pg = montarPagina((u) => {
      const p = Number(u.searchParams.get('pagina')); const l = Number(u.searchParams.get('limite'));
      return resposta(200, pagina(todos.slice((p - 1) * l, p * l), { total: 150, pagina: p, limite: l }));
    });
    await pg.esperar();
    Object.assign(pg.el('availableCategory'), { value: 'EPI' });
    await pg.clicar('botaoFiltrar');
    await pg.clicar('botaoExportar');
    assert.deepEqual(chamadas.slice(-2).map((c) => c.caminho), ['/api/estoque/itens-disponiveis?categoria=EPI&pagina=1&limite=100', '/api/estoque/itens-disponiveis?categoria=EPI&pagina=2&limite=100']);
    const blob = pg.downloads.find((d) => d.blob).blob;
    const texto = blob.partes.join('');
    assert.equal(texto.slice(1).split('\r\n').length, 151);
    assert.match(texto, /"Quantidade disponível";"Unidade";"Status"/);
    assert.equal(pg.downloads.find((d) => d.nome).nome, 'itens_disponiveis.csv');
  });

  test('Exportar com falha: nenhum arquivo e aviso de erro', async () => {
    let n = 0;
    const pg = montarPagina(() => { n += 1; return n === 1 ? resposta(200, pagina([item()])) : resposta(500, { status: 'erro' }); });
    await pg.esperar();
    await pg.clicar('botaoExportar');
    assert.equal(pg.downloads.length, 0);
    assert.match(pg.el('aviso').innerHTML, /Não foi possível consultar/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Ajustes da auditoria da C3 (25/09/2026): consultas assíncronas e
// exportação acima do limite suportado.
// ═══════════════════════════════════════════════════════════════════

/** Servidor com respostas controladas: cada requisição fica pendente até ser resolvida pelo teste. */
function servidorControlado() {
  const pendentes = [];
  const responder = (u) => new Promise((resolve) => { pendentes.push({ caminho: u.pathname + u.search, resolver: (corpo) => resolve(resposta(200, corpo)) }); });
  return { pendentes, responder };
}
const linhasDe = (pg) => (pg.el('itensDisponiveisCorpo').innerHTML.match(/<tr>/g) || []).length;

describe('ajuste 1 — uma resposta antiga nunca substitui a consulta mais recente', () => {
  test('Filtrar seguido rapidamente de Limpar: a resposta atrasada do Filtrar é descartada', async () => {
    const srv = servidorControlado();
    const pg = montarPagina(srv.responder);
    await pg.esperar();
    srv.pendentes.shift().resolver(pagina([item()]));                       // carga inicial
    await pg.esperar();
    Object.assign(pg.el('availableType'), { value: 'Luva' });
    pg.disparar('botaoFiltrar');                                           // consulta A (filtrada), pendente
    pg.disparar('botaoLimpar');                                            // consulta B (sem filtros), pendente
    await pg.esperar();
    const [a, b] = srv.pendentes.splice(0);
    assert.match(a.caminho, /tipo=Luva/);
    assert.doesNotMatch(b.caminho, /tipo=/);
    b.resolver(pagina([item(), item({ tamanho: '41' }), item({ tamanho: '42' })], { total: 3 }));
    await pg.esperar();
    a.resolver(pagina([item({ material: 'RESPOSTA ANTIGA' })], { total: 1, filtros: { categorias: ['VELHA'], tipos: [], tamanhos: [] } }));
    await pg.esperar();
    assert.equal(linhasDe(pg), 3, 'a tabela continua com o resultado de Limpar');
    assert.doesNotMatch(pg.el('itensDisponiveisCorpo').innerHTML, /RESPOSTA ANTIGA/);
    assert.doesNotMatch(pg.el('availableCategory').innerHTML, /VELHA/);
    assert.equal(pg.el('paginacaoTexto').textContent, 'Itens 1–3 de 3 · página 1 de 1');
  });

  test('troca rápida de páginas com respostas fora de ordem: vale a última página pedida', async () => {
    const srv = servidorControlado();
    const pg = montarPagina(srv.responder);
    await pg.esperar();
    srv.pendentes.shift().resolver(pagina([item()], { total: 200 }));
    await pg.esperar();
    pg.disparar('paginaProxima');                                          // página 2
    pg.disparar('paginaProxima');                                          // página 3
    await pg.esperar();
    const [p2, p3] = srv.pendentes.splice(0);
    assert.match(p2.caminho, /pagina=2/);
    assert.match(p3.caminho, /pagina=3/);
    p3.resolver(pagina([item({ material: 'PAGINA 3' })], { total: 200, pagina: 3 }));
    await pg.esperar();
    p2.resolver(pagina([item({ material: 'PAGINA 2' })], { total: 200, pagina: 2 }));
    await pg.esperar();
    assert.match(pg.el('itensDisponiveisCorpo').innerHTML, /PAGINA 3/);
    assert.doesNotMatch(pg.el('itensDisponiveisCorpo').innerHTML, /PAGINA 2/);
    assert.match(pg.el('paginacaoTexto').textContent, /página 3 de 4/);
  });

  test('duas consultas com respostas fora de ordem: nem a tabela, nem os filtros, nem a paginação voltam ao estado antigo', async () => {
    const srv = servidorControlado();
    const pg = montarPagina(srv.responder);
    await pg.esperar();
    srv.pendentes.shift().resolver(pagina([item()]));
    await pg.esperar();
    Object.assign(pg.el('availableCategory'), { value: 'EPI' });
    pg.disparar('botaoFiltrar');
    Object.assign(pg.el('availableCategory'), { value: 'Uniforme' });
    pg.disparar('botaoFiltrar');
    await pg.esperar();
    const [epi, uniforme] = srv.pendentes.splice(0);
    uniforme.resolver(pagina([], { total: 0, filtros: { categorias: ['EPI', 'Uniforme'], tipos: [], tamanhos: [] } }));
    await pg.esperar();
    epi.resolver(pagina([item(), item({ tamanho: '41' })], { total: 2, filtros: { categorias: ['SÓ-ANTIGA'], tipos: [], tamanhos: [] } }));
    await pg.esperar();
    assert.match(pg.el('itensDisponiveisCorpo').innerHTML, /Limpar/, 'continua o vazio da consulta mais recente');
    assert.doesNotMatch(pg.el('availableCategory').innerHTML, /SÓ-ANTIGA/);
    assert.equal(pg.el('paginacaoTexto').textContent, 'Nenhum item');
  });

  test('consulta pendente durante o logout: a resposta que chega depois não restaura dados na tabela', async () => {
    const srv = servidorControlado();
    const pg = montarPagina(srv.responder);
    await pg.esperar();
    srv.pendentes.shift().resolver(pagina([item()]));
    await pg.esperar();
    pg.disparar('paginaProxima');                                          // consulta pendente
    await pg.esperar();
    pg.sandbox.opcoesMontar.aoEncerrar();                                  // saída confirmada (ou restauração com sessão encerrada)
    assert.equal(pg.el('itensDisponiveisCorpo').innerHTML, '');
    srv.pendentes.shift().resolver(pagina([item({ material: 'DADO APÓS LOGOUT' })], { total: 2, pagina: 2 }));
    await pg.esperar();
    assert.equal(pg.el('itensDisponiveisCorpo').innerHTML, '', 'nada volta para a tela');
    assert.doesNotMatch(pg.el('availableCategory').innerHTML, /EPI/);
    assert.equal(pg.el('paginacaoTexto').textContent, '—');
  });

  test('exportação pendente durante o logout: nenhum arquivo é gerado', async () => {
    const srv = servidorControlado();
    const pg = montarPagina(srv.responder);
    await pg.esperar();
    srv.pendentes.shift().resolver(pagina([item()]));
    await pg.esperar();
    pg.disparar('botaoExportar');
    await pg.esperar();
    pg.sandbox.opcoesMontar.aoEncerrar();
    srv.pendentes.shift().resolver(pagina([item()], { total: 1, limite: 100 }));
    await pg.esperar();
    assert.equal(pg.downloads.length, 0);
  });
});

describe('ajuste 2 — exportação acima do limite suportado não gera CSV parcial', () => {
  test('módulo: mais de 10.000 registros → recusa na primeira página, sem buscar as demais, motivo próprio', async () => {
    servidor((u) => resposta(200, pagina([item()], { total: 10001, pagina: Number(u.searchParams.get('pagina')), limite: 100 })));
    const r = await modulo().acoes.listarTodos({ categoria: 'EPI' });
    assert.deepEqual([r.ok, r.motivo, r.total, r.limite], [false, 'LIMITE_EXPORTACAO', 10001, 10000]);
    assert.equal(chamadas.length, 1, 'nenhuma página além da primeira');
    assert.equal(modulo().acoes.LIMITE_EXPORTACAO, 10000);
    const msg = modulo().mensagens.erroExportacao(r);
    assert.match(msg, /10\.001/);
    assert.match(msg, /10\.000/);
    assert.match(msg, /filtros/i);
  });

  test('módulo: exatamente 10.000 registros exporta completo (100 páginas de 100)', async () => {
    const lote = Array.from({ length: 100 }, () => item());
    servidor((u) => resposta(200, pagina(lote, { total: 10000, pagina: Number(u.searchParams.get('pagina')), limite: 100 })));
    const r = await modulo().acoes.listarTodos({});
    assert.deepEqual([r.ok, r.dados.itens.length, r.dados.completo], [true, 10000, true]);
    assert.equal(chamadas.length, 100);
  });

  test('módulo: dados que mudam durante a exportação (página vazia antes do total) → recusa, nunca CSV parcial', async () => {
    servidor((u) => resposta(200, pagina(u.searchParams.get('pagina') === '1' ? Array.from({ length: 100 }, () => item()) : [], { total: 150, limite: 100 })));
    const r = await modulo().acoes.listarTodos({});
    assert.deepEqual([r.ok, r.motivo], [false, 'EXPORTACAO_INCOMPLETA']);
    assert.match(modulo().mensagens.erroExportacao(r), /tente exportar novamente/i);
  });

  test('página: 10.001 registros → nenhum download e aviso orientando a restringir os filtros', async () => {
    let n = 0;
    const pg = montarPagina((u) => { n += 1; return resposta(200, pagina([item()], { total: 10001, pagina: Number(u.searchParams.get('pagina')), limite: Number(u.searchParams.get('limite')) })); });
    await pg.esperar();
    const antes = n;
    await pg.clicar('botaoExportar');
    assert.equal(pg.downloads.length, 0);
    assert.equal(n - antes, 1, 'só a primeira página foi consultada');
    assert.match(pg.el('aviso').innerHTML, /10\.000/);
    assert.match(pg.el('aviso').innerHTML, /filtros/i);
    assert.equal(pg.el('botaoExportar').disabled, false, 'o botão volta a ficar disponível');
  });
});

describe('ajuste 3 — encerramento da sessão não preserva a consulta anterior', () => {
  test('após o encerramento, os quatro filtros ficam vazios, as opções voltam a "Todos/Todas" e nenhuma nova consulta é feita', async () => {
    const pg = montarPagina(resposta(200, pagina([item()], { total: 120 })));
    await pg.esperar();
    for (const [id, v] of [['availableCategory', 'EPI'], ['availableType', 'Sapatão / Botina'], ['availableSize', '40'], ['deliveredStatus', 'expired']]) Object.assign(pg.el(id), { value: v });
    await pg.clicar('botaoFiltrar');
    await pg.clicar('paginaProxima');
    assert.match(chamadas.at(-1).caminho, /categoria=EPI.*validade=expired&pagina=2/);
    const antes = chamadas.length;

    pg.sandbox.opcoesMontar.aoEncerrar();
    assert.deepEqual(['availableCategory', 'availableType', 'availableSize', 'deliveredStatus'].map((id) => pg.el(id).value), ['', '', '', '']);
    assert.equal(pg.el('availableCategory').innerHTML, '<option value="">Todas</option>');
    assert.equal(pg.el('paginacaoTexto').textContent, '—');
    await pg.clicar('paginaProxima');
    await pg.clicar('botaoFiltrar');
    assert.equal(chamadas.length, antes, 'página encerrada não consulta mais');
  });

  test('encerrarTela reinicia o estado interno: aplicados = {} e pagina = 1 (preserva a proteção assíncrona)', () => {
    const html = ler('pages/available-items.html');
    const corpo = html.slice(html.indexOf('function encerrarTela()'), html.indexOf('\n  }', html.indexOf('function encerrarTela()')));
    assert.match(corpo, /encerrada = true;/);
    assert.match(corpo, /consultaAtual \+= 1;/);
    assert.match(corpo, /aplicados = \{\};/);
    assert.match(corpo, /pagina = 1;/);
    assert.match(corpo, /\$\('deliveredStatus'\)\.value = '';/);
  });
});
