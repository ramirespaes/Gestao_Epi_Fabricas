'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const EpiHttp = require('../js/api-http');

/**
 * 12G-6 — três indicadores das solicitações no Dashboard, só mostrados como
 * o servidor mediu: "Solicitações aguardando SST", "Solicitações aguardando
 * estoque" (nenhum item coberto) e "Disponíveis para entrega" (algum item
 * coberto), as duas últimas populações exclusivas. Número de solicitações; sem
 * a ação, "—" e "sem permissão" (nunca zero); sem atalho (os cliques são da
 * futura 12I); "Pendências sem estoque" continua como estava. Nada no
 * navegador recalcula ou guarda.
 */

const BASE = 'http://localhost:3000/api';
const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const modulo = () => require('../js/dashboard'); // eslint-disable-line global-require
const resposta = (status, corpo) => ({ status, ok: status >= 200 && status < 300, text: async () => (corpo === undefined ? '' : JSON.stringify(corpo)) });

const NOVOS = {
  aguardandoSst: ['solicitacoesAguardandoSst', 'kpiAguardandoSst', 'Solicitações aguardando SST', 'Pedidos aguardando a decisão da Segurança do Trabalho'],
  aguardandoEstoque: ['solicitacoesAguardandoEstoque', 'kpiAguardandoEstoque', 'Solicitações aguardando estoque', 'Pedidos aprovados sem nenhum item coberto pelo estoque'],
  disponiveisEntrega: ['disponiveisParaEntrega', 'kpiDisponiveisEntrega', 'Disponíveis para entrega', 'Pedidos com algum item já coberto pelo estoque'],
};
const INDICADORES = {
  semCobertura: { permitido: true, valor: 9 },
  solicitacoesAguardandoSst: { permitido: true, valor: 3 },
  solicitacoesAguardandoEstoque: { permitido: true, valor: 1250 },
  disponiveisParaEntrega: { permitido: true, valor: 0 },
};

describe('render dos três indicadores das solicitações', () => {
  test('número formatado e a explicação do cartão; zero real é "0"', () => {
    const c = modulo().render.cards(INDICADORES);
    assert.deepEqual(c.aguardandoSst, { valor: '3', meta: NOVOS.aguardandoSst[3] });
    assert.deepEqual(c.aguardandoEstoque, { valor: '1.250', meta: NOVOS.aguardandoEstoque[3] });
    assert.equal('aguardandoEntrega' in c, false, 'o cartão antigo não existe mais');
    assert.deepEqual(c.disponiveisEntrega, { valor: '0', meta: NOVOS.disponiveisEntrega[3] });
    assert.deepEqual(c.semCobertura, { valor: '9', meta: 'Aprovado sem estoque para cobrir' }, 'Pendências sem estoque continua igual');
  });

  test('sem a ação: "—" e "sem permissão", nunca zero; ausente ou malformado: "indisponível"', () => {
    const negado = modulo().render.cards({
      solicitacoesAguardandoSst: { permitido: false }, solicitacoesAguardandoEstoque: { permitido: false }, disponiveisParaEntrega: { permitido: false },
    });
    for (const k of Object.keys(NOVOS)) assert.deepEqual(negado[k], { valor: '—', meta: 'sem permissão' }, k);
    const ruim = modulo().render.cards({ solicitacoesAguardandoSst: { permitido: true, valor: -1 }, solicitacoesAguardandoEstoque: { permitido: true, valor: '2' } });
    for (const k of Object.keys(NOVOS)) assert.deepEqual(ruim[k], { valor: '—', meta: 'indisponível' }, k);
  });

  test('o navegador não deriva um número do outro: cada cartão aparece como veio', () => {
    const c = modulo().render.cards({ solicitacoesAguardandoEstoque: { permitido: true, valor: 1 }, disponiveisParaEntrega: { permitido: true, valor: 2 } });
    assert.deepEqual([c.aguardandoEstoque.valor, c.disponiveisEntrega.valor], ['1', '2']);
  });
});

