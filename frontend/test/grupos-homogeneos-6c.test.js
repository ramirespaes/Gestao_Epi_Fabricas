'use strict';

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const EpiHttp = require('../js/api-http');

/**
 * Incremento 6C (RED): importação GHE / EPIs no navegador — XLSX → linhas → preview → confirmação → atualização da tela.
 *
 * Arquitetura (backend pronto e fechado): o XLSX é lido NO NAVEGADOR pela biblioteca que já existe (vendor/read-excel-file-9.3.10.min.js,
 * global readXlsxFile, injetada no módulo como na importação de funcionários); o servidor recebe só JSON e é a autoridade
 * (normalização, matching, conflitos, duplicatas, situação do vínculo). O navegador só lê, estrutura, valida o mínimo e apresenta.
 *
 * Módulo novo js/importacao-ghe.js (global EpiImportacaoGhe):
 *   arquivo.verificar({nome,tamanho,inicio})   só .xlsx; arquivo.lerXlsx(arquivo, leitor)  primeira aba, leitor injetado
 *   planilha.montarLinhas(matriz)              cabeçalho nos 10 primeiros itens; GHE, DESCRIÇÃO, EPI, CLASSIFICAÇÃO obrigatórios
 *       → { ok, linhas:[{ ghe, descricao, epi, classificacao, linha }], ignoradas } | { ok:false, codigo:'COLUNAS_AUSENTES'|
 *         'SEM_DADOS'|'LINHAS_EXCEDIDAS', faltando?, total? }; célula vazia = null, valores como estão (nada é corrigido),
 *         `linha` = número real na planilha; linha toda vazia é ignorada; linha parcial é ENVIADA; mais de 1000 = bloqueio (sem truncar, sem lotes)
 *   acoes.previa(linhas) / acoes.confirmar(linhas)   POST /grupos-homogeneos/importacao/{preview|confirmar}, corpo SÓ { linhas }
 *   rotulos, render.resumoPrevia / linhasPrevia / resumoResultado, mensagens.arquivo / mensagens.erro   textos humanos
 *
 * Página (employee-groups.html): #botaoImportarGhe abre o seletor (#arquivoImportacaoGhe, accept=".xlsx"); o painel inline
 * #painelImportacaoGhe mostra #importacaoArquivo, #importacaoAviso, #importacaoResumo, a tabela #importacaoCorpo e os botões
 * #botaoConfirmarImportacao e #botaoCancelarImportacao. As linhas ORIGINAIS ficam em memória: a confirmação as reenvia (nunca o
 * resultado do preview). Depois de confirmar com sucesso: lista de GHE recarregada e a área EPIs selecionada é fechada.
 */

const BASE = 'http://localhost:3000/api';
const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const resposta = (status, corpo) => ({ status, ok: status >= 200 && status < 300, text: async () => (corpo === undefined ? '' : JSON.stringify(corpo)) });
const erroApi = (status, codigo, detalhes) => resposta(status, { status: 'error', codigo, message: 'texto técnico do servidor', ...(detalhes ? { detalhes } : {}) });
const semTags = (s) => s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const celulas = (html) => [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1]));
const tecnico = /[A-Z]{3,}_[A-Z_]+/;

// Módulo novo: ausente no RED → falha de asserção clara (nunca TypeError de import/chamada).
function tentarModulo() {
  try { return require('../js/importacao-ghe'); } catch (erro) { // eslint-disable-line global-require
    if (erro.code === 'MODULE_NOT_FOUND' && /importacao-ghe/.test(erro.message)) return null;
    throw erro;
  }
}
const exigir = (objeto, rotulo) => new Proxy(objeto, { get: (alvo, nome) => (nome in alvo ? alvo[nome] : () => assert.fail(`ainda não implementado: ${rotulo}.${String(nome)}`)) });
const api = () => {
  const m = tentarModulo();
  if (m === null) assert.fail('módulo ainda não implementado: js/importacao-ghe.js');
  const grupo = (nome) => exigir(m[nome] || {}, nome);
  return { arquivo: grupo('arquivo'), planilha: grupo('planilha'), acoes: grupo('acoes'), rotulos: grupo('rotulos'), render: grupo('render'), mensagens: grupo('mensagens') };
};

// ─── Dados de teste ────────────────────────────────────────────────
const CABECALHO = ['GHE', 'DESCRIÇÃO', 'EPI', 'CLASSIFICAÇÃO'];
const planilha = (dados, { cabecalho = CABECALHO, antes = [] } = {}) => [...antes, cabecalho, ...dados];
const BASICA = [['GHE-020', 'Montagem Nova', 'Capacete', 'Obrigatório'], ['GHE-020', 'Montagem Nova', 'Luva de Raspa', 'Não obrigatório'], ['GHE-021', 'Pintura', 'Inexistente', 'Obrigatório']];
const PK = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
const arquivoFalso = (nome, matriz, { tamanho = 2048, bytes = PK } = {}) => ({
  name: nome, size: tamanho, __matriz: matriz, slice: () => ({ arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }),
});
const leitorFalso = async (arquivo) => {
  if (!arquivo.__matriz) throw new Error('xlsx ilegível');
  return [{ sheet: 'Plan1', data: arquivo.__matriz }];
};

const ghe = (extra = {}) => ({ id: 5, codigo: 'GHE-002', nome: 'ALMOXARIFADO', descricao: null, setor: null, funcao: null, riscos: null, ativo: true, ...extra });
const listaGrupos = (grupos) => ({ status: 'ok', grupos, total: grupos.length, pagina: 1, limite: 100 });

