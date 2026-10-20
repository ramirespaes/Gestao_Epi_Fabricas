'use strict';

/**
 * Etapa A3 — ajuste complementar (RED): Grupo de Proteção filtrado pelo catálogo da empresa no Cadastro de Materiais.
 *
 * Decisões de 11/10/2026: D1 — as proteções oferecidas são as que têm tipo ATIVO do Grupo escolhido no catálogo, na ordem
 * oficial das 12, mais "Outros"; nada de lista fixa por Grupo. D2 — se a consulta falhar, a lista completa volta como
 * contingência, SEMPRE com aviso visível de que as opções não foram validadas (nunca como se o catálogo as confirmasse).
 *
 * Interface esperada:
 *   - js/materiais.js: `formulario.protecoesDoCatalogo(tipos, grupo, manter)` → nomes das proteções com tipo ativo do Grupo
 *     (só os 12 do vocabulário, sem repetir, na ordem oficial), mais `manter` (a proteção gravada na edição) se for do
 *     vocabulário; `render.opcoesProtecao(lista)` → placeholder + lista (escapada) + "Outros"; sem argumento continua com
 *     as 12 + "Outros"; `mensagens.estadoProtecoes({ situacao: 'FALHA', resposta })` → o aviso da contingência;
 *   - pages/materials.html: ao escolher EPI ou Vestimenta, UMA consulta GET /tipos-material?grupo=<G>&ativo=true (sem
 *     grupoProtecao); resposta antiga descartada; `#materialProtecaoEstado` (role="status", aria-live) no campo da
 *     Proteção, escrito só por textContent, com o aviso da contingência enquanto ela valer;
 *   - o cadastro de TIPOS (seção do catálogo nesta página e o formulário da A1) continua com as 12 proteções.
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
const { GRUPOS_PROTECAO, CATALOGO_BASE } = require('../../backend/test/integracao/helpers/classificacao-v2');

const BASE = 'http://localhost:3000/api';
const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const OUTROS = 'Outros';

/** O catálogo base da empresa (o mesmo semeado pela 082), com ids 1..26. */
const CATALOGO = CATALOGO_BASE.map(([grupo, grupoProtecao, nome], i) => ({ id: i + 1, grupo, grupoProtecao, nome, ativo: true, origem: 'BASE' }));
const PROTECOES_EPI = GRUPOS_PROTECAO.filter((p) => p !== 'Proteção do tronco');

const V2_MANGA_OUTROS = {
  id: 90, empresaId: 3, nome: 'Manga térmica especial', categoria: 'Vestimenta', categoriaDescricao: null, grupoProtecao: 'Proteção dos braços',
  grupoProtecaoDescricao: null, tipoMaterialId: null, tipo: OUTROS, tipoDescricao: 'Manga térmica', modeloClassificacao: 'V2', fabricante: 'Fab',
  caNumero: null, caValidade: null, prazoUsoDias: 180, unidade: 'unidade', estoqueMinimo: 0, codigoInterno: null, descricao: null, exigeTamanho: false,
  oculosComGrau: null, ativo: true,
};

const F = () => new Proxy(EpiMateriais.formulario, { get: (a, n) => (n in a ? a[n] : () => assert.fail(`ainda não implementado: formulario.${String(n)}`)) });
const M = () => new Proxy(EpiMateriais.mensagens, { get: (a, n) => (n in a ? a[n] : () => assert.fail(`ainda não implementado: mensagens.${String(n)}`)) });
const valores = (html) => [...String(html).matchAll(/<option value="([^"]*)"[^>]*>/g)].map((m) => m[1]);

