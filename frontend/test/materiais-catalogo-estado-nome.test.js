'use strict';

/**
 * Etapa A3 (RED) — Gestão de Estoque › Cadastro de Materiais: estado do catálogo junto ao Tipo e sugestão do nome.
 *
 * O cadastro já usa o catálogo compartilhado com a Gestão de GHE (GET /tipos-material por Grupo + Grupo de Proteção, valor
 * = id, envio por tipoMaterialId). Decisões de 11/10/2026: D1 — o nome é sugerido SÓ no cadastro novo (na edição, o nome
 * existente fica); D2 — a caixa "Óculos com grau" e suas validações não mudam; D3 — "Outros" e os "Especifique…" não
 * mudam (nenhum campo novo, nenhuma migration); D4 — estados: não selecionado, carregando, disponível, vazio, sem
 * permissão e falha.
 *
 * Interface esperada:
 *   - js/materiais.js: `formulario.sugestaoNome({ nomeAtual, sugestaoAnterior, tipoNome })` → o nome que o campo deve ter:
 *     vazio (só espaços) ou ainda igual à sugestão anterior → o nome do tipo ('' quando não há tipo do catálogo, como em
 *     "Outros"); personalizado → o próprio nome, intacto;
 *   - pages/materials.html: `#materialTipoEstado` (role="status", aria-live) junto ao campo Tipo, escrito só por
 *     textContent: "Escolha o grupo de proteção…", "Carregando tipos do catálogo…", "N tipo(s) do catálogo para
 *     <Grupo> / <Proteção>.", "Nenhum tipo do catálogo para <Grupo> / <Proteção>…" com a orientação de cadastrar o tipo ou
 *     usar "Outros", e nas falhas o texto de `mensagens.erroCatalogo` (rede, 403, servidor) — sem confundir vazio com falha.
 *   - o vínculo continua só por tipoMaterialId; o nome nunca escolhe o tipo.
 *
 * Arquivo novo; nenhum teste existente foi alterado.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const EpiHttp = require('../js/api-http');
const EpiMateriais = require('../js/materiais');
const P = require('../js/permissoes-efetivas');
const { GRUPOS_PROTECAO } = require('../../backend/test/integracao/helpers/classificacao-v2');

const BASE = 'http://localhost:3000/api';
const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const F = EpiMateriais.formulario;
const OUTROS = 'Outros';

const CATALOGO = [
  { id: 11, grupo: 'EPI', grupoProtecao: 'Proteção auditiva', nome: 'Protetor Auricular Concha', ativo: true, origem: 'BASE' },
  { id: 12, grupo: 'EPI', grupoProtecao: 'Proteção auditiva', nome: 'Protetor Auricular Plug', ativo: true, origem: 'BASE' },
  { id: 13, grupo: 'EPI', grupoProtecao: 'Proteção ocular', nome: 'Óculos de Proteção Incolor', ativo: true, origem: 'BASE' },
  { id: 14, grupo: 'EPI', grupoProtecao: 'Proteção ocular', nome: 'Visor Panorâmico', ativo: true, origem: 'MANUAL' },
  { id: 15, grupo: 'EPI', grupoProtecao: 'Proteção auditiva', nome: 'Protetor Antigo', ativo: false, origem: 'MANUAL' },
  { id: 21, grupo: 'Vestimenta', grupoProtecao: 'Proteção do tronco', nome: 'Avental de Segurança', ativo: true, origem: 'BASE' },
];
const V2_CONCHA = {
  id: 78, empresaId: 3, nome: 'Concha azul', categoria: 'EPI', categoriaDescricao: null, grupoProtecao: 'Proteção auditiva', grupoProtecaoDescricao: null,
  tipoMaterialId: 11, tipo: 'Protetor Auricular Concha', tipoDescricao: null, modeloClassificacao: 'V2', tipoMaterialAtivo: true, fabricante: 'Fab',
  caNumero: null, caValidade: null, prazoUsoDias: 180, unidade: 'unidade', estoqueMinimo: 0, codigoInterno: null, descricao: null, exigeTamanho: false,
  oculosComGrau: null, ativo: true,
};

// Função do módulo que ainda não existe no RED: falha com asserção clara (nunca TypeError).
const formulario = () => new Proxy(F, { get: (alvo, nome) => (nome in alvo ? alvo[nome] : () => assert.fail(`ainda não implementado: formulario.${String(nome)}`)) });

// ═══════════════════════════════════════════════════════════════════
// Módulo: sugestaoNome
// ═══════════════════════════════════════════════════════════════════
describe('A3 — módulo: formulario.sugestaoNome', () => {
  const s = (nomeAtual, sugestaoAnterior, tipoNome) => formulario().sugestaoNome({ nomeAtual, sugestaoAnterior, tipoNome });

  test('nome vazio (ou só espaços) recebe o nome do tipo', () => {
    assert.equal(s('', null, 'Protetor Auricular Concha'), 'Protetor Auricular Concha');
    assert.equal(s('   ', null, 'Protetor Auricular Concha'), 'Protetor Auricular Concha');
  });

  test('nome ainda igual à sugestão anterior acompanha a troca de tipo', () => {
    assert.equal(s('Protetor Auricular Concha', 'Protetor Auricular Concha', 'Protetor Auricular Plug'), 'Protetor Auricular Plug');
  });

  test('nome personalizado nunca é sobrescrito', () => {
    assert.equal(s('Concha azul 3M', 'Protetor Auricular Concha', 'Protetor Auricular Plug'), 'Concha azul 3M');
    assert.equal(s('Kit especial', null, 'Protetor Auricular Plug'), 'Kit especial');
  });

  test('sem tipo do catálogo ("Outros" ou tipo limpo): a sugestão intacta é apagada; o nome manual fica', () => {
    assert.equal(s('Protetor Auricular Concha', 'Protetor Auricular Concha', ''), '');
    assert.equal(s('Kit especial', 'Protetor Auricular Concha', ''), 'Kit especial');
    assert.equal(s('', null, ''), '');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Página em DOM simulado
// ═══════════════════════════════════════════════════════════════════
const CONTEXTO = { empresa: { id: 3, nome: 'Empresa Demonstração SafeWork' }, usuario: { id: 7, nome: 'Pessoa', email: 'p@exemplo-cliente.com.br', perfil: 'MASTER' } };
const PERMISSOES = { recursos: { materials: { visualizar: true, criar: true, editar: true, excluir: false } }, acoes: { ENTRADA_ESTOQUE: true, BAIXA_ESTOQUE: true }, administracao: {} };
const resposta = (status, corpo) => ({ status, ok: status >= 200 && status < 300, text: async () => (corpo === undefined ? '' : JSON.stringify(corpo)) });

let chamadas;
/**
 * `falhaCatalogo`: 'rede' (fetch rejeita), 403 ou 500 no GET /tipos-material. `atrasos`: { <grupoProtecao>: Promise } —
 * a resposta dessa proteção só sai quando a promessa resolver (estado "carregando" e resposta antiga).
 */