/** Preview realista para as linhas recebidas: EPI "Inexistente" é bloqueado; o resto vira novo vínculo. */
function previaDe(linhas) {
  const lista = linhas.map((l) => {
    const bloqueada = l.epi === 'Inexistente';
    const invalida = !l.ghe || !l.epi;
    return {
      linha: l.linha, ghe: l.ghe ? String(l.ghe).toUpperCase() : null, descricao: l.descricao, epi: l.epi, classificacao: l.classificacao === 'Obrigatório' ? 'OBRIGATORIO' : 'NAO_OBRIGATORIO',
      situacaoGhe: invalida ? null : 'GHE_NOVO', gheId: null, gheInativo: false, tipoMaterialId: bloqueada || invalida ? null : 1, tipoInativo: false,
      situacao: invalida ? 'LINHA_INVALIDA' : bloqueada ? 'EPI_NAO_ENCONTRADO' : 'NOVO_VINCULO', motivo: null, duplicadaDe: null, aplicavel: !bloqueada && !invalida,
      problemas: invalida ? [{ campo: 'ghe', codigo: 'GHE_CODIGO_OBRIGATORIO' }] : [],
    };
  });
  const porSituacao = {};
  for (const l of lista) porSituacao[l.situacao] = (porSituacao[l.situacao] || 0) + 1;
  return {
    status: 'ok', resumo: { linhasRecebidas: linhas.length, linhasIgnoradas: 0, aplicaveis: lista.filter((l) => l.aplicavel).length, porSituacao, ghes: { GHE_NOVO: new Set(lista.filter((l) => l.ghe).map((l) => l.ghe)).size } },
    ghes: [], linhas: lista,
  };
}
function resultadoDe(previa, { importacaoId = '3f2b8a52-6f0b-4d2e-9b1c-0a1b2c3d4e5f', aplicadas = 2, ghesCriados = 1 } = {}) {
  return {
    status: 'ok', importacaoId, ghes: [],
    resumo: { ...previa.resumo, aplicadas, ghesCriados, ghesComCodigoAtribuido: 0, vinculosCriados: aplicadas, classificacoesAlteradas: 0, semAlteracao: 0, bloqueadas: previa.linhas.filter((l) => !l.aplicavel).length },
    linhas: previa.linhas.map((l) => ({ ...l, resultado: l.aplicavel ? 'APLICADA' : 'BLOQUEADA' })),
  };
}

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
beforeEach(() => servidor(resposta(200, listaGrupos([ghe()]))));

/** Servidor em memória da página: lista de GHE, EPIs do GHE e os dois endpoints de importação (com ganchos para falhas e travas). */
function servidorImp({ previa, confirmar, grupos = [ghe()] } = {}) {
  const estado = { listagens: 0 };
  const responder = (u, o) => {
    const corpo = o.body === undefined ? undefined : JSON.parse(o.body);
    if (u.pathname === '/api/grupos-homogeneos' && o.method === 'GET') { estado.listagens += 1; return resposta(200, listaGrupos(grupos)); }
    if (u.pathname === '/api/grupos-homogeneos/importacao/preview') return previa ? previa(corpo) : resposta(200, previaDe(corpo.linhas));
    if (u.pathname === '/api/grupos-homogeneos/importacao/confirmar') return confirmar ? confirmar(corpo) : resposta(200, resultadoDe(previaDe(corpo.linhas)));
    if (/\/tipos-material$/.test(u.pathname)) return resposta(200, { status: 'ok', grupo: { id: 5, nome: 'ALMOXARIFADO', ativo: true }, tipos: [] });
    if (/\/materiais$/.test(u.pathname)) return resposta(200, { status: 'ok', grupo: { id: 5, nome: 'ALMOXARIFADO', ativo: true }, materiais: [] });
    return resposta(500, { status: 'error' });
  };
  return { estado, responder };
}

// ═══════════════════════════════════════════════════════════════════
// Página em DOM simulado
// ═══════════════════════════════════════════════════════════════════
const CONTEXTO = { empresa: { id: 3, nome: 'Empresa Demonstração SafeWork' }, usuario: { id: 7, nome: 'Pessoa', email: 'p@exemplo-cliente.com.br', perfil: 'MASTER' } };
const acesso = ({ visualizar = true, criar = false, editar = false } = {}) => ({
  permissoes: { recursos: { employeeGroups: { visualizar, criar, editar, excluir: false } }, acoes: {}, administracao: {} }, podeAlterar: editar === true,
});
const ACESSO_TOTAL = acesso({ criar: true, editar: true });

function montarPagina(responder, { acessoDaPagina = ACESSO_TOTAL, confirmar = true } = {}) {
  servidor(responder);
  const html = ler('pages/employee-groups.html');
  const script = html.slice(html.lastIndexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));
  const mapa = {};
  const el = (id) => (mapa[id] = mapa[id] || {
    id, value: '', innerHTML: '', textContent: '', disabled: false, hidden: undefined, style: {}, listeners: {}, files: [], cliques: 0,
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    focus() {}, click() { this.cliques += 1; },
  });
  const confirmacoes = [];
  const leituras = [];
  const sandbox = {
    document: { getElementById: el, querySelectorAll: () => [] },
    window: {
      SAFEWORK_PORTAL_API_BASE_URL: BASE,
      confirm: (pergunta) => { confirmacoes.push(pergunta); return confirmar; },
      readXlsxFile: async (arquivo) => { leituras.push(arquivo); return leitorFalso(arquivo); },
    },
    EpiHttp, EpiGruposHomogeneos: require('../js/grupos-homogeneos'), // eslint-disable-line global-require
    EpiImportacaoGhe: tentarModulo() || undefined,
    EpiPermissoes: { prepararPagina: async () => acessoDaPagina },
    EpiSessaoEmpresarial: { montar: async () => CONTEXTO, sessaoEncerrada() { sandbox.encerrada = true; } },
    console, setTimeout, Promise, String, Number, Array, Object, JSON, Uint8Array,
  };
  vm.runInNewContext(script, sandbox);
  const esperar = async () => { for (let i = 0; i < 60; i += 1) await new Promise((r) => setImmediate(r)); };
  const disparar = async (id, evento, alvo) => { for (const fn of (el(id).listeners[evento] || [])) await fn({ target: alvo, preventDefault() {} }); await esperar(); };
  const dispararSemEsperar = (id, evento, alvo) => Promise.all((el(id).listeners[evento] || []).map((fn) => fn({ target: alvo, preventDefault() {} })));
  const clicar = (id) => disparar(id, 'click', undefined);
  const escolherArquivo = async (arquivo) => { el('arquivoImportacaoGhe').files = [arquivo]; await disparar('arquivoImportacaoGhe', 'change', el('arquivoImportacaoGhe')); };
  const escolherSemEsperar = (arquivo) => { el('arquivoImportacaoGhe').files = [arquivo]; return dispararSemEsperar('arquivoImportacaoGhe', 'change', el('arquivoImportacaoGhe')); };
  const acaoGrupo = (acao, id) => disparar('gruposCorpo', 'click', { getAttribute: (n) => ({ 'data-acao': acao, 'data-id': String(id) })[n] ?? null, closest() { return this; } });
  return { el, sandbox, esperar, clicar, escolherArquivo, escolherSemEsperar, dispararSemEsperar, acaoGrupo, confirmacoes, leituras };
}
const chamadasDe = (sufixo) => chamadas.filter((c) => c.caminho.endsWith(sufixo));
const previas = () => chamadasDe('/importacao/preview');
const confirmacoesHttp = () => chamadasDe('/importacao/confirmar');
async function importar(pg, matriz = planilha(BASICA), nome = 'ghe-epi.xlsx') {
  await pg.esperar();
  const arquivo = arquivoFalso(nome, matriz);
  await pg.escolherArquivo(arquivo);
  return arquivo;
}
const comporta = () => {
  let liberar;
  const porta = new Promise((r) => { liberar = r; });
  return { porta, liberar };
};