describe('pages/dashboard.html', () => {
  const html = ler('pages/dashboard.html');

  test('três cartões novos com título, valor e explicação próprios; nascem "—"; sem link nem atalho novo', () => {
    for (const [, id, titulo, meta] of Object.values(NOVOS)) {
      const cartao = html.match(new RegExp(`<article class="kpi-card[^"]*">\\s*<div class="kpi-head">\\s*<div class="kpi-title">${titulo}</div>[\\s\\S]*?</article>`));
      assert.ok(cartao, titulo);
      assert.match(cartao[0], new RegExp(`<div class="kpi-value" id="${id}Valor">—</div>`));
      assert.match(cartao[0], new RegExp(`<div class="kpi-meta" id="${id}Meta">${meta}</div>`));
      assert.equal(/<a\b|href=|onclick/.test(cartao[0]), false, `${titulo}: sem atalho novo`);
    }
  });

  test('"Pendências sem estoque" continua e não há um segundo cartão de "Aguardando estoque"', () => {
    assert.equal((html.match(/<div class="kpi-title">Pendências sem estoque<\/div>/g) || []).length, 1);
    assert.equal(/<div class="kpi-title">Aguardando estoque<\/div>/.test(html), false);
  });

  test('o mapa de cartões da página liga cada cartão novo ao seu indicador', () => {
    const script = html.slice(html.lastIndexOf('<script>'), html.lastIndexOf('</script>'));
    for (const [chave, [, id]] of Object.entries(NOVOS)) assert.match(script, new RegExp(`${chave}: '${id}'`), chave);
  });
});

describe('página (DOM simulado)', () => {
  function montarPagina(corpo) {
    EpiHttp.configurar({ baseUrl: BASE, fetch: async () => resposta(200, corpo) });
    const html = ler('pages/dashboard.html');
    const script = html.slice(html.lastIndexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));
    const mapa = {};
    const el = (id) => (mapa[id] = mapa[id] || {
      id, innerHTML: '', textContent: '', style: {}, listeners: {}, atributos: {},
      addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
      setAttribute(k, v) { this.atributos[k] = String(v); }, removeAttribute(k) { delete this.atributos[k]; }, focus() {},
    });
    const sandbox = {
      document: { getElementById: el, querySelectorAll: () => [] },
      window: { SAFEWORK_PORTAL_API_BASE_URL: BASE },
      EpiHttp,
      EpiDashboard: modulo(),
      EpiPermissoes: { prepararPagina: async () => ({ permissoes: { recursos: { dashboard: { visualizar: true } }, acoes: {}, administracao: {} }, podeAlterar: false }) },
      EpiSessaoEmpresarial: { montar: async (o) => { sandbox.opcoesMontar = o; return { empresa: { id: 3, nome: 'Empresa' }, usuario: { id: 7, nome: 'Pessoa', perfil: 'USUARIO' } }; }, sessaoEncerrada() {} },
      console, Promise, String, Number, Object, JSON,
    };
    vm.runInNewContext(script, sandbox);
    const esperar = async () => { for (let i = 0; i < 40; i += 1) await new Promise((r) => setImmediate(r)); };
    return { el, sandbox, esperar };
  }

  test('os três cartões recebem os números do servidor; sem permissão aparece como tal', async () => {
    const pg = montarPagina({ status: 'ok', indicadores: { ...INDICADORES, disponiveisParaEntrega: { permitido: false } } });
    assert.equal(pg.el('kpiAguardandoSstMeta').textContent, 'Carregando…');
    await pg.esperar();
    assert.deepEqual(
      ['kpiAguardandoSst', 'kpiAguardandoEstoque', 'kpiDisponiveisEntrega'].map((k) => [pg.el(`${k}Valor`).textContent, pg.el(`${k}Meta`).textContent]),
      [['3', NOVOS.aguardandoSst[3]], ['1.250', NOVOS.aguardandoEstoque[3]], ['—', 'sem permissão']],
    );
  });

  test('o encerramento da sessão limpa também os três cartões novos', async () => {
    const pg = montarPagina({ status: 'ok', indicadores: INDICADORES });
    await pg.esperar();
    pg.sandbox.opcoesMontar.aoEncerrar();
    for (const k of ['kpiAguardandoSst', 'kpiAguardandoEstoque', 'kpiDisponiveisEntrega']) assert.equal(pg.el(`${k}Valor`).textContent, '—', k);
  });
});
