'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const EpiHttp = require('../js/api-http');
const Permissoes = require('../js/permissoes-efetivas');

/**
 * 12I (decisão de 21/10/2026) — os cartões do Dashboard NÃO ampliam mais e não têm prévia: são compactos, de vidro fosco e inteiramente
 * clicáveis (um link semântico que cobre o cartão), com um movimento discreto no hover (sobe ~2 px em ~160 ms, respeitando
 * prefers-reduced-motion). Cada destino leva à tela correspondente já filtrada, e o cartão só tem link quando a fonte do número é a mesma
 * autoridade que abre a tela de destino. Os seis cartões das Tasks 01 a 06 somem por inteiro sem permissão; os demais com destino confirmado
 * (itens disponíveis, saldo livre, comprometido e aguardando SST) mostram "sem permissão" como antes e só ganham o link.
 */

const BASE = 'http://localhost:3000/api';
const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const modulo = () => require('../js/dashboard'); // eslint-disable-line global-require
const resposta = (status, corpo) => ({ status, ok: status >= 200 && status < 300, text: async () => (corpo === undefined ? '' : JSON.stringify(corpo)) });

// chave do indicador, ids da página, destino (função de EpiDashboard.destinos), página de destino e a autoridade que abre o destino.
const CARTOES = [
  { nome: 'Estoque abaixo do mínimo', chave: 'estoqueAbaixoMinimo', card: 'cardAbaixoMinimo', link: 'linkAbaixoMinimo', valorId: 'kpiAbaixoMinimoValor', destinoFn: 'abaixoMinimo', destino: 'available-items.html?situacao=ABAIXO_MINIMO', pagina: 'availableItems', oculta: true },
  { nome: 'Necessidade de reposição', chave: 'necessidadeReposicao', card: 'cardNecessidade', link: 'linkNecessidade', valorId: 'kpiNecessidadeValor', destinoFn: 'necessidade', destino: 'available-items.html?somenteComNecessidade=true', pagina: 'availableItems', oculta: true },
  { nome: 'Pendências sem estoque', chave: 'semCobertura', card: 'cardSemCobertura', link: 'linkSemCobertura', valorId: 'kpiSemCoberturaValor', destinoFn: 'semCobertura', destino: 'available-items.html?situacao=SEM_COBERTURA', pagina: 'availableItems', oculta: true },
  { nome: 'Funcionários ativos', chave: 'funcionariosAtivos', card: 'cardFuncionarios', link: 'linkFuncionarios', valorId: 'kpiFuncionariosValor', destinoFn: 'funcionarios', destino: 'funcionarios.html?situacao=ATIVO', pagina: 'funcionarios', oculta: true },
  { nome: 'Disponíveis para entrega', chave: 'disponiveisParaEntrega', card: 'cardDisponiveisEntrega', link: 'linkDisponiveisEntrega', valorId: 'kpiDisponiveisEntregaValor', destinoFn: 'disponiveisEntrega', destino: 'stock-requests.html?cobertura=COBERTURA_COMPLETA', pagina: 'stockRequests', oculta: true },
  { nome: 'Solicitações aguardando estoque', chave: 'solicitacoesAguardandoEstoque', card: 'cardAguardandoEstoque', link: 'linkAguardandoEstoque', valorId: 'kpiAguardandoEstoqueValor', destinoFn: 'aguardandoEstoque', destino: 'stock-requests.html?cobertura=SEM_COBERTURA', pagina: 'stockRequests', oculta: true },
  { nome: 'Itens disponíveis', chave: 'itensDisponiveis', card: 'cardItensDisponiveis', link: 'linkItensDisponiveis', valorId: 'kpiDisponiveisValor', destinoFn: 'itensDisponiveis', destino: 'available-items.html', pagina: 'availableItems', oculta: false },
  { nome: 'Saldo livre', chave: 'saldoLivre', card: 'cardSaldoLivre', link: 'linkSaldoLivre', valorId: 'kpiSaldoLivreValor', destinoFn: 'saldoLivre', destino: 'available-items.html', pagina: 'availableItems', oculta: false },
  { nome: 'Saldo comprometido', chave: 'comprometido', card: 'cardComprometido', link: 'linkComprometido', valorId: 'kpiComprometidoValor', destinoFn: 'comprometido', destino: 'available-items.html?situacao=COM_COMPROMETIDO', pagina: 'availableItems', oculta: false },
  { nome: 'Solicitações aguardando aprovação', chave: 'solicitacoesAguardandoSst', card: 'cardAguardandoSst', link: 'linkAguardandoSst', valorId: 'kpiAguardandoSstValor', destinoFn: 'aguardandoSst', destino: 'supervisor-approval.html', pagina: 'supervisorApproval', oculta: true },
  { nome: 'EPIs entregues', chave: 'episEntregues', card: 'cardEpisEntregues', link: 'linkEpisEntregues', valorId: 'kpiEpisEntreguesValor', destinoFn: 'episEntregues', destino: 'reports.html?de=2026-10-01&ate=2026-10-31#reportDelivered', pagina: 'reports', oculta: true, extra: { de: '2026-10-01', ate: '2026-10-31' } },
  { nome: 'Próximo do vencimento de uso', chave: 'proximoVencimentoUso', card: 'cardProximoVencimentoUso', link: 'linkProximoVencimentoUso', valorId: 'kpiProximoVencimentoValor', destinoFn: 'proximoVencimentoUso', destino: 'reports.html#reportUpcoming', pagina: 'reports', oculta: true },
];