// ───────────────────────────────────────────────────────────────────
describe('módulo: arquivo (só .xlsx, pela biblioteca existente)', () => {
  test('aceita .xlsx; recusa csv, xls antigo, outras extensões, arquivo vazio e conteúdo que não é xlsx', () => {
    const { arquivo } = api();
    const v = (nome, tamanho = 100, inicio = PK) => arquivo.verificar({ nome, tamanho, inicio });
    assert.equal(v('modelo.xlsx').ok, true);
    assert.equal(v('MODELO.XLSX').ok, true);
    for (const [nome, codigo] of [['dados.csv', 'FORMATO_INVALIDO'], ['dados.xls', 'FORMATO_XLS'], ['dados.txt', 'FORMATO_INVALIDO'], ['semextensao', 'FORMATO_INVALIDO'], ['dados.xlsx.exe', 'FORMATO_INVALIDO']]) {
      assert.deepEqual([v(nome).ok, v(nome).codigo], [false, codigo], nome);
    }
    assert.deepEqual([v('vazio.xlsx', 0).ok, v('vazio.xlsx', 0).codigo], [false, 'ARQUIVO_VAZIO']);
    assert.deepEqual([v('falso.xlsx', 100, new Uint8Array([1, 2, 3, 4])).ok, v('falso.xlsx', 100, new Uint8Array([1, 2, 3, 4])).codigo], [false, 'CONTEUDO_INCOMPATIVEL']);
  });

  test('lerXlsx usa o leitor injetado (a biblioteca existente) e devolve as linhas da primeira aba; falha de leitura vira XLSX_ILEGIVEL', async () => {
    const { arquivo } = api();
    const chamado = [];
    const leitor = async (a) => { chamado.push(a); return [{ sheet: 'Primeira', data: [['A']] }, { sheet: 'Segunda', data: [['B']] }]; };
    const f = arquivoFalso('x.xlsx', null);
    const lido = await arquivo.lerXlsx(f, leitor);
    assert.deepEqual([lido.ok, lido.linhas], [true, [['A']]]);
    assert.deepEqual(chamado, [f]);
    assert.deepEqual(await arquivo.lerXlsx(f, async () => { throw new Error('zip corrompido'); }), { ok: false, codigo: 'XLSX_ILEGIVEL' });
    assert.deepEqual(await arquivo.lerXlsx(f, undefined), { ok: false, codigo: 'XLSX_ILEGIVEL' });
  });
});

describe('módulo: planilha → linhas (a regra de negócio fica no servidor)', () => {
  test('reconhece GHE, DESCRIÇÃO, EPI e CLASSIFICAÇÃO (caixa e acento) e monta { ghe, descricao, epi, classificacao, linha } com a linha real', () => {
    const { planilha: p } = api();
    const r = p.montarLinhas(planilha(BASICA));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.linhas, [
      { ghe: 'GHE-020', descricao: 'Montagem Nova', epi: 'Capacete', classificacao: 'Obrigatório', linha: 2 },
      { ghe: 'GHE-020', descricao: 'Montagem Nova', epi: 'Luva de Raspa', classificacao: 'Não obrigatório', linha: 3 },
      { ghe: 'GHE-021', descricao: 'Pintura', epi: 'Inexistente', classificacao: 'Obrigatório', linha: 4 },
    ]);
    for (const cabecalho of [['ghe', 'descrição', 'epi', 'classificação'], ['Ghe', 'Descricao', 'Epi', 'Classificacao'], [' GHE ', 'DESCRIÇÃO', 'EPI', 'CLASSIFICAÇÃO']]) {
      assert.equal(p.montarLinhas(planilha(BASICA, { cabecalho })).ok, true, cabecalho.join('|'));
    }
  });

  test('o cabeçalho pode estar numa das primeiras linhas; a linha de cada dado continua sendo o número real na planilha', () => {
    const { planilha: p } = api();
    const r = p.montarLinhas(planilha(BASICA, { antes: [['Cobresul — GHE x EPI', null, null, null], [null, null, null, null]] }));
    assert.deepEqual(r.linhas.map((l) => l.linha), [4, 5, 6]);
  });

  test('falta de qualquer coluna obrigatória bloqueia, dizendo qual', () => {
    const { planilha: p } = api();
    for (const [indice, nome] of [[0, 'GHE'], [1, 'DESCRIÇÃO'], [2, 'EPI'], [3, 'CLASSIFICAÇÃO']]) {
      const cabecalho = CABECALHO.filter((_, i) => i !== indice);
      const r = p.montarLinhas(planilha(BASICA.map((l) => l.filter((_, i) => i !== indice)), { cabecalho }));
      assert.deepEqual([r.ok, r.codigo, r.faltando], [false, 'COLUNAS_AUSENTES', [nome]], nome);
    }
    assert.equal(p.montarLinhas([['Coluna A', 'Coluna B']]).codigo, 'COLUNAS_AUSENTES');
  });

  test('linha totalmente vazia é ignorada; linha parcial é ENVIADA como está (o servidor valida); valores não são corrigidos', () => {
    const { planilha: p } = api();
    const r = p.montarLinhas(planilha([
      ['GHE-020', 'Montagem', 'Capacete', 'Obrigatório'], [null, null, null, null], ['  ', '', null, ' '], ['GHE-021', null, 'Luva', null], ['ghe-022 ', ' pintura  geral', 'capacete', 'NAO OBRIGATORIO'],
    ]));
    assert.equal(r.ok, true);
    assert.equal(r.ignoradas, 2);
    assert.deepEqual(r.linhas, [
      { ghe: 'GHE-020', descricao: 'Montagem', epi: 'Capacete', classificacao: 'Obrigatório', linha: 2 },
      { ghe: 'GHE-021', descricao: null, epi: 'Luva', classificacao: null, linha: 5 },
      { ghe: 'ghe-022 ', descricao: ' pintura  geral', epi: 'capacete', classificacao: 'NAO OBRIGATORIO', linha: 6 },
    ]);
  });

  test('número vira texto, colunas extras são ignoradas e só as quatro chaves (mais linha) saem', () => {
    const { planilha: p } = api();
    const r = p.montarLinhas([['Obs', ...CABECALHO, 'Outra'], ['x', 'GHE-020', 123, 'Capacete', 'Obrigatório', 'y']]);
    assert.deepEqual(r.linhas, [{ ghe: 'GHE-020', descricao: '123', epi: 'Capacete', classificacao: 'Obrigatório', linha: 2 }]);
    assert.deepEqual(Object.keys(r.linhas[0]).sort(), ['classificacao', 'descricao', 'epi', 'ghe', 'linha']);
  });

  test('mais de 1000 linhas: bloqueia sem truncar nem dividir; exatamente 1000 passa inteiro; sem dados é recusado', () => {
    const { planilha: p } = api();
    const dados = (n) => Array.from({ length: n }, (_, i) => [`GHE-${String(100 + (i % 40))}`, `Setor ${i % 40}`, `EPI ${i % 25}`, 'Obrigatório']);
    const excedido = p.montarLinhas(planilha(dados(1001)));
    assert.deepEqual([excedido.ok, excedido.codigo, excedido.total], [false, 'LINHAS_EXCEDIDAS', 1001]);
    assert.equal('linhas' in excedido, false, 'nada é devolvido pela metade');
    const exato = p.montarLinhas(planilha(dados(1000)));
    assert.deepEqual([exato.ok, exato.linhas.length, exato.linhas.at(-1).linha], [true, 1000, 1001]);
    assert.equal(p.montarLinhas(planilha([])).codigo, 'SEM_DADOS');
    assert.equal(p.montarLinhas(planilha([[null, null, null, null]])).codigo, 'SEM_DADOS');
  });
});

