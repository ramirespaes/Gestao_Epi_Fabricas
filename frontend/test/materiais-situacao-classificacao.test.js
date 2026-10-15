'use strict';

/**
 * Etapa A2 (RED) — Gestão de Estoque › Estoque por lote: situação da classificação do material escolhido.
 *
 * Decisões de 11/10/2026: D1 — a situação aparece numa linha abaixo do seletor "Material" (o seletor não muda); D2 — o
 * texto explica a relação entre o material, o tipo do catálogo e a previsão por GHE, sem afirmar previsão em todos os
 * GHEs ou trabalhadores; D3 — o tipo indisponível (id sem a confirmação do estado) é tratado defensivamente.
 *
 * Interface esperada (só dados estruturados que o backend já devolve; nunca o nome):
 *   - js/materiais.js: `formulario.situacaoClassificacao(m)` → 'LEGADO' (modelo diferente de V2), 'CATALOGO' (V2 com
 *     tipoMaterialId e tipoMaterialAtivo === true), 'TIPO_INATIVO' (=== false), 'TIPO_INDISPONIVEL' (id sem estado
 *     confirmado), 'OUTROS' (V2 sem tipoMaterialId); `mensagens.textoClassificacao(m)` → o texto da linha ('' sem material);
 *   - pages/materials.html: `#materialClassificacaoAtual` (class="helper", role="status", aria-live="polite") logo abaixo
 *     de #gradeMaterialHelper, escrito só por textContent quando o estoque do material é mostrado; limpo sem material ou
 *     na falha da consulta.
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

const BASE = 'http://localhost:3000/api';
const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const OUTROS = 'Outros';

const BASE_MATERIAL = {
  empresaId: 3, fabricante: 'Fab', caNumero: null, caValidade: null, prazoUsoDias: 180, unidade: 'par', estoqueMinimo: 0, codigoInterno: null,
  descricao: null, exigeTamanho: false, oculosComGrau: null, ativo: true, categoriaDescricao: null, grupoProtecaoDescricao: null, tipoDescricao: null,
};
const CATALOGO_ATIVO = { ...BASE_MATERIAL, id: 1, nome: 'Luva nitrílica azul', codigoInterno: 'LUV-01', modeloClassificacao: 'V2', categoria: 'EPI', grupoProtecao: 'Proteção das mãos', tipoMaterialId: 7, tipo: 'Luva de Segurança', tipoMaterialAtivo: true };
const TIPO_INATIVO = { ...CATALOGO_ATIVO, id: 2, nome: 'Luva antiga', codigoInterno: null, tipoMaterialId: 8, tipo: 'Luva Descontinuada', tipoMaterialAtivo: false };
const TIPO_INDISPONIVEL = { ...CATALOGO_ATIVO, id: 3, nome: 'Luva sem confirmação', codigoInterno: null, tipoMaterialId: 9, tipo: 'Luva X', tipoMaterialAtivo: null };
const OUTROS_GRUPO = { ...BASE_MATERIAL, id: 4, nome: 'Chave de fenda isolada', modeloClassificacao: 'V2', categoria: OUTROS, categoriaDescricao: 'Ferramenta', grupoProtecao: null, tipoMaterialId: null, tipo: OUTROS, tipoDescricao: 'Chave isolada', tipoMaterialAtivo: null };
const OUTROS_PROTECAO = { ...BASE_MATERIAL, id: 5, nome: 'Manta antichama', modeloClassificacao: 'V2', categoria: 'EPI', grupoProtecao: OUTROS, grupoProtecaoDescricao: 'Proteção contra arco elétrico', tipoMaterialId: null, tipo: OUTROS, tipoDescricao: 'Manta', tipoMaterialAtivo: null };
const OUTROS_TIPO = { ...BASE_MATERIAL, id: 6, nome: 'Manga térmica especial', modeloClassificacao: 'V2', categoria: 'Vestimenta', grupoProtecao: 'Proteção dos braços', tipoMaterialId: null, tipo: OUTROS, tipoDescricao: 'Manga térmica', tipoMaterialAtivo: null };
const LEGADO = { ...BASE_MATERIAL, id: 7, nome: 'Capacete de Segurança', modeloClassificacao: 'LEGADO', categoria: 'EPI', grupoProtecao: null, tipoMaterialId: null, tipo: 'Capacete de Segurança', tipoMaterialAtivo: null };
const SEM_MODELO = { ...BASE_MATERIAL, id: 8, nome: 'Óculos antigo', categoria: 'EPI', grupoProtecao: null, tipoMaterialId: null, tipo: 'Óculos de proteção', tipoMaterialAtivo: null };
const HTML_EM_OUTROS = { ...OUTROS_TIPO, id: 9, nome: 'Item com descrição estranha', tipoDescricao: '<img src=x onerror=alert(1)>' };
const MATERIAIS = [CATALOGO_ATIVO, TIPO_INATIVO, TIPO_INDISPONIVEL, OUTROS_GRUPO, OUTROS_PROTECAO, OUTROS_TIPO, LEGADO, SEM_MODELO, HTML_EM_OUTROS];

const F = () => new Proxy(EpiMateriais.formulario, { get: (a, n) => (n in a ? a[n] : () => assert.fail(`ainda não implementado: formulario.${String(n)}`)) });
const M = () => new Proxy(EpiMateriais.mensagens, { get: (a, n) => (n in a ? a[n] : () => assert.fail(`ainda não implementado: mensagens.${String(n)}`)) });
const situacao = (m) => F().situacaoClassificacao(m);
const texto = (m) => M().textoClassificacao(m);
/** O texto nunca afirma previsão geral nem fala de estoque. */
function semPromessaNemEstoque(t, rotulo) {
  assert.doesNotMatch(t, /todos os (GHEs|trabalhadores|funcionários)|qualquer (GHE|trabalhador|funcionário)|previsto para todos/i, `${rotulo}: não promete previsão geral`);
  assert.doesNotMatch(t, /saldo|lote|físico|disponível para entrega|\b\d+\s*(un|unidades|pares?)\b/i, `${rotulo}: nada de estoque`);
}