function servidor({ materiais = [], catalogo = CATALOGO, falhaCatalogo = null, atrasos = {} } = {}) {
  chamadas = [];
  EpiHttp.configurar({
    baseUrl: BASE,
    fetch: async (url, opcoes) => {
      const u = new URL(url);
      const corpo = opcoes && opcoes.body ? JSON.parse(opcoes.body) : undefined;
      chamadas.push({ metodo: opcoes.method, caminho: u.pathname + u.search, corpo });
      const p = u.pathname;
      if (p === '/api/tipos-material' && opcoes.method === 'GET') {
        const g = u.searchParams.get('grupo'); const gp = u.searchParams.get('grupoProtecao'); const ativo = u.searchParams.get('ativo');
        if (atrasos[gp]) await atrasos[gp];
        if (falhaCatalogo === 'rede') throw new TypeError('Failed to fetch');
        if (falhaCatalogo === 403) return resposta(403, { status: 'erro', codigo: 'SEM_PERMISSAO', mensagem: 'texto do servidor' });
        if (falhaCatalogo === 500) return resposta(500, { status: 'erro', codigo: 'ERRO_INTERNO', mensagem: 'texto do servidor' });
        const tipos = catalogo.filter((t) => (!g || t.grupo === g) && (!gp || t.grupoProtecao === gp) && (ativo === null || String(t.ativo) === ativo));
        return resposta(200, { status: 'ok', tipos, total: tipos.length, pagina: 1, limite: 100, vocabulario: { grupos: ['EPI', 'Vestimenta'], gruposProtecao: [...GRUPOS_PROTECAO] } });
      }
      if (p === '/api/materiais' && opcoes.method === 'GET') return resposta(200, { status: 'ok', materiais, total: materiais.length, pagina: 1, limite: 100 });
      if (p === '/api/materiais' && opcoes.method === 'POST') return resposta(201, { status: 'ok', material: { ...V2_CONCHA, ...corpo, id: 999 } });
      const m = p.match(/^\/api\/materiais\/(\d+)$/);
      if (m && opcoes.method === 'GET') { const mat = materiais.find((x) => x.id === Number(m[1])); return mat ? resposta(200, { status: 'ok', material: mat }) : resposta(404, { status: 'erro', codigo: 'MATERIAL_NAO_ENCONTRADO' }); }
      if (m && opcoes.method === 'PATCH') { const mat = materiais.find((x) => x.id === Number(m[1])) || {}; return resposta(200, { status: 'ok', material: { ...mat, ...corpo } }); }
      if (/^\/api\/materiais\/\d+\/estoque(\/lotes)?$/.test(p)) return resposta(200, { status: 'ok', material: materiais[0] || V2_CONCHA, saldos: [], lotes: [], totais: {} });
      return resposta(404, { status: 'erro', codigo: 'NAO_ENCONTRADO' });
    },
  });
}