describe('módulo: chamadas à API', () => {
  test('preview e confirmação: POST com corpo SÓ { linhas }, sem campos de autoridade, empresa ou ator', async () => {
    const { acoes, planilha: p } = api();
    const linhas = p.montarLinhas(planilha(BASICA)).linhas;
    await acoes.previa(linhas);
    await acoes.confirmar(linhas);
    assert.deepEqual(chamadas.map((c) => `${c.metodo} ${c.caminho}`), ['POST /api/grupos-homogeneos/importacao/preview', 'POST /api/grupos-homogeneos/importacao/confirmar']);
    for (const c of chamadas) {
      assert.deepEqual(Object.keys(c.corpo), ['linhas']);
      assert.deepEqual(c.corpo.linhas, linhas);
      assert.equal(/empresaId|usuarioId|situacao|aplicavel|resultado|importacaoId|gheId|resumo/.test(JSON.stringify(c.corpo)), false);
    }
  });
});

describe('módulo: textos humanos (nunca o enum técnico)', () => {
  test('situação do vínculo, situação do GHE, resultados, motivos, problemas e classificação', () => {
    const { rotulos } = api();
    const casos = {
      situacao: { NOVO_VINCULO: 'Novo vínculo', VINCULO_EXISTENTE: 'Vínculo existente', CLASSIFICACAO_ALTERADA: 'Classificação será alterada', EPI_NAO_ENCONTRADO: 'EPI não encontrado', EPI_AMBIGUO: 'EPI ambíguo', EPI_INATIVO: 'EPI inativo', GHE_INATIVO: 'GHE inativo', CONFLITO_GHE: 'Conflito de GHE', GHE_AMBIGUO: 'GHE ambíguo', DUPLICADA_NO_ARQUIVO: 'Linha duplicada', CONFLITO_NO_ARQUIVO: 'Conflito no arquivo', LINHA_INVALIDA: 'Linha inválida' },
      situacaoGhe: { GHE_NOVO: 'Novo GHE', GHE_EXISTENTE: 'GHE existente', LEGADO_RECEBERA_CODIGO: 'GHE existente receberá código', CONFLITO_GHE: 'Conflito de GHE', AMBIGUO: 'GHE ambíguo' },
      resultadoLinha: { APLICADA: 'Aplicada', SEM_ALTERACAO: 'Sem alteração', BLOQUEADA: 'Não aplicada' },
      resultadoGhe: { CRIADO: 'GHE criado', CODIGO_ATRIBUIDO: 'Código atribuído ao GHE', SEM_ALTERACAO: 'Sem alteração', BLOQUEADO: 'Não aplicado' },
      classificacao: { OBRIGATORIO: 'Obrigatório', NAO_OBRIGATORIO: 'Não obrigatório' },
    };
    for (const [funcao, mapa] of Object.entries(casos)) {
      for (const [codigo, texto] of Object.entries(mapa)) assert.equal(rotulos[funcao](codigo), texto, `${funcao}(${codigo})`);
    }
    assert.match(rotulos.motivo('CODIGO_COM_DESCRICAO_DIFERENTE'), /código já existe com outra descrição/i);
    assert.match(rotulos.motivo('DESCRICAO_COM_OUTRO_CODIGO'), /outro código/i);
    assert.match(rotulos.motivo('DESCRICAO_DIVERGENTE_NO_ARQUIVO'), /descrições diferentes/i);
    assert.match(rotulos.motivo('DESCRICAO_REPETIDA_NO_ARQUIVO'), /códigos diferentes/i);
    assert.match(rotulos.problema('GHE_CODIGO_INVALIDO'), /GHE-/);
    assert.match(rotulos.problema('CLASSIFICACAO_INVALIDA'), /Obrigatório ou Não obrigatório/);
    for (const [funcao, valor] of [['situacao', 'ALGO_NOVO_DO_SERVIDOR'], ['situacaoGhe', 'ALGO_NOVO'], ['motivo', 'MOTIVO_NOVO'], ['problema', 'PROBLEMA_NOVO']]) {
      assert.equal(tecnico.test(rotulos[funcao](valor)), false, `${funcao}: código desconhecido não vaza`);
    }
  });
});