// ═══════════════════════════════════════════════════════════════════
// Módulo: nada de ampliação nem de prévia
// ═══════════════════════════════════════════════════════════════════
describe('módulo: a ampliação e a prévia foram removidas', () => {
  test('EpiDashboard não exporta mais ampliacao, layout nem renderizadores de prévia', () => {
    const D = modulo();
    assert.equal(D.ampliacao, undefined);
    assert.equal(D.layout, undefined);
    for (const nome of Object.keys(D.render)) assert.equal(/previa/i.test(nome), false, `render.${nome}`);
  });

  test('o código-fonte não tem mais posição fixa, reserva, temporizador de recolher nem ouvintes de hover, foco, rolagem ou redimensionamento', () => {
    const fonte = ler('js/dashboard.js');
    for (const trecho of ['posicionarAmpliacao', 'kpi-reserva', 'data-ampliado', 'DEMORA_RECOLHER', 'mouseenter', 'mouseleave', 'focusin', 'previa']) {
      assert.equal(fonte.includes(trecho), false, trecho);
    }
  });

  test('render.cards e render.visivelCartao continuam: os números e a regra de ocultar só pela negação explícita', () => {
    const D = modulo();
    const c = D.render.cards({ itensDisponiveis: { permitido: true, valor: 1500 }, funcionariosAtivos: { permitido: false } });
    assert.equal(c.disponiveis.valor, '1.500');
    assert.deepEqual(c.funcionarios, { valor: '—', meta: 'sem permissão' });
    assert.equal(D.render.visivelCartao({ permitido: false }), false);
    for (const visivel of [{ permitido: true, valor: 0 }, undefined, null, {}, { permitido: true, valor: -1 }]) assert.equal(D.render.visivelCartao(visivel), true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Destinos
// ═══════════════════════════════════════════════════════════════════
describe('destinos: cada cartão leva à tela correspondente já filtrada; sem permissão ou indicador malformado, nenhum', () => {
  for (const c of CARTOES) {
    test(`${c.nome} → ${c.destino}`, () => {
      const d = modulo().destinos[c.destinoFn];
      assert.equal(typeof d, 'function', `destinos.${c.destinoFn}`);
      assert.equal(d({ permitido: true, valor: 0, ...(c.extra || {}) }), c.destino, 'mesmo com zero quem vê a fonte abre a tela');
      assert.equal(d({ permitido: true, valor: 7, ...(c.extra || {}) }), c.destino);
      for (const sem of [{ permitido: false }, undefined, null, {}, { permitido: true, valor: -1 }, { permitido: true, valor: '3' }]) assert.equal(d(sem), null, JSON.stringify(sem));
    });
  }

  test('os filtros dos destinos existem nas telas (nenhuma URL inventada)', () => {
    const itens = require('../js/itens-disponiveis'); // eslint-disable-line global-require
    assert.equal(itens.filtroDaUrl('?situacao=ABAIXO_MINIMO'), 'ABAIXO_MINIMO');
    assert.equal(itens.filtroDaUrl('?situacao=SEM_COBERTURA'), 'SEM_COBERTURA');
    assert.equal(itens.filtroDaUrl('?situacao=COM_COMPROMETIDO'), 'COM_COMPROMETIDO');
    assert.equal(ler('pages/available-items.html').includes('somenteComNecessidade'), true);
    for (const [arquivo, trecho] of [['pages/funcionarios.html', 'situacaoDaUrl'], ['pages/stock-requests.html', 'coberturaDaUrl']]) assert.equal(ler(arquivo).includes(trecho), true, arquivo);
    for (const pagina of ['pages/available-items.html', 'pages/funcionarios.html', 'pages/stock-requests.html', 'pages/supervisor-approval.html']) assert.equal(fs.existsSync(path.join(RAIZ, pagina)), true, pagina);
  });
});

describe('autorização: a fonte que libera o número é a mesma que abre a tela de destino', () => {
  const mundo = (recursos = {}, acoes = {}) => ({ perfil: 'USUARIO', recursos, acoes, administracao: {} });
  const ver = { visualizar: true, criar: false, editar: false, excluir: false };

  test('availableItems.visualizar abre Itens Disponíveis (os seis cartões de estoque)', () => {
    assert.equal(Permissoes.podeAbrir(mundo({ availableItems: ver }), 'availableItems'), true);
    assert.equal(Permissoes.podeAbrir(mundo({}), 'availableItems'), false);
  });

  test('Funcionários ativos: employeeHistory.visualizar (a fonte do número) abre o Cadastro de Colaboradores', () => {
    assert.equal(Permissoes.podeAbrir(mundo({ employeeHistory: ver }), 'funcionarios'), true);
    assert.equal(Permissoes.podeAbrir(mundo({ dashboard: ver }), 'funcionarios'), false);
  });

  test('Disponíveis para entrega (REALIZAR_ENTREGA) e Aguardando estoque (REALIZAR_ENTREGA ou ENCERRAR_SOLICITACAO) abrem Entregas por solicitação', () => {
    assert.equal(Permissoes.podeAbrir(mundo({}, { REALIZAR_ENTREGA: true }), 'stockRequests'), true);
    assert.equal(Permissoes.podeAbrir(mundo({}, { ENCERRAR_SOLICITACAO: true }), 'stockRequests'), true);
    assert.equal(Permissoes.podeAbrir(mundo({}, {}), 'stockRequests'), false);
  });

  test('Aguardando SST: APROVAR_SOLICITACAO (a fonte do número) abre a Aprovação; REPROVAR sozinha não', () => {
    assert.equal(Permissoes.podeAbrir(mundo({}, { APROVAR_SOLICITACAO: true }), 'supervisorApproval'), true);
    assert.equal(Permissoes.podeAbrir(mundo({}, { REPROVAR_SOLICITACAO: true }), 'supervisorApproval'), false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Estrutura e CSS
// ═══════════════════════════════════════════════════════════════════
describe('estrutura: cartão inteiro é um link semântico; sem prévia, reserva nem aria-describedby de prévia', () => {
  const html = ler('pages/dashboard.html');

  for (const c of CARTOES) {
    test(`${c.nome}: <a id="${c.link}" class="kpi-link kpi-link-total"> envolve título, ícone, número e texto; sem botão nem prévia`, () => {
      const artigo = (html.match(new RegExp(`<article class="kpi-card [a-z]+"[^>]*\\bid="${c.card}"[^>]*>[\\s\\S]*?</article>`)) || [''])[0];
      assert.notEqual(artigo, '', `<article id="${c.card}">`);
      assert.equal(/style="display:none"/.test(artigo.slice(0, artigo.indexOf('>') + 1)), c.oculta, c.oculta ? 'nasce oculto' : 'nasce visível');
      const ancora = (artigo.match(/<a\b[^>]*>([\s\S]*?)<\/a>/) || [, ''])[1];
      assert.match(artigo, new RegExp(`<a\\b[^>]*\\bid="${c.link}"[^>]*\\bclass="kpi-link kpi-link-total"|<a\\b[^>]*\\bclass="kpi-link kpi-link-total"[^>]*\\bid="${c.link}"`));
      assert.ok(ancora.includes('class="kpi-title"') && ancora.includes('class="kpi-icon"') && ancora.includes(`id="${c.valorId}"`) && ancora.includes(`id="${c.valorId.replace('Valor', 'Meta')}"`), 'conteúdo dentro do link');
      assert.equal(/<button\b|kpi-previa|aria-describedby/.test(artigo), false);
      assert.equal(/\shref=/.test(artigo), false, 'o href só vem do script, quando há permissão');
    });
  }

  test('restam exatamente 15 cartões, cada id de cartão aparece uma vez e nenhum resto de prévia ou ampliação fica no HTML/CSS inline', () => {
    assert.equal((html.match(/<article class="kpi-card/g) || []).length, 15);
    for (const c of CARTOES) assert.equal((html.match(new RegExp(`id="${c.card}"`, 'g')) || []).length, 1);
    for (const resto of ['kpi-previa', 'kpi-reserva', 'data-ampliado', 'data-limitada', 'ampliacao', 'posicionarAmpliacao']) assert.equal(html.includes(resto), false, resto);
  });

  test('os cartões em integração e os de CA (que já tinham o seu link) não ganharam link novo', () => {
    const ancoras = (html.match(/<a\b[^>]*\bclass="kpi-link[^"]*"[^>]*>/g) || []).filter((a) => !CARTOES.some((c) => a.includes(`id="${c.link}"`)) && !/id="link(ProximoVencimentoUso|AguardandoEntrega)"/.test(a));
    assert.equal(ancoras.length, 2);
    assert.equal(ancoras.every((a) => /id="linkCa(Vencidos|AVencer)"/.test(a)), true);
  });
});

describe('visual: vidro fosco, hover discreto e acessibilidade (dashboard.css)', () => {
  const css = ler('css/dashboard.css');

  test('o link do cartão inteiro só é ativo com href e mostra o cursor de ação', () => {
    assert.match(css, /\.kpi-link-total\[href\]::after\s*\{[^}]*cursor\s*:\s*pointer/);
    assert.match(ler('pages/dashboard.html'), /\.kpi-link-total::after\{content:"";position:absolute;inset:0;border-radius:inherit\}/);
  });

  test('hover: sobe 2 px em cerca de 160 ms, só em cartão clicável e só onde há hover real; sem aumentar, deformar nem deslocar vizinhos', () => {
    assert.match(css, /transition\s*:\s*transform\s+\.16s[^;}]*,\s*box-shadow\s+\.16s/);
    const bloco = css.slice(css.indexOf('@media(hover:hover)'));
    assert.match(bloco, /\.kpi-card:has\(\.kpi-link-total\[href\]\):hover\s*\{[^}]*transform\s*:\s*translateY\(-2px\)/);
    assert.equal(/scale\(|translate\(|width|height|margin|top\s*:|left\s*:/.test(bloco.slice(0, bloco.indexOf('}') + 1)), false, 'só translateY(-2px) e sombra');
    assert.equal(/\.kpi-card:hover\s*\{[^}]*translateY/.test(css.replace(/\.kpi-card:has\([^)]*\):hover/g, '')), false, 'cartão sem link não se move');
  });

  test('prefers-reduced-motion remove a transição e o movimento', () => {
    const rm = css.slice(css.indexOf('@media(prefers-reduced-motion:reduce)'));
    assert.match(rm, /transition\s*:\s*none/);
    assert.match(rm, /\.kpi-card[^{]*:hover[^{]*\{[^}]*transform\s*:\s*none/);
    assert.match(rm, /\.kpi-card:has\(\.kpi-link-total\[href\]\):hover\s*\{[^}]*transform\s*:\s*none/, 'a regra do cartão clicável (mais específica) também é neutralizada');
  });

  test('vidro fosco: translúcido, desfoque perceptível, borda com luz sutil e reflexo suave no topo, nos dois temas e só com suporte', () => {
    const vidro = css.slice(css.indexOf('Vidro fosco'));
    assert.ok(vidro.length > 200, 'bloco "Vidro fosco" ausente');
    assert.match(vidro, /@supports\s*\(\(backdrop-filter:blur\(1px\)\)/);
    assert.match(vidro, /backdrop-filter\s*:\s*blur\(\s*(1[6-9]|2\d)px\s*\)/);
    assert.match(vidro, /-webkit-backdrop-filter/);
    assert.match(vidro, /linear-gradient\(180deg,\s*rgba\(255,255,255,/, 'reflexo suave no topo');
    assert.match(vidro, /html\[data-theme="dark"\]/);
    assert.match(vidro, /box-shadow\s*:[^;]*inset/, 'luz sutil na borda');
  });

  test('o vidro não vale para alto contraste, acessibilidade nem cores forçadas (legibilidade primeiro)', () => {
    const vidro = css.slice(css.indexOf('Vidro fosco'));
    assert.match(vidro, /:not\(\[data-display\]\):not\(\[data-a11y\]\)/);
    assert.match(css, /@media\(forced-colors:active\)[\s\S]*backdrop-filter:none/);
  });

  test('o CSS não tem mais nada da ampliação (os resíduos viviam no HTML)', () => {
    for (const resto of ['kpi-reserva', 'data-ampliado', 'kpi-previa']) assert.equal(css.includes(resto), false, resto);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Página em DOM simulado
// ═══════════════════════════════════════════════════════════════════
const CONTEXTO = { empresa: { id: 3, nome: 'Empresa Demonstração SafeWork' }, usuario: { id: 7, nome: 'Pessoa Teste', email: 'p@exemplo-cliente.com.br', perfil: 'MASTER' } };
const ACESSO = { permissoes: { recursos: { dashboard: { visualizar: true, criar: false, editar: false, excluir: false } }, acoes: {}, administracao: {} }, podeAlterar: false };

function montarPagina(corpoDaResposta, acesso = ACESSO) {
  EpiHttp.configurar({ baseUrl: BASE, fetch: async () => corpoDaResposta });
  const html = ler('pages/dashboard.html');
  const script = html.slice(html.lastIndexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));
  const novoElemento = (id) => ({
    id, innerHTML: '', textContent: '', style: {}, listeners: {}, atributos: {}, className: '', parentNode: null,
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    setAttribute(k, v) { this.atributos[k] = String(v); }, removeAttribute(k) { delete this.atributos[k]; }, focus() {},
    contains() { return false; }, remove() {},
  });
  const mapa = {};
  const el = (id) => (mapa[id] = mapa[id] || novoElemento(id));
  const timers = [];
  const documento = {
    getElementById: el, querySelectorAll: () => [], listeners: {}, createElement: () => novoElemento('novo'),
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
  };
  const janelaFalsa = {
    SAFEWORK_PORTAL_API_BASE_URL: BASE, innerWidth: 1440, innerHeight: 900, listeners: {},
    matchMedia: () => ({ matches: false }),
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
  };
  const sandbox = {
    document: documento, window: janelaFalsa, EpiHttp, EpiDashboard: modulo(),
    EpiPermissoes: { prepararPagina: async () => acesso },
    EpiSessaoEmpresarial: { montar: async (o) => { sandbox.opcoesMontar = o; return CONTEXTO; }, sessaoEncerrada() { sandbox.encerrada = true; } },
    console, Promise, String, Number, Object, JSON, Math,
    setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout() {},
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : ['2026-10-19T12:00:00.000Z'])); } },
  };
  vm.runInNewContext(script, sandbox);
  const esperar = async () => { for (let i = 0; i < 40; i += 1) await new Promise((r) => setImmediate(r)); };
  return { el, esperar, janelaFalsa, documento, sandbox, mapa };
}

const todosPermitidos = () => ({
  itensDisponiveis: { permitido: true, valor: 40 }, estoqueAbaixoMinimo: { permitido: true, valor: 3 }, saldoLivre: { permitido: true, valor: 30 }, comprometido: { permitido: true, valor: 10 },
  semCobertura: { permitido: true, valor: 2 }, necessidadeReposicao: { permitido: true, valor: 11 }, caVencido: { permitido: true, valor: 4, aVencer: 5, diasAlerta: 60 },
  funcionariosAtivos: { permitido: true, valor: 17 }, solicitacoesAguardandoSst: { permitido: true, valor: 5 }, solicitacoesAguardandoEstoque: { permitido: true, valor: 3 }, disponiveisParaEntrega: { permitido: true, valor: 2 },
  episEntregues: { permitido: true, valor: 31, de: '2026-10-01', ate: '2026-10-31' }, proximoVencimentoUso: { permitido: true, valor: 8 },
});
const ok = (indicadores) => resposta(200, { status: 'ok', indicadores });

describe('página: cada cartão clicável recebe o link da tela de destino e nada de ampliação é ligado', () => {
  test('com todas as fontes liberadas: os dez cartões têm href para o destino filtrado e estão visíveis', async () => {
    const pg = montarPagina(ok(todosPermitidos()));
    await pg.esperar();
    for (const c of CARTOES) {
      assert.equal(pg.el(c.link).atributos.href, c.destino, c.nome);
      assert.notEqual(pg.el(c.card).style.display, 'none', c.nome);
    }
  });

  test('zero é número permitido: o cartão aparece e continua clicável', async () => {
    const zeros = Object.fromEntries(Object.entries(todosPermitidos()).map(([k, v]) => [k, { permitido: true, valor: 0, ...(v.de ? { de: v.de, ate: v.ate } : {}) }])); // o período de EPIs entregues acompanha o número, inclusive no zero
    const pg = montarPagina(ok(zeros));
    await pg.esperar();
    for (const c of CARTOES) assert.equal(pg.el(c.link).atributos.href, c.destino, c.nome);
  });

  for (const c of CARTOES) {
    test(`${c.nome}: sem permissão ${c.oculta ? 'o cartão inteiro fica oculto' : 'continua "— sem permissão"'}, sem link`, async () => {
      const pg = montarPagina(ok({ ...todosPermitidos(), [c.chave]: { permitido: false } }));
      await pg.esperar();
      assert.equal(Object.hasOwn(pg.el(c.link).atributos, 'href'), false);
      if (c.oculta) assert.equal(pg.el(c.card).style.display, 'none');
      else {
        assert.notEqual(pg.el(c.card).style.display, 'none');
        assert.equal(pg.el(c.valorId).textContent, '—');
      }
    });

    test(`${c.nome}: ${c.oculta ? 'nasce oculto (sem piscar) e só aparece depois da resposta' : 'sem resposta do servidor não há link'}`, async () => {
      let liberar;
      const segurada = new Promise((r) => { liberar = r; });
      const pg = montarPagina(segurada);
      await pg.esperar();
      assert.equal(Object.hasOwn(pg.el(c.link).atributos, 'href'), false);
      if (c.oculta) assert.equal(pg.el(c.card).style.display, 'none');
      liberar(ok(todosPermitidos()));
      await pg.esperar();
      assert.equal(pg.el(c.link).atributos.href, c.destino);
    });
  }

  test('erro de carga não é falta de permissão: os cartões ocultáveis aparecem como indisponíveis, sem link', async () => {
    for (const falha of [resposta(503, { status: 'erro', codigo: 'INDISPONIVEL' }), ok({})]) {
      const pg = montarPagina(falha);
      await pg.esperar();
      for (const c of CARTOES) {
        assert.equal(Object.hasOwn(pg.el(c.link).atributos, 'href'), false, c.nome);
        assert.notEqual(pg.el(c.card).style.display, 'none', c.nome);
      }
    }
  });

  test('ao encerrar a sessão os cartões ocultáveis voltam a nascer ocultos e os links são retirados', async () => {
    const pg = montarPagina(ok(todosPermitidos()));
    await pg.esperar();
    pg.sandbox.opcoesMontar.aoEncerrar();
    for (const c of CARTOES) {
      assert.equal(Object.hasOwn(pg.el(c.link).atributos, 'href'), false, c.nome);
      if (c.oculta) assert.equal(pg.el(c.card).style.display, 'none', c.nome);
    }
  });

  test('nenhum ouvinte de hover, foco, rolagem, redimensionamento ou tecla é registrado para os cartões: o movimento é só CSS', async () => {
    const pg = montarPagina(ok(todosPermitidos()));
    await pg.esperar();
    for (const c of CARTOES) {
      for (const id of [c.card, c.link]) assert.deepEqual(Object.keys(pg.el(id).listeners), [], `${id} sem ouvintes`);
    }
    assert.equal(Object.keys(pg.janelaFalsa.listeners).some((e) => ['scroll', 'resize'].includes(e)), false);
    assert.equal(Object.keys(pg.documento.listeners).includes('keydown'), false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 12I (21/10/2026): 15 cartões — consolidação, remoções e os dois indicadores dos relatórios
// ═══════════════════════════════════════════════════════════════════
describe('15 cartões: aguardando aprovação consolidado; entrega, vencidos em uso e EPI pendente retirados', () => {
  const html = ler('pages/dashboard.html');

  test('removidos por inteiro, sem ids, textos nem indicador: EPIs vencidos em uso, Funcionários com EPI pendente e Solicitações aguardando entrega', () => {
    for (const resto of ['EPIs vencidos em uso', 'Funcionários com EPI pendente', 'Solicitações aguardando entrega', 'cardAguardandoEntrega', 'kpiAguardandoEntrega', 'linkAguardandoEntrega', 'kpiEpisVencidosUso', 'kpiFuncionariosEpiPendente', 'Aguardando em partes']) {
      assert.equal(html.includes(resto), false, resto);
    }
  });

  test('"Solicitações aguardando aprovação" é UM cartão só (a fila do SST); o título antigo "aguardando SST" não existe mais', () => {
    assert.equal((html.match(/<div class="kpi-title">Solicitações aguardando aprovação<\/div>/g) || []).length, 1);
    assert.equal(html.includes('Solicitações aguardando SST'), false);
    assert.equal((html.match(/id="cardAguardandoSst"/g) || []).length, 1);
  });

  test('a grade fecha sem lacunas no meio: 15 cartões em fluxo automático (3 linhas de 4 e a última com 3); nenhuma regra por posição', () => {
    const cartoes = (html.match(/<article class="kpi-card/g) || []).length;
    assert.equal(cartoes, 15);
    const css = ler('css/dashboard.css');
    assert.match(css, /\.kpi-row\{grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
    assert.equal(/nth-child|nth-of-type|grid-column\s*:|grid-row\s*:/.test(css.slice(0, css.indexOf('Vidro fosco'))), false);
  });

  test('destinos.porPermissao deixou de existir: os dois cartões agora saem do indicador do servidor (mesma permissão do relatório)', () => {
    assert.equal(modulo().destinos.porPermissao, undefined);
  });

  test('EPIs entregues: o destino leva o mês do SERVIDOR (de/ate) e só existe com período válido; sem ele, nenhum link', () => {
    const d = modulo().destinos.episEntregues;
    assert.equal(d({ permitido: true, valor: 3, de: '2026-10-01', ate: '2026-10-31' }), 'reports.html?de=2026-10-01&ate=2026-10-31#reportDelivered');
    for (const ruim of [{ permitido: true, valor: 3 }, { permitido: true, valor: 3, de: '2026-10-31', ate: '2026-10-01' }, { permitido: true, valor: 3, de: '2026-13-01', ate: '2026-13-31' },
      { permitido: true, valor: 3, de: 'x', ate: 'y' }, { permitido: false }, null, undefined]) {
      assert.equal(d(ruim), null, JSON.stringify(ruim));
    }
  });

  test('os textos dos dois novos cartões dizem o que contam: unidades entregues no mês e itens com prazo de uso vencendo em até 30 dias', () => {
    const c = modulo().render.cards({ episEntregues: { permitido: true, valor: 1234, de: '2026-10-01', ate: '2026-10-31' }, proximoVencimentoUso: { permitido: true, valor: 8 } });
    assert.deepEqual(c.episEntregues, { valor: '1.234', meta: 'Unidades entregues no mês' });
    assert.deepEqual(c.proximoVencimento, { valor: '8', meta: 'Itens com prazo de uso vencendo em até 30 dias' });
  });
});