function montarPagina(opcoes = {}) {
  servidor(opcoes);
  const html = ler('pages/materials.html');
  const script = html.slice(html.lastIndexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));
  const SELECTS = new Set(['materialCategoria', 'materialGrupoProtecao', 'materialTipo', 'materialUnidade', 'materialValidade', 'materialValidadeTipo', 'materialTamanhoEntrada', 'gradeMaterial',
    'materialRegistrarEntrada', 'entradaTamanho', 'materialControleTamanho', 'baixaLote', 'baixaMotivo']);
  const mapa = {};
  const elemento = (id) => {
    const listeners = {};
    return {
      id, value: '', checked: false, textContent: '', innerHTML: '', disabled: false, selectedIndex: 0, style: {}, atributos: {}, listeners,
      tagName: SELECTS.has(id) ? 'SELECT' : 'INPUT', hidden: false, filhos: [], replaceChildren(...nos) { this.filhos = nos; },
      addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
      setAttribute(k, v) { this.atributos[k] = v; }, removeAttribute(k) { delete this.atributos[k]; }, focus() {},
      querySelector() { return elemento('form-grid'); }, querySelectorAll() { return []; },
    };
  };
  const el = (id) => (mapa[id] = mapa[id] || elemento(id));
  const noSvg = (ns, tag) => ({ namespaceURI: ns, tagName: tag, atributos: {}, filhos: [], setAttribute(k, v) { this.atributos[k] = String(v); }, appendChild(n) { this.filhos.push(n); return n; } });
  const sandbox = {
    document: { getElementById: el, querySelectorAll: () => [], createElementNS: noSvg },
    window: { SAFEWORK_PORTAL_API_BASE_URL: BASE },
    EpiHttp, EpiMateriais, EpiEstoqueMinimos: require('../js/estoque-minimos'), EpiCatalogoVisual: require('../js/catalogo-visual'), // eslint-disable-line global-require
    EpiPermissoes: { prepararPagina: async () => ({ permissoes: PERMISSOES, podeAlterar: true }), acao: P.acao, recurso: P.recurso, somenteLeitura() {} },
    EpiSessaoEmpresarial: { montar: async () => CONTEXTO, sessaoEncerrada() {} },
    showToast() {}, console, setTimeout, Promise, String, Number, Array, Object, JSON, crypto: globalThis.crypto,
  };
  vm.runInNewContext(script, sandbox);
  const esperar = async () => { for (let i = 0; i < 40; i += 1) await new Promise((r) => setImmediate(r)); };
  const disparar = async (id, ev = 'click') => { for (const fn of (el(id).listeners[ev] || [])) await fn(); await esperar(); };
  /** Dispara sem esperar o fim (para observar o estado enquanto a consulta está pendente). */
  const dispararSemEsperar = (id, ev = 'change') => Promise.all((el(id).listeners[ev] || []).map((fn) => fn()));
  const preencher = (c) => { for (const [id, v] of Object.entries(c)) el(id).value = v; };
  const visivel = (id) => el(id).style.display !== 'none';
  const opcoesDe = (id) => [...el(id).innerHTML.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map((x) => x[1]);
  return { el, esperar, disparar, dispararSemEsperar, preencher, visivel, opcoes: opcoesDe, estado: () => el('materialTipoEstado').textContent };
}
const CAMPOS_FIXOS = { materialControleTamanho: 'grade', materialUnidade: 'Par', materialEstoqueMinimo: '5', materialValidadeTipo: 'meses', materialPrazo: '6', materialRegistrarEntrada: 'nao' };
const posts = () => chamadas.filter((c) => c.metodo === 'POST' && c.caminho === '/api/materiais').map((c) => c.corpo);
const consultasCatalogo = () => chamadas.filter((c) => c.metodo === 'GET' && c.caminho.startsWith('/api/tipos-material'));
async function escolher(pg, categoria, protecao, tipo) {
  pg.el('materialCategoria').value = categoria; await pg.disparar('materialCategoria', 'change');
  if (protecao !== undefined) { pg.el('materialGrupoProtecao').value = protecao; await pg.disparar('materialGrupoProtecao', 'change'); }
  if (tipo !== undefined) await escolherTipo(pg, tipo);
}
async function escolherTipo(pg, tipo) { pg.el('materialTipo').value = tipo; await pg.disparar('materialTipo', 'change'); }
async function abrirEdicao(pg, id) {
  pg.el('gradeMaterial').value = String(id);
  await pg.disparar('gradeMaterial', 'change');
  await pg.disparar('botaoEditarMaterial');
}
/** Promessa que o teste resolve quando quiser. */
function adiada() { let soltar; const promessa = new Promise((r) => { soltar = r; }); return { promessa, soltar }; }
const exigirEstado = (pg, re, rotulo) => assert.match(pg.estado(), re, `${rotulo}: #materialTipoEstado = "${pg.estado()}"`);