describe('módulo: render do preview e do resultado', () => {
  const previa = () => previaDe(planilhaLinhas());
  function planilhaLinhas() { return api().planilha.montarLinhas(planilha(BASICA)).linhas; }

  test('uma linha por linha da planilha, sete células, linha bloqueada continua visível e explicada, tudo escapado', () => {
    const { render } = api();
    const p = previa();
    p.linhas.push({ ...p.linhas[0], linha: 9, ghe: null, descricao: '<img src=x onerror=1>', epi: null, situacao: 'LINHA_INVALIDA', aplicavel: false, problemas: [{ campo: 'ghe', codigo: 'GHE_CODIGO_OBRIGATORIO' }, { campo: 'epi', codigo: 'EPI_OBRIGATORIO' }] });
    const linhas = celulas(render.linhasPrevia(p.linhas));
    assert.equal(linhas.length, 4);
    for (const l of linhas) assert.equal(l.length, 7, 'Linha | GHE | Descrição | EPI | Classificação | Resultado | Observação');
    assert.deepEqual(linhas[0].slice(0, 6).map(semTags), ['2', 'GHE-020', 'Montagem Nova', 'Capacete', 'Obrigatório', 'Novo vínculo']);
    assert.deepEqual(linhas[2].slice(0, 6).map(semTags), ['4', 'GHE-021', 'Pintura', 'Inexistente', 'Obrigatório', 'EPI não encontrado']);
    assert.deepEqual(linhas[3].slice(0, 3).map(semTags), ['9', '—', '&lt;img src=x onerror=1&gt;']);
    assert.match(semTags(linhas[3][6]), /Informe o código/);
    assert.equal(/<img/.test(render.linhasPrevia(p.linhas)), false);
    assert.equal(tecnico.test(semTags(render.linhasPrevia(p.linhas))), false);
  });

  test('o resumo usa os números do servidor, em linguagem humana, e avisa que as linhas bloqueadas não serão aplicadas', () => {
    const { render } = api();
    const texto = semTags(render.resumoPrevia(previa().resumo));
    assert.match(texto, /Linhas lidas:\s*3/);
    assert.match(texto, /Serão aplicadas:\s*2/);
    assert.match(texto, /Novo vínculo:\s*2/);
    assert.match(texto, /EPI não encontrado:\s*1/);
    assert.match(texto, /Novo GHE:\s*2/);
    assert.match(texto, /não serão aplicadas/i);
    assert.equal(tecnico.test(texto), false);
  });

  test('o resultado final distingue aplicadas, sem alteração e não aplicadas; sem alteração nenhuma diz que nada foi necessário', () => {
    const { render } = api();
    const aplicada = semTags(render.resumoResultado(resultadoDe(previa()), 'a3f2'));
    assert.match(aplicada, /Importação concluída/);
    assert.match(aplicada, /GHEs criados:\s*1/);
    assert.match(aplicada, /Vínculos criados:\s*2/);
    assert.match(aplicada, /Linhas não aplicadas:\s*1/);
    const nada = semTags(render.resumoResultado({ ...resultadoDe(previa(), { importacaoId: null, aplicadas: 0, ghesCriados: 0 }) }, null));
    assert.match(nada, /Nenhuma alteração necessária/);
    assert.equal(/Importação concluída/.test(nada), false, 'não diz que algo foi importado');
  });
});

describe('módulo: mensagens de erro', () => {
  test('413, 400 por excesso de linhas, 400 genérico, 401, 403, 500 e rede, em texto amigável e sem falso sucesso', () => {
    const { mensagens } = api();
    const erro = (status, codigo, detalhes) => mensagens.erro({ ok: false, status, codigo, detalhes });
    assert.equal(erro(413, 'PAYLOAD_MUITO_GRANDE'), 'O arquivo possui dados demais para esta importação.');
    assert.match(erro(400, 'VALIDACAO', [{ campo: 'body.linhas', codigo: 'TAMANHO_MAXIMO' }]), /1000 linhas/);
    assert.match(erro(400, 'VALIDACAO', [{ campo: 'body.linhas.3.ghe', codigo: 'TAMANHO_MAXIMO' }]), /campo|texto|longo/i);
    assert.match(erro(400, 'VALIDACAO'), /inválidos/i);
    assert.match(erro(401, 'SESSAO_INVALIDA'), /sessão/i);
    assert.match(erro(403, 'SEM_PERMISSAO'), /permissão/i);
    assert.match(erro(500, 'ERRO_INTERNO'), /Não foi possível concluir/);
    assert.match(mensagens.erro({ ok: false, status: 0 }), /rede/i);
    for (const [s, c] of [[413, 'PAYLOAD_MUITO_GRANDE'], [400, 'VALIDACAO'], [401, 'SESSAO_INVALIDA'], [403, 'SEM_PERMISSAO'], [500, 'ERRO_INTERNO']]) {
      assert.equal(tecnico.test(erro(s, c)), false, c);
      assert.equal(/sucesso|conclu[ií]da/i.test(erro(s, c)), false, `${c}: sem falso sucesso`);
    }
  });

  test('erros locais do arquivo: formato, vazio, ilegível, colunas ausentes (com o nome da coluna) e excesso de linhas', () => {
    const { mensagens } = api();
    assert.match(mensagens.arquivo({ codigo: 'FORMATO_INVALIDO' }), /\.xlsx/);
    assert.match(mensagens.arquivo({ codigo: 'FORMATO_XLS' }), /\.xlsx/);
    assert.match(mensagens.arquivo({ codigo: 'ARQUIVO_VAZIO' }), /vazio/i);
    assert.match(mensagens.arquivo({ codigo: 'CONTEUDO_INCOMPATIVEL' }), /\.xlsx/);
    assert.match(mensagens.arquivo({ codigo: 'XLSX_ILEGIVEL' }), /ler/i);
    assert.match(mensagens.arquivo({ codigo: 'COLUNAS_AUSENTES', faltando: ['DESCRIÇÃO', 'EPI'] }), /DESCRIÇÃO.*EPI/);
    assert.match(mensagens.arquivo({ codigo: 'SEM_DADOS' }), /nenhuma linha/i);
    assert.match(mensagens.arquivo({ codigo: 'LINHAS_EXCEDIDAS', total: 1001 }), /1000/);
    for (const c of ['FORMATO_INVALIDO', 'XLSX_ILEGIVEL', 'COLUNAS_AUSENTES', 'SEM_DADOS', 'LINHAS_EXCEDIDAS']) assert.equal(tecnico.test(mensagens.arquivo({ codigo: c, faltando: ['GHE'] })), false, c);
  });
});

