'use strict';

/**
 * Etapa A1 (RED) — Gestão de GHE › Importação GHE/EPI: tipos de EPI não encontrados no catálogo e cadastro explícito.
 *
 * Contrato do servidor (D1 + opção A): a prévia traz `resumo.tiposNaoEncontrados` = [{ nome, variantes, linhas, ghes,
 * reservado, nomeExcedeLimite }], calculado pelo núcleo do backend com a MESMA chave de comparação da importação. A tela
 * NÃO normaliza nem agrupa nada: só apresenta a lista do servidor. Aqui a prévia vem do `analisarLote` REAL do backend.
 *
 * Interface esperada:
 *   - módulo js/importacao-ghe.js: `render.tiposNaoEncontrados(lista, { podeCadastrar })` (tudo escapado; botão
 *     data-acao="cadastrar-tipo" data-indice="<i>" só com podeCadastrar e para item não reservado e dentro do teto) e os
 *     textos `mensagens.TIPO_SEM_PERMISSAO`, `mensagens.TIPO_RESERVADO`, `mensagens.TIPO_NOME_LONGO`;
 *   - página: seção #importacaoTiposNaoEncontrados (escondida sem itens) com #importacaoTiposCorpo; formulário
 *     #formTipoImportacao com #tipoImportacaoNome (somente leitura, valor = nome do servidor), #tipoImportacaoGrupo e
 *     #tipoImportacaoProtecao (vocabulário de EpiTiposMaterial, sem "Outros"), #botaoSalvarTipoImportacao,
 *     #botaoCancelarTipoImportacao e #tipoImportacaoEstado;
 *   - cadastro pela rota existente (EpiTiposMaterial.acoes.criar → POST /api/tipos-material), validação local de
 *     EpiTiposMaterial.formulario.montarTipo, mensagens de EpiTiposMaterial.mensagens (nunca o texto do servidor);
 *   - depois do cadastro (201) ou de "já existe" (409), a prévia é refeita com as linhas ORIGINAIS da planilha;
 *   - botão só com materials.criar efetiva; o servidor continua a autoridade.
 *
 * Arquivo novo; nenhum teste existente foi alterado.
 */

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const EpiHttp = require('../js/api-http');
const I = require('../js/importacao-ghe');
const T = require('../js/tipos-material');
const { analisarLote } = require('../../backend/src/utils/ghe-importacao');