// ═══════════════════════════════════════════════════════════════════
// Módulo: situacaoClassificacao (S1–S6)
// ═══════════════════════════════════════════════════════════════════
describe('A2 — formulario.situacaoClassificacao (S1–S6)', () => {
  test('S1 — V2 com tipo do catálogo ativo → CATALOGO', () => {
    assert.equal(situacao(CATALOGO_ATIVO), 'CATALOGO');
  });

  test('S2 — V2 com tipo do catálogo inativo → TIPO_INATIVO (o vínculo não some)', () => {
    assert.equal(situacao(TIPO_INATIVO), 'TIPO_INATIVO');
  });

  test('S3 — V2 com tipoMaterialId sem a confirmação do estado do tipo → TIPO_INDISPONIVEL', () => {
    assert.equal(situacao(TIPO_INDISPONIVEL), 'TIPO_INDISPONIVEL');
    assert.equal(situacao({ ...TIPO_INDISPONIVEL, tipoMaterialAtivo: undefined }), 'TIPO_INDISPONIVEL');
  });

  test('S4 — V2 sem tipo do catálogo → OUTROS, nas três formas (grupo, proteção ou tipo "Outros")', () => {
    assert.equal(situacao(OUTROS_GRUPO), 'OUTROS');
    assert.equal(situacao(OUTROS_PROTECAO), 'OUTROS');
    assert.equal(situacao(OUTROS_TIPO), 'OUTROS');
  });

  test('S5 — modelo diferente de V2 (LEGADO ou ausente) → LEGADO', () => {
    assert.equal(situacao(LEGADO), 'LEGADO');
    assert.equal(situacao(SEM_MODELO), 'LEGADO');
  });

  test('S6 — o nome nunca decide: nome e tipo em texto iguais a um tipo do catálogo, sem tipoMaterialId, nunca viram CATALOGO', () => {
    assert.equal(situacao(LEGADO), 'LEGADO');
    assert.equal(situacao({ ...OUTROS_TIPO, nome: 'Luva de Segurança', tipoDescricao: 'Luva de Segurança' }), 'OUTROS');
    assert.equal(situacao({ ...CATALOGO_ATIVO, nome: 'Qualquer coisa', tipo: 'Outro nome' }), 'CATALOGO', 'o id é que decide, não o nome');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Módulo: textoClassificacao (T1–T5)
// ═══════════════════════════════════════════════════════════════════
describe('A2 — mensagens.textoClassificacao (T1–T5)', () => {
  test('T1 — CATALOGO: nome do tipo, grupo e proteção; a previsão por tipo vale só nos GHEs que têm o tipo vinculado', () => {
    const t = texto(CATALOGO_ATIVO);
    assert.match(t, /Tipo do catálogo: Luva de Segurança/);
    assert.match(t, /EPI \/ Proteção das mãos/);
    assert.match(t, /previsão por tipo/i);
    assert.match(t, /GHEs? que t[eê]m (esse|este) tipo vinculado/i);
    semPromessaNemEstoque(t, 'T1');
  });

  test('T2 — TIPO_INATIVO: diz que o tipo está inativo e que o vínculo existente continua valendo', () => {
    const t = texto(TIPO_INATIVO);
    assert.match(t, /Tipo do catálogo inativo: Luva Descontinuada/);
    assert.match(t, /vínculo/i);
    assert.match(t, /continua/i);
    semPromessaNemEstoque(t, 'T2');
  });

  test('T3 — TIPO_INDISPONIVEL: não foi possível confirmar o tipo do catálogo', () => {
    const t = texto(TIPO_INDISPONIVEL);
    assert.match(t, /Não foi possível confirmar o tipo do catálogo/);
    semPromessaNemEstoque(t, 'T3');
  });

  test('T4 — OUTROS: as descrições específicas (grupo, proteção e tipo efetivos), sem tipo do catálogo, só por vínculo direto', () => {
    const grupo = texto(OUTROS_GRUPO);
    assert.match(grupo, /^Outros: Chave isolada \(Ferramenta\)/);
    const protecao = texto(OUTROS_PROTECAO);
    assert.match(protecao, /^Outros: Manta \(EPI \/ Proteção contra arco elétrico\)/);
    const tipo = texto(OUTROS_TIPO);
    assert.match(tipo, /^Outros: Manga térmica \(Vestimenta \/ Proteção dos braços\)/);
    for (const [t, r] of [[grupo, 'grupo'], [protecao, 'proteção'], [tipo, 'tipo']]) {
      assert.match(t, /sem tipo do catálogo/i, r);
      assert.match(t, /vínculo direto/i, r);
      semPromessaNemEstoque(t, `T4 ${r}`);
    }
  });

  test('T5 — LEGADO: cadastro antigo, sem tipo do catálogo, só por vínculo direto; nada é convertido sozinho', () => {
    for (const m of [LEGADO, SEM_MODELO]) {
      const t = texto(m);
      assert.match(t, /legado/i);
      assert.match(t, /sem tipo do catálogo/i);
      assert.match(t, /vínculo direto/i);
      semPromessaNemEstoque(t, 'T5');
    }
    assert.equal(texto(null), '');
    assert.equal(texto(undefined), '');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Página em DOM simulado (G1–G3)
// ═══════════════════════════════════════════════════════════════════
const CONTEXTO = { empresa: { id: 3, nome: 'Empresa Demonstração SafeWork' }, usuario: { id: 7, nome: 'Pessoa', email: 'p@exemplo-cliente.com.br', perfil: 'MASTER' } };
const PERMISSOES = { recursos: { materials: { visualizar: true, criar: true, editar: true, excluir: false } }, acoes: { ENTRADA_ESTOQUE: true, BAIXA_ESTOQUE: true }, administracao: {} };
const resposta = (status, corpo) => ({ status, ok: status >= 200 && status < 300, text: async () => (corpo === undefined ? '' : JSON.stringify(corpo)) });

let chamadas;
/** `falhaEstoque`: ids cujo GET /materiais/:id/estoque/lotes responde 500. */
function servidor({ materiais = MATERIAIS, falhaEstoque = [] } = {}) {
  chamadas = [];
  EpiHttp.configurar({
    baseUrl: BASE,
    fetch: async (url, opcoes) => {
      const u = new URL(url);
      chamadas.push({ metodo: opcoes.method, caminho: u.pathname + u.search });
      const p = u.pathname;
      if (p === '/api/tipos-material' && opcoes.method === 'GET') return resposta(200, { status: 'ok', tipos: [], total: 0, pagina: 1, limite: 100 });
      if (p === '/api/materiais' && opcoes.method === 'GET') return resposta(200, { status: 'ok', materiais, total: materiais.length, pagina: 1, limite: 100 });
      const lotes = p.match(/^\/api\/materiais\/(\d+)\/estoque(\/lotes)?$/);
      if (lotes) {
        const id = Number(lotes[1]);
        if (falhaEstoque.includes(id)) return resposta(500, { status: 'erro', codigo: 'ERRO_INTERNO' });
        const material = materiais.find((x) => x.id === id);
        return material ? resposta(200, { status: 'ok', material, saldos: [], lotes: [], totais: { fisico: 12, bloqueado: 0, disponivel: 12 } }) : resposta(404, { status: 'erro', codigo: 'MATERIAL_NAO_ENCONTRADO' });
      }
      const m = p.match(/^\/api\/materiais\/(\d+)$/);
      if (m && opcoes.method === 'GET') { const mat = materiais.find((x) => x.id === Number(m[1])); return mat ? resposta(200, { status: 'ok', material: mat }) : resposta(404, { status: 'erro', codigo: 'MATERIAL_NAO_ENCONTRADO' }); }
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
  return {
    el, esperar,
    escolher: async (id) => { el('gradeMaterial').value = id === '' ? '' : String(id); await disparar('gradeMaterial', 'change'); },
    linha: () => el('materialClassificacaoAtual').textContent,
    opcoesSeletor: () => [...el('gradeMaterial').innerHTML.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map((m) => [m[1], m[2]]),
  };
}
/** A linha exigida não vazia (ausência = falha funcional). */
function exigirLinha(pg, rotulo) {
  const t = pg.linha();
  assert.ok(t, `${rotulo}: #materialClassificacaoAtual vazio`);
  return t;
}

describe('A2 — página: inspeção estática', () => {
  test('#materialClassificacaoAtual logo abaixo de #gradeMaterialHelper, helper anunciado, vazio, escrito só por textContent', () => {
    const html = ler('pages/materials.html');
    const depoisDoHelper = html.slice(html.indexOf('id="gradeMaterialHelper"'));
    const proxima = /<[^>]*\bid="([^"]+)"[^>]*>/g;
    proxima.lastIndex = depoisDoHelper.indexOf('>') + 1;
    const seguinte = proxima.exec(depoisDoHelper);
    assert.ok(seguinte && seguinte[1] === 'materialClassificacaoAtual', `o elemento seguinte ao helper deveria ser #materialClassificacaoAtual; é ${seguinte && seguinte[1]}`);
    for (const atributo of [/\bclass="helper"/, /\brole="status"/, /\baria-live="polite"/]) assert.match(seguinte[0], atributo);
    assert.match(depoisDoHelper, /id="materialClassificacaoAtual"[^>]*><\//, 'começa vazio');
    const script = html.slice(html.lastIndexOf('<script>'));
    assert.match(script, /\$\('materialClassificacaoAtual'\)\.textContent\s*=/);
    assert.equal(/materialClassificacaoAtual'\)\.innerHTML/.test(script), false);
  });

  test('G3 — o seletor "Material" e o formulário homologado da A3 continuam no HTML como estão', () => {
    const html = ler('pages/materials.html');
    assert.match(html, /<select id="gradeMaterial" class="select" style="flex:1"><\/select>/);
    assert.match(html, /<span id="pictogramaMaterialAtual" class="pictograma-material-atual" aria-hidden="true" hidden><\/span>/);
    for (const id of ['materialTipoEstado', 'materialProtecaoEstado', 'materialNome', 'materialCategoria', 'materialGrupoProtecao', 'materialTipo', 'materialOculosComGrau']) {
      assert.match(html, new RegExp(`\\bid="${id}"`), id);
    }
    assert.ok(html.indexOf('id="materialClassificacaoAtual"') > html.indexOf('id="gradeMaterial"'), 'a linha nova fica no card do estoque, não no formulário');
  });
});

describe('A2 — página: a linha da classificação (G1–G3)', () => {
  test('G1 — cada situação mostra o seu texto ao escolher o material; nenhuma fala de estoque nem promete todos os GHEs', async () => {
    const pg = montarPagina();
    await pg.esperar();
    for (const [m, re] of [
      [CATALOGO_ATIVO, /^Tipo do catálogo: Luva de Segurança/], [TIPO_INATIVO, /^Tipo do catálogo inativo: Luva Descontinuada/],
      [TIPO_INDISPONIVEL, /Não foi possível confirmar o tipo do catálogo/], [OUTROS_GRUPO, /^Outros: Chave isolada \(Ferramenta\)/],
      [OUTROS_TIPO, /^Outros: Manga térmica \(Vestimenta \/ Proteção dos braços\)/], [LEGADO, /legado/i],
    ]) {
      await pg.escolher(m.id);
      const t = exigirLinha(pg, m.nome);
      assert.match(t, re, m.nome);
      semPromessaNemEstoque(t, m.nome);
      assert.equal(t, texto(m), `${m.nome}: o mesmo texto do módulo`);
    }
  });

  test('G1 — sem material escolhido ou com falha na consulta do estoque, a linha fica vazia', async () => {
    const pg = montarPagina({ falhaEstoque: [LEGADO.id] });
    await pg.esperar();
    await pg.escolher(CATALOGO_ATIVO.id);
    exigirLinha(pg, 'antes de desmarcar');
    await pg.escolher('');
    assert.equal(pg.linha(), '', 'sem material');
    await pg.escolher(CATALOGO_ATIVO.id);
    exigirLinha(pg, 'antes da falha');
    await pg.escolher(LEGADO.id);
    assert.equal(pg.linha(), '', 'falha na consulta');
  });

  test('G2 — descrição com aparência de HTML aparece como texto, sem interpretação', async () => {
    const pg = montarPagina();
    await pg.esperar();
    await pg.escolher(HTML_EM_OUTROS.id);
    const t = exigirLinha(pg, 'HTML');
    assert.ok(t.includes('<img src=x onerror=alert(1)>'), t);
    assert.equal(pg.el('materialClassificacaoAtual').innerHTML, '');
  });

  test('G3 — o seletor continua só com nome · código; o pictograma segue funcionando; o formulário não é tocado pela escolha', async () => {
    const pg = montarPagina();
    await pg.esperar();
    assert.deepEqual(pg.opcoesSeletor().slice(0, 3), [['', 'Selecione um material'], ['1', 'Luva nitrílica azul · LUV-01'], ['2', 'Luva antiga']]);
    pg.el('materialNome').value = 'Rascunho do cadastro';
    await pg.escolher(CATALOGO_ATIVO.id);
    exigirLinha(pg, 'linha presente');
    assert.equal(pg.el('pictogramaMaterialAtual').hidden, false);
    assert.equal(pg.el('pictogramaMaterialAtual').filhos.length, 1);
    assert.equal(pg.el('materialNome').value, 'Rascunho do cadastro');
    assert.equal(pg.el('materialCategoria').value, '');
  });
});
