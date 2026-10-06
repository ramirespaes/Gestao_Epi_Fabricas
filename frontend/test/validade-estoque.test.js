'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const EpiHttp = require('../js/api-http');
const P = require('../js/permissoes-efetivas');
const Catalogo = require('../js/catalogo-visual');

/**
 * E7 — Validade de estoque: módulo js/validade-estoque.js com fetch
 * injetado, página pages/stock-validity.html em DOM simulado e inspeção
 * estática. A prova com PostgreSQL real está em
 * backend/test/integracao/estoque-validade.integration.js.
 */

const BASE = 'http://localhost:3000/api';
const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const semComentarios = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const modulo = () => require('../js/validade-estoque'); // eslint-disable-line global-require
const materiais = () => require('../js/materiais'); // eslint-disable-line global-require
const resposta = (status, corpo) => ({ status, ok: status >= 200 && status < 300, text: async () => (corpo === undefined ? '' : JSON.stringify(corpo)) });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ATAQUE = '<img src=x onerror=alert(1)>';
const ESCAPADO = '&lt;img src=x onerror=alert(1)&gt;';

let chamadas;
function servidor(responder) {
  chamadas = [];
  EpiHttp.configurar({
    baseUrl: BASE,
    fetch: async (url, opcoes) => {
      const u = new URL(url);
      const corpo = opcoes && opcoes.body ? JSON.parse(opcoes.body) : undefined;
      chamadas.push({ metodo: opcoes.method, caminho: u.pathname + u.search, corpo });
      const r = responder(opcoes.method, u, corpo);
      if (r instanceof Error) throw r;
      return r;
    },
  });
}

const lote = (extra) => ({
  loteId: 11, materialId: 7, material: 'Botina de segurança', codigoInterno: 'EPI-1', categoria: 'EPI', tipo: 'Sapatão / Botina',
  tamanho: '40', caNumero: '38271', caValidade: '2026-09-29', fisico: 5, bloqueado: 5, disponivel: 0, situacaoCa: 'VENCIDO', ...extra,
});
const LOTES = [
  lote(),
  lote({ loteId: 12, tamanho: null, caNumero: '12345', caValidade: '2026-09-30', bloqueado: 0, disponivel: 5, situacaoCa: 'VENCE_HOJE' }),
  lote({ loteId: 13, material: 'Uniforme', tamanho: 'G', caNumero: null, caValidade: null, fisico: 6, bloqueado: 0, disponivel: 6, situacaoCa: 'NAO_EXIGE_CA' }),
  lote({ loteId: 14, material: 'Luva', tamanho: 'M', caNumero: null, caValidade: null, fisico: 8, bloqueado: 8, disponivel: 0, situacaoCa: 'SEM_CA' }),
];
const INDICADORES = { lotes: 4, vencido: 1, venceHoje: 1, aVencer: 0, valido: 0, semCa: 1, naoExigeCa: 1, bloqueados: 2 };
const listagem = (extra = {}) => ({ status: 'ok', hoje: '2026-09-30', diasAlerta: 60, lotes: LOTES, indicadores: INDICADORES, total: 4, pagina: 1, limite: 50, ...extra });

