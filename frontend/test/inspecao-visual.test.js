'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { NUNCA_PUBLICAR, lerAllowlist } = require('../publicacao/empacotar');

/**
 * Liberação visual controlada (05/10/2026, temporária): js/inspecao-visual.js
 * só age quando o protótipo é aberto com ?inspecao=1 (link que o menu das
 * páginas integradas monta para o MASTER). Esconde a tela de login SIMULADA,
 * mostra a faixa fixa e recusa toda escrita na API simulada. Nunca publicado.
 */

const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
// Configurações (config.html) deixou de ser protótipo: é página integrada.
// 05/10/2026: Compras / Entradas e Regras Função / Setor são MÓDULOS TEMPORARIAMENTE DESATIVADOS / ADIADOS —
// fora da inspeção, arquivos preservados; ainda carregam o script, que recusa ativar neles.
// 12K-C: EPIs Entregues (delivered-items.html) e, na 12K-D, Relatórios (reports.html) viraram páginas integradas e saíram da inspeção.
const PROTOTIPOS = ['emails-gestao.html', 'lgpd.html', 'self-service.html', 'support.html'];
const DESATIVADOS = ['purchases.html', 'eligibility-rules.html'];

function elemento(tag) {
  return {
    tag, style: {}, textContent: '', filhos: [], atributos: {},
    appendChild(f) { this.filhos.push(f); return f; },
    insertBefore(f) { this.filhos.unshift(f); return f; },
    setAttribute(n, v) { this.atributos[n] = String(v); },
  };
}

// <a href="..."> da barra lateral do protótipo, com um filho (ícone) para o clique chegar por dentro.
function ancora(href) {
  const a = { tagName: 'A', parentNode: null, atributos: { href }, getAttribute: (n) => (Object.hasOwn(a.atributos, n) ? a.atributos[n] : null), setAttribute: (n, v) => { a.atributos[n] = String(v); } };
  a.filho = { tagName: 'DIV', parentNode: a };
  return a;
}

function montar(search, ancoras = []) {
  const login = elemento('div');
  login.style.display = 'flex';
  const body = elemento('body');
  body.firstChild = elemento('div');
  const head = elemento('head');
  const ouvintes = {};
  const document = {
    body,
    head,
    getElementById: (id) => (id === 'loginScreen' ? login : null),
    querySelectorAll: (sel) => (sel === 'a[href]' ? ancoras.filter((a) => a.atributos.href !== null && a.atributos.href !== undefined) : []),
    createElement: (tag) => elemento(tag),
    addEventListener: (ev, fn, captura) => { (ouvintes[ev] = ouvintes[ev] || []).push({ fn, captura: !!captura }); },
  };
  const chamadas = [];
  const original = async (metodo, endpoint) => { chamadas.push([metodo, endpoint]); return { ok: true, status: 200, data: [] }; };
  const EpiAPI = { request: original, query: {}, _db: () => ({}) };
  const toasts = [];
  const sandbox = { document, location: { search }, EpiAPI, showToast: (m) => toasts.push(m), console, Promise, String, Object, Array, URLSearchParams };
  sandbox.window = sandbox;
  vm.runInNewContext(ler('js/inspecao-visual.js'), sandbox);
  const carregar = () => { for (const o of ouvintes.DOMContentLoaded || []) o.fn(); };
  return { sandbox, login, body, head, ouvintes, chamadas, toasts, EpiAPI, original, carregar };
}