describe('inspeção estática: pages/employee-groups.html', () => {
  const html = ler('pages/employee-groups.html');
  const codigoFonte = html.replace(/<!--[\s\S]*?-->/g, '');
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);

  test('carrega a biblioteca XLSX já existente e o módulo novo, antes do módulo de GHE; sem CDN novo; módulo na allowlist de publicação', () => {
    const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
    assert.deepEqual(scripts, [
      '../js/tema.js', '../js/api-http.js', '../portal/config.js', '../js/sessao-empresarial.js', '../js/permissoes-efetivas.js', '../js/pagina-base.js',
      '../vendor/read-excel-file-9.3.10.min.js', '../js/importacao-ghe.js', '../js/grupos-homogeneos.js',
    ]);
    assert.ok(fs.existsSync(path.join(RAIZ, 'vendor/read-excel-file-9.3.10.min.js')));
    assert.match(ler('publicacao/allowlist.json'), /"js\/importacao-ghe\.js"/);
    assert.equal(/cdn\.|unpkg|jsdelivr|localStorage|sessionStorage/.test(codigoFonte.replace(/fonts\.googleapis\.com/g, '')), false);
  });

  test('seletor só de .xlsx, escondido e rotulado; painel com resumo, tabela de conferência e botões Confirmar e Cancelar', () => {
    assert.match(html, /<input type="file" id="arquivoImportacaoGhe" accept="\.xlsx"[^>]*aria-label="[^"]+"/);
    assert.match(html, /<input type="file" id="arquivoImportacaoGhe"[^>]*\bhidden\b|<input type="file" id="arquivoImportacaoGhe"[^>]*display:none/);
    for (const id of ['painelImportacaoGhe', 'importacaoArquivo', 'importacaoAviso', 'importacaoResumo', 'importacaoCorpo', 'botaoConfirmarImportacao', 'botaoCancelarImportacao']) assert.ok(ids.includes(id), `falta #${id}`);
    assert.match(html, /<[^>]*id="painelImportacaoGhe"[^>]*\bhidden\b/);
    const inicio = html.lastIndexOf('<thead>', html.indexOf('id="importacaoCorpo"'));
    const cabecalhos = [...html.slice(inicio, html.indexOf('</thead>', inicio)).matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => semTags(m[1]));
    assert.deepEqual(cabecalhos, ['Linha', 'GHE', 'Descrição', 'EPI', 'Classificação', 'Resultado', 'Observação']);
    assert.match(html, /id="botaoConfirmarImportacao"[^>]*>[\s\S]*?Confirmar importação/);
    assert.match(html, /id="botaoCancelarImportacao"[^>]*>[\s\S]*?Cancelar/);
    assert.match(html, /Importação de GHE \/ EPIs/);
    assert.match(html, /role="status"[^>]*id="importacaoAviso"|id="importacaoAviso"[^>]*role="status"/);
  });
});

describe('página: abrir o fluxo e ler o arquivo', () => {
  test('o botão agora abre o seletor de arquivo (não mostra mais "em integração")', async () => {
    const pg = montarPagina(servidorImp().responder);
    await pg.esperar();
    await pg.clicar('botaoImportarGhe');
    assert.equal(pg.el('arquivoImportacaoGhe').cliques, 1);
    assert.equal(/integra/i.test(pg.el('aviso').innerHTML), false);
  });

  test('arquivo que não é .xlsx é recusado com mensagem amigável, sem ler nem chamar a API', async () => {
    const pg = montarPagina(servidorImp().responder);
    await pg.esperar();
    const antes = chamadas.length;
    await pg.escolherArquivo(arquivoFalso('dados.csv', planilha(BASICA)));
    assert.equal(chamadas.length, antes);
    assert.equal(pg.leituras.length, 0);
    assert.match(semTags(pg.el('importacaoAviso').innerHTML + pg.el('aviso').innerHTML), /\.xlsx/);
    assert.equal(pg.el('botaoConfirmarImportacao').disabled, true);
  });

  test('coluna obrigatória ausente: mensagem com o nome da coluna e nenhuma chamada de preview', async () => {
    for (const [indice, nome] of [[0, 'GHE'], [1, 'DESCRIÇÃO'], [2, 'EPI'], [3, 'CLASSIFICAÇÃO']]) {
      const pg = montarPagina(servidorImp().responder);
      await pg.esperar();
      const matriz = planilha(BASICA.map((l) => l.filter((_, i) => i !== indice)), { cabecalho: CABECALHO.filter((_, i) => i !== indice) });
      await pg.escolherArquivo(arquivoFalso('f.xlsx', matriz));
      assert.equal(previas().length, 0, nome);
      assert.match(semTags(pg.el('importacaoAviso').innerHTML + pg.el('aviso').innerHTML), new RegExp(nome), nome);
    }
  });

  test('a leitura usa a biblioteca existente (window.readXlsxFile) e o preview recebe TODAS as linhas de uma vez, no formato { linhas }', async () => {
    const pg = montarPagina(servidorImp().responder);
    const arquivo = await importar(pg, planilha([...BASICA, [null, null, null, null], ['GHE-022', null, 'Capacete', null]]));
    assert.deepEqual(pg.leituras, [arquivo]);
    assert.equal(previas().length, 1, 'uma única requisição de preview (sem lotes)');
    assert.deepEqual(Object.keys(previas()[0].corpo), ['linhas']);
    assert.deepEqual(previas()[0].corpo.linhas.map((l) => l.linha), [2, 3, 4, 6], 'linha vazia ignorada, parcial enviada, número real preservado');
    assert.deepEqual(previas()[0].corpo.linhas[3], { ghe: 'GHE-022', descricao: null, epi: 'Capacete', classificacao: null, linha: 6 });
    assert.equal(/situacao|aplicavel|resultado|empresaId|importacaoId/.test(JSON.stringify(previas()[0].corpo)), false);
  });

  test('mais de 1000 linhas é bloqueado antes da API, sem truncar nem dividir; exatamente 1000 vai em UMA requisição', async () => {
    const dados = (n) => Array.from({ length: n }, (_, i) => [`GHE-${100 + (i % 40)}`, `Setor ${i % 40}`, `EPI ${i % 25}`, 'Obrigatório']);
    const excedido = montarPagina(servidorImp().responder);
    await importar(excedido, planilha(dados(1001)));
    assert.equal(previas().length, 0);
    assert.match(semTags(excedido.el('importacaoAviso').innerHTML + excedido.el('aviso').innerHTML), /1000/);

    const exato = montarPagina(servidorImp().responder);
    await importar(exato, planilha(dados(1000)));
    assert.equal(previas().length, 1);
    assert.equal(previas()[0].corpo.linhas.length, 1000);
  });
});

