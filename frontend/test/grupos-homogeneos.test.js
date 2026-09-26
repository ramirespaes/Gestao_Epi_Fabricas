'use strict';

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const EpiHttp = require('../js/api-http');
const P = require('../js/permissoes-efetivas');

/**
 * GHE e matriz GHE × EPI (Bloco 9, Etapa C, Parte C5): módulo
 * js/grupos-homogeneos.js com `fetch` injetado, entrada `employeeGroups`
 * no mapa de páginas, inspeção estática de pages/employee-groups.html e
 * comportamento da página sobre um DOM simulado. Somente endpoints reais:
 * /api/grupos-homogeneos e /api/grupos-homogeneos/:id/materiais.
 */

const BASE = 'http://localhost:3000/api';
const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const semComentarios = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const modulo = () => require('../js/grupos-homogeneos'); // eslint-disable-line global-require
const resposta = (status, corpo) => ({ status, ok: status >= 200 && status < 300, text: async () => (corpo === undefined ? '' : JSON.stringify(corpo)) });

const grupo = (extra = {}) => ({ id: 5, nome: 'Soldadores', descricao: null, setor: 'Caldeiraria', funcao: 'Soldador', riscos: 'Radiação não ionizante', ativo: true, ...extra });
const material = (extra = {}) => ({ id: 11, nome: 'Luva de raspa', tipo: 'Luva', categoria: 'EPI', codigoInterno: 'EPI-011', caNumero: '12345', prazoUsoDias: 90, unidade: 'par', ativo: true, vinculado: false, ...extra });
const listaGrupos = (grupos) => ({ status: 'ok', grupos, total: grupos.length, pagina: 1, limite: 100 });
const matriz = (materiais, extra = {}) => ({ status: 'ok', grupo: { id: 5, nome: 'Soldadores', ativo: true }, materiais, ...extra });

let chamadas;
function servidor(responder) {
  chamadas = [];
  EpiHttp.configurar({
    baseUrl: BASE,
    fetch: async (url, opcoes) => {
      const u = new URL(url);
      chamadas.push({ metodo: opcoes.method, caminho: u.pathname + u.search, corpo: opcoes.body === undefined ? undefined : JSON.parse(opcoes.body) });
      const r = typeof responder === 'function' ? responder(u, opcoes) : responder;
      if (r instanceof Error) throw r;
      return r;
    },
  });
}
beforeEach(() => servidor(resposta(200, listaGrupos([grupo()]))));

describe('acoes: somente endpoints reais; empresa e ator nunca saem do navegador', () => {
  test('GHE: listar, criar, alterar, inativar e reativar', async () => {
    const { acoes } = modulo();
    await acoes.listarGrupos();
    await acoes.criarGrupo({ nome: '  Soldadores ', setor: 'Caldeiraria', funcao: '', descricao: ' ', riscos: 'Fumos' });
    await acoes.alterarGrupo(5, { nome: 'Soldadores II', setor: '', funcao: 'Soldador', descricao: 'Turno A', riscos: '' });
    await acoes.inativarGrupo(5);
    await acoes.reativarGrupo(5);
    assert.deepEqual(chamadas.map((c) => `${c.metodo} ${c.caminho}`), [
      'GET /api/grupos-homogeneos?pagina=1&limite=100',
      'POST /api/grupos-homogeneos',
      'PATCH /api/grupos-homogeneos/5',
      'POST /api/grupos-homogeneos/5/inativar',
      'POST /api/grupos-homogeneos/5/reativar',
    ]);
    assert.deepEqual(chamadas[1].corpo, { nome: 'Soldadores', setor: 'Caldeiraria', funcao: null, descricao: null, riscos: 'Fumos' });
    assert.deepEqual(chamadas[2].corpo, { nome: 'Soldadores II', setor: null, funcao: 'Soldador', descricao: 'Turno A', riscos: null });
    assert.deepEqual([chamadas[3].corpo, chamadas[4].corpo], [{}, {}]);
  });

  test('matriz: consultar, vincular e desvincular', async () => {
    const { acoes } = modulo();
    await acoes.consultarMatriz(5);
    await acoes.vincular(5, 11);
    await acoes.desvincular(5, 12);
    assert.deepEqual(chamadas.map((c) => `${c.metodo} ${c.caminho}`), [
      'GET /api/grupos-homogeneos/5/materiais',
      'POST /api/grupos-homogeneos/5/materiais',
      'DELETE /api/grupos-homogeneos/5/materiais/12',
    ]);
    assert.deepEqual(chamadas[1].corpo, { materialId: 11 });
    assert.equal(chamadas.some((c) => /empresaId|usuarioId/.test(JSON.stringify(c))), false);
  });

  test('salvarMatriz: inclui e remove item a item, e informa cada resultado; 401 interrompe', async () => {
    const { acoes } = modulo();
    servidor((u, o) => (o.method === 'POST' && u.pathname.endsWith('/materiais') ? resposta(409, { status: 'erro', codigo: 'MATERIAL_INATIVO' }) : resposta(200, { status: 'ok', removido: true })));
    const r = await acoes.salvarMatriz(5, { incluir: [11], remover: [12, 13] });
    assert.deepEqual(chamadas.map((c) => `${c.metodo} ${c.caminho}`), ['POST /api/grupos-homogeneos/5/materiais', 'DELETE /api/grupos-homogeneos/5/materiais/12', 'DELETE /api/grupos-homogeneos/5/materiais/13']);
    assert.equal(r.ok, false);
    assert.deepEqual(r.falhas.map((f) => [f.materialId, f.operacao, f.resposta.codigo]), [[11, 'incluir', 'MATERIAL_INATIVO']]);

    servidor(resposta(401, { status: 'erro', codigo: 'SESSAO_INVALIDA' }));
    const sessao = await acoes.salvarMatriz(5, { incluir: [11, 12], remover: [13] });
    assert.equal(chamadas.length, 1, 'para no primeiro 401');
    assert.equal(sessao.semSessao, true);
  });
});