describe('A3 — página: inspeção estática', () => {
  test('#materialTipoEstado existe junto ao campo Tipo, anunciado (role="status" e aria-live) e começa vazio', () => {
    const html = ler('pages/materials.html');
    const campoTipo = html.slice(html.indexOf('<label for="materialTipo">'), html.indexOf('id="customMaterialTypeField"'));
    assert.match(campoTipo, /<select id="materialTipo"/);
    assert.match(campoTipo, /<[^>]*\bid="materialTipoEstado"[^>]*>/, 'o estado fica no mesmo campo do Tipo');
    const tag = /<[^>]*\bid="materialTipoEstado"[^>]*>/.exec(campoTipo)[0];
    assert.match(tag, /\brole="status"/);
    assert.match(tag, /\baria-live="polite"/);
    assert.match(campoTipo, /id="materialTipoEstado"[^>]*><\//, 'começa vazio');
  });

  test('N8 — o estado é escrito só por textContent (nunca innerHTML) no script da página', () => {
    const html = ler('pages/materials.html');
    const script = html.slice(html.lastIndexOf('<script>'));
    assert.match(script, /\$\('materialTipoEstado'\)\.textContent\s*=/);
    assert.equal(/materialTipoEstado'\)\.innerHTML/.test(script), false);
  });
});

describe('A3 — página: estados do catálogo junto ao Tipo (E1–E5)', () => {
  test('E1 — grupo do catálogo sem proteção: orienta escolher a proteção e não consulta o catálogo', async () => {
    const pg = montarPagina();
    await pg.esperar();
    await escolher(pg, 'EPI');
    assert.equal(consultasCatalogo().length, 1, 'só a consulta por Grupo (proteções do catálogo)');
    exigirEstado(pg, /Escolha o grupo de proteção/, 'sem proteção');
  });

  test('E2 — carregando e depois disponível: "Carregando…" enquanto a consulta está pendente; depois a contagem e os tipos ativos (valor = id)', async () => {
    const atraso = adiada();
    const pg = montarPagina({ atrasos: { 'Proteção auditiva': atraso.promessa } });
    await pg.esperar();
    await escolher(pg, 'EPI');
    pg.el('materialGrupoProtecao').value = 'Proteção auditiva';
    const pendente = pg.dispararSemEsperar('materialGrupoProtecao');
    await new Promise((r) => setImmediate(r));
    exigirEstado(pg, /Carregando tipos do catálogo/, 'pendente');
    atraso.soltar();
    await pendente;
    await pg.esperar();
    exigirEstado(pg, /\b2 tipos do catálogo para EPI \/ Proteção auditiva\b/, 'disponível');
    assert.deepEqual(pg.opcoes('materialTipo'), ['', '11', '12', OUTROS]);

    await escolher(pg, 'Vestimenta', 'Proteção do tronco');
    exigirEstado(pg, /\b1 tipo do catálogo para Vestimenta \/ Proteção do tronco\b/, 'singular');
  });

  test('E3 — catálogo vazio para a combinação: só "Outros" e a orientação de cadastrar o tipo ou usar "Outros" (texto diferente da falha)', async () => {
    const pg = montarPagina();
    await pg.esperar();
    await escolher(pg, 'EPI', 'Proteção dos pés');
    assert.equal(consultasCatalogo().length, 2, 'consulta por Grupo e consulta por Tipo');
    assert.deepEqual(pg.opcoes('materialTipo'), ['', OUTROS]);
    exigirEstado(pg, /Nenhum tipo do catálogo para EPI \/ Proteção dos pés/, 'vazio');
    exigirEstado(pg, /Tipos de EPI \/ Vestimenta/, 'vazio: onde cadastrar');
    exigirEstado(pg, /"Outros"/, 'vazio: alternativa');
    for (const falha of [EpiMateriais.mensagens.erroCatalogo({ status: 0 }), EpiMateriais.mensagens.erroCatalogo({ status: 500 }), EpiMateriais.mensagens.erroCatalogo({ status: 403 })]) {
      assert.equal(pg.estado().includes(falha), false, 'vazio não é falha');
    }
  });

  test('E4 — falha de rede, do servidor e sem permissão: cada uma com o texto de mensagens.erroCatalogo junto ao campo (nunca o do vazio)', async () => {
    for (const [falha, status] of [['rede', 0], [500, 500], [403, 403]]) {
      const pg = montarPagina({ falhaCatalogo: falha });
      await pg.esperar();
      await escolher(pg, 'EPI', 'Proteção auditiva');
      const esperado = EpiMateriais.mensagens.erroCatalogo({ status });
      assert.ok(pg.estado().includes(esperado), `${falha}: esperado "${esperado}"; veio "${pg.estado()}"`);
      assert.equal(/Nenhum tipo do catálogo/.test(pg.estado()), false, `${falha}: falha não é vazio`);
      assert.equal(pg.estado().includes('texto do servidor'), false);
    }
    assert.match(EpiMateriais.mensagens.erroCatalogo({ status: 403 }), /perfil não pode consultar o catálogo/, 'premissa: o 403 tem texto próprio');
  });

  test('E5 — resposta antiga não sobrescreve: a proteção trocada no meio da consulta vence (opções e estado)', async () => {
    const atraso = adiada();
    const pg = montarPagina({ atrasos: { 'Proteção auditiva': atraso.promessa } });
    await pg.esperar();
    await escolher(pg, 'EPI');
    pg.el('materialGrupoProtecao').value = 'Proteção auditiva';
    const antiga = pg.dispararSemEsperar('materialGrupoProtecao');
    await new Promise((r) => setImmediate(r));
    pg.el('materialGrupoProtecao').value = 'Proteção ocular';
    await pg.disparar('materialGrupoProtecao', 'change');
    atraso.soltar();
    await antiga;
    await pg.esperar();
    assert.deepEqual(pg.opcoes('materialTipo'), ['', '13', '14', OUTROS]);
    exigirEstado(pg, /\b2 tipos do catálogo para EPI \/ Proteção ocular\b/, 'a resposta vigente');
    assert.equal(/Proteção auditiva/.test(pg.estado()), false);
  });
});

describe('A3 — página: sugestão do nome no cadastro novo (N1–N7)', () => {
  test('N1 — nome vazio: escolher o tipo preenche o nome com o nome do tipo (editável)', async () => {
    const pg = montarPagina();
    await pg.esperar();
    await escolher(pg, 'EPI', 'Proteção auditiva', '11');
    assert.equal(pg.el('materialNome').value, 'Protetor Auricular Concha');
    assert.equal(pg.el('materialNome').disabled, false);
  });

  test('N2 — nome já digitado não muda ao escolher o tipo', async () => {
    const pg = montarPagina();
    await pg.esperar();
    pg.el('materialNome').value = 'Meu protetor';
    await escolher(pg, 'EPI', 'Proteção auditiva', '11');
    exigirEstado(pg, /\b2 tipos do catálogo\b/, 'estado presente');
    assert.equal(pg.el('materialNome').value, 'Meu protetor');
  });

  test('N3 — sugestão intacta acompanha a troca de tipo', async () => {
    const pg = montarPagina();
    await pg.esperar();
    await escolher(pg, 'EPI', 'Proteção auditiva', '11');
    assert.equal(pg.el('materialNome').value, 'Protetor Auricular Concha');
    await escolherTipo(pg, '12');
    assert.equal(pg.el('materialNome').value, 'Protetor Auricular Plug');
  });

  test('N4 — sugestão editada pela pessoa fica, mesmo trocando o tipo', async () => {
    const pg = montarPagina();
    await pg.esperar();
    await escolher(pg, 'EPI', 'Proteção auditiva', '11');
    assert.equal(pg.el('materialNome').value, 'Protetor Auricular Concha');
    pg.el('materialNome').value = 'Concha azul 3M';
    await pg.disparar('materialNome', 'input');
    await escolherTipo(pg, '12');
    assert.equal(pg.el('materialNome').value, 'Concha azul 3M');
  });

  test('N5 — "Outros": a sugestão intacta é apagada e o nome fica para a pessoa; nome manual é preservado; "Especifique o tipo" segue obrigatório', async () => {
    const pg = montarPagina();
    await pg.esperar();
    await escolher(pg, 'EPI', 'Proteção auditiva', '11');
    assert.equal(pg.el('materialNome').value, 'Protetor Auricular Concha');
    await escolherTipo(pg, OUTROS);
    assert.equal(pg.el('materialNome').value, '');
    assert.equal(pg.visivel('customMaterialTypeField'), true);

    pg.el('materialNome').value = 'Kit especial';
    await escolherTipo(pg, '12');
    await escolherTipo(pg, OUTROS);
    assert.equal(pg.el('materialNome').value, 'Kit especial');
    pg.preencher(CAMPOS_FIXOS);
    await pg.disparar('botaoSalvar');
    assert.equal(posts().length, 0, 'sem "Especifique o tipo" nada é enviado');
  });

  test('N6 — o POST leva tipoMaterialId do tipo escolhido e o nome do campo; o nome nunca escolhe o tipo; nenhum campo novo', async () => {
    const pg = montarPagina();
    await pg.esperar();
    await escolher(pg, 'EPI', 'Proteção auditiva', '11');
    pg.preencher(CAMPOS_FIXOS);
    await pg.disparar('botaoSalvar');
    const [sugerido] = posts();
    assert.ok(sugerido, 'houve POST');
    assert.equal(sugerido.nome, 'Protetor Auricular Concha');
    assert.equal(sugerido.tipoMaterialId, 11);

    const pg2 = montarPagina();
    await pg2.esperar();
    pg2.el('materialNome').value = 'Protetor Auricular Plug';
    await escolher(pg2, 'EPI', 'Proteção auditiva', '11');
    pg2.preencher(CAMPOS_FIXOS);
    await pg2.disparar('botaoSalvar');
    const [manual] = posts();
    assert.equal(manual.tipoMaterialId, 11, 'o nome igual ao de outro tipo não muda o tipo escolhido');
    assert.equal(manual.nome, 'Protetor Auricular Plug');
    assert.deepEqual(Object.keys(manual).sort(), Object.keys(sugerido).sort(), 'mesmos campos com e sem sugestão');
  });

  test('N7 — edição: o nome gravado nunca muda sozinho, nem ao trocar o tipo; o PATCH não leva nome', async () => {
    const pg = montarPagina({ materiais: [V2_CONCHA] });
    await pg.esperar();
    await abrirEdicao(pg, 78);
    assert.equal(pg.el('materialNome').value, 'Concha azul');
    exigirEstado(pg, /\b2 tipos do catálogo para EPI \/ Proteção auditiva\b/, 'edição também mostra o estado');
    await escolherTipo(pg, '12');
    assert.equal(pg.el('materialNome').value, 'Concha azul');
    await pg.disparar('botaoSalvar');
    const patch = chamadas.find((c) => c.metodo === 'PATCH' && c.caminho === '/api/materiais/78');
    assert.ok(patch, 'houve PATCH');
    assert.equal(Object.hasOwn(patch.corpo, 'nome'), false);
    assert.equal(patch.corpo.tipoMaterialId, 12);
  });
});

describe('A3 — preservação (O1–O2)', () => {
  test('O1 — Óculos com grau: a caixa aparece em EPI + Proteção ocular (com a sugestão do nome) e some fora dela', async () => {
    const pg = montarPagina();
    await pg.esperar();
    await escolher(pg, 'EPI', 'Proteção ocular', '13');
    assert.equal(pg.el('materialNome').value, 'Óculos de Proteção Incolor');
    assert.equal(pg.visivel('campoOculosComGrau'), true);
    await escolher(pg, 'EPI', 'Proteção auditiva', '11');
    assert.equal(pg.visivel('campoOculosComGrau'), false);
  });

  test('O2 — Grupo "Outros": não consulta o catálogo, o estado de orientação some, o tipo fica em "Outros" com os dois "Especifique…" e o nome continua manual', async () => {
    const pg = montarPagina();
    await pg.esperar();
    await escolher(pg, 'EPI');
    exigirEstado(pg, /Escolha o grupo de proteção/, 'antes de "Outros"');
    pg.el('materialNome').value = 'Chave de fenda isolada';
    const consultasAntes = consultasCatalogo().length;
    await escolher(pg, OUTROS);
    assert.equal(consultasCatalogo().length, consultasAntes, '"Outros" não acrescenta consulta ao catálogo');
    assert.equal(pg.estado(), '', 'o catálogo não se aplica a "Outros"');
    assert.equal(pg.el('materialTipo').value, OUTROS);
    assert.equal(pg.visivel('campoCategoriaCustom'), true);
    assert.equal(pg.visivel('customMaterialTypeField'), true);
    assert.equal(pg.el('materialNome').value, 'Chave de fenda isolada');
  });
});
