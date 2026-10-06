'use strict';

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const EpiHttp = require('../js/api-http');
const P = require('../js/permissoes-efetivas');
const Catalogo = require('../js/catalogo-visual');

/**
 * Itens Disponíveis (Bloco 9, Etapa C, Parte C3; posição da 12D-3): módulo
 * js/itens-disponiveis.js com `fetch` injetado, entrada `availableItems`
 * no mapa de páginas, inspeção estática de pages/available-items.html e
 * comportamento da página sobre um DOM simulado. Somente leitura.
 *
 * Desde a 12D-3 cada item é um par (material, tamanho) da posição de estoque e
 * o payload dos testes é EXATAMENTE o contrato da 12D-2 (as 21 chaves). A
 * situação do estoque vem do servidor (`abaixoDoMinimo`, que o servidor mede
 * pelo saldo livre): o frontend não recalcula mínimo, livre nem necessidade.
 */

const BASE = 'http://localhost:3000/api';
const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const semComentarios = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const modulo = () => require('../js/itens-disponiveis'); // eslint-disable-line global-require
const resposta = (status, corpo) => ({ status, ok: status >= 200 && status < 300, text: async () => (corpo === undefined ? '' : JSON.stringify(corpo)) });

// As 21 chaves do item de GET /api/estoque/itens-disponiveis (contrato da 12D-2, igual ao teste de integração do backend).
const CHAVES_DO_ITEM = [
  'abaixoDoMinimo', 'bloqueado', 'caValidade', 'categoria', 'codigoInterno', 'comprometido', 'deficit', 'disponivel', 'estoqueMinimo', 'fisicoUtilizavel',
  'material', 'materialId', 'minimoOrigem', 'necessidade', 'saldo', 'saldoLivre', 'semCobertura', 'tamanho', 'tipo', 'unidade', 'validade',
];
const item = (extra = {}) => ({
  materialId: 1, material: 'Botina de segurança', codigoInterno: 'EPI-001', categoria: 'EPI', tipo: 'Sapatão / Botina', tamanho: '40',
  saldo: 12, bloqueado: 0, disponivel: 12, fisicoUtilizavel: 12, comprometido: 0, saldoLivre: 12, semCobertura: 0,
  estoqueMinimo: 5, minimoOrigem: 'PADRAO', abaixoDoMinimo: false, deficit: 0, necessidade: 0, unidade: 'par', caValidade: '2027-01-31', validade: 'ok', ...extra,
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

  test('filtros novos (12D-3): busca, situação e somente com necessidade, na ordem do contrato e só quando preenchidos', async () => {
    await modulo().acoes.listar({ categoria: 'EPI', busca: '  Botina 50% ', situacao: 'ABAIXO_MINIMO', somenteComNecessidade: true, pagina: 2, limite: 20 });
    assert.equal(chamadas[0].caminho, '/api/estoque/itens-disponiveis?categoria=EPI&busca=Botina%2050%25&situacao=ABAIXO_MINIMO&somenteComNecessidade=true&pagina=2&limite=20');
    await modulo().acoes.listar({ busca: '', situacao: '', somenteComNecessidade: false });
    assert.equal(chamadas[1].caminho, '/api/estoque/itens-disponiveis?pagina=1&limite=50', 'vazio, "Todas" e falso são omitidos');
  });

  test('situação só vai se for uma das quatro do servidor; qualquer outro valor é descartado antes da rede', async () => {
    const { acoes, SITUACOES } = modulo();
    assert.deepEqual(SITUACOES.map(([valor]) => valor), ['', 'SEM_ESTOQUE', 'ABAIXO_MINIMO', 'COM_COMPROMETIDO', 'SEM_COBERTURA']);
    for (const [valor] of SITUACOES.slice(1)) {
      await acoes.listar({ situacao: valor });
      assert.match(chamadas.at(-1).caminho, new RegExp(`situacao=${valor}&`));
    }
    for (const invalida of ['COM_NECESSIDADE', 'sem_estoque', 'QUALQUER', '1; DROP']) {
      await acoes.listar({ situacao: invalida });
      assert.doesNotMatch(chamadas.at(-1).caminho, /situacao=/, invalida);
    }
    await acoes.listar({ somenteComNecessidade: 'true' });
    assert.doesNotMatch(chamadas.at(-1).caminho, /somenteComNecessidade/, 'só o booleano verdadeiro vale');
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

// As células de uma linha, sem as marcações de formatação interna, na ordem da tabela.
const celulasDe = (html) => [...html.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
const semMarcacao = (s) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
// 12G-7: a célula do material começa pelo pictograma decorativo; o resto dela segue igual.
const semPictograma = (s) => s.replace(/^<svg [^>]*>[\s\S]*?<\/svg>/, '');
const COLUNAS = ['categoria', 'tipo', 'material', 'tamanho', 'fisico', 'comprometido', 'livre', 'semCobertura', 'minimo', 'deficit', 'necessidade', 'unidade', 'status'];
const colunasDe = (html) => Object.fromEntries(celulasDe(html).map((c, i) => [COLUNAS[i], c]));

describe('render: tabela da posição (12D-3), 13 colunas', () => {
  test('linha: categoria, tipo, material (com código interno), tamanho, físico utilizável, comprometido, saldo livre, sem cobertura, mínimo, déficit, necessidade, unidade, status — tudo escapado', () => {
    const html = modulo().render.linhas([item({ material: '<b>x</b>', codigoInterno: 'C&D', comprometido: 2, saldoLivre: 10, estoqueMinimo: 5, deficit: 0, necessidade: 0 })]);
    const tds = celulasDe(html);
    assert.equal(tds.length, 13);
    const c = colunasDe(html);
    assert.equal(c.categoria, 'EPI');
    assert.equal(c.tipo, 'Sapatão / Botina');
    assert.match(semPictograma(c.material), /^&lt;b&gt;x&lt;\/b&gt;/);
    assert.match(c.material, /C&amp;D/);
    assert.deepEqual([c.tamanho, c.fisico, c.comprometido, c.livre, c.semCobertura, c.deficit, c.necessidade, c.unidade], ['40', '12', '2', '10', '0', '0', '0', 'Par']);
    assert.match(c.minimo, /^5\b/);
    assert.match(c.status, /<span class="badge [^"]+">[^<]+<\/span>/);
  });

  test('o físico utilizável vem de fisicoUtilizavel; disponivel é só o apelido antigo (mesmo valor) e a falta dele não quebra', () => {
    const { render } = modulo();
    assert.equal(colunasDe(render.linhas([item({ fisicoUtilizavel: 9, disponivel: 9 })])).fisico, '9');
    assert.equal(colunasDe(render.linhas([item({ fisicoUtilizavel: 9, disponivel: undefined })])).fisico, '9');
    assert.equal(item().disponivel, item().fisicoUtilizavel, 'compatibilidade do contrato: disponivel === fisicoUtilizavel');
  });

  test('status vem do servidor: sem cobertura > sem estoque > abaixo do mínimo > comprometido > disponível; sempre com texto', () => {
    const { render } = modulo();
    const status = (extra) => semMarcacao(colunasDe(render.linhas([item(extra)])).status);
    assert.equal(status({}), 'Disponível');
    assert.equal(status({ fisicoUtilizavel: 0, disponivel: 0, saldoLivre: 0, saldo: 0 }), 'Sem estoque');
    assert.equal(status({ fisicoUtilizavel: 3, disponivel: 3, saldoLivre: 3, abaixoDoMinimo: true, deficit: 2, necessidade: 2 }), 'Abaixo do mínimo');
    assert.equal(status({ comprometido: 4, saldoLivre: 8 }), 'Com saldo comprometido');
    assert.equal(status({ fisicoUtilizavel: 1, disponivel: 1, comprometido: 1, saldoLivre: 0, semCobertura: 2, necessidade: 2 }), 'Sem cobertura');
    assert.equal(status({ fisicoUtilizavel: 0, disponivel: 0, saldoLivre: 0, semCobertura: 3, necessidade: 3 }), 'Sem cobertura', 'a demanda sem cobertura prevalece sobre "sem estoque"');
    assert.match(render.linhas([item({ fisicoUtilizavel: 0, disponivel: 0, saldoLivre: 0 })]), /badge status-inactive">Sem estoque/);
    assert.match(render.linhas([item()]), /badge status-active">Disponível/);
  });

  test('SITUAÇÃO PELO SALDO LIVRE: físico 10 acima do mínimo 5, mas livre 2 e o servidor diz abaixo → "Abaixo do mínimo"; o frontend não recalcula', () => {
    const { render } = modulo();
    const abaixo = item({ fisicoUtilizavel: 10, disponivel: 10, comprometido: 8, saldoLivre: 2, estoqueMinimo: 5, abaixoDoMinimo: true, deficit: 3, necessidade: 3 });
    assert.equal(semMarcacao(colunasDe(render.linhas([abaixo])).status), 'Com saldo comprometido Abaixo do mínimo');
    // A decisão é do servidor: se ele manda abaixoDoMinimo=false, o frontend não refaz a conta do mínimo.
    const obedece = item({ fisicoUtilizavel: 3, disponivel: 3, saldoLivre: 3, estoqueMinimo: 5, abaixoDoMinimo: false });
    assert.equal(semMarcacao(colunasDe(render.linhas([obedece])).status), 'Disponível');
  });

  test('"Abaixo do mínimo" aparece também junto de outra situação (nunca só por cor): comprometido + abaixo mostra as duas', () => {
    const html = modulo().render.linhas([item({ comprometido: 8, saldoLivre: 2, abaixoDoMinimo: true, deficit: 3, necessidade: 3 })]);
    const status = colunasDe(html).status;
    assert.match(status, />Com saldo comprometido</);
    assert.match(status, />Abaixo do mínimo</);
  });

  test('mínimo: o próprio aparece como "Próprio" e o herdado como "Padrão"; o próprio 0 é mostrado como 0 (não é "—" nem herança)', () => {
    const { render } = modulo();
    const minimo = (extra) => semMarcacao(colunasDe(render.linhas([item(extra)])).minimo);
    assert.equal(minimo({ estoqueMinimo: 20, minimoOrigem: 'PADRAO' }), '20 Padrão');
    assert.equal(minimo({ estoqueMinimo: 5, minimoOrigem: 'PROPRIO' }), '5 Próprio');
    assert.equal(minimo({ estoqueMinimo: 0, minimoOrigem: 'PROPRIO' }), '0 Próprio');
    assert.equal(minimo({ estoqueMinimo: 0, minimoOrigem: 'PADRAO' }), '0 Padrão');
    assert.notEqual(minimo({ estoqueMinimo: 0, minimoOrigem: 'PROPRIO' }), minimo({ estoqueMinimo: 0, minimoOrigem: 'PADRAO' }));
  });

  test('sem cobertura, déficit e necessidade são mostrados como o servidor mandou (a necessidade inclui a demanda sem cobertura)', () => {
    const c = colunasDe(modulo().render.linhas([item({ fisicoUtilizavel: 0, disponivel: 0, saldo: 0, saldoLivre: 0, semCobertura: 2, estoqueMinimo: 5, deficit: 5, necessidade: 7, abaixoDoMinimo: true })]));
    assert.deepEqual([c.semCobertura, c.deficit, c.necessidade], ['2', '5', '7']);
    assert.equal(semMarcacao(c.status), 'Sem cobertura Abaixo do mínimo');
  });

  test('tamanho ausente (material sem tamanho) e campos vazios viram "—"; zero real continua 0', () => {
    const html = modulo().render.linhas([item({ tamanho: null, categoria: null, tipo: null, codigoInterno: null, comprometido: 0 })]);
    const c = colunasDe(html);
    assert.deepEqual([c.categoria, c.tipo, c.tamanho], ['—', '—', '—']);
    assert.equal(c.comprometido, '0');
  });

  test('colunas secundárias (categoria, tipo, déficit, unidade) têm a classe que esconde em tela pequena; as principais não', () => {
    const html = modulo().render.linhas([item()]);
    const tds = [...html.matchAll(/<td([^>]*)>/g)].map((m) => m[1]);
    const secundarias = tds.map((a, i) => (/class="[^"]*\bcol-sec\b/.test(a) ? COLUNAS[i] : null)).filter(Boolean);
    assert.deepEqual(secundarias, ['categoria', 'tipo', 'deficit', 'unidade']);
  });

  test('guarda do contrato: o render só lê chaves que existem no contrato da 12D-2 e lê as críticas (um nome trocado quebra este teste)', () => {
    const lidas = new Set();
    const espiao = new Proxy(item(), { get(alvo, chave) { if (typeof chave === 'string') lidas.add(chave); return alvo[chave]; } });
    modulo().render.linhas([espiao]);
    for (const chave of lidas) assert.ok(CHAVES_DO_ITEM.includes(chave), `o render lê "${chave}", que não existe no contrato`);
    for (const critica of ['fisicoUtilizavel', 'comprometido', 'saldoLivre', 'semCobertura', 'estoqueMinimo', 'minimoOrigem', 'abaixoDoMinimo', 'deficit', 'necessidade', 'tamanho', 'material']) {
      assert.ok(lidas.has(critica), `o render não lê "${critica}"`);
    }
    assert.deepEqual(Object.keys(item()).sort(), CHAVES_DO_ITEM);
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
    assert.match(render.estado('Nenhum item'), /<tr><td colspan="13"[^>]*>Nenhum item<\/td><\/tr>/);
    assert.match(mensagens.vazio(false), /Nenhum material ativo com tamanho cadastrado nesta empresa/);
    assert.match(mensagens.vazio(true), /Limpar/);
    assert.match(mensagens.erroConsulta({ ok: false, status: 0 }), /rede/i);
    assert.match(mensagens.erroConsulta({ ok: false, status: 403, codigo: 'PERMISSAO_NEGADA' }), /não pode consultar os itens disponíveis/i);
    assert.match(mensagens.erroConsulta({ ok: false, status: 400, codigo: 'VALIDACAO' }), /filtros/i);
    assert.match(mensagens.erroConsulta({ ok: false, status: 503 }), /Não foi possível consultar/i);
    assert.equal(mensagens.exigeNovoLogin({ status: 401 }), true);
  });
});

describe('csv: exportação com os campos da posição (12D-3)', () => {
  const CABECALHO = '"Categoria";"Tipo";"Material";"Tamanho";"Físico utilizável";"Comprometido";"Saldo livre";"Sem cobertura";"Mínimo";"Origem do mínimo";"Déficit";"Necessidade";"Unidade";"Status"';

  test('cabeçalho e linhas correspondem à tabela; BOM; aspas; fórmulas neutralizadas', () => {
    const { csv } = modulo();
    const texto = csv.gerar([
      item(),
      item({ material: '=HYPERLINK("x")', tamanho: '41', saldo: 3, disponivel: 3, fisicoUtilizavel: 3, saldoLivre: 3, codigoInterno: null, abaixoDoMinimo: true, deficit: 2, necessidade: 2 }),
      item({ tamanho: '42', saldo: 0, disponivel: 0, fisicoUtilizavel: 0, saldoLivre: 0 }),
    ]);
    assert.equal(texto.charCodeAt(0), 0xFEFF);
    const linhas = texto.slice(1).split('\r\n');
    assert.equal(linhas[0], CABECALHO);
    assert.equal(linhas[1], '"EPI";"Sapatão / Botina";"Botina de segurança (EPI-001)";"40";"12";"0";"12";"0";"5";"Padrão";"0";"0";"Par";"Disponível"');
    assert.equal(linhas[2], '"EPI";"Sapatão / Botina";"\'=HYPERLINK(""x"")";"41";"3";"0";"3";"0";"5";"Padrão";"2";"2";"Par";"Abaixo do mínimo"');
    assert.equal(linhas[3], '"EPI";"Sapatão / Botina";"Botina de segurança (EPI-001)";"42";"0";"0";"0";"0";"5";"Padrão";"0";"0";"Par";"Sem estoque"');
    assert.equal(linhas.length, 4);
    assert.equal(csv.NOME_ARQUIVO, 'itens_disponiveis.csv');
  });

  test('comprometido, sem cobertura, mínimo próprio 0 e necessidade chegam ao arquivo exatamente como o servidor mandou', () => {
    const texto = modulo().csv.gerar([
      item({ fisicoUtilizavel: 5, disponivel: 5, comprometido: 2, saldoLivre: 3, estoqueMinimo: 0, minimoOrigem: 'PROPRIO' }),
      item({ tamanho: '42', fisicoUtilizavel: 0, disponivel: 0, saldo: 0, saldoLivre: 0, semCobertura: 2, estoqueMinimo: 5, deficit: 5, necessidade: 7, abaixoDoMinimo: true }),
    ]);
    const [, proprio, semCob] = texto.slice(1).split('\r\n');
    assert.equal(proprio, '"EPI";"Sapatão / Botina";"Botina de segurança (EPI-001)";"40";"5";"2";"3";"0";"0";"Próprio";"0";"0";"Par";"Com saldo comprometido"');
    assert.equal(semCob, '"EPI";"Sapatão / Botina";"Botina de segurança (EPI-001)";"42";"0";"0";"0";"2";"5";"Padrão";"5";"7";"Par";"Sem cobertura · Abaixo do mínimo"');
  });

  test('sem itens: só o cabeçalho', () => {
    assert.equal(modulo().csv.gerar([]).slice(1), CABECALHO);
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
    // 12D-3: a situação vem do servidor, então a regra local de js/materiais.js não é mais carregada aqui.
    // 12G-7: o catálogo visual vem antes do módulo que desenha a linha.
    assert.deepEqual(scripts, ['../js/tema.js', '../js/api-http.js', '../portal/config.js', '../js/sessao-empresarial.js', '../js/permissoes-efetivas.js', '../js/pagina-base.js', '../js/catalogo-visual.js', '../js/itens-disponiveis.js']);
    assert.match(codigo, /EpiSessaoEmpresarial\.montar\(/);
    assert.match(codigo, /EpiPermissoes\.prepararPagina\(\{\s*pagina: 'availableItems'/);
    for (const id of ['telaSessao', 'telaSessaoMensagem', 'telaSessaoPortal', 'aviso']) assert.ok(ids.includes(id), id);
  });

  test('filtros, botões, tabela e exportação originais preservados; linhas fictícias removidas; paginação acrescentada', () => {
    for (const id of ['availableItemsView', 'availableCategory', 'availableType', 'availableSize', 'deliveredStatus', 'botaoLimpar', 'botaoFiltrar', 'botaoExportar', 'itensDisponiveisCorpo', 'paginaAnterior', 'paginacaoTexto', 'paginaProxima']) {
      assert.ok(ids.includes(id), `falta #${id}`);
    }
    // 12D-3: a tabela mostra a posição; as colunas secundárias esvaziam em tela pequena (classe col-sec).
    const cabecalhos = [...html.matchAll(/<th([^>]*)>([^<]+)<\/th>/g)].map((m) => [m[2], /\bcol-sec\b/.test(m[1])]);
    assert.deepEqual(cabecalhos.map(([t]) => t), ['Categoria', 'Tipo', 'Material', 'Tamanho', 'Físico utilizável', 'Comprometido', 'Saldo livre', 'Sem cobertura', 'Mínimo', 'Déficit', 'Necessidade', 'Unidade', 'Status']);
    assert.deepEqual(cabecalhos.filter(([, sec]) => sec).map(([t]) => t), ['Categoria', 'Tipo', 'Déficit', 'Unidade']);
    assert.match(html, /@media \(max-width: \d+px\)[^}]*\.col-sec|\.col-sec[^}]*display:\s*none/);
    assert.equal(/Quantidade disponível/.test(html), false, 'o rótulo antigo saiu');
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

  test('filtros novos da 12D-3: busca, situação e somente com necessidade, com rótulo associado; situações só as quatro do servidor', () => {
    for (const id of ['availableSearch', 'availableSituation', 'availableNeed']) assert.ok(ids.includes(id), `falta #${id}`);
    assert.match(html, /<label for="availableSearch">/);
    assert.match(html, /<label for="availableSituation">/);
    assert.match(html, /<label[^>]*for="availableNeed"/);
    assert.match(html, /<input id="availableSearch"[^>]*maxlength="100"/);
    assert.match(html, /<input id="availableNeed"[^>]*type="checkbox"|<input[^>]*type="checkbox"[^>]*id="availableNeed"/);
    const opcoes = [...html.slice(html.indexOf('id="availableSituation"')).matchAll(/<option value="([^"]*)">([^<]+)<\/option>/g)].slice(0, 5).map((m) => [m[1], m[2]]);
    assert.deepEqual(opcoes, [['', 'Todas'], ['SEM_ESTOQUE', 'Sem estoque'], ['ABAIXO_MINIMO', 'Abaixo do mínimo'], ['COM_COMPROMETIDO', 'Com saldo comprometido'], ['SEM_COBERTURA', 'Sem cobertura']]);
    assert.match(html, /saldo livre/i, 'a explicação da página fala do saldo livre');
  });

  test('menu: estrutura preservada; Análise de estoque ativa; integrados por permissão; demais sem link', () => {
    const links = [...html.matchAll(/<a [^>]*data-pagina="([^"]+)"[^>]*>/g)];
    assert.deepEqual(links.map((m) => m[1]).sort(), ['autorizacoes-individuais', 'availableItems', 'config', 'dashboard', 'employeeGroups', 'employeeHistory', 'epiFicha', 'gestaoUsuarios', 'grupo-permissoes', 'grupo-usuarios', 'grupos-acesso', 'importEmployees', 'materials', 'newUser', 'operations', 'request', 'stockRequests', 'stockValidity', 'supervisorApproval', 'userAdmin']);
    for (const m of links) assert.match(m[0], /style="display:none"/);
    assert.match(html, /<a class="active" href="javascript:void\(0\)" data-pagina="availableItems"/);
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]).filter((h) => !h.startsWith('http') && !h.startsWith('../css/') && h !== 'javascript:void(0)');
    const permitidos = new Set(['materials.html', 'stock-validity.html', 'operations.html', 'dashboard.html', 'employee-groups.html', 'epi-ficha.html', 'employee-history.html', 'import-employees.html', 'request.html', 'supervisor-approval.html', 'stock-requests.html', 'grupos-acesso.html', 'grupo-permissoes.html', 'grupo-usuarios.html', 'autorizacoes-individuais.html', 'new-user.html', 'user-admin.html', 'gestao-usuarios.html', 'config.html', '../portal/index.html', '../portal/inicio.html']);
    for (const h of hrefs) assert.ok(permitidos.has(h), h);
    // 20 na C3; a C4 integrou Histórico e Importar Funcionários (D9): restam 18; Configurações integrada: restam 8 pendentes.
    assert.ok([...html.matchAll(/<a class="nav-pendente"/g)].length >= 8); // C6: Dashboard; E7: Validade; E8: Operações; F: Novo Usuário e Administração de Usuários; 10I: Ficha de EPI; 12G-1: as três da solicitação
  });

  test('a Gestão de estoque e o início do Portal oferecem a Análise de estoque (oculta até a permissão)', () => {
    assert.match(ler('pages/materials.html'), /<a href="available-items\.html" data-pagina="availableItems" style="display:none"><div class="nav-icon green">checklist<\/div>Análise de estoque<\/a>/);
    assert.match(ler('portal/inicio.html'), /<a href="\.\.\/pages\/available-items\.html" data-pagina="availableItems" style="display:none">Análise de estoque<\/a>/);
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
  const SELECTS = new Set(['availableCategory', 'availableType', 'availableSize', 'deliveredStatus', 'availableSituation']);
  const mapa = {};
  const el = (id) => (mapa[id] = mapa[id] || {
    id, value: '', checked: false, innerHTML: '', textContent: '', disabled: false, style: {}, listeners: {}, tagName: SELECTS.has(id) ? 'SELECT' : 'DIV',
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
    EpiHttp, EpiItensDisponiveis: modulo(), EpiCatalogoVisual: Catalogo,
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
    const pg = montarPagina(resposta(200, pagina([item(), item({ tamanho: '41', saldo: 0, disponivel: 0, fisicoUtilizavel: 0, saldoLivre: 0 })], { total: 2, filtros: { categorias: ['EPI', 'Uniforme'], tipos: ['Luva'], tamanhos: ['40', '41'] } })));
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

  test('filtros da 12D-3: busca, situação e somente com necessidade vão ao servidor; Limpar zera os três (a caixa desmarca)', async () => {
    const pg = montarPagina(resposta(200, pagina([item()])));
    await pg.esperar();
    Object.assign(pg.el('availableSearch'), { value: '  botina ' });
    Object.assign(pg.el('availableSituation'), { value: 'SEM_COBERTURA' });
    Object.assign(pg.el('availableNeed'), { checked: true });
    await pg.clicar('botaoFiltrar');
    assert.equal(chamadas.at(-1).caminho, '/api/estoque/itens-disponiveis?busca=botina&situacao=SEM_COBERTURA&somenteComNecessidade=true&pagina=1&limite=50');
    await pg.clicar('paginaProxima');
    assert.match(chamadas.at(-1).caminho, /busca=botina&situacao=SEM_COBERTURA&somenteComNecessidade=true&pagina=2/, 'a página seguinte mantém os filtros novos');
    await pg.clicar('botaoLimpar');
    assert.deepEqual([pg.el('availableSearch').value, pg.el('availableSituation').value, pg.el('availableNeed').checked], ['', '', false]);
    assert.equal(chamadas.at(-1).caminho, '/api/estoque/itens-disponiveis?pagina=1&limite=50');
  });

  test('vazio com os filtros novos sugere Limpar; a situação e a necessidade contam como filtro aplicado', async () => {
    const pg = montarPagina(resposta(200, pagina([], { total: 0, filtros: { categorias: [], tipos: [], tamanhos: [] } })));
    await pg.esperar();
    assert.doesNotMatch(pg.el('itensDisponiveisCorpo').innerHTML, /Limpar/);
    Object.assign(pg.el('availableNeed'), { checked: true });
    await pg.clicar('botaoFiltrar');
    assert.match(pg.el('itensDisponiveisCorpo').innerHTML, /Limpar/);
  });

  test('a tabela mostra a posição exatamente como o servidor mandou: físico, comprometido, livre, sem cobertura, mínimo, déficit e necessidade', async () => {
    const pg = montarPagina(resposta(200, pagina([item({ fisicoUtilizavel: 0, disponivel: 0, saldo: 0, saldoLivre: 0, semCobertura: 2, estoqueMinimo: 5, deficit: 5, necessidade: 7, abaixoDoMinimo: true })], { total: 1 })));
    await pg.esperar();
    const c = colunasDe(pg.el('itensDisponiveisCorpo').innerHTML);
    assert.deepEqual([c.fisico, c.livre, c.semCobertura, c.deficit, c.necessidade], ['0', '0', '2', '5', '7']);
    assert.equal(semMarcacao(c.status), 'Sem cobertura Abaixo do mínimo');
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

  test('Exportar: busca TODAS as páginas do filtro aplicado e baixa itens_disponiveis.csv com as quatorze colunas', async () => {
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
    assert.match(texto, /"Físico utilizável";"Comprometido";"Saldo livre";"Sem cobertura";"Mínimo";"Origem do mínimo";"Déficit";"Necessidade";"Unidade";"Status"/);
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

    Object.assign(pg.el('availableSearch'), { value: 'botina' });
    Object.assign(pg.el('availableSituation'), { value: 'ABAIXO_MINIMO' });
    Object.assign(pg.el('availableNeed'), { checked: true });
    pg.sandbox.opcoesMontar.aoEncerrar();
    assert.deepEqual(['availableCategory', 'availableType', 'availableSize', 'deliveredStatus'].map((id) => pg.el(id).value), ['', '', '', '']);
    assert.deepEqual([pg.el('availableSearch').value, pg.el('availableSituation').value, pg.el('availableNeed').checked], ['', '', false], 'os filtros novos também são limpos');
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
    assert.match(corpo, /\$\(CAIXA_NECESSIDADE\)\.checked = false;/, 'a caixa "somente com necessidade" também desmarca');
    assert.match(html, /busca: 'availableSearch', situacao: 'availableSituation'/, 'busca e situação entram no mapa de filtros que o encerramento zera');
  });
});

describe('12G-7 — pictograma do material: na mesma célula, antes do nome, decorativo', () => {
  test('o pictograma do tipo abre a célula do material; o nome e o código continuam em texto; 13 colunas', () => {
    const html = modulo().render.linhas([item({ material: 'Luva de raspa', codigoInterno: 'L-1', categoria: 'EPI', tipo: 'Luva' })]);
    const tds = celulasDe(html);
    assert.equal(tds.length, 13);
    const c = colunasDe(html);
    assert.ok(c.material.startsWith(Catalogo.marcacao({ tipo: 'Luva' })), c.material);
    assert.match(c.material, /^<svg [^>]*aria-hidden="true"[^>]*data-pictograma="luva"/);
    assert.equal(semMarcacao(c.material), 'Luva de raspa L-1');
    assert.equal((html.match(/<svg /g) || []).length, 1, 'um pictograma por linha');
    for (const [nome, conteudo] of Object.entries(c)) if (nome !== 'material') assert.equal(/<svg/.test(conteudo), false, nome);
  });

  test('tipo "Outro" ou desconhecido usa o pictograma da categoria; sem categoria conhecida, o genérico', () => {
    const chaveDa = (extra) => (colunasDe(modulo().render.linhas([item(extra)])).material.match(/data-pictograma="([^"]+)"/) || [])[1];
    assert.equal(chaveDa({ tipo: 'Sapatão / Botina', categoria: 'EPI' }), 'botina');
    assert.equal(chaveDa({ tipo: 'Avental', categoria: 'Uniforme' }), 'uniforme');
    assert.equal(chaveDa({ tipo: null, categoria: 'Material de consumo' }), 'consumo');
    assert.equal(chaveDa({ tipo: 'Outro', categoria: 'Brinde' }), 'material');
    assert.equal(chaveDa({ tipo: null, categoria: null }), 'material');
  });

  test('as linhas de estado e as opções dos filtros não ganham pictograma', () => {
    const { render } = modulo();
    assert.equal(/<svg/.test(render.estado('Carregando…')), false);
    assert.equal(/<svg/.test(render.opcoes(['Luva', 'Capacete'], 'Todos', 'Luva')), false);
  });
});

describe('segurança: na Análise de estoque, conteúdo da API aparece como texto, nunca como elemento ou evento', () => {
  const ATAQUE = '<img src=x onerror=alert(1)>';
  const ESCAPADO = '&lt;img src=x onerror=alert(1)&gt;';
  const marcacoes = (html) => [...String(html).matchAll(/<\s*([a-zA-Z][\w-]*)([^>]*)>/g)].map((m) => ({ nome: m[1].toLowerCase(), atributos: m[2] }));
  // Nomes de atributo, com os valores entre aspas neutralizados.
  const nomesDeAtributo = (atributos) => [...atributos.replace(/"[^"]*"|'[^']*'/g, '""').matchAll(/([^\s="'/]+)\s*=/g)].map((m) => m[1].toLowerCase());
  const semElementoInjetado = (html) => {
    for (const m of marcacoes(html)) {
      assert.notEqual(m.nome, 'img', html);
      assert.equal(nomesDeAtributo(m.atributos).some((n) => n.startsWith('on')), false, `atributo de evento em <${m.nome}>: ${html}`);
    }
  };

  test('linha da tabela: categoria, tipo, material, código, tamanho, quantidade e unidade escapados', () => {
    const html = modulo().render.linhas([item({
      categoria: ATAQUE, tipo: ATAQUE, material: ATAQUE, codigoInterno: `"><${ATAQUE}`, tamanho: ATAQUE, disponivel: ATAQUE, fisicoUtilizavel: ATAQUE, comprometido: ATAQUE,
      saldoLivre: ATAQUE, semCobertura: ATAQUE, estoqueMinimo: ATAQUE, minimoOrigem: ATAQUE, deficit: ATAQUE, necessidade: ATAQUE, unidade: ATAQUE,
    })]);
    assert.ok(html.includes(ESCAPADO));
    semElementoInjetado(html);
  });

  test('12G-7: tipo, categoria e nome maliciosos só escolhem o pictograma genérico; nada deles entra no SVG', () => {
    const html = modulo().render.linhas([item({ categoria: ATAQUE, tipo: `" onload="alert(1)`, material: ATAQUE, codigoInterno: null })]);
    semElementoInjetado(html);
    const svg = (html.match(/<svg [\s\S]*?<\/svg>/) || [])[0];
    assert.equal(svg, Catalogo.marcacao({}), 'o SVG é o genérico, fixo');
    assert.equal(/alert|onerror|onload/.test(svg), false);
  });

  test('opções dos filtros e linha de estado: valores escapados, inclusive dentro de value="..."', () => {
    const opcoes = modulo().render.opcoes([ATAQUE, `" onmouseover="alert(1)`], 'Todos', ATAQUE);
    assert.ok(opcoes.includes(`value="${ESCAPADO}" selected>${ESCAPADO}`));
    semElementoInjetado(opcoes);
    const estado = modulo().render.estado(ATAQUE);
    assert.ok(estado.includes(ESCAPADO));
    semElementoInjetado(estado);
  });

  test('a página só escreve innerHTML com texto fixo ou com o render do módulo, que escapa', () => {
    const html = ler('pages/available-items.html');
    const script = html.slice(html.lastIndexOf('<script>'));
    const atribuicoes = [...script.matchAll(/\.innerHTML\s*=\s*([^;]+);/g)].map((m) => m[1].trim());
    assert.ok(atribuicoes.length > 0);
    for (const origem of atribuicoes) {
      assert.match(origem, /^(''|Itens\.render\.[a-z]+\(|d\.itens\.length|'<div class="notice" style="' \+ cor \+ '">' \+ Itens\.render\.escaparHtml\(texto\) \+ '<\/div>')/, origem);
    }
  });
});