describe('matriz: alterações pendentes em relação ao estado persistido', () => {
  test('incluir = marcados não persistidos; remover = persistidos desmarcados; ordenados', () => {
    const { matriz: m } = modulo();
    assert.deepEqual(m.alteracoes([11, 12], [12, 14, 13]), { incluir: [13, 14], remover: [11] });
    assert.deepEqual(m.alteracoes([], []), { incluir: [], remover: [] });
    assert.equal(m.temAlteracoes({ incluir: [], remover: [] }), false);
    assert.equal(m.temAlteracoes({ incluir: [1], remover: [] }), true);
    assert.deepEqual(m.vinculados([material({ id: 1, vinculado: true }), material({ id: 2 })]), [1]);
  });
});

describe('render', () => {
  test('matriz: uma linha por EPI, caixa marcada = vinculado, prazo de troca de materiais.prazo_uso_dias, tudo escapado', () => {
    const { render } = modulo();
    const html = render.linhasMatriz([material({ nome: '<b>x</b>' }), material({ id: 12, nome: 'Óculos', prazoUsoDias: null, caNumero: null })], [11], { podeEditar: true });
    assert.equal((html.match(/<tr>/g) || []).length, 2);
    assert.match(html, /<input type="checkbox" data-material-id="11" checked aria-label="Vincular &lt;b&gt;x&lt;\/b&gt; ao GHE">/);
    assert.match(html, /<input type="checkbox" data-material-id="12" aria-label="Vincular Óculos ao GHE">/);
    assert.match(html, /90 dias/);
    assert.equal(/<b>x<\/b>/.test(html), false);
  });

  test('matriz somente leitura: caixas desabilitadas; material inativo vinculado aparece desabilitado e sinalizado', () => {
    const { render } = modulo();
    assert.match(render.linhasMatriz([material()], [], { podeEditar: false }), /data-material-id="11" disabled/);
    const inativo = render.linhasMatriz([material({ ativo: false, vinculado: true })], [11], { podeEditar: true });
    assert.match(inativo, /Inativo/);
    assert.match(inativo, /data-material-id="11" checked aria-label/, 'pode ser desmarcado (remoção permitida)');
  });

  test('GHE: linhas com situação e ações conforme permissão e estado', () => {
    const { render } = modulo();
    const html = render.linhasGrupos([grupo(), grupo({ id: 6, nome: 'Pintores', ativo: false })], { podeEditar: true, selecionado: 5 });
    assert.match(html, /<tr class="selecionado">/);
    assert.match(html, /data-acao="selecionar" data-id="5"/);
    assert.match(html, /data-acao="editar" data-id="5"/);
    assert.match(html, /data-acao="inativar" data-id="5"/);
    assert.match(html, /data-acao="reativar" data-id="6"/);
    assert.match(html, /badge status-active">Ativo/);
    assert.match(html, /badge status-inactive">Inativo/);
    const leitura = render.linhasGrupos([grupo()], { podeEditar: false });
    assert.match(leitura, /data-acao="selecionar"/);
    assert.equal(/data-acao="(editar|inativar|reativar)"/.test(leitura), false);
  });
});

describe('mensagens: padrão de erros da API', () => {
  test('rede, 400, 401, 403, 404, 409 por código e 500', () => {
    const { mensagens } = modulo();
    assert.match(mensagens.erro({ ok: false, status: 0 }), /rede/i);
    assert.match(mensagens.erro({ ok: false, status: 400, codigo: 'VALIDACAO' }), /dados/i);
    assert.match(mensagens.erro({ ok: false, status: 403 }), /perfil/i);
    assert.match(mensagens.erro({ ok: false, status: 404, codigo: 'GHE_NAO_ENCONTRADO' }), /GHE não encontrado/);
    assert.match(mensagens.erro({ ok: false, status: 404, codigo: 'MATERIAL_NAO_ENCONTRADO' }), /EPI não encontrado/);
    assert.match(mensagens.erro({ ok: false, status: 409, codigo: 'GHE_NOME_EM_USO' }), /Já existe um GHE com este nome/);
    assert.match(mensagens.erro({ ok: false, status: 409, codigo: 'GHE_INATIVO' }), /GHE inativo/);
    assert.match(mensagens.erro({ ok: false, status: 409, codigo: 'MATERIAL_INATIVO' }), /EPI inativo/);
    assert.match(mensagens.erro({ ok: false, status: 409, codigo: 'GHE_MATERIAL_JA_VINCULADO' }), /já está vinculado/);
    assert.match(mensagens.erro({ ok: false, status: 500 }), /Não foi possível concluir/);
    assert.equal(mensagens.exigeNovoLogin({ status: 401 }), true);
  });
});

describe('permissões: página employeeGroups', () => {
  const p = (visualizar, editar) => ({ recursos: { employeeGroups: { visualizar, criar: editar, editar, excluir: false } }, acoes: {}, administracao: {} });
  test('abrir exige employeeGroups.visualizar; alterar exige employeeGroups.editar', () => {
    assert.deepEqual(P.PAGINAS.employeeGroups, { abrir: [{ recurso: 'employeeGroups', operacao: 'visualizar' }], alterar: [{ recurso: 'employeeGroups', operacao: 'editar' }] });
    assert.equal(P.podeAbrir(p(true, false), 'employeeGroups'), true);
    assert.equal(P.podeAlterar(p(true, false), 'employeeGroups'), false);
    assert.equal(P.podeAlterar(p(true, true), 'employeeGroups'), true);
    assert.equal(P.podeAbrir(p(false, true), 'employeeGroups'), false);
  });
});

describe('inspeção estática: pages/employee-groups.html e menus', () => {
  const html = ler('pages/employee-groups.html');
  const codigo = semComentarios(html);
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);

  test('sessão real e endpoints reais; sem protótipo, mocks ou armazenamento local', () => {
    for (const proibido of [/db-api\.js/, /main\.js/, /localStorage/, /sessionStorage/, /document\.cookie/, /rulesData/, /localhost:3000/, /loginScreen/]) {
      assert.equal(proibido.test(codigo), false, `employee-groups.html contém ${proibido}`);
    }
    const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
    assert.deepEqual(scripts, ['../js/api-http.js', '../portal/config.js', '../js/sessao-empresarial.js', '../js/permissoes-efetivas.js', '../js/pagina-base.js', '../js/grupos-homogeneos.js']);
    assert.match(codigo, /EpiSessaoEmpresarial\.montar\(/);
    assert.match(codigo, /EpiPermissoes\.prepararPagina\(\{\s*pagina: 'employeeGroups'/);
    for (const id of ['telaSessao', 'telaSessaoMensagem', 'telaSessaoPortal', 'identidade', 'botaoSair', 'botaoTrocarEmpresa', 'aviso',
      'gruposCorpo', 'botaoNovoGrupo', 'formGrupo', 'gheNome', 'gheSetor', 'gheFuncao', 'gheDescricao', 'gheRiscos', 'botaoSalvarGrupo', 'botaoCancelarGrupo',
      'matrizTitulo', 'matrizCorpo', 'botaoSalvarMatriz', 'botaoDescartarMatriz', 'matrizResumo']) {
      assert.ok(ids.includes(id), `falta #${id}`);
    }
    assert.match(html, /EPIs vinculados ao GHE/);
  });

  test('menus das páginas integradas e início do Portal oferecem a página (oculta até a permissão)', () => {
    assert.match(html, /<a class="active" href="javascript:void\(0\)" data-pagina="employeeGroups" style="display:none">/);
    for (const arquivo of ['pages/materials.html', 'pages/available-items.html', 'pages/employee-history.html', 'pages/import-employees.html']) {
      assert.match(ler(arquivo), /<a href="employee-groups\.html" data-pagina="employeeGroups" style="display:none"><div class="nav-icon purple">group_work<\/div>GHE e EPIs<\/a>/, arquivo);
    }
    assert.match(ler('portal/inicio.html'), /<a href="\.\.\/pages\/employee-groups\.html" data-pagina="employeeGroups" style="display:none">GHE e EPIs<\/a>/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Página em DOM simulado: o script embutido de employee-groups.html
// ═══════════════════════════════════════════════════════════════════
const CONTEXTO = { empresa: { id: 3, nome: 'Empresa Demonstração SafeWork' }, usuario: { id: 7, nome: 'Pessoa', email: 'p@exemplo-cliente.com.br', perfil: 'MASTER' } };
const ACESSO_EDITAR = { permissoes: { recursos: { employeeGroups: { visualizar: true, criar: true, editar: true, excluir: false } }, acoes: {}, administracao: {} }, podeAlterar: true };
const ACESSO_LEITURA = { permissoes: { recursos: { employeeGroups: { visualizar: true, criar: false, editar: false, excluir: false } }, acoes: {}, administracao: {} }, podeAlterar: false };

function montarPagina(responder, { acesso = ACESSO_EDITAR } = {}) {
  servidor(responder);
  const html = ler('pages/employee-groups.html');
  const script = html.slice(html.lastIndexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));
  const mapa = {};
  const el = (id) => (mapa[id] = mapa[id] || {
    id, value: '', innerHTML: '', textContent: '', disabled: false, hidden: false, style: {}, listeners: {},
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    focus() {},
  });
  const sandbox = {
    document: { getElementById: el, querySelectorAll: () => [] },
    window: { SAFEWORK_PORTAL_API_BASE_URL: BASE, confirm: () => true },
    EpiHttp, EpiGruposHomogeneos: modulo(),
    EpiPermissoes: { prepararPagina: async () => acesso },
    EpiSessaoEmpresarial: { montar: async (o) => { sandbox.opcoesMontar = o; return CONTEXTO; }, sessaoEncerrada() { sandbox.encerrada = true; } },
    console, setTimeout, Promise, String, Number, Array, Object, JSON,
  };
  vm.runInNewContext(script, sandbox);
  const esperar = async () => { for (let i = 0; i < 40; i += 1) await new Promise((r) => setImmediate(r)); };
  const clicar = async (id) => { for (const fn of (el(id).listeners.click || [])) await fn({ preventDefault() {} }); await esperar(); };
  const alvo = (atributos) => ({ getAttribute: (n) => (Object.hasOwn(atributos, n) ? atributos[n] : null), closest() { return this; }, checked: atributos.checked });
  const acaoGrupo = async (acao, id) => {
    for (const fn of (el('gruposCorpo').listeners.click || [])) await fn({ target: alvo({ 'data-acao': acao, 'data-id': String(id) }), preventDefault() {} });
    await esperar();
  };
  const marcar = async (materialId, checked) => {
    for (const fn of (el('matrizCorpo').listeners.change || [])) await fn({ target: alvo({ 'data-material-id': String(materialId), checked }) });
    await esperar();
  };
  return { el, sandbox, esperar, clicar, acaoGrupo, marcar };
}

/** Servidor em memória com o mesmo contrato da API (estado persistido real). */
function servidorEmMemoria({ vinculados = [11], grupos = [grupo()] } = {}) {
  const estado = { vinculados: new Set(vinculados), grupos: grupos.map((g) => ({ ...g })) };
  const materiais = [material(), material({ id: 12, nome: 'Óculos de proteção' }), material({ id: 13, nome: 'Protetor auricular' })];
  const responder = (u, o) => {
    const m = u.pathname.match(/^\/api\/grupos-homogeneos\/(\d+)\/materiais(?:\/(\d+))?$/);
    if (m && o.method === 'GET') return resposta(200, matriz(materiais.map((x) => ({ ...x, vinculado: estado.vinculados.has(x.id) }))));
    if (m && o.method === 'POST') { estado.vinculados.add(JSON.parse(o.body).materialId); return resposta(201, { status: 'ok', vinculo: {} }); }
    if (m && o.method === 'DELETE') { estado.vinculados.delete(Number(m[2])); return resposta(200, { status: 'ok', removido: true }); }
    if (u.pathname === '/api/grupos-homogeneos' && o.method === 'GET') return resposta(200, listaGrupos(estado.grupos));
    if (u.pathname === '/api/grupos-homogeneos' && o.method === 'POST') {
      const g = grupo({ id: 99, ...JSON.parse(o.body) });
      estado.grupos.push(g);
      return resposta(201, { status: 'ok', grupo: g });
    }
    return resposta(500, { status: 'erro' });
  };
  return { estado, responder };
}

describe('página (DOM simulado)', () => {
  test('ao abrir: estado de carregamento, depois os GHEs reais da API', async () => {
    const pg = montarPagina(resposta(200, listaGrupos([grupo(), grupo({ id: 6, nome: 'Pintores' })])));
    assert.match(pg.el('gruposCorpo').innerHTML, /Carregando/);
    await pg.esperar();
    assert.deepEqual(chamadas.map((c) => c.caminho), ['/api/grupos-homogeneos?pagina=1&limite=100']);
    assert.equal((pg.el('gruposCorpo').innerHTML.match(/<tr[ >]/g) || []).length, 2);
    assert.match(pg.el('gruposCorpo').innerHTML, /Pintores/);
  });

  test('estado vazio: nenhum GHE cadastrado', async () => {
    const pg = montarPagina(resposta(200, listaGrupos([])));
    await pg.esperar();
    assert.match(pg.el('gruposCorpo').innerHTML, /Nenhum GHE cadastrado/);
  });

  test('selecionar GHE carrega a matriz: EPIs da empresa, vinculados marcados', async () => {
    const srv = servidorEmMemoria();
    const pg = montarPagina(srv.responder);
    await pg.esperar();
    await pg.acaoGrupo('selecionar', 5);
    assert.equal(chamadas.at(-1).caminho, '/api/grupos-homogeneos/5/materiais');
    assert.match(pg.el('matrizTitulo').textContent, /Soldadores/);
    assert.match(pg.el('matrizCorpo').innerHTML, /data-material-id="11" checked/);
    assert.match(pg.el('matrizCorpo').innerHTML, /data-material-id="12" aria-label/);
    assert.equal(pg.el('botaoSalvarMatriz').disabled, true, 'sem alterações pendentes');
  });

  test('marcar/desmarcar e salvar: envia só as diferenças e recarrega o estado persistido', async () => {
    const srv = servidorEmMemoria();
    const pg = montarPagina(srv.responder);
    await pg.esperar();
    await pg.acaoGrupo('selecionar', 5);
    await pg.marcar(12, true);
    await pg.marcar(11, false);
    assert.equal(pg.el('botaoSalvarMatriz').disabled, false);
    assert.match(pg.el('matrizResumo').textContent, /1 inclusão.*1 remoção/);
    const antes = chamadas.length;
    await pg.clicar('botaoSalvarMatriz');
    assert.deepEqual(chamadas.slice(antes).map((c) => `${c.metodo} ${c.caminho}`), [
      'POST /api/grupos-homogeneos/5/materiais', 'DELETE /api/grupos-homogeneos/5/materiais/11', 'GET /api/grupos-homogeneos/5/materiais',
    ]);
    assert.deepEqual([...srv.estado.vinculados], [12]);
    assert.match(pg.el('matrizCorpo').innerHTML, /data-material-id="12" checked/);
    assert.match(pg.el('matrizCorpo').innerHTML, /data-material-id="11" aria-label/);
    assert.match(pg.el('aviso').innerHTML, /Vínculos salvos/);
  });

  test('recarregar a página mostra exatamente o estado persistido', async () => {
    const srv = servidorEmMemoria({ vinculados: [13] });
    const pg = montarPagina(srv.responder);
    await pg.esperar();
    await pg.acaoGrupo('selecionar', 5);
    assert.match(pg.el('matrizCorpo').innerHTML, /data-material-id="13" checked/);
    assert.equal((pg.el('matrizCorpo').innerHTML.match(/ checked/g) || []).length, 1);
  });

  test('falha ao salvar (409): mensagem do erro e matriz recarregada do servidor (nunca estado local)', async () => {
    const srv = servidorEmMemoria();
    const pg = montarPagina((u, o) => (o.method === 'POST' ? resposta(409, { status: 'erro', codigo: 'GHE_INATIVO' }) : srv.responder(u, o)));
    await pg.esperar();
    await pg.acaoGrupo('selecionar', 5);
    await pg.marcar(12, true);
    await pg.clicar('botaoSalvarMatriz');
    assert.match(pg.el('aviso').innerHTML, /GHE inativo/);
    assert.equal(chamadas.at(-1).caminho, '/api/grupos-homogeneos/5/materiais');
    assert.match(pg.el('matrizCorpo').innerHTML, /data-material-id="12" aria-label/, 'volta ao persistido');
  });

  test('erro de autorização (403) ao listar: mensagem, tabela sem dados; 401 devolve ao Portal', async () => {
    const pg = montarPagina(resposta(403, { status: 'erro', codigo: 'PERMISSAO_NEGADA' }));
    await pg.esperar();
    assert.match(pg.el('gruposCorpo').innerHTML, /perfil/i);
    const sessao = montarPagina(resposta(401, { status: 'erro', codigo: 'SESSAO_INVALIDA' }));
    await sessao.esperar();
    assert.equal(sessao.sandbox.encerrada, true);
  });

  test('novo GHE: erro de validação (400) exibido e formulário mantido; sucesso recarrega a lista', async () => {
    const pg = montarPagina((u, o) => (o.method === 'POST' ? resposta(400, { status: 'erro', codigo: 'VALIDACAO', mensagem: 'x' }) : resposta(200, listaGrupos([grupo()]))));
    await pg.esperar();
    await pg.clicar('botaoNovoGrupo');
    Object.assign(pg.el('gheNome'), { value: 'Pintores' });
    await pg.clicar('botaoSalvarGrupo');
    assert.match(pg.el('aviso').innerHTML, /dados/i);
    assert.equal(pg.el('gheNome').value, 'Pintores', 'o que foi digitado não se perde');

    const srv = servidorEmMemoria();
    const ok = montarPagina(srv.responder);
    await ok.esperar();
    await ok.clicar('botaoNovoGrupo');
    Object.assign(ok.el('gheNome'), { value: 'Pintores' });
    await ok.clicar('botaoSalvarGrupo');
    assert.equal(srv.estado.grupos.length, 2);
    assert.match(ok.el('gruposCorpo').innerHTML, /Pintores/);
  });

  test('nome vazio não chega à API', async () => {
    const pg = montarPagina(resposta(200, listaGrupos([])));
    await pg.esperar();
    await pg.clicar('botaoNovoGrupo');
    const antes = chamadas.length;
    await pg.clicar('botaoSalvarGrupo');
    assert.equal(chamadas.length, antes);
    assert.match(pg.el('aviso').innerHTML, /nome/i);
  });

  test('somente leitura: sem novo GHE nem salvar; caixas desabilitadas', async () => {
    const srv = servidorEmMemoria();
    const pg = montarPagina(srv.responder, { acesso: ACESSO_LEITURA });
    await pg.esperar();
    assert.equal(pg.el('botaoNovoGrupo').hidden, true);
    await pg.acaoGrupo('selecionar', 5);
    assert.match(pg.el('matrizCorpo').innerHTML, /data-material-id="11" disabled/);
    assert.equal(pg.el('botaoSalvarMatriz').hidden, true);
  });
});