describe('inspecao-visual: a navegação entre protótipos mantém a inspeção (o login simulado fica inacessível)', () => {
  const INTEGRADAS = ['dashboard.html', 'reports.html', 'config.html', 'materials.html', 'import-employees.html', '../portal/inicio.html'];

  test('a lista dos seis protótipos é a mesma do menu das páginas integradas (permissoes-efetivas.js), sem Configurações; os dois módulos adiados ficam fora das duas listas, com os arquivos preservados', () => {
    const P = require('../js/permissoes-efetivas'); // eslint-disable-line global-require
    const sandbox = montar('').sandbox;
    const lista = Array.from(sandbox.EpiInspecaoVisual.PROTOTIPOS).sort(); // Array do host: o sandbox tem outro protótipo
    assert.deepEqual(lista, Object.values(P.INSPECAO_PROTOTIPOS).sort());
    assert.deepEqual(lista, PROTOTIPOS);
    assert.equal(lista.includes('config.html'), false);
    assert.deepEqual(Array.from(sandbox.EpiInspecaoVisual.DESATIVADOS), DESATIVADOS);
    for (const arquivo of DESATIVADOS) {
      assert.equal(lista.includes(arquivo), false, arquivo);
      assert.equal(sandbox.EpiInspecaoVisual.desativado(arquivo), true, arquivo);
      assert.equal(sandbox.EpiInspecaoVisual.desativado(`${arquivo}?_s=abc#x`), true, arquivo);
      assert.ok(fs.existsSync(path.join(RAIZ, 'pages', arquivo)), `${arquivo} preservado`);
    }
    assert.equal(sandbox.EpiInspecaoVisual.desativado('lgpd.html'), false);
    assert.equal(sandbox.EpiInspecaoVisual.desativado('https://example.invalid/purchases.html'), false, 'só caminhos relativos do próprio frontend');
  });

  test('módulo adiado: a própria página não ativa a inspeção nem com ?inspecao=1 (fica no estado legado, não operacional)', () => {
    for (const arquivo of DESATIVADOS) {
      const m = montar('?inspecao=1');
      m.sandbox.location.pathname = `/pages/${arquivo}`;
      m.carregar();
      assert.equal(m.login.style.display, 'flex', `${arquivo}: login simulado continua visível`);
      assert.equal(m.body.filhos.length, 0, `${arquivo}: sem faixa de inspeção`);
      assert.equal(m.EpiAPI.request, m.original, `${arquivo}: API simulada intocada`);
      assert.equal((m.ouvintes.click || []).length, 0, `${arquivo}: sem ouvinte de clique`);
    }
    const normal = montar('?inspecao=1');
    normal.sandbox.location.pathname = '/pages/lgpd.html';
    normal.carregar();
    assert.equal(normal.body.filhos.length, 1, 'protótipo em inspeção continua ativando');
  });

  test('comMarcador: só os seis protótipos ganham ?inspecao=1, uma vez só, preservando o ?_s= do legado e o fragmento; integradas, Configurações, módulos adiados, javascript: e URLs externas ficam como estão', () => {
    const { comMarcador } = montar('').sandbox.EpiInspecaoVisual;
    for (const arquivo of PROTOTIPOS) {
      assert.equal(comMarcador(arquivo), `${arquivo}?inspecao=1`, arquivo);
      assert.equal(comMarcador(`${arquivo}?inspecao=1`), `${arquivo}?inspecao=1`, 'não repete');
      assert.equal(comMarcador(`${arquivo}?_s=abc`), `${arquivo}?_s=abc&inspecao=1`, 'preserva o parâmetro do legado');
      assert.equal(comMarcador(`${arquivo}?_s=abc&inspecao=1`), `${arquivo}?_s=abc&inspecao=1`);
      assert.equal(comMarcador(`${arquivo}?inspecao=0#x`), `${arquivo}?inspecao=1#x`, 'o marcador vence e o fragmento fica');
      assert.equal(comMarcador(`./${arquivo}`), `./${arquivo}?inspecao=1`);
      assert.equal((comMarcador(comMarcador(arquivo)).match(/inspecao=1/g) || []).length, 1);
    }
    for (const outro of [...INTEGRADAS, ...DESATIVADOS, 'purchases.html?_s=abc', 'javascript:void(0)', '#topo', 'https://example.invalid/lgpd.html', 'mailto:x@example.invalid', '', null, undefined]) {
      assert.equal(comMarcador(outro), outro, String(outro));
    }
  });

  test('ativo: os links já presentes são marcados na carga e o clique (fase de captura) marca o link na hora, mesmo depois de o legado reescrever o href; links de páginas integradas não mudam', () => {
    const reports = ancora('lgpd.html');
    const suporte = ancora('support.html?_s=abc');
    const dashboard = ancora('dashboard.html');
    const config = ancora('config.html');
    const vazio = ancora('javascript:void(0)');
    const m = montar('?inspecao=1', [reports, suporte, dashboard, config, vazio]);
    m.carregar();
    assert.deepEqual([reports, suporte, dashboard, config, vazio].map((a) => a.atributos.href), ['lgpd.html?inspecao=1', 'support.html?_s=abc&inspecao=1', 'dashboard.html', 'config.html', 'javascript:void(0)']);

    const clique = (m.ouvintes.click || [])[0];
    assert.ok(clique && clique.captura, 'clique interceptado na fase de captura');
    suporte.setAttribute('href', 'support.html?_s=zzz'); // o legado reescreveu o href depois da carga
    clique.fn({ target: suporte.filho });
    assert.equal(suporte.atributos.href, 'support.html?_s=zzz&inspecao=1');
    clique.fn({ target: config.filho });
    assert.equal(config.atributos.href, 'config.html', 'Configurações é página integrada: nunca recebe o marcador');
    assert.doesNotThrow(() => clique.fn({ target: null }));
    assert.doesNotThrow(() => clique.fn({ target: { tagName: 'DIV', parentNode: null } }));
  });

  test('módulo adiado dentro da inspeção: o link nunca ganha o marcador, fica aria-disabled com o aviso, e o clique é recusado com toast (fase de captura), mesmo depois de o legado reescrever o href', () => {
    const compras = ancora('purchases.html');
    const regras = ancora('eligibility-rules.html?_s=abc');
    const reports = ancora('lgpd.html');
    const m = montar('?inspecao=1', [compras, regras, reports]);
    m.carregar();
    assert.deepEqual([compras, regras, reports].map((a) => a.atributos.href), ['purchases.html', 'eligibility-rules.html?_s=abc', 'lgpd.html?inspecao=1']);
    for (const a of [compras, regras]) {
      assert.equal(a.atributos['aria-disabled'], 'true');
      assert.match(a.atributos.title, /desativado/i);
    }
    const clique = (m.ouvintes.click || [])[0];
    compras.setAttribute('href', 'purchases.html?_s=zzz');
    let prevenido = 0; let parado = 0;
    clique.fn({ target: compras.filho, preventDefault: () => { prevenido += 1; }, stopImmediatePropagation: () => { parado += 1; } });
    assert.deepEqual([prevenido, parado], [1, 1], 'o clique não navega');
    assert.equal(compras.atributos.href, 'purchases.html?_s=zzz', 'sem marcador');
    assert.equal(m.toasts.at(-1), m.sandbox.EpiInspecaoVisual.DESATIVADO);
    clique.fn({ target: reports.filho, preventDefault: () => { prevenido += 1; } });
    assert.equal(prevenido, 1, 'protótipo em inspeção segue navegando');
  });

  test('inativo (sem o marcador): nenhum link é tocado e não há ouvinte de clique', () => {
    const reports = ancora('lgpd.html');
    const m = montar('', [reports]);
    m.carregar();
    assert.equal(reports.atributos.href, 'lgpd.html');
    assert.equal((m.ouvintes.click || []).length, 0);
  });

  test('a tela de login simulada fica escondida também por regra de estilo com !important, para o legado não a reexibir', () => {
    const m = montar('?inspecao=1');
    m.carregar();
    assert.equal(m.login.style.display, 'none');
    const estilo = m.head.filhos.find((f) => f.tag === 'style');
    assert.ok(estilo, 'regra inserida no <head>');
    assert.match(estilo.textContent, /#loginScreen\s*\{\s*display:\s*none\s*!important/);
    assert.equal(estilo.atributos['data-inspecao-visual'], 'login');
    assert.equal(montar('').head.filhos.length, 0, 'sem o marcador, nada é inserido');
  });

  test('navegação oculta (05/10/2026): em inspeção, a barra legada esconde Compras, Validade, Regras, Novo Usuário e Administração de Usuários com !important (o main.js reexibe com display:flex); sem o marcador, nada', () => {
    const m = montar('?inspecao=1');
    m.carregar();
    const estilo = m.head.filhos.find((f) => f.tag === 'style' && f.atributos['data-inspecao-visual'] === 'navegacao');
    assert.ok(estilo, 'regra inserida no <head>');
    for (const pagina of ['purchases', 'stockValidity', 'eligibilityRules', 'newUser', 'userAdmin']) assert.ok(estilo.textContent.includes(`.nav a[data-page="${pagina}"]`), pagina);
    assert.match(estilo.textContent, /display:none !important/);
    assert.deepEqual(Array.from(m.sandbox.EpiInspecaoVisual.NAVEGACAO_OCULTA_LEGADA), ['purchases', 'stockValidity', 'eligibilityRules', 'newUser', 'userAdmin']);
    assert.equal(montar('').head.filhos.length, 0);
  });
});

describe('inspecao-visual: só com ?inspecao=1', () => {
  test('sem o marcador (ou com outro valor): o protótipo fica como está — login simulado visível, sem faixa, API simulada intocada', () => {
    for (const search of ['', '?x=1', '?inspecao=0', '?inspecao=true', '?inspecao=']) {
      const m = montar(search);
      m.carregar();
      assert.equal(m.login.style.display, 'flex', search);
      assert.equal(m.body.filhos.length, 0, search);
      assert.equal(m.EpiAPI.request, m.original, search);
      assert.equal(m.sandbox.EpiInspecaoVisual.ativo({ search }), false, search);
    }
  });

  test('com o marcador: esconde a tela de login simulada, mostra a faixa fixa de inspeção e bloqueia qualquer escrita simulada; leitura continua', async () => {
    const m = montar('?inspecao=1&outra=2');
    assert.equal(m.sandbox.EpiInspecaoVisual.ativo({ search: '?inspecao=1' }), true);
    m.carregar();
    assert.equal(m.login.style.display, 'none');
    assert.equal(m.body.filhos.length, 1);
    const faixa = m.body.filhos[0];
    assert.match(faixa.textContent, /Em integração/);
    assert.match(faixa.textContent, /inspeção visual/i);
    assert.match(faixa.textContent, /nenhum dado é gravado/i);
    assert.equal(faixa.atributos['data-inspecao-visual'], '1');

    assert.deepEqual(await m.EpiAPI.request('GET', '/funcionarios'), { ok: true, status: 200, data: [] });
    for (const metodo of ['POST', 'PUT', 'DELETE', 'post']) {
      const r = await m.EpiAPI.request(metodo, '/funcionarios', { nome: 'x' });
      assert.deepEqual([r.ok, r.status], [false, 403], metodo);
      assert.match(r.message, /inspeção/i);
    }
    assert.deepEqual(m.chamadas, [['GET', '/funcionarios']], 'a escrita nunca chega à API simulada');
    assert.ok(m.toasts.length >= 4, 'cada recusa avisa');

    const submit = (m.ouvintes.submit || [])[0];
    assert.ok(submit && submit.captura, 'submit interceptado na fase de captura');
    let prevenido = 0; let parado = 0;
    submit.fn({ preventDefault: () => { prevenido += 1; }, stopImmediatePropagation: () => { parado += 1; } });
    assert.deepEqual([prevenido, parado], [1, 1]);
  });

  test('tolerante: sem loginScreen, sem showToast e sem EpiAPI não falha', () => {
    const m = montar('?inspecao=1');
    m.sandbox.document.getElementById = () => null;
    delete m.sandbox.showToast;
    delete m.sandbox.EpiAPI;
    assert.doesNotThrow(() => m.carregar());
    assert.equal(m.body.filhos.length, 1);
  });
});

describe('inspecao-visual: onde entra e onde nunca entra', () => {
  test('os seis protótipos e os dois módulos adiados carregam o script logo depois de main.js; nenhuma página integrada o carrega', () => {
    const paginas = fs.readdirSync(path.join(RAIZ, 'pages')).filter((f) => f.endsWith('.html'));
    for (const arquivo of paginas) {
      const html = ler(`pages/${arquivo}`);
      if (PROTOTIPOS.includes(arquivo) || DESATIVADOS.includes(arquivo)) {
        assert.match(html, /<script src="\.\.\/js\/main\.js"><\/script>\s*<script src="\.\.\/js\/inspecao-visual\.js"><\/script>/, arquivo);
      } else {
        assert.doesNotMatch(html, /inspecao-visual/, arquivo);
      }
    }
    assert.equal(PROTOTIPOS.length, 4);
    assert.equal(DESATIVADOS.length, 2);
  });

  test('nunca é publicado: fora da allowlist, listado em NUNCA_PUBLICAR, e nenhuma página publicada o referencia', () => {
    const allowlist = lerAllowlist();
    assert.ok(!allowlist.includes('js/inspecao-visual.js'));
    assert.ok(NUNCA_PUBLICAR.includes('js/inspecao-visual.js'));
    for (const entrada of allowlist.filter((f) => f.endsWith('.html'))) assert.doesNotMatch(ler(entrada), /inspecao-visual/, entrada);
  });

  test('o módulo não chama o backend real nem grava no navegador', () => {
    const codigo = ler('js/inspecao-visual.js');
    assert.doesNotMatch(codigo, /fetch\(|XMLHttpRequest|localStorage|sessionStorage|innerHTML|document\.cookie/);
  });
});
