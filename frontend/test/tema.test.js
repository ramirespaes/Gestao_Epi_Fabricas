'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const T = require('../js/tema');

/**
 * Configurações — js/tema.js aplica a aparência POR IDENTIDADE (tema e modo
 * visual vindos do servidor) em todas as páginas integradas. O
 * localStorage é só cache da primeira pintura: o servidor sempre vence.
 */

const RAIZ = path.join(__dirname, '..');

function janela({ escuroNoSistema = false, cache } = {}) {
  const atributos = {};
  const armazenado = {};
  if (cache !== undefined) armazenado[T.CHAVE_CACHE] = cache;
  const ouvintes = [];
  const consulta = { matches: escuroNoSistema, addEventListener: (ev, fn) => ouvintes.push(fn) };
  const w = {
    document: {
      documentElement: {
        style: {},
        setAttribute: (k, v) => { atributos[k] = String(v); },
        removeAttribute: (k) => { delete atributos[k]; },
        getAttribute: (k) => (Object.hasOwn(atributos, k) ? atributos[k] : null),
      },
    },
    matchMedia: (q) => (q === T.CONSULTA ? consulta : { matches: false }),
    localStorage: {
      getItem: (k) => (Object.hasOwn(armazenado, k) ? armazenado[k] : null),
      setItem: (k, v) => { armazenado[k] = String(v); },
      removeItem: (k) => { delete armazenado[k]; },
    },
  };
  return { w, atributos, armazenado, consulta, mudarSistema(escuro) { consulta.matches = escuro; ouvintes.forEach((fn) => fn()); } };
}

describe('tema: modelo da preferência', () => {
  test('domínios iguais aos do servidor; normalizar completa e corrige para os padrões', () => {
    assert.deepEqual(T.TEMAS, ['sistema', 'claro', 'escuro']);
    assert.deepEqual(T.MODOS_VISUAIS, ['padrao', 'alto_contraste', 'deuteranopia', 'protanopia', 'tritanopia', 'baixa_visao', 'monocromatico']);
    assert.deepEqual(T.normalizar({ tema: 'escuro', modoVisual: 'tritanopia' }), { tema: 'escuro', modoVisual: 'tritanopia' });
    assert.deepEqual(T.normalizar({ tema: 'dark', modoVisual: 'contrast' }), { tema: 'sistema', modoVisual: 'padrao' });
    assert.deepEqual(T.normalizar(null), { tema: 'sistema', modoVisual: 'padrao' });
    assert.deepEqual(T.normalizar('x'), { tema: 'sistema', modoVisual: 'padrao' });
    assert.equal(T.CHAVE_CACHE, 'safework-aparencia');
  });
});

describe('tema: aplicação no <html>', () => {
  test('tema: escuro e claro são manuais; sistema segue prefers-color-scheme', () => {
    const j = janela({ escuroNoSistema: true });
    T.aplicarPreferencias({ tema: 'claro', modoVisual: 'padrao' }, j.w);
    assert.deepEqual([j.atributos['data-theme'], j.w.document.documentElement.style.colorScheme], ['light', 'light']);
    T.aplicarPreferencias({ tema: 'escuro', modoVisual: 'padrao' }, j.w);
    assert.equal(j.atributos['data-theme'], 'dark');
    T.aplicarPreferencias({ tema: 'sistema', modoVisual: 'padrao' }, j.w);
    assert.equal(j.atributos['data-theme'], 'dark', 'sistema escuro');
    j.mudarSistema(false);
    assert.equal(j.atributos['data-theme'], 'light', 'acompanha a troca do sistema');
    T.aplicarPreferencias({ tema: 'escuro', modoVisual: 'padrao' }, j.w);
    j.mudarSistema(false);
    assert.equal(j.atributos['data-theme'], 'dark', 'manual ignora o sistema');
  });

  test('modo visual: alto contraste é data-display, os demais são data-a11y com os nomes que main.css já conhece; padrão limpa os dois', () => {
    const j = janela();
    const esperado = {
      alto_contraste: { display: 'contrast', a11y: null },
      deuteranopia: { display: null, a11y: 'deuteranopia' },
      protanopia: { display: null, a11y: 'protanopia' },
      tritanopia: { display: null, a11y: 'tritanopia' },
      baixa_visao: { display: null, a11y: 'lowvision' },
      monocromatico: { display: null, a11y: 'monochrome' },
      padrao: { display: null, a11y: null },
    };
    for (const [modoVisual, e] of Object.entries(esperado)) {
      T.aplicarPreferencias({ tema: 'claro', modoVisual }, j.w);
      assert.deepEqual({ display: j.atributos['data-display'] ?? null, a11y: j.atributos['data-a11y'] ?? null }, e, modoVisual);
    }
    const css = fs.readFileSync(path.join(RAIZ, 'css', 'main.css'), 'utf8');
    for (const seletor of ['html[data-display="contrast"]', 'html[data-a11y="deuteranopia"]', 'html[data-a11y="protanopia"]', 'html[data-a11y="tritanopia"]', 'html[data-a11y="lowvision"]', 'html[data-a11y="monochrome"]']) {
      assert.ok(css.includes(seletor), `${seletor} existe no CSS compartilhado`);
    }
    assert.match(css, /html\[data-a11y="lowvision"\] body \{ font-size: 17px !important; \}/, 'baixa visão: texto maior, não só cor');
  });

  test('valor desconhecido vindo do servidor cai no padrão, nunca em atributo arbitrário', () => {
    const j = janela();
    T.aplicarPreferencias({ tema: 'x', modoVisual: '"><script>' }, j.w);
    assert.deepEqual(j.atributos, { 'data-theme': 'light' });
    assert.deepEqual(T.preferenciasAtuais(), { tema: 'sistema', modoVisual: 'padrao' });
  });
});