const BASE = 'http://localhost:3000/api';
const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const resposta = (status, corpo) => ({ status, ok: status >= 200 && status < 300, text: async () => (corpo === undefined ? '' : JSON.stringify(corpo)) });
const semTags = (s) => String(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const json = (v) => JSON.parse(JSON.stringify(v));

// Função do módulo que ainda não existe no RED: ao ser chamada falha com asserção clara (nunca TypeError).
const exigir = (objeto, rotulo) => new Proxy(objeto || {}, { get: (alvo, nome) => (nome in alvo ? alvo[nome] : () => assert.fail(`ainda não implementado: ${rotulo}.${String(nome)}`)) });
const render = () => exigir(I.render, 'render');
const textoExigido = (nome) => {
  const v = I.mensagens && I.mensagens[nome];
  assert.equal(typeof v, 'string', `ainda não implementado: mensagens.${nome}`);
  assert.ok(v.length > 0);
  return v;
};

const item = (extra = {}) => ({ nome: 'Luva Nitrila', variantes: ['Luva Nitrila'], linhas: [3, 4], ghes: ['GHE-001', 'GHE-040'], reservado: false, nomeExcedeLimite: false, ...extra });

// ═══════════════════════════════════════════════════════════════════
// Módulo: render.tiposNaoEncontrados e textos
// ═══════════════════════════════════════════════════════════════════
describe('A1 — módulo: render.tiposNaoEncontrados', () => {
  test('lista o tipo com linhas e GHEs afetados e o botão "Cadastrar tipo" com o índice do item', () => {
    const html = render().tiposNaoEncontrados([item(), item({ nome: 'Cinturão Paraquedista', variantes: ['Cinturão Paraquedista'], linhas: [5], ghes: ['GHE-041'] })], { podeCadastrar: true });
    const texto = semTags(html);
    assert.match(texto, /Luva Nitrila/);
    assert.match(texto, /GHE-001/);
    assert.match(texto, /GHE-040/);
    assert.match(texto, /2 linhas/);
    assert.match(texto, /Cinturão Paraquedista/);
    assert.match(texto, /1 linha\b/);
    assert.match(html, /<button[^>]*data-acao="cadastrar-tipo"[^>]*data-indice="0"|<button[^>]*data-indice="0"[^>]*data-acao="cadastrar-tipo"/);
    assert.match(html, /<button[^>]*data-acao="cadastrar-tipo"[^>]*data-indice="1"|<button[^>]*data-indice="1"[^>]*data-acao="cadastrar-tipo"/);
    assert.match(texto, /Cadastrar tipo/);
  });

  test('tudo escapado: nome e variantes vindos da planilha nunca viram marcação', () => {
    const perigoso = '<img src=x onerror=alert(1)>';
    const html = render().tiposNaoEncontrados([item({ nome: perigoso, variantes: [perigoso, `${perigoso}"'`] })], { podeCadastrar: true });
    assert.equal(html.includes('<img'), false);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  });

  test('sem materials.criar: nenhum botão; aparece a orientação de pedir a quem cadastra materiais', () => {
    const html = render().tiposNaoEncontrados([item()], { podeCadastrar: false });
    assert.equal(/data-acao="cadastrar-tipo"/.test(html), false);
    const aviso = textoExigido('TIPO_SEM_PERMISSAO');
    assert.match(aviso, /Gestão de Estoque/);
    assert.ok(semTags(html).includes(aviso));
  });

  test('"Outros" reservado e nome acima de 100 caracteres: sem botão, cada um com a sua orientação', () => {
    const reservado = textoExigido('TIPO_RESERVADO');
    const longo = textoExigido('TIPO_NOME_LONGO');
    assert.match(reservado, /"Outros"/);
    assert.match(reservado, /vínculo direto/i);
    assert.match(longo, /100 caracteres/);
    const html = render().tiposNaoEncontrados([item({ nome: 'Outros', variantes: ['Outros'], reservado: true }), item({ nome: 'L'.repeat(101), nomeExcedeLimite: true })], { podeCadastrar: true });
    assert.equal(/data-acao="cadastrar-tipo"/.test(html), false);
    assert.ok(semTags(html).includes(reservado));
    assert.ok(semTags(html).includes(longo));
  });

  test('lista vazia ou ausente: nada a desenhar', () => {
    assert.equal(render().tiposNaoEncontrados([], { podeCadastrar: true }), '');
    assert.equal(render().tiposNaoEncontrados(undefined, { podeCadastrar: true }), '');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Página em DOM simulado: a prévia vem do analisarLote real sobre o "banco" do cenário
// ═══════════════════════════════════════════════════════════════════
const CONTEXTO = { empresa: { id: 3, nome: 'Empresa Demonstração SafeWork' }, usuario: { id: 7, nome: 'Pessoa', email: 'p@exemplo-cliente.com.br', perfil: 'MASTER' } };
const acesso = (materiaisCriar) => ({
  permissoes: {
    recursos: {
      employeeGroups: { visualizar: true, criar: true, editar: true, excluir: false },
      materials: { visualizar: true, criar: materiaisCriar, editar: false, excluir: false },
    },
    acoes: {},
    administracao: {},
  },
  podeAlterar: true,
});
const PK = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
const CABECALHO = ['GHE', 'DESCRIÇÃO', 'EPI', 'CLASSIFICAÇÃO'];
const MATRIZ = [
  CABECALHO,
  ['GHE-001', 'SOLDAGEM', 'Capacete', 'Obrigatório'],
  ['GHE-001', 'SOLDAGEM', 'Luva Nitrila', 'Obrigatório'],
  ['GHE-040', 'EXPEDIÇÃO NOVA', 'luva   nitrila', 'Não obrigatório'],
  ['GHE-041', 'SUCATA NOVA', 'Cinturão Paraquedista', 'Obrigatório'],
  ['GHE-040', 'EXPEDIÇÃO NOVA', 'Outros', 'Obrigatório'],
];
const bancoInicial = () => ({
  ghes: [{ id: 1, codigo: 'GHE-001', nome: 'SOLDAGEM', ativo: true }],
  tipos: [{ id: 1, nome: 'Capacete', ativo: true }],
  vinculos: [{ gheId: 1, tipoId: 1, classificacao: 'OBRIGATORIO' }],
});

let chamadas;
function servidor(responder) {
  chamadas = [];
  EpiHttp.configurar({
    baseUrl: BASE,
    fetch: async (url, o) => {
      const u = new URL(url);
      chamadas.push({ metodo: o.method, caminho: u.pathname + u.search, corpo: o.body === undefined ? undefined : JSON.parse(o.body) });
      return responder(u, o);
    },
  });
}
beforeEach(() => servidor(() => resposta(200, { status: 'ok' })));

/**
 * Servidor do cenário: prévia = analisarLote real sobre o banco; POST /tipos-material segue `cadastro`
 * ('ok' → 201 e o tipo entra no catálogo; 'existe' → 409; 'invalido' → 400 com texto do servidor que a tela não pode mostrar).
 */
function servidorDoCenario(banco, cadastro) {
  return (u, o) => {
    if (u.pathname === '/api/grupos-homogeneos' && o.method === 'GET') return resposta(200, { status: 'ok', grupos: banco.ghes, total: banco.ghes.length, pagina: 1, limite: 100 });
    if (u.pathname === '/api/tipos-material' && o.method === 'POST') {
      const corpo = JSON.parse(o.body);
      if (cadastro === 'existe') return resposta(409, { status: 'error', codigo: 'TIPO_MATERIAL_JA_EXISTE', mensagem: 'texto do servidor que não aparece' });
      if (cadastro === 'invalido') return resposta(400, { status: 'error', codigo: 'VALIDACAO', mensagem: 'texto do servidor <b>cru</b>', detalhes: [{ campo: 'body.nome', codigo: 'NOME_INVALIDO', mensagem: 'texto do servidor <b>cru</b>' }] });
      const tipo = { id: banco.tipos.length + 100, grupo: corpo.grupo, grupoProtecao: corpo.grupoProtecao, nome: corpo.nome, ativo: true, origem: 'MANUAL' };
      banco.tipos.push({ id: tipo.id, nome: tipo.nome, ativo: true });
      return resposta(201, { status: 'ok', tipo });
    }
    if (u.pathname.endsWith('/importacao/preview') || u.pathname.endsWith('/importacao/confirmar')) {
      const analise = analisarLote({ linhas: JSON.parse(o.body).linhas, ghes: banco.ghes, tipos: banco.tipos, vinculos: banco.vinculos });
      if (u.pathname.endsWith('/importacao/preview')) return resposta(200, { status: 'ok', ...analise });
      const aplicadas = analise.linhas.filter((x) => x.aplicavel).length;
      return resposta(200, {
        status: 'ok', importacaoId: aplicadas > 0 ? '3f2b8a52-6f0b-4d2e-9b1c-0a1b2c3d4e5f' : null, ghes: analise.ghes,
        resumo: { ...analise.resumo, aplicadas, ghesCriados: 0, ghesComCodigoAtribuido: 0, vinculosCriados: aplicadas, classificacoesAlteradas: 0, semAlteracao: 0, bloqueadas: analise.linhas.length - aplicadas },
        linhas: analise.linhas.map((x) => ({ ...x, resultado: x.aplicavel ? 'APLICADA' : 'BLOQUEADA' })),
      });
    }
    return resposta(500, { status: 'error' });
  };
}

function montarPagina({ podeCadastrarTipo = true, cadastro = 'ok', banco = bancoInicial(), matriz = MATRIZ } = {}) {
  servidor(servidorDoCenario(banco, cadastro));
  const html = ler('pages/employee-groups.html');
  const script = html.slice(html.lastIndexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));
  const mapa = {};
  const el = (id) => (mapa[id] = mapa[id] || {
    id, value: '', innerHTML: '', textContent: '', disabled: false, hidden: undefined, style: {}, listeners: {}, files: [],
    appendChild(no) { no.parentNode = this; return no; },
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    focus() {}, click() {},
  });
  const sandbox = {
    document: { getElementById: el, querySelectorAll: () => [] },
    window: { SAFEWORK_PORTAL_API_BASE_URL: BASE, confirm: () => true, readXlsxFile: async () => [{ data: matriz }] },
    EpiHttp, EpiGruposHomogeneos: require('../js/grupos-homogeneos'), EpiImportacaoGhe: I, EpiTiposMaterial: T, // eslint-disable-line global-require
    EpiPermissoes: { prepararPagina: async () => acesso(podeCadastrarTipo) },
    EpiSessaoEmpresarial: { montar: async () => CONTEXTO, sessaoEncerrada() {} },
    console, setTimeout, Promise, String, Number, Array, Object, JSON, Uint8Array,
  };
  vm.runInNewContext(script, sandbox);
  const esperar = async () => { for (let i = 0; i < 60; i += 1) await new Promise((r) => setImmediate(r)); };
  const disparar = async (id, ev, alvo) => { for (const fn of (el(id).listeners[ev] || [])) await fn({ target: alvo, preventDefault() {} }); await esperar(); };
  const alvoAcao = (acao, indice) => ({ getAttribute: (n) => ({ 'data-acao': acao, 'data-indice': String(indice) })[n] ?? null, closest() { return this; } });
  return {
    el, banco,
    clicar: (id) => disparar(id, 'click', undefined),
    cadastrarTipo: (indice) => disparar('importacaoTiposCorpo', 'click', alvoAcao('cadastrar-tipo', indice)),
    importar: async () => {
      await esperar();
      el('arquivoImportacaoGhe').files = [{ name: 'Importacao_GHE_EPI.xlsx', size: 2048, slice: () => ({ arrayBuffer: async () => PK.buffer }) }];
      await disparar('arquivoImportacaoGhe', 'change', el('arquivoImportacaoGhe'));
    },
    lista: () => el('importacaoTiposCorpo').innerHTML,
    estado: () => el('tipoImportacaoEstado').textContent,
  };
}
const posts = (sufixo) => chamadas.filter((c) => c.metodo === 'POST' && c.caminho.endsWith(sufixo));

/** Abre a página, importa a planilha e exige a seção da lista visível (ausência = falha funcional). */
async function comPrevia(opcoes) {
  const pg = montarPagina(opcoes);
  await pg.importar();
  assert.equal(posts('/importacao/preview').length, 1, 'premissa: uma prévia');
  assert.equal(pg.el('importacaoTiposNaoEncontrados').hidden, false, 'a seção de tipos não encontrados deveria aparecer');
  return pg;
}

/** Conteúdo da <section id="…"> até o </section> que a fecha (contando seções aninhadas). */
function secaoBalanceada(html, id) {
  const inicio = html.search(new RegExp(`<section[^>]*\\bid="${id}"[^>]*>`));
  assert.ok(inicio !== -1, `falta <section id="${id}">`);
  const marca = /<section\b|<\/section>/g;
  marca.lastIndex = inicio + 1;
  let profundidade = 1;
  for (let m = marca.exec(html); m; m = marca.exec(html)) {
    profundidade += m[0] === '</section>' ? -1 : 1;
    if (profundidade === 0) return html.slice(inicio, m.index);
  }
  return assert.fail(`<section id="${id}"> sem fechamento`);
}

describe('A1 — inspeção estática: pages/employee-groups.html', () => {
  test('carrega js/tipos-material.js antes do script da página, depois de api-http.js', () => {
    const html = ler('pages/employee-groups.html');
    const tipos = html.indexOf('<script src="../js/tipos-material.js"></script>');
    assert.ok(tipos !== -1, 'falta <script src="../js/tipos-material.js">');
    assert.ok(html.indexOf('<script src="../js/api-http.js"></script>') < tipos);
    assert.ok(tipos < html.lastIndexOf('<script>'));
  });

  test('o painel de importação tem a seção dos tipos não encontrados e o formulário de cadastro, escondidos, com o nome somente leitura', () => {
    const painel = secaoBalanceada(ler('pages/employee-groups.html'), 'painelImportacaoGhe');
    for (const id of ['importacaoTiposNaoEncontrados', 'importacaoTiposCorpo', 'formTipoImportacao', 'tipoImportacaoNome', 'tipoImportacaoGrupo', 'tipoImportacaoProtecao', 'botaoSalvarTipoImportacao', 'botaoCancelarTipoImportacao', 'tipoImportacaoEstado']) {
      assert.match(painel, new RegExp(`\\bid="${id}"`), `falta #${id} dentro do painel de importação`);
    }
    assert.match(painel, /<[^>]*\bid="importacaoTiposNaoEncontrados"[^>]*\bhidden\b|<[^>]*\bhidden\b[^>]*\bid="importacaoTiposNaoEncontrados"/, 'a seção começa escondida');
    assert.match(painel, /<[^>]*\bid="formTipoImportacao"[^>]*\bhidden\b|<[^>]*\bhidden\b[^>]*\bid="formTipoImportacao"/, 'o formulário começa escondido');
    assert.match(painel, /<input[^>]*\bid="tipoImportacaoNome"[^>]*\breadonly\b|<input[^>]*\breadonly\b[^>]*\bid="tipoImportacaoNome"/, 'o nome do tipo é somente leitura');
  });
});

describe('A1 — página: lista de tipos não encontrados na prévia', () => {
  test('com materials.criar: a seção aparece com os itens do servidor e o botão de cadastro nos itens cadastráveis', async () => {
    const pg = await comPrevia();
    const texto = semTags(pg.lista());
    assert.match(texto, /Luva Nitrila/);
    assert.match(texto, /Cinturão Paraquedista/);
    assert.match(texto, /Outros/);
    assert.equal((pg.lista().match(/data-acao="cadastrar-tipo"/g) || []).length, 2, 'Luva e Cinturão; "Outros" sem botão');
    assert.ok(texto.includes(textoExigido('TIPO_RESERVADO')));
  });

  test('sem materials.criar: a seção aparece, nenhum botão, a orientação; um clique forjado não abre o formulário nem chama a API', async () => {
    const pg = await comPrevia({ podeCadastrarTipo: false });
    assert.equal(/data-acao="cadastrar-tipo"/.test(pg.lista()), false);
    assert.ok(semTags(pg.lista()).includes(textoExigido('TIPO_SEM_PERMISSAO')));
    await pg.cadastrarTipo(0);
    assert.notEqual(pg.el('formTipoImportacao').hidden, false);
    assert.equal(posts('/tipos-material').length, 0);
  });

  test('planilha sem tipo inexistente (lista vazia do servidor): a seção fica escondida', async () => {
    const banco = bancoInicial();
    banco.tipos.push({ id: 2, nome: 'Luva Nitrila', ativo: true });
    const pg = montarPagina({ banco, matriz: MATRIZ.slice(0, 4) });
    await pg.importar();
    assert.equal(posts('/importacao/preview').length, 1);
    assert.equal(pg.el('importacaoTiposNaoEncontrados').hidden, true);
    assert.equal(/data-acao="cadastrar-tipo"/.test(pg.lista()), false);
  });
});

describe('A1 — página: formulário de cadastro do tipo', () => {
  test('abrir: nome = o do servidor (por .value), grupo e grupo de proteção do vocabulário de EpiTiposMaterial, sem "Outros"', async () => {
    const pg = await comPrevia();
    await pg.cadastrarTipo(0);
    assert.equal(pg.el('formTipoImportacao').hidden, false);
    assert.equal(pg.el('tipoImportacaoNome').value, 'Luva Nitrila');
    const grupos = semTags(pg.el('tipoImportacaoGrupo').innerHTML);
    for (const g of T.VOCABULARIO.grupos) assert.match(grupos, new RegExp(g));
    const protecoes = pg.el('tipoImportacaoProtecao').innerHTML;
    for (const p of T.VOCABULARIO.gruposProtecao) assert.ok(protecoes.includes(`value="${T.render.escaparHtml(p)}"`), `falta ${p}`);
    assert.equal(/value="Outros"/.test(pg.el('tipoImportacaoGrupo').innerHTML + protecoes), false);
  });

  test('salvar: POST /tipos-material com o corpo exato e, depois do 201, a prévia é refeita com as linhas ORIGINAIS e o tipo sai da lista', async () => {
    const pg = await comPrevia();
    const originais = json(posts('/importacao/preview')[0].corpo.linhas);
    await pg.cadastrarTipo(0);
    pg.el('tipoImportacaoGrupo').value = 'EPI';
    pg.el('tipoImportacaoProtecao').value = 'Proteção das mãos';
    await pg.clicar('botaoSalvarTipoImportacao');

    assert.deepEqual(posts('/tipos-material').map((c) => c.corpo), [{ grupo: 'EPI', grupoProtecao: 'Proteção das mãos', nome: 'Luva Nitrila' }]);
    const previas = posts('/importacao/preview');
    assert.equal(previas.length, 2, 'a prévia é refeita depois do cadastro');
    assert.deepEqual(json(previas[1].corpo.linhas), originais);
    assert.equal(/Luva Nitrila/.test(semTags(pg.lista())), false);
    assert.match(semTags(pg.lista()), /Cinturão Paraquedista/);
    assert.equal(pg.el('formTipoImportacao').hidden, true);
  });

  test('409 TIPO_MATERIAL_JA_EXISTE: mostra o texto de EpiTiposMaterial (nunca o do servidor) e refaz a prévia', async () => {
    const pg = await comPrevia({ cadastro: 'existe' });
    await pg.cadastrarTipo(0);
    pg.el('tipoImportacaoGrupo').value = 'EPI';
    pg.el('tipoImportacaoProtecao').value = 'Proteção das mãos';
    await pg.clicar('botaoSalvarTipoImportacao');
    assert.equal(posts('/tipos-material').length, 1);
    assert.ok(pg.estado().includes(T.mensagens.POR_CODIGO.TIPO_MATERIAL_JA_EXISTE), `estado: "${pg.estado()}"`);
    assert.equal(pg.estado().includes('texto do servidor'), false);
    assert.equal(posts('/importacao/preview').length, 2);
  });

  test('400: mostra o texto de EpiTiposMaterial para o código e não refaz a prévia', async () => {
    const pg = await comPrevia({ cadastro: 'invalido' });
    await pg.cadastrarTipo(1);
    pg.el('tipoImportacaoGrupo').value = 'EPI';
    pg.el('tipoImportacaoProtecao').value = 'Proteção contra quedas';
    await pg.clicar('botaoSalvarTipoImportacao');
    assert.deepEqual(posts('/tipos-material').map((c) => c.corpo.nome), ['Cinturão Paraquedista']);
    assert.ok(pg.estado().includes(T.mensagens.POR_CODIGO.NOME_INVALIDO), `estado: "${pg.estado()}"`);
    assert.equal(pg.estado().includes('texto do servidor'), false);
    assert.equal(posts('/importacao/preview').length, 1);
  });

  test('validação local de EpiTiposMaterial: sem grupo nada é enviado e a mensagem aparece', async () => {
    const pg = await comPrevia();
    await pg.cadastrarTipo(0);
    pg.el('tipoImportacaoGrupo').value = '';
    pg.el('tipoImportacaoProtecao').value = 'Proteção das mãos';
    await pg.clicar('botaoSalvarTipoImportacao');
    assert.equal(posts('/tipos-material').length, 0);
    assert.match(pg.estado(), /Selecione o grupo/);
  });

  test('cancelar fecha o formulário sem chamar a API; clique forjado em item reservado não abre nada', async () => {
    const pg = await comPrevia();
    await pg.cadastrarTipo(0);
    assert.equal(pg.el('formTipoImportacao').hidden, false);
    await pg.clicar('botaoCancelarTipoImportacao');
    assert.equal(pg.el('formTipoImportacao').hidden, true);
    await pg.cadastrarTipo(2);
    assert.equal(pg.el('formTipoImportacao').hidden, true, '"Outros" nunca abre o formulário');
    assert.equal(posts('/tipos-material').length, 0);
  });

  test('confirmar depois do cadastro reenvia as linhas ORIGINAIS da planilha', async () => {
    const pg = await comPrevia();
    const originais = json(posts('/importacao/preview')[0].corpo.linhas);
    await pg.cadastrarTipo(0);
    pg.el('tipoImportacaoGrupo').value = 'EPI';
    pg.el('tipoImportacaoProtecao').value = 'Proteção das mãos';
    await pg.clicar('botaoSalvarTipoImportacao');
    assert.equal(posts('/tipos-material').length, 1);
    await pg.clicar('botaoConfirmarImportacao');
    const confirmacoes = posts('/importacao/confirmar');
    assert.equal(confirmacoes.length, 1);
    assert.deepEqual(json(confirmacoes[0].corpo.linhas), originais);
  });
});