describe('página: preview', () => {
  test('mostra o painel com o arquivo, o resumo do servidor e a tabela de conferência; a linha bloqueada continua visível e humanizada', async () => {
    const pg = montarPagina(servidorImp().responder);
    await importar(pg, planilha(BASICA), 'cobresul.xlsx');
    assert.equal(pg.el('painelImportacaoGhe').hidden, false);
    assert.match(pg.el('importacaoArquivo').textContent, /cobresul\.xlsx/);
    assert.match(pg.el('importacaoArquivo').textContent, /3/);
    const resumo = semTags(pg.el('importacaoResumo').innerHTML);
    assert.match(resumo, /Linhas lidas:\s*3/);
    assert.match(resumo, /Serão aplicadas:\s*2/);
    assert.match(resumo, /não serão aplicadas/i);
    const linhas = celulas(pg.el('importacaoCorpo').innerHTML);
    assert.deepEqual(linhas.map((l) => l.slice(0, 6).map(semTags)), [
      ['2', 'GHE-020', 'Montagem Nova', 'Capacete', 'Obrigatório', 'Novo vínculo'],
      ['3', 'GHE-020', 'Montagem Nova', 'Luva de Raspa', 'Não obrigatório', 'Novo vínculo'],
      ['4', 'GHE-021', 'Pintura', 'Inexistente', 'Obrigatório', 'EPI não encontrado'],
    ]);
    assert.equal(tecnico.test(semTags(pg.el('importacaoCorpo').innerHTML + pg.el('importacaoResumo').innerHTML)), false);
    assert.equal(pg.el('botaoConfirmarImportacao').disabled, false);
  });

  test('só depois do preview a confirmação fica disponível; preview com erro não a habilita e mostra mensagem amigável (413, 401, 403, 500, 400)', async () => {
    const casos = [[413, 'PAYLOAD_MUITO_GRANDE', /dados demais/], [403, 'SEM_PERMISSAO', /permissão/i], [500, 'ERRO_INTERNO', /Não foi possível concluir/], [400, 'VALIDACAO', /inválidos/i]];
    for (const [status, codigo, esperado] of casos) {
      const pg = montarPagina(servidorImp({ previa: () => erroApi(status, codigo) }).responder);
      await importar(pg);
      assert.match(semTags(pg.el('importacaoAviso').innerHTML), esperado, codigo);
      assert.equal(tecnico.test(pg.el('importacaoAviso').innerHTML), false, codigo);
      assert.equal(pg.el('botaoConfirmarImportacao').disabled, true, `${codigo}: confirmar bloqueado`);
      assert.equal(confirmacoesHttp().length, 0);
    }
    const sessao = montarPagina(servidorImp({ previa: () => erroApi(401, 'SESSAO_INVALIDA') }).responder);
    await importar(sessao);
    assert.equal(sessao.sandbox.encerrada, true, '401 devolve ao Portal');
  });

  test('duplo clique: enquanto o preview está em andamento uma segunda escolha não dispara outra requisição', async () => {
    const gate = comporta();
    const pg = montarPagina(servidorImp({ previa: (corpo) => gate.porta.then(() => resposta(200, previaDe(corpo.linhas))) }).responder);
    await pg.esperar();
    const primeiro = pg.escolherSemEsperar(arquivoFalso('a.xlsx', planilha(BASICA)));
    await pg.esperar();
    const segundo = pg.escolherSemEsperar(arquivoFalso('b.xlsx', planilha(BASICA)));
    await pg.esperar();
    gate.liberar();
    await Promise.all([primeiro, segundo]);
    await pg.esperar();
    assert.equal(previas().length, 1);
  });
});

describe('página: confirmação', () => {
  test('exige confirmação humana com o aviso certo; recusar não grava nada', async () => {
    const pg = montarPagina(servidorImp().responder, { confirmar: false });
    await importar(pg);
    await pg.clicar('botaoConfirmarImportacao');
    assert.equal(pg.confirmacoes.length, 1);
    assert.match(pg.confirmacoes[0], /serão aplicadas/i);
    assert.match(pg.confirmacoes[0], /não serão aplicadas/i);
    assert.match(pg.confirmacoes[0], /não são removidos/i);
    assert.equal(confirmacoesHttp().length, 0);
  });

  test('confirma reenviando as linhas ORIGINAIS (iguais às do preview), nunca o resultado do preview', async () => {
    const pg = montarPagina(servidorImp().responder);
    await importar(pg, planilha([...BASICA, ['GHE-022', null, 'Capacete', null]]));
    await pg.clicar('botaoConfirmarImportacao');
    assert.equal(confirmacoesHttp().length, 1);
    const confirmacao = confirmacoesHttp()[0];
    assert.deepEqual(Object.keys(confirmacao.corpo), ['linhas']);
    assert.deepEqual(confirmacao.corpo.linhas, previas()[0].corpo.linhas);
    assert.equal(/situacao|aplicavel|resultado|gheId|tipoMaterialId|importacaoId|resumo|empresaId/.test(JSON.stringify(confirmacao.corpo)), false);
  });

  test('sucesso: resultado humanizado, lista de GHE recarregada e a área EPIs selecionada é fechada (sem estado residual)', async () => {
    const srv = servidorImp();
    const pg = montarPagina(srv.responder);
    await pg.esperar();
    await pg.acaoGrupo('selecionar', 5);
    assert.ok(chamadas.some((c) => /\/5\/tipos-material$/.test(c.caminho)));
    await pg.escolherArquivo(arquivoFalso('f.xlsx', planilha(BASICA)));
    const antes = chamadas.length;
    const listagensAntes = srv.estado.listagens;
    await pg.clicar('botaoConfirmarImportacao');
    const depois = chamadas.slice(antes);
    assert.ok(depois.length > 0, 'a confirmação deveria ter sido enviada');
    assert.equal(depois[0].caminho, '/api/grupos-homogeneos/importacao/confirmar');
    assert.equal(srv.estado.listagens, listagensAntes + 1, 'a lista de GHE foi recarregada');
    assert.equal(depois.some((c) => /tipos-material|\/materiais/.test(c.caminho)), false, 'nenhuma leitura de EPIs depois da importação');
    assert.match(pg.el('tiposCorpo').innerHTML, /Escolha um GHE/);
    assert.equal(pg.el('tiposGhe').textContent, 'Escolha um GHE para ver os EPIs.');
    assert.equal(/class="selecionado"/.test(pg.el('gruposCorpo').innerHTML), false);
    const resultado = semTags(pg.el('importacaoResumo').innerHTML + pg.el('importacaoAviso').innerHTML);
    assert.match(resultado, /Importação concluída/);
    assert.match(resultado, /GHEs criados:\s*1/);
    const linhas = celulas(pg.el('importacaoCorpo').innerHTML).map((l) => semTags(l[5]));
    assert.deepEqual(linhas, ['Aplicada', 'Aplicada', 'Não aplicada']);
    assert.equal(tecnico.test(resultado), false);
  });

  test('sem nenhuma alteração (importacaoId nulo): "Nenhuma alteração necessária", sem dizer que algo foi importado', async () => {
    const pg = montarPagina(servidorImp({ confirmar: (corpo) => resposta(200, resultadoDe(previaDe(corpo.linhas), { importacaoId: null, aplicadas: 0, ghesCriados: 0 })) }).responder);
    await importar(pg);
    await pg.clicar('botaoConfirmarImportacao');
    const texto = semTags(pg.el('importacaoResumo').innerHTML + pg.el('importacaoAviso').innerHTML);
    assert.match(texto, /Nenhuma alteração necessária/);
    assert.equal(/Importação concluída/.test(texto), false);
  });

  test('falha da confirmação (500, 413, 403, 400): sem falso sucesso, preview mantido, nova tentativa possível e lista não recarregada; 401 volta ao Portal', async () => {
    for (const [status, codigo, esperado] of [[500, 'ERRO_INTERNO', /Não foi possível concluir/], [413, 'PAYLOAD_MUITO_GRANDE', /dados demais/], [403, 'SEM_PERMISSAO', /permissão/i], [400, 'VALIDACAO', /inválidos/i]]) {
      const srv = servidorImp({ confirmar: () => erroApi(status, codigo) });
      const pg = montarPagina(srv.responder);
      await importar(pg);
      const listagens = srv.estado.listagens;
      await pg.clicar('botaoConfirmarImportacao');
      const texto = semTags(pg.el('importacaoAviso').innerHTML);
      assert.match(texto, esperado, codigo);
      assert.equal(/Importação concluída/.test(texto + semTags(pg.el('importacaoResumo').innerHTML)), false, `${codigo}: sem falso sucesso`);
      assert.equal(celulas(pg.el('importacaoCorpo').innerHTML).length, 3, `${codigo}: o preview continua na tela`);
      assert.equal(pg.el('botaoConfirmarImportacao').disabled, false, `${codigo}: dá para tentar de novo`);
      assert.equal(srv.estado.listagens, listagens, `${codigo}: a lista não foi recarregada`);
    }
    const sessao = montarPagina(servidorImp({ confirmar: () => erroApi(401, 'SESSAO_INVALIDA') }).responder);
    await importar(sessao);
    await sessao.clicar('botaoConfirmarImportacao');
    assert.equal(sessao.sandbox.encerrada, true);
  });

  test('duplo clique em Confirmar: uma única confirmação enviada', async () => {
    const gate = comporta();
    const pg = montarPagina(servidorImp({ confirmar: (corpo) => gate.porta.then(() => resposta(200, resultadoDe(previaDe(corpo.linhas)))) }).responder);
    await importar(pg);
    const primeiro = pg.dispararSemEsperar('botaoConfirmarImportacao', 'click');
    await pg.esperar();
    const segundo = pg.dispararSemEsperar('botaoConfirmarImportacao', 'click');
    await pg.esperar();
    assert.equal(pg.el('botaoConfirmarImportacao').disabled, true, 'desabilitado enquanto envia');
    gate.liberar();
    await Promise.all([primeiro, segundo]);
    await pg.esperar();
    assert.equal(confirmacoesHttp().length, 1);
  });
});