describe('tema: cache de pintura inicial', () => {
  test('aplicar grava o cache (só tema e modo); iniciar pinta pelo cache antes do servidor; cache corrompido ou ausente usa o padrão; limparCache apaga', () => {
    const j = janela({ escuroNoSistema: false });
    T.aplicarPreferencias({ tema: 'escuro', modoVisual: 'monocromatico' }, j.w);
    assert.deepEqual(JSON.parse(j.armazenado[T.CHAVE_CACHE]), { tema: 'escuro', modoVisual: 'monocromatico' });

    const j2 = janela({ cache: '{"tema":"escuro","modoVisual":"deuteranopia","extra":"ignorado"}' });
    T.iniciar(j2.w);
    assert.deepEqual([j2.atributos['data-theme'], j2.atributos['data-a11y']], ['dark', 'deuteranopia']);

    const j3 = janela({ cache: '{nao é json', escuroNoSistema: true });
    T.iniciar(j3.w);
    assert.deepEqual([j3.atributos['data-theme'], j3.atributos['data-a11y'] ?? null], ['dark', null], 'corrompido: sistema + padrão');

    const j4 = janela({ cache: '{"tema":"escuro","modoVisual":"padrao","senha":"x"}' });
    T.iniciar(j4.w);
    assert.equal(j4.atributos['data-theme'], 'dark');
    assert.equal(j4.armazenado[T.CHAVE_CACHE], '{"tema":"escuro","modoVisual":"padrao","senha":"x"}', 'iniciar só lê: nada é escrito sem o servidor');
    T.aplicarPreferencias({ tema: 'escuro', modoVisual: 'padrao' }, j4.w);
    assert.deepEqual(JSON.parse(j4.armazenado[T.CHAVE_CACHE]), { tema: 'escuro', modoVisual: 'padrao' }, 'o servidor reescreve o cache só com os dois campos');
    T.limparCache(j4.w);
    assert.equal(j4.armazenado[T.CHAVE_CACHE], undefined);

    const semStorage = janela();
    delete semStorage.w.localStorage;
    assert.doesNotThrow(() => T.aplicarPreferencias({ tema: 'claro', modoVisual: 'padrao' }, semStorage.w));
  });

  test('o servidor vence o cache: a preferência aplicada depois substitui a pintura inicial', () => {
    const j = janela({ cache: '{"tema":"escuro","modoVisual":"monocromatico"}' });
    T.iniciar(j.w);
    assert.equal(j.atributos['data-a11y'], 'monochrome');
    T.aplicarPreferencias({ tema: 'claro', modoVisual: 'padrao' }, j.w);
    assert.deepEqual(j.atributos, { 'data-theme': 'light' });
    assert.deepEqual(JSON.parse(j.armazenado[T.CHAVE_CACHE]), { tema: 'claro', modoVisual: 'padrao' });
  });
});

describe('tema: ligação com a sessão', () => {
  test('sessao-empresarial aplica as preferências de /auth/me quando EpiTema está presente, e limpa o cache ao sair', () => {
    const codigo = fs.readFileSync(path.join(RAIZ, 'js', 'sessao-empresarial.js'), 'utf8');
    assert.match(codigo, /EpiTema\.aplicarPreferencias\(/);
    assert.match(codigo, /EpiTema\.limparCache\(/);
  });

  test('todas as páginas integradas carregam js/tema.js no <head>, antes de pintar', () => {
    const paginas = fs.readdirSync(path.join(RAIZ, 'pages')).filter((f) => f.endsWith('.html'));
    const prototipos = ['delivered-items.html', 'eligibility-rules.html', 'emails-gestao.html', 'lgpd.html', 'purchases.html', 'reports.html', 'self-service.html', 'support.html'];
    for (const arquivo of paginas) {
      if (prototipos.includes(arquivo)) continue;
      const html = fs.readFileSync(path.join(RAIZ, 'pages', arquivo), 'utf8');
      const head = html.slice(0, html.indexOf('</head>'));
      assert.match(head, /<script src="\.\.\/js\/tema\.js"><\/script>/, arquivo);
    }
  });
});