// ═══════════════════════════════════════════════════════════════════
// Módulo
// ═══════════════════════════════════════════════════════════════════
describe('A3 proteções — módulo', () => {
  test('protecoesDoCatalogo: só proteções com tipo ATIVO do Grupo, sem repetir, na ordem oficial; Grupo fora do catálogo → []', () => {
    const comInativo = [...CATALOGO, { id: 99, grupo: 'EPI', grupoProtecao: 'Proteção do tronco', nome: 'Colete antigo', ativo: false }];
    assert.deepEqual(F().protecoesDoCatalogo(comInativo, 'Vestimenta'), ['Proteção das pernas', 'Proteção do tronco']);
    assert.deepEqual(F().protecoesDoCatalogo(comInativo, 'EPI'), PROTECOES_EPI);
    assert.deepEqual(F().protecoesDoCatalogo(comInativo, OUTROS), []);
    assert.deepEqual(F().protecoesDoCatalogo(comInativo, ''), []);
  });

  test('protecoesDoCatalogo: `manter` (proteção gravada) entra na ordem oficial; valor fora do vocabulário nunca entra', () => {
    assert.deepEqual(F().protecoesDoCatalogo(CATALOGO, 'Vestimenta', 'Proteção dos braços'), ['Proteção das pernas', 'Proteção dos braços', 'Proteção do tronco']);
    assert.deepEqual(F().protecoesDoCatalogo(CATALOGO, 'Vestimenta', 'Proteção do tronco'), ['Proteção das pernas', 'Proteção do tronco']);
    const estranho = [{ id: 1, grupo: 'Vestimenta', grupoProtecao: '<img src=x onerror=1>', nome: 'X', ativo: true }];
    assert.deepEqual(F().protecoesDoCatalogo(estranho, 'Vestimenta', 'Proteção inventada'), []);
  });

  test('P9 — render.opcoesProtecao(lista): placeholder, a lista escapada e "Outros"; sem argumento continua com as 12 + "Outros"', () => {
    const html = EpiMateriais.render.opcoesProtecao(['Proteção das pernas', 'Proteção do tronco']);
    assert.deepEqual(valores(html), ['', 'Proteção das pernas', 'Proteção do tronco', OUTROS]);
    assert.deepEqual(valores(EpiMateriais.render.opcoesProtecao()), ['', ...GRUPOS_PROTECAO, OUTROS]);
    const perigoso = EpiMateriais.render.opcoesProtecao(['<b>x</b>"']);
    assert.equal(perigoso.includes('<b>'), false);
  });

  test('mensagens.estadoProtecoes: a contingência diz que as opções não foram validadas e que a lista completa está disponível', () => {
    for (const status of [0, 403, 500]) {
      const texto = M().estadoProtecoes({ situacao: 'FALHA', resposta: { status } });
      assert.match(texto, /Não foi possível validar/, String(status));
      assert.match(texto, /lista completa/, String(status));
    }
    assert.equal(M().estadoProtecoes({ situacao: 'DISPONIVEL' }), '');
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
 * `falhaGrupo`: 'rede' | 403 | 500 só na consulta por Grupo (sem grupoProtecao). `atrasos`: { <grupo>: Promise } —
 * a consulta por Grupo daquele Grupo só responde quando a promessa resolver.
 */
function servidor({ materiais = [], catalogo = CATALOGO, falhaGrupo = null, atrasos = {} } = {}) {
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
        if (gp === '') return resposta(400, { status: 'erro', codigo: 'VALIDACAO', detalhes: [{ campo: 'query.grupoProtecao', codigo: 'GRUPO_PROTECAO_INVALIDO' }] });
        if (gp === null) {
          if (atrasos[g]) await atrasos[g];
          if (falhaGrupo === 'rede') throw new TypeError('Failed to fetch');
          if (falhaGrupo === 403) return resposta(403, { status: 'erro', codigo: 'SEM_PERMISSAO' });
          if (falhaGrupo === 500) return resposta(500, { status: 'erro', codigo: 'ERRO_INTERNO' });
        }
        const tipos = catalogo.filter((t) => (!g || t.grupo === g) && (gp === null || t.grupoProtecao === gp) && (ativo === null || String(t.ativo) === ativo));
        return resposta(200, { status: 'ok', tipos, total: tipos.length, pagina: 1, limite: 100, vocabulario: { grupos: ['EPI', 'Vestimenta'], gruposProtecao: [...GRUPOS_PROTECAO] } });
      }
      if (p === '/api/materiais' && opcoes.method === 'GET') return resposta(200, { status: 'ok', materiais, total: materiais.length, pagina: 1, limite: 100 });
      if (p === '/api/materiais' && opcoes.method === 'POST') return resposta(201, { status: 'ok', material: { ...V2_MANGA_OUTROS, ...corpo, id: 999 } });
      const m = p.match(/^\/api\/materiais\/(\d+)$/);
      if (m && opcoes.method === 'GET') { const mat = materiais.find((x) => x.id === Number(m[1])); return mat ? resposta(200, { status: 'ok', material: mat }) : resposta(404, { status: 'erro', codigo: 'MATERIAL_NAO_ENCONTRADO' }); }
      if (m && opcoes.method === 'PATCH') { const mat = materiais.find((x) => x.id === Number(m[1])) || {}; return resposta(200, { status: 'ok', material: { ...mat, ...corpo } }); }
      if (/^\/api\/materiais\/\d+\/estoque(\/lotes)?$/.test(p)) return resposta(200, { status: 'ok', material: materiais[0] || V2_MANGA_OUTROS, saldos: [], lotes: [], totais: {} });
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
      tagName: SELECTS.has(id) ? 'SELECT' : 'INPUT', hidden: false, filhos: [], replaceChildren(...nos) { this.filhos = nos; }, appendChild(no) { this.filhos.push(no); return no; },
      addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
      setAttribute(k, v) { this.atributos[k] = v; }, removeAttribute(k) { delete this.atributos[k]; }, focus() {},
      querySelector() { return elemento('form-grid'); }, querySelectorAll() { return []; },
    };
  };
  const el = (id) => (mapa[id] = mapa[id] || elemento(id));
  const noSvg = (ns, tag) => ({ namespaceURI: ns, tagName: tag, atributos: {}, filhos: [], setAttribute(k, v) { this.atributos[k] = String(v); }, appendChild(n) { this.filhos.push(n); return n; } });
  const noHtml = (tag) => ({ tagName: String(tag).toUpperCase(), id: '', className: '', type: '', textContent: '', disabled: false, atributos: {}, setAttribute(k, v) { this.atributos[k] = String(v); } });
  const sandbox = {
    document: { getElementById: el, querySelectorAll: () => [], createElementNS: noSvg, createElement: noHtml },
    window: { SAFEWORK_PORTAL_API_BASE_URL: BASE, EpiTiposMaterial: require('../js/tipos-material') }, // eslint-disable-line global-require
    EpiHttp, EpiMateriais, EpiEstoqueMinimos: require('../js/estoque-minimos'), EpiCatalogoVisual: require('../js/catalogo-visual'), EpiImagensMaterial: { montar: () => ({ habilitar() {}, reiniciar() {}, definirGravada() {}, paraEnvio() {}, encerrar() {} }), mensagens: { deGravacao: () => null } }, // eslint-disable-line global-require
    EpiTiposMaterial: require('../js/tipos-material'), // eslint-disable-line global-require
    EpiPermissoes: { prepararPagina: async () => ({ permissoes: PERMISSOES, podeAlterar: true }), acao: P.acao, recurso: P.recurso, somenteLeitura() {} },
    EpiSessaoEmpresarial: { montar: async () => CONTEXTO, sessaoEncerrada() {} },
    showToast() {}, console, setTimeout, Promise, String, Number, Array, Object, JSON, crypto: globalThis.crypto,
  };
  vm.runInNewContext(script, sandbox);
  const esperar = async () => { for (let i = 0; i < 40; i += 1) await new Promise((r) => setImmediate(r)); };
  const disparar = async (id, ev = 'click') => { for (const fn of (el(id).listeners[ev] || [])) await fn(); await esperar(); };
  const dispararSemEsperar = (id, ev = 'change') => Promise.all((el(id).listeners[ev] || []).map((fn) => fn()));
  return {
    el, esperar, disparar, dispararSemEsperar,
    visivel: (id) => el(id).style.display !== 'none',
    protecoes: () => valores(el('materialGrupoProtecao').innerHTML),
    estadoProtecao: () => el('materialProtecaoEstado').textContent,
  };
}
// Só as consultas do formulário de material por Grupo: com `grupo` e sem `grupoProtecao`. A listagem da seção
// "Tipos de EPI / Vestimenta" (sem filtro de Grupo) fica de fora.
const consultasPorGrupo = () => chamadas.filter((c) => {
  if (c.metodo !== 'GET' || !c.caminho.startsWith('/api/tipos-material')) return false;
  const q = new URL(`http://x${c.caminho}`).searchParams;
  return q.get('grupo') !== null && q.get('grupoProtecao') === null;
});
const consultasCatalogo = () => chamadas.filter((c) => c.metodo === 'GET' && c.caminho.startsWith('/api/tipos-material'));
async function escolherGrupo(pg, grupo) { pg.el('materialCategoria').value = grupo; await pg.disparar('materialCategoria', 'change'); }
async function escolherProtecao(pg, protecao) { pg.el('materialGrupoProtecao').value = protecao; await pg.disparar('materialGrupoProtecao', 'change'); }
async function escolherTipo(pg, tipo) { pg.el('materialTipo').value = tipo; await pg.disparar('materialTipo', 'change'); }
async function abrirEdicao(pg, id) {
  pg.el('gradeMaterial').value = String(id);
  await pg.disparar('gradeMaterial', 'change');
  await pg.disparar('botaoEditarMaterial');
}
function adiada() { let soltar; const promessa = new Promise((r) => { soltar = r; }); return { promessa, soltar }; }

describe('A3 proteções — inspeção estática', () => {
  test('#materialProtecaoEstado existe no campo da Proteção, anunciado, vazio no início e escrito só por textContent', () => {
    const html = ler('pages/materials.html');
    const campo = html.slice(html.indexOf('id="campoGrupoProtecao"'), html.indexOf('id="campoGrupoProtecaoCustom"'));
    const tag = /<[^>]*\bid="materialProtecaoEstado"[^>]*>/.exec(campo);
    assert.ok(tag, 'falta #materialProtecaoEstado no campo da Proteção');
    assert.match(tag[0], /\brole="status"/);
    assert.match(tag[0], /\baria-live="polite"/);
    assert.match(campo, /id="materialProtecaoEstado"[^>]*><\//, 'começa vazio');
    const script = html.slice(html.lastIndexOf('<script>'));
    assert.match(script, /\$\('materialProtecaoEstado'\)\.textContent\s*=/);
    assert.equal(/materialProtecaoEstado'\)\.innerHTML/.test(script), false);
  });
});

describe('A3 proteções — página', () => {
  test('P1 — Vestimenta: uma consulta por Grupo (sem grupoProtecao, só ativos); só "Proteção das pernas", "Proteção do tronco" e "Outros"; o Tipo e o Nome seguem funcionando', async () => {
    const pg = montarPagina();
    await pg.esperar();
    await escolherGrupo(pg, 'Vestimenta');
    const [consulta] = consultasPorGrupo();
    assert.ok(consulta, 'consultou o catálogo pelo Grupo');
    const q = new URL(`http://x${consulta.caminho}`).searchParams;
    assert.deepEqual([q.get('grupo'), q.get('ativo'), q.has('grupoProtecao')], ['Vestimenta', 'true', false]);
    assert.deepEqual(pg.protecoes(), ['', 'Proteção das pernas', 'Proteção do tronco', OUTROS]);
    assert.equal(pg.estadoProtecao(), '', 'sem aviso quando o catálogo respondeu');
    await escolherProtecao(pg, 'Proteção do tronco');
    await escolherTipo(pg, String(CATALOGO.find((t) => t.nome === 'Avental de Segurança').id));
    assert.equal(pg.el('materialNome').value, 'Avental de Segurança', 'a sugestão de nome da A3 continua');
  });

  test('P2 — EPI: as 11 proteções com tipo ativo (sem "Proteção do tronco"), na ordem oficial, e "Outros"; a caixa de óculos continua em Proteção ocular', async () => {
    const pg = montarPagina();
    await pg.esperar();
    await escolherGrupo(pg, 'EPI');
    assert.deepEqual(pg.protecoes(), ['', ...PROTECOES_EPI, OUTROS]);
    await escolherProtecao(pg, 'Proteção ocular');
    assert.equal(pg.visivel('campoOculosComGrau'), true);
  });

  test('P3 — tipo novo no catálogo (Vestimenta / Proteção dos braços) acrescenta a proteção na posição oficial', async () => {
    const catalogo = [...CATALOGO, { id: 50, grupo: 'Vestimenta', grupoProtecao: 'Proteção dos braços', nome: 'Manga de Vestimenta', ativo: true, origem: 'MANUAL' }];
    const pg = montarPagina({ catalogo });
    await pg.esperar();
    await escolherGrupo(pg, 'Vestimenta');
    assert.deepEqual(pg.protecoes(), ['', 'Proteção das pernas', 'Proteção dos braços', 'Proteção do tronco', OUTROS]);
  });

  test('P4 — resposta antiga descartada: a lista do Grupo trocado no meio da consulta vence', async () => {
    const atraso = adiada();
    const pg = montarPagina({ atrasos: { EPI: atraso.promessa } });
    await pg.esperar();
    pg.el('materialCategoria').value = 'EPI';
    const antiga = pg.dispararSemEsperar('materialCategoria');
    await new Promise((r) => setImmediate(r));
    await escolherGrupo(pg, 'Vestimenta');
    atraso.soltar();
    await antiga;
    await pg.esperar();
    assert.equal(consultasPorGrupo().length, 2, 'premissa: as duas consultas aconteceram');
    assert.deepEqual(pg.protecoes(), ['', 'Proteção das pernas', 'Proteção do tronco', OUTROS]);
  });

  test('P5 — falha (rede, 403, 500): lista completa como contingência, com aviso visível de opções não validadas que permanece até nova consulta bem-sucedida', async () => {
    for (const falha of ['rede', 403, 500]) {
      const pg = montarPagina({ falhaGrupo: falha });
      await pg.esperar();
      await escolherGrupo(pg, 'Vestimenta');
      assert.deepEqual(pg.protecoes(), ['', ...GRUPOS_PROTECAO, OUTROS], `${falha}: contingência com a lista completa`);
      assert.match(pg.estadoProtecao(), /Não foi possível validar/, `${falha}: aviso visível`);
      assert.match(pg.estadoProtecao(), /lista completa/, `${falha}: diz que é a lista completa`);
      await escolherProtecao(pg, 'Proteção dos braços');
      await escolherTipo(pg, OUTROS);
      assert.match(pg.estadoProtecao(), /Não foi possível validar/, `${falha}: o aviso permanece depois de escolher proteção e tipo`);
    }
  });

  test('P5b — a contingência termina quando uma nova consulta por Grupo dá certo (o aviso some)', async () => {
    const pg = montarPagina({ falhaGrupo: 500 });
    await pg.esperar();
    await escolherGrupo(pg, 'Vestimenta');
    assert.match(pg.estadoProtecao(), /Não foi possível validar/);
    servidor({});
    await escolherGrupo(pg, 'EPI');
    assert.deepEqual(pg.protecoes(), ['', ...PROTECOES_EPI, OUTROS]);
    assert.equal(pg.estadoProtecao(), '');
  });

  test('P6 — edição: a proteção gravada sem tipo ativo no catálogo continua como opção, na ordem oficial, e selecionada; o Tipo "Outros" e a descrição ficam', async () => {
    const pg = montarPagina({ materiais: [V2_MANGA_OUTROS] });
    await pg.esperar();
    await abrirEdicao(pg, 90);
    assert.deepEqual(pg.protecoes(), ['', 'Proteção das pernas', 'Proteção dos braços', 'Proteção do tronco', OUTROS]);
    assert.equal(pg.el('materialGrupoProtecao').value, 'Proteção dos braços');
    assert.equal(pg.el('materialTipo').value, OUTROS);
    assert.equal(pg.el('materialTipoCustom').value, 'Manga térmica');
    assert.equal(pg.el('materialNome').value, 'Manga térmica especial');
  });

  test('P7 — Grupo "Outros": nenhuma consulta ao catálogo, Proteção escondida, os dois "Especifique…" visíveis', async () => {
    const pg = montarPagina();
    await pg.esperar();
    await escolherGrupo(pg, 'Vestimenta');
    assert.equal(consultasPorGrupo().length, 1, 'premissa: Vestimenta consulta');
    const consultasAntes = consultasCatalogo().length;
    await escolherGrupo(pg, OUTROS);
    assert.equal(consultasCatalogo().length, consultasAntes, '"Outros" não acrescenta consulta');
    assert.equal(pg.visivel('campoGrupoProtecao'), false);
    assert.equal(pg.visivel('campoCategoriaCustom'), true);
    assert.equal(pg.visivel('customMaterialTypeField'), true);
    assert.equal(pg.estadoProtecao(), '');
  });

  test('P8 — o cadastro de TIPOS continua com as 12 proteções: seção do catálogo nesta página e formulário da A1 na Gestão de GHE', async () => {
    const pg = montarPagina();
    await pg.esperar();
    await escolherGrupo(pg, 'Vestimenta');
    assert.deepEqual(pg.protecoes(), ['', 'Proteção das pernas', 'Proteção do tronco', OUTROS], 'premissa: o material está filtrado');
    assert.deepEqual(valores(pg.el('novoTipoProtecao').innerHTML), ['', ...GRUPOS_PROTECAO]);
    assert.deepEqual(valores(pg.el('catalogoProtecao').innerHTML), ['', ...GRUPOS_PROTECAO]);
    assert.match(ler('pages/employee-groups.html'), /T\.render\.opcoes\(T\.VOCABULARIO\.gruposProtecao, 'Selecione'\)/);
  });
});