describe('página: cancelar, nova importação e permissões', () => {
  test('cancelar antes de confirmar limpa o fluxo (painel, linhas, seletor) e não chama a confirmação', async () => {
    const pg = montarPagina(servidorImp().responder);
    await importar(pg);
    await pg.clicar('botaoCancelarImportacao');
    assert.equal(pg.el('painelImportacaoGhe').hidden, true);
    assert.equal(pg.el('arquivoImportacaoGhe').value, '');
    assert.equal(pg.el('importacaoCorpo').innerHTML, '');
    assert.equal(confirmacoesHttp().length, 0);
    await pg.clicar('botaoConfirmarImportacao');
    assert.equal(confirmacoesHttp().length, 0, 'depois de cancelar não há o que confirmar');
  });

  test('uma nova importação não reaproveita nada da anterior (arquivo, linhas, preview, mensagens)', async () => {
    const pg = montarPagina(servidorImp().responder);
    await importar(pg, planilha(BASICA), 'primeiro.xlsx');
    await pg.clicar('botaoConfirmarImportacao');
    await pg.escolherArquivo(arquivoFalso('segundo.xlsx', planilha([['GHE-030', 'Solda', 'Capacete', 'Obrigatório']])));
    assert.equal(previas().length, 2);
    assert.deepEqual(previas()[1].corpo.linhas, [{ ghe: 'GHE-030', descricao: 'Solda', epi: 'Capacete', classificacao: 'Obrigatório', linha: 2 }]);
    assert.match(pg.el('importacaoArquivo').textContent, /segundo\.xlsx/);
    assert.equal(celulas(pg.el('importacaoCorpo').innerHTML).length, 1);
    assert.equal(/Importação concluída/.test(semTags(pg.el('importacaoResumo').innerHTML + pg.el('importacaoAviso').innerHTML)), false);
    await pg.clicar('botaoConfirmarImportacao');
    assert.ok(confirmacoesHttp().length > 0, 'a confirmação do arquivo novo deveria ter sido enviada');
    assert.deepEqual(confirmacoesHttp().at(-1).corpo.linhas, previas()[1].corpo.linhas, 'a confirmação usa as linhas do arquivo novo');
  });

  test('o botão de importação só existe para quem tem criar E editar', async () => {
    for (const [permissao, escondido] of [[acesso({ criar: true, editar: true }), false], [acesso({ criar: true }), true], [acesso({ editar: true }), true], [acesso(), true]]) {
      const pg = montarPagina(servidorImp().responder, { acessoDaPagina: permissao });
      await pg.esperar();
      assert.strictEqual(pg.el('botaoImportarGhe').hidden, escondido);
    }
  });

  test('durante preview e confirmação não há nenhuma chamada de GHE × material ou GHE × tipo; só a recarga da lista depois do sucesso', async () => {
    const pg = montarPagina(servidorImp().responder);
    await importar(pg);
    await pg.clicar('botaoConfirmarImportacao');
    assert.ok(chamadas.every((c) => c.caminho.startsWith('/api/grupos-homogeneos')));
    assert.equal(chamadas.some((c) => /tipos-material|\/materiais/.test(c.caminho)), false);
    assert.deepEqual(chamadas.map((c) => `${c.metodo} ${c.caminho}`).filter((c) => !/pagina=1/.test(c)), ['POST /api/grupos-homogeneos/importacao/preview', 'POST /api/grupos-homogeneos/importacao/confirmar']);
  });
});