// Marcações de um trecho de HTML e nomes de atributo, com os valores entre aspas neutralizados.
const marcacoes = (html) => [...String(html).matchAll(/<\s*([a-zA-Z][\w-]*)([^>]*)>/g)].map((m) => ({ nome: m[1].toLowerCase(), atributos: m[2] }));
const nomesDeAtributo = (a) => [...a.replace(/"[^"]*"|'[^']*'/g, '""').matchAll(/([^\s="'/]+)\s*=/g)].map((m) => m[1].toLowerCase());
const semElementoInjetado = (html) => {
  for (const m of marcacoes(html)) {
    assert.notEqual(m.nome, 'img', html);
    assert.equal(nomesDeAtributo(m.atributos).some((n) => n.startsWith('on')), false, `atributo de evento em <${m.nome}>`);
  }
};

describe('módulo: filtro, consulta e textos', () => {
  test('o filtro da URL só aceita as situações da lista; qualquer outra coisa vira "todos"', () => {
    const V = modulo();
    for (const valor of ['VENCIDO', 'VENCE_HOJE', 'A_VENCER', 'VENCIMENTO_PROXIMO', 'VALIDO', 'SEM_CA', 'NAO_EXIGE_CA']) {
      assert.equal(V.filtroDaUrl(`?situacao=${valor}`), valor);
    }
    for (const busca of ['', '?', '?situacao=vencido', '?situacao=<script>', '?situacao=VENCIDO%27', '?outra=VENCIDO', `?situacao=${encodeURIComponent(ATAQUE)}`]) {
      assert.equal(V.filtroDaUrl(busca), '', busca);
    }
    assert.deepEqual(V.FILTROS.map((f) => f[0]), ['', 'VENCIDO', 'VENCE_HOJE', 'A_VENCER', 'VENCIMENTO_PROXIMO', 'VALIDO', 'SEM_CA', 'NAO_EXIGE_CA']);
  });

  test('a consulta leva só filtro permitido, busca aparada e paginação; nunca empresa', async () => {
    servidor(() => resposta(200, listagem()));
    const V = modulo();
    await V.acoes.listar({ situacao: 'VENCIDO', busca: '  botina & 50%  ', pagina: 2, limite: 50 });
    await V.acoes.listar({ situacao: 'QUALQUER', busca: '   ' });
    assert.deepEqual(chamadas.map((c) => c.caminho), [
      '/api/estoque/validade?situacao=VENCIDO&busca=botina%20%26%2050%25&pagina=2&limite=50',
      '/api/estoque/validade?pagina=1&limite=50',
    ]);
    assert.equal(chamadas.some((c) => /empresa/i.test(c.caminho)), false);
  });

  test('textos: tamanho null é "Único"; não exige CA não inventa CA nem validade; datas em DD/MM/AAAA', () => {
    const T = modulo().texto;
    assert.deepEqual([T.tamanho(null), T.tamanho(''), T.tamanho('40')], ['Único', 'Único', '40']);
    assert.deepEqual([T.ca(LOTES[2]), T.validade(LOTES[2])], ['Não exige CA', '—']);
    assert.deepEqual([T.ca(LOTES[3]), T.validade(LOTES[3])], ['Sem CA', '—']);
    assert.deepEqual([T.ca(LOTES[0]), T.validade(LOTES[0])], ['38271', '29/09/2026']);
  });

  test('situação: rótulo e cor do mapa; situação desconhecida não vira classe', () => {
    const S = modulo().SITUACOES;
    assert.deepEqual(Object.keys(S), ['VENCIDO', 'VENCE_HOJE', 'A_VENCER', 'VALIDO', 'SEM_CA', 'NAO_EXIGE_CA']);
    assert.deepEqual([S.VENCIDO.rotulo, S.VENCE_HOJE.rotulo, S.SEM_CA.rotulo, S.NAO_EXIGE_CA.rotulo], ['Vencido', 'Vence hoje', 'Sem CA', 'Não exige CA']);
    const html = modulo().render.linhas([lote({ situacaoCa: ATAQUE })], { podeBaixar: false });
    semElementoInjetado(html);
    assert.match(html, /<span class="badge badge-warning">/);
  });

  test('linhas: material, CA e tamanho escapados; disponibilidade; botão de baixa só com permissão e saldo físico', () => {
    const R = modulo().render;
    const atacado = lote({ material: ATAQUE, caNumero: ATAQUE, tamanho: ATAQUE, codigoInterno: `"><${ATAQUE}` });
    const html = R.linhas([atacado, ...LOTES], { podeBaixar: true });
    assert.ok(html.includes(ESCAPADO));
    semElementoInjetado(html);
    assert.equal((html.match(/data-baixa-lote="/g) || []).length, 5);
    assert.match(html, /data-baixa-lote="11"/);
    assert.match(html, />Bloqueado</);
    assert.match(html, />Disponível</);
    assert.match(html, />Único</);
    assert.equal(/data-baixa-lote/.test(R.linhas(LOTES, { podeBaixar: false })), false, 'sem MOVIMENTAR_ESTOQUE, nenhuma ação');
    assert.equal(/data-baixa-lote/.test(R.linhas([lote({ fisico: 0, bloqueado: 0 })], { podeBaixar: true })), false);
  });

  test('mensagens de falha: texto próprio, sem repetir o que o servidor mandou', () => {
    const M = modulo().mensagens;
    const segredo = { ok: false, status: 400, codigo: 'VALIDACAO', mensagem: 'SEGREDO-INTERNO', detalhes: [{ caminho: 'query.situacao', valor: 'SEGREDO-9' }] };
    for (const r of [segredo, { ok: false, status: 403 }, { ok: false, status: 0 }, { ok: false, status: 500, mensagem: 'SEGREDO-INTERNO' }]) {
      const texto = M.erroListagem(r);
      assert.equal(typeof texto, 'string');
      assert.equal(/SEGREDO/.test(texto), false, texto);
    }
    assert.match(M.erroListagem({ ok: false, status: 403 }), /perfil/i);
    assert.match(M.erroListagem({ ok: false, status: 0 }), /rede/i);
  });
});

describe('12G-7 — pictograma do material: na mesma célula, antes do nome, decorativo', () => {
  const celulas = (html) => [...html.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
  const texto = (s) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  test('o pictograma do tipo abre a célula do material; nome, "Material inativo" e código continuam; 9 colunas; tabela igual', () => {
    const R = modulo().render;
    const html = R.linhas([lote({ material: 'Luva de raspa', tipo: 'Luva', categoria: 'EPI', materialAtivo: false, codigoInterno: 'L-1' })], { podeBaixar: true });
    const tds = celulas(html);
    assert.equal(tds.length, 9);
    assert.ok(tds[0].startsWith(Catalogo.marcacao({ tipo: 'Luva' })), tds[0]);
    assert.match(tds[0], /^<svg [^>]*aria-hidden="true"[^>]*focusable="false"/);
    assert.equal(texto(tds[0]), 'Luva de raspa Material inativo L-1');
    assert.equal(texto(tds[1]), 'Luva EPI', 'a coluna do tipo continua só com texto');
    assert.equal((html.match(/<svg /g) || []).length, 1, 'um pictograma por linha');
    assert.match(html, /data-baixa-lote="11"/, 'a ação da linha não muda');
  });

  test('tipo desconhecido usa a categoria; sem categoria conhecida, o genérico', () => {
    const chaveDa = (extra) => (modulo().render.linhas([lote(extra)], { podeBaixar: false }).match(/data-pictograma="([^"]+)"/) || [])[1];
    assert.equal(chaveDa({ tipo: 'Capacete', categoria: 'EPI' }), 'capacete');
    assert.equal(chaveDa({ tipo: 'Jaleco', categoria: 'Uniforme' }), 'uniforme');
    assert.equal(chaveDa({ tipo: null, categoria: 'Ferramenta' }), 'ferramenta');
    assert.equal(chaveDa({ tipo: null, categoria: null }), 'material');
  });

  test('tipo, categoria e nome maliciosos: nada vira elemento ou atributo; o SVG é o genérico, fixo', () => {
    const html = modulo().render.linhas([lote({ material: ATAQUE, tipo: `" onload="alert(1)`, categoria: ATAQUE })], { podeBaixar: false });
    semElementoInjetado(html);
    assert.equal((html.match(/<svg [\s\S]*?<\/svg>/) || [])[0], Catalogo.marcacao({}));
  });

  test('a linha de estado não ganha pictograma', () => {
    const R = modulo().render;
    assert.equal(/<svg/.test(R.vazio('Carregando…')), false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Página em DOM simulado: o script embutido de stock-validity.html
// ═══════════════════════════════════════════════════════════════════
const CONTEXTO = { empresa: { id: 3, nome: 'Empresa' }, usuario: { id: 7, nome: 'Pessoa', perfil: 'MASTER' } };
const PODE_TUDO = { recursos: { materials: { visualizar: true, criar: false, editar: false, excluir: false } }, acoes: { BAIXA_ESTOQUE: true }, administracao: {} };
const SO_VER = { recursos: { materials: { visualizar: true, criar: false, editar: false, excluir: false } }, acoes: {}, administracao: {} };

function montarPagina({ busca = '', permissoes = PODE_TUDO, responder } = {}) {
  servidor(responder || ((metodo) => (metodo === 'GET' ? resposta(200, listagem()) : resposta(201, { status: 'ok', repetida: false, lote: { loteId: 11, saldo: 3 } }))));
  const html = ler('pages/stock-validity.html');
  const script = html.slice(html.lastIndexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));
  const SELECTS = new Set(['filtroSituacao', 'baixaMotivo']);
  const mapa = {};
  const el = (id) => (mapa[id] = mapa[id] || {
    id, value: '', textContent: '', innerHTML: '', disabled: false, style: {}, atributos: {}, listeners: {},
    tagName: SELECTS.has(id) ? 'SELECT' : 'INPUT',
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    setAttribute(k, v) { this.atributos[k] = String(v); }, removeAttribute(k) { delete this.atributos[k]; }, focus() {},
  });
  const sandbox = {
    document: { getElementById: el, querySelectorAll: () => [] },
    window: { SAFEWORK_PORTAL_API_BASE_URL: BASE, location: { search: busca } },
    EpiHttp, EpiMateriais: materiais(), EpiValidadeEstoque: modulo(), EpiCatalogoVisual: Catalogo,
    EpiPermissoes: { prepararPagina: async () => ({ permissoes, podeAlterar: false }), acao: P.acao, recurso: P.recurso },
    EpiSessaoEmpresarial: { montar: async (o) => { sandbox.opcoesMontar = o; return CONTEXTO; }, sessaoEncerrada() { sandbox.encerrada = true; } },
    showToast() {}, console, Promise, String, Number, Array, Object, JSON, crypto: globalThis.crypto,
  };
  vm.runInNewContext(script, sandbox);
  const esperar = async () => { for (let i = 0; i < 40; i += 1) await new Promise((r) => setImmediate(r)); };
  const disparar = async (id, ev = 'click', evento = {}) => { for (const fn of (el(id).listeners[ev] || [])) await fn(evento); await esperar(); };
  const clicarBaixa = (loteId) => disparar('validadeCorpo', 'click', { target: { closest: () => ({ getAttribute: () => String(loteId) }) } });
  return { el, sandbox, esperar, disparar, clicarBaixa };
}
const escritas = () => chamadas.filter((c) => c.metodo !== 'GET');
const leituras = () => chamadas.filter((c) => c.metodo === 'GET').map((c) => c.caminho);

describe('página (DOM simulado)', () => {
  test('abre com o filtro da URL quando ele é permitido; indicadores pintados por texto; nenhuma escrita ao abrir', async () => {
    const pg = montarPagina({ busca: '?situacao=VENCIDO' });
    await pg.esperar();
    assert.deepEqual(leituras(), ['/api/estoque/validade?situacao=VENCIDO&pagina=1&limite=50']);
    assert.equal(pg.el('filtroSituacao').value, 'VENCIDO');
    assert.deepEqual(['indVencidoValor', 'indVenceHojeValor', 'indAVencerValor', 'indValidoValor', 'indSemCaValor', 'indBloqueadosValor'].map((id) => pg.el(id).textContent), ['1', '1', '0', '0', '1', '2']);
    assert.match(pg.el('validadeCorpo').innerHTML, /data-baixa-lote="11"/);
    assert.equal(escritas().length, 0, 'abrir a página nunca dá baixa');
  });

  test('filtro adulterado na URL é ignorado: a consulta vai sem situação', async () => {
    const pg = montarPagina({ busca: `?situacao=${encodeURIComponent(ATAQUE)}` });
    await pg.esperar();
    assert.deepEqual(leituras(), ['/api/estoque/validade?pagina=1&limite=50']);
    assert.equal(pg.el('filtroSituacao').value, '');
  });

  test('clicar num indicador filtra por aquela situação', async () => {
    const pg = montarPagina();
    await pg.esperar();
    await pg.disparar('indAVencer');
    assert.equal(leituras().at(-1), '/api/estoque/validade?situacao=A_VENCER&pagina=1&limite=50');
    assert.equal(pg.el('filtroSituacao').value, 'A_VENCER');
  });

  test('sem MOVIMENTAR_ESTOQUE: nenhuma ação de baixa na tabela; a consulta continua', async () => {
    const pg = montarPagina({ permissoes: SO_VER });
    await pg.esperar();
    assert.equal(/data-baixa-lote/.test(pg.el('validadeCorpo').innerHTML), false);
    await pg.clicarBaixa(11);
    assert.equal(pg.el('painelBaixa').style.display, 'none');
  });

  test('baixa de lote vencido: o painel sugere CA vencido, mas nada vai sem quantidade e confirmação', async () => {
    const pg = montarPagina();
    await pg.esperar();
    await pg.clicarBaixa(11);
    assert.equal(pg.el('painelBaixa').style.display, '');
    assert.deepEqual([pg.el('baixaMotivo').value, pg.el('baixaQuantidade').value, pg.el('baixaQuantidade').max], ['CA_VENCIDO', '', '5']);
    assert.match(pg.el('baixaLoteDescricao').textContent, /Botina de segurança/);
    assert.equal(escritas().length, 0);
    await pg.disparar('botaoConfirmarBaixa');
    assert.equal(escritas().length, 0, 'sem quantidade nada é enviado');
    assert.equal(pg.el('baixaQuantidade').atributos['aria-invalid'], 'true');
  });

  test('baixa confirmada: POST no lote escolhido com chave de idempotência; depois a lista e os indicadores são recarregados', async () => {
    const pg = montarPagina();
    await pg.esperar();
    await pg.clicarBaixa(11);
    pg.el('baixaQuantidade').value = '2';
    await pg.disparar('botaoConfirmarBaixa');
    const [baixa, ...resto] = escritas();
    assert.equal(resto.length, 0);
    assert.equal(baixa.caminho, '/api/estoque/lotes/11/baixas');
    assert.deepEqual([baixa.corpo.quantidade, baixa.corpo.motivo], [2, 'CA_VENCIDO']);
    assert.match(baixa.corpo.chaveIdempotencia, UUID);
    assert.equal(leituras().length, 2, 'a lista é consultada de novo');
    assert.equal(pg.el('painelBaixa').style.display, 'none');
    assert.match(pg.el('aviso').innerHTML, /Baixa registrada/);
  });

  test('lote que não está vencido: o motivo não vem escolhido; "Outro" exige justificativa', async () => {
    const pg = montarPagina();
    await pg.esperar();
    await pg.clicarBaixa(12);
    assert.equal(pg.el('baixaMotivo').value, '');
    pg.el('baixaQuantidade').value = '1';
    pg.el('baixaMotivo').value = 'OUTRO';
    await pg.disparar('baixaMotivo', 'change');
    assert.equal(pg.el('campoBaixaJustificativa').style.display, '');
    await pg.disparar('botaoConfirmarBaixa');
    assert.equal(escritas().length, 0);
    assert.equal(pg.el('baixaJustificativa').atributos['aria-invalid'], 'true');
  });

  test('falha na consulta: mensagem própria no aviso, tabela vazia e indicadores "—"', async () => {
    const pg = montarPagina({ responder: () => resposta(500, { status: 'error', codigo: 'ERRO_INTERNO', message: 'SEGREDO-INTERNO' }) });
    await pg.esperar();
    assert.equal(/SEGREDO/.test(pg.el('aviso').innerHTML), false);
    assert.equal(pg.el('indVencidoValor').textContent, '—');
    assert.equal(/data-baixa-lote/.test(pg.el('validadeCorpo').innerHTML), false);
  });
});

describe('inspeção estática', () => {
  const html = ler('pages/stock-validity.html');
  const codigo = semComentarios(html);

  test('página integrada: sessão real, permissões do servidor, sem protótipo, sem biblioteca externa de planilha', () => {
    const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
    // 12G-7: o catálogo visual vem antes do módulo que desenha a linha.
    assert.deepEqual(scripts, ['../js/tema.js', '../js/api-http.js', '../portal/config.js', '../js/sessao-empresarial.js', '../js/permissoes-efetivas.js', '../js/pagina-base.js', '../js/materiais.js', '../js/catalogo-visual.js', '../js/validade-estoque.js']);
    for (const proibido of [/db-api\.js/, /main\.js/, /xlsx/, /localStorage/, /sessionStorage/, /document\.cookie/, /showView\(/, /setActiveNav/, /data-page=/, /localhost:3000/, /Fulano de Tal/]) {
      assert.equal(proibido.test(codigo.replace(/onclick="(closeMobileMenu|toggleSidebar)\(\)"/g, '')), false, `contém ${proibido}`);
    }
    assert.match(codigo, /EpiSessaoEmpresarial\.montar\(/);
    assert.match(codigo, /EpiPermissoes\.prepararPagina\(\{\s*pagina: 'stockValidity'/);
    for (const id of ['identidade', 'botaoSair', 'botaoTrocarEmpresa']) assert.equal(html.includes(`id="${id}"`), false, id);
  });

  test('nome, subtítulo e menu: "Validade de estoque", lotes, CA, vencimentos e bloqueios', () => {
    assert.match(html, /<title>Validade de estoque — Gestão de EPIs<\/title>/);
    assert.match(html, /<h2[^>]*>Validade de estoque<\/h2>/);
    assert.match(html, /Acompanhe, lote a lote, o CA e a validade de cada entrada, o que vence em breve, o que está bloqueado e dê baixa no que não pode mais ser entregue\./);
    assert.match(html, /<a class="active" href="javascript:void\(0\)" data-pagina="stockValidity" style="display:none"><div class="nav-icon red">event_busy<\/div>Validade de estoque<\/a>/);
    assert.equal(/CA do material|CA mestre/i.test(codigo), false);
  });

  test('filtros com as opções do módulo; colunas pedidas; indicadores clicáveis por situação', () => {
    const trecho = html.slice(html.indexOf('id="filtroSituacao"')).split('</select>')[0];
    assert.deepEqual([...trecho.matchAll(/<option value="([^"]*)">/g)].map((m) => m[1]), modulo().FILTROS.map((f) => f[0]));
    for (const th of ['Material', 'Tipo', 'Tamanho', 'Número do CA', 'Validade do CA', 'Saldo', 'Situação', 'Disponibilidade', 'Ação']) {
      assert.match(html, new RegExp(`<th[^>]*>${th}</th>`), th);
    }
    for (const [id, situacao] of [['indVencido', 'VENCIDO'], ['indVenceHoje', 'VENCE_HOJE'], ['indAVencer', 'A_VENCER'], ['indValido', 'VALIDO'], ['indSemCa', 'SEM_CA']]) {
      assert.match(html, new RegExp(`<button id="${id}" class="[^"]*" type="button" data-situacao="${situacao}"`), id);
    }
    assert.match(html, /id="indBloqueados"/);
  });

  test('innerHTML só com texto fixo, o render do módulo ou o aviso escapado', () => {
    const script = html.slice(html.lastIndexOf('<script>'));
    const origens = [...script.matchAll(/\.innerHTML\s*=\s*([^;]+);/g)].map((m) => m[1].trim());
    assert.ok(origens.length > 0);
    for (const origem of origens) {
      assert.match(origem, /^(''|V\.render\.[a-zA-Z]+\([^)]*\)|'<div class="notice" style="' \+ cor \+ '">' \+ V\.render\.escaparHtml\(texto\) \+ '<\/div>')$/, origem);
    }
  });

  test('visual de vidro com tema claro e escuro pelos tokens do sistema', () => {
    assert.match(html, /\.vidro\{[^}]*backdrop-filter:blur\(/);
    assert.match(html, /html\[data-theme="dark"\] \.vidro\{/);
  });
});

describe('Dashboard e mapa de páginas', () => {
  // E9: os atalhos só ganham destino quando o servidor libera o indicador (ver rbac-estoque-e9.test.js).
  test('o número de CA vencido abre a página filtrada em vencidos; o "a vencer" abre vence hoje ou a vencer', () => {
    const dash = ler('pages/dashboard.html');
    assert.match(dash, /<a id="linkCaVencidos" class="kpi-link">\s*<div class="kpi-value" id="kpiCaVencidoValor">/);
    assert.match(dash, /<a id="linkCaAVencer" class="kpi-link">\s*<div class="kpi-meta" id="kpiCaVencidoMeta">/);
    assert.match(dash, /linkCaVencidos: 'stock-validity\.html\?situacao=VENCIDO', linkCaAVencer: 'stock-validity\.html\?situacao=VENCIMENTO_PROXIMO'/);
    for (const situacao of ['VENCIDO', 'VENCIMENTO_PROXIMO']) assert.equal(modulo().filtroDaUrl(`?situacao=${situacao}`), situacao);
  });

  test('a página abre com stockValidity.visualizar, a permissão própria (E9); a baixa continua exigindo MOVIMENTAR_ESTOQUE', () => {
    assert.deepEqual(P.PAGINAS.stockValidity, { abrir: [{ recurso: 'stockValidity', operacao: 'visualizar' }], alterar: [] });
  });

  test('as páginas integradas com a seção Estoque passam a oferecer a Validade de estoque (oculta até a permissão)', () => {
    for (const arquivo of ['materials', 'available-items', 'dashboard', 'employee-groups', 'employee-history', 'import-employees']) {
      assert.match(ler(`pages/${arquivo}.html`), /<a href="stock-validity\.html" data-pagina="stockValidity" style="display:none"><div class="nav-icon red">event_busy<\/div>Validade de estoque<\/a>/, arquivo);
    }
    assert.match(ler('portal/inicio.html'), /<a href="\.\.\/pages\/stock-validity\.html" data-pagina="stockValidity" style="display:none">Validade de estoque<\/a>/);
  });
});
