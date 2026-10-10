'use strict';

/**
 * 12G-7 — catálogo visual dos materiais (js/catalogo-visual.js).
 *
 * Tipo conhecido → pictograma do tipo; tipo desconhecido ou "Outro" → o da
 * categoria; categoria desconhecida ou ausente → o genérico. O dado do sistema
 * só escolhe uma chave do catálogo: os SVGs são fixos, locais e decorativos, e
 * o nome do material continua sendo a identificação em texto.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const C = require('../js/catalogo-visual');

const SVG_NS = 'http://www.w3.org/2000/svg';
// Cópia congelada das listas legadas da 12G-8 (Categoria → Tipo). A classificação V2 (08/10/2026) tirou essas listas do
// módulo de Materiais (o tipo agora vem do catálogo da empresa); o catálogo visual continua reconhecendo os nomes
// legados pelo material já gravado, e é isso que esta baseline segue provando. Os nomes V2 estão em catalogo-visual-v2.test.js.
const CATEGORIAS_ATUAIS = ['EPI', 'Uniforme', 'Ferramenta', 'Material de consumo'];
const CHAVES_DOS_TIPOS = ['botina', 'oculos', 'luva', 'protetor-auricular', 'capacete', 'respirador'];
const CHAVES_DAS_CATEGORIAS = ['epi', 'uniforme', 'ferramenta', 'consumo'];
const GENERICO = 'material';
// 12G-8: as listas oficiais da tela de Materiais e o desenho de cada tipo que
// tem um (os demais caem na categoria). A arquitetura da 12G-7 não mudou.
const LISTA_EPI = [
  'Botina de Segurança', 'Capacete', 'Creme de Proteção', 'Luva', 'Mangote', 'Óculos de Proteção Ampla Visão',
  'Óculos de Proteção Incolor', 'Outros', 'Palmilha', 'Proteção Auricular Concha', 'Proteção Auricular Descartável',
  'Respirador PFF2', 'Sapato de Segurança', 'Viseira Película Ouro',
];
const LISTA_UNIFORME = ['Calça', 'Calça de Forneiro', 'Calça Eletricista', 'Camisa', 'Camisa de Forneiro', 'Camisa Eletricista', 'Camiseta', 'Outros'];
const TIPOS_ATUAIS = [...LISTA_EPI, ...LISTA_UNIFORME].filter((t) => t !== 'Outros');
const TIPO_POR_CHAVE = {
  botina: 'Botina de Segurança', oculos: 'Óculos de Proteção Incolor', luva: 'Luva', 'protetor-auricular': 'Proteção Auricular Concha', capacete: 'Capacete', respirador: 'Respirador PFF2',
};
const DESENHO_DO_TIPO_EPI = {
  'Botina de Segurança': 'botina', Capacete: 'capacete', Luva: 'luva', 'Óculos de Proteção Ampla Visão': 'oculos', 'Óculos de Proteção Incolor': 'oculos',
  'Proteção Auricular Concha': 'protetor-auricular', 'Respirador PFF2': 'respirador',
};
const NOMES_ANTERIORES = [['Sapatão / Botina', 'botina'], ['Óculos de proteção', 'oculos'], ['Luva', 'luva'], ['Protetor auricular', 'protetor-auricular'], ['Capacete', 'capacete'], ['Respirador', 'respirador']];

// Um material de exemplo para cada chave do catálogo.
const EXEMPLOS = Object.fromEntries([
  ...CHAVES_DOS_TIPOS.map((chave) => [chave, { tipo: TIPO_POR_CHAVE[chave], categoria: 'EPI' }]),
  ...CATEGORIAS_ATUAIS.map((categoria, i) => [CHAVES_DAS_CATEGORIAS[i], { tipo: 'Outros', categoria }]),
  [GENERICO, {}],
]);
const marcacoesFixas = () => Object.fromEntries(Object.entries(EXEMPLOS).map(([chave, m]) => [chave, C.marcacao(m)]));

const ELEMENTOS = new Set(['svg', 'path', 'rect', 'circle', 'line']);
const ATRIBUTOS = new Set(['class', 'viewbox', 'width', 'height', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
  'aria-hidden', 'focusable', 'data-pictograma', 'd', 'x', 'y', 'rx', 'ry', 'cx', 'cy', 'r', 'x1', 'y1', 'x2', 'y2']);
const etiquetas = (html) => [...String(html).matchAll(/<\s*\/?\s*([a-zA-Z][\w-]*)([^>]*)>/g)].map((m) => ({ nome: m[1].toLowerCase(), atributos: m[2] }));
const nomesDeAtributo = (atributos) => [...atributos.replace(/"[^"]*"|'[^']*'/g, '""').matchAll(/([^\s="'/]+)\s*=/g)].map((m) => m[1].toLowerCase());

const ATAQUES = [
  '"><script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  'javascript:alert(1)',
  'url(https://exemplo.invalid/x.svg)',
  '<foreignObject><div>x</div></foreignObject>',
  'xlink:href="https://exemplo.invalid"',
  '" onload="alert(1)',
  'Luva" onload="alert(1)',
  '__proto__', 'constructor', 'toString', 'hasOwnProperty',
  'x'.repeat(5000),
];

/** Documento mínimo que registra tudo o que o catálogo cria pelo DOM. */
function documentoGravador() {
  const criados = [];
  const no = (ns, tag) => {
    const el = {
      namespaceURI: ns, tagName: tag, atributos: [], filhos: [], escritas: [],
      setAttribute(nome, valor) { this.atributos.push([String(nome), String(valor)]); },
      appendChild(filho) { this.filhos.push(filho); return filho; },
    };
    for (const proibida of ['innerHTML', 'outerHTML', 'textContent', 'innerText']) {
      Object.defineProperty(el, proibida, { set(v) { el.escritas.push([proibida, v]); }, get() { return ''; } });
    }
    criados.push(el);
    return el;
  };
  return {
    criados,
    createElementNS: (ns, tag) => no(ns, tag),
    createElement: (tag) => no(null, tag),
    createTextNode: (texto) => { const t = { texto }; criados.push(t); return t; },
  };
}
// O que o DOM montou, escrito no mesmo formato da marcação: tem de ser o mesmo SVG.
const serializar = (el) => `<${el.tagName}${el.atributos.map(([k, v]) => ` ${k}="${v}"`).join('')}>`
  + el.filhos.map((f) => `<${f.tagName}${f.atributos.map(([k, v]) => ` ${k}="${v}"`).join('')}/>`).join('')
  + `</${el.tagName}>`;

describe('RED 1 — resolução: tipo, depois categoria, depois genérico', () => {
  test('as listas legadas da 12G-8 (cópia congelada); o catálogo continua com os onze desenhos da 12G-7', () => {
    assert.deepEqual(TIPOS_ATUAIS, [...LISTA_EPI, ...LISTA_UNIFORME].filter((t) => t !== 'Outros'));
    assert.deepEqual(CATEGORIAS_ATUAIS, ['EPI', 'Uniforme', 'Ferramenta', 'Material de consumo']);
    assert.deepEqual([...C.CHAVES], [...CHAVES_DOS_TIPOS, ...CHAVES_DAS_CATEGORIAS, GENERICO]);
  });

  test('cada tipo oficial resolve para o desenho existente adequado; sem desenho adequado, cai na categoria; os nomes anteriores seguem reconhecidos', () => {
    for (const tipo of LISTA_EPI) {
      const esperado = Object.hasOwn(DESENHO_DO_TIPO_EPI, tipo) ? { chave: DESENHO_DO_TIPO_EPI[tipo], origem: 'TIPO' } : { chave: 'epi', origem: 'CATEGORIA' };
      assert.deepEqual(C.resolver({ tipo, categoria: 'EPI' }), esperado, tipo);
    }
    for (const tipo of LISTA_UNIFORME) assert.deepEqual(C.resolver({ tipo, categoria: 'Uniforme' }), { chave: 'uniforme', origem: 'CATEGORIA' }, tipo);
    assert.deepEqual(C.resolver({ tipo: 'Outros', categoria: 'Material de consumo' }), { chave: 'consumo', origem: 'CATEGORIA' });
    assert.deepEqual(C.resolver({ tipo: 'Outros', categoria: 'Ferramenta' }), { chave: 'ferramenta', origem: 'CATEGORIA' });
    for (const [tipo, chave] of NOMES_ANTERIORES) assert.deepEqual(C.resolver({ tipo }), { chave, origem: 'TIPO' }, tipo);
    const resolvidos = CHAVES_DOS_TIPOS.map((chave) => C.resolver(EXEMPLOS[chave]));
    assert.deepEqual(resolvidos.map((r) => r.chave), CHAVES_DOS_TIPOS);
    assert.ok(resolvidos.every((r) => r.origem === 'TIPO'));
    assert.equal(new Set(Object.values(marcacoesFixas())).size, C.CHAVES.length, 'onze desenhos diferentes');
  });

  test('normalização: caixa, acentos e espaços (inclusive em volta da barra) não mudam o tipo', () => {
    assert.equal(C.normalizar('  Óculos   de  PROTEÇÃO '), 'oculos de protecao');
    assert.equal(C.normalizar('Sapatão  /  Botina'), 'sapatao/botina');
    const variantes = [
      ['sapatão / botina', 'botina'], ['SAPATAO/BOTINA', 'botina'], ['  Sapatão   /  Botina ', 'botina'],
      ['oculos de protecao', 'oculos'], ['ÓCULOS  DE PROTEÇÃO', 'oculos'], [' luva ', 'luva'],
      ['PROTETOR AURICULAR', 'protetor-auricular'], ['capacete', 'capacete'], ['RESPIRADOR', 'respirador'],
    ];
    for (const [tipo, chave] of variantes) assert.deepEqual(C.resolver({ tipo }), { chave, origem: 'TIPO' }, tipo);
    assert.deepEqual(C.resolver({ tipo: 'Outro', categoria: '  material DE consumo ' }), { chave: 'consumo', origem: 'CATEGORIA' });
  });

  test('"Outro" e tipo desconhecido caem no pictograma da categoria', () => {
    for (const [i, categoria] of CATEGORIAS_ATUAIS.entries()) {
      assert.deepEqual(C.resolver({ tipo: 'Outro', categoria }), { chave: CHAVES_DAS_CATEGORIAS[i], origem: 'CATEGORIA' }, categoria);
      assert.deepEqual(C.resolver({ tipo: 'Avental de raspa', categoria }), { chave: CHAVES_DAS_CATEGORIAS[i], origem: 'CATEGORIA' }, categoria);
    }
  });

  test('o tipo conhecido vence a categoria (a ordem é tipo → categoria → genérico)', () => {
    assert.deepEqual(C.resolver({ tipo: 'Luva', categoria: 'Uniforme' }), { chave: 'luva', origem: 'TIPO' });
    assert.deepEqual(C.resolver({ tipo: 'Capacete', categoria: 'Ferramenta' }), { chave: 'capacete', origem: 'TIPO' });
  });

  test('categoria desconhecida, vazia ou ausente cai no genérico; dado vazio também', () => {
    const genericos = [
      { tipo: 'Outro', categoria: 'Brinde' }, { tipo: 'Desconhecido' }, { tipo: '', categoria: '' }, { tipo: '   ', categoria: '   ' },
      { tipo: null, categoria: null }, {}, null, undefined,
    ];
    for (const m of genericos) assert.deepEqual(C.resolver(m), { chave: GENERICO, origem: 'GENERICO' }, JSON.stringify(m));
  });

  test('o nome do material não escolhe o pictograma: só tipo e categoria', () => {
    assert.deepEqual(C.resolver({ nome: 'Luva de raspa', tipo: 'Outro', categoria: null }), { chave: GENERICO, origem: 'GENERICO' });
    assert.deepEqual(C.resolver({ material: 'Capacete aba total', tipo: 'Outro', categoria: 'Uniforme' }), { chave: 'uniforme', origem: 'CATEGORIA' });
    // Mesmo com o tipo vazio e um nome igual a um tipo conhecido, o nome não conta.
    for (const tipo of [null, undefined, '', '   ']) {
      assert.deepEqual(C.resolver({ nome: 'Luva', material: 'Capacete', tipo, categoria: null }), { chave: GENERICO, origem: 'GENERICO' }, String(tipo));
      assert.deepEqual(C.resolver({ nome: 'Luva', material: 'Capacete', tipo, categoria: 'Ferramenta' }), { chave: 'ferramenta', origem: 'CATEGORIA' }, String(tipo));
    }
  });

  test('nomes de propriedade do JavaScript não são tipos nem categorias', () => {
    for (const nome of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      assert.deepEqual(C.resolver({ tipo: nome, categoria: nome }), { chave: GENERICO, origem: 'GENERICO' }, nome);
    }
  });
});

describe('RED 2 — segurança: o SVG é fixo; a entrada só escolhe a chave', () => {
  test('cada pictograma é um SVG do catálogo: só elementos e atributos permitidos, sem URL, evento, estilo, script ou texto', () => {
    for (const [chave, svg] of Object.entries(marcacoesFixas())) {
      assert.match(svg, /^<svg [^>]*>[\s\S]*<\/svg>$/, chave);
      for (const e of etiquetas(svg)) {
        assert.ok(ELEMENTOS.has(e.nome), `${chave}: elemento <${e.nome}>`);
        for (const nome of nomesDeAtributo(e.atributos)) assert.ok(ATRIBUTOS.has(nome), `${chave}: atributo ${nome}`);
      }
      assert.equal(/\son\w+\s*=|href|url\(|https?:|javascript:|script|foreignobject|style|<title|<desc/i.test(svg), false, chave);
      assert.equal(svg.replace(/<[^>]+>/g, '').trim(), '', `${chave}: nenhum texto dentro do SVG`);
      assert.match(svg, new RegExp(`^<svg [^>]*data-pictograma="${chave}"`), chave);
    }
  });

  test('entradas maliciosas em tipo, categoria e nome: a saída é sempre um dos onze SVGs fixos, sem nada da entrada', () => {
    const fixas = new Set(Object.values(marcacoesFixas()));
    for (const tipo of ATAQUES) {
      for (const categoria of [...ATAQUES, 'EPI', null]) {
        const svg = C.marcacao({ tipo, categoria, nome: ATAQUES[0], material: ATAQUES[1] });
        assert.ok(fixas.has(svg), `${tipo} / ${categoria}`);
        assert.equal(/alert|onerror|onload|exemplo\.invalid|foreignObject|xlink|<img|<script/i.test(svg), false);
      }
    }
  });

  test('pelo DOM (createElementNS) nasce o mesmo SVG fixo; nada é escrito por innerHTML, textContent ou texto', () => {
    for (const material of [...Object.values(EXEMPLOS), ...ATAQUES.map((a) => ({ tipo: a, categoria: a, nome: a }))]) {
      const doc = documentoGravador();
      const svg = C.elemento(doc, material);
      assert.ok(svg, JSON.stringify(material).slice(0, 60));
      assert.equal(serializar(svg), C.marcacao(material));
      assert.ok(doc.criados.every((el) => el.namespaceURI === SVG_NS), 'tudo no espaço de nomes do SVG');
      assert.ok(doc.criados.every((el) => ELEMENTOS.has(el.tagName)), 'só elementos do catálogo');
      assert.ok(doc.criados.every((el) => el.escritas.length === 0), 'nenhuma escrita de HTML ou texto');
    }
  });

  test('o módulo não carrega nada de fora: a única URL é o espaço de nomes do SVG; sem innerHTML nem eval', () => {
    const fonte = ler('js/catalogo-visual.js');
    assert.deepEqual(fonte.match(/https?:\/\/[^'"\s)]+/g), [SVG_NS]);
    assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|url\(|href/.test(fonte), false);
  });
});

describe('RED 3 — acessibilidade: pictograma decorativo; o nome continua em texto', () => {
  test('todo SVG tem aria-hidden="true" e focusable="false", sem rótulo, título, papel ou texto próprio', () => {
    for (const [chave, svg] of Object.entries(marcacoesFixas())) {
      assert.match(svg, /^<svg [^>]*aria-hidden="true"/, chave);
      assert.match(svg, /^<svg [^>]*focusable="false"/, chave);
      assert.equal(/aria-label|aria-labelledby|role=|<title|<desc/.test(svg), false, chave);
    }
  });

  test('pelo DOM também: aria-hidden e focusable no SVG criado', () => {
    const svg = C.elemento(documentoGravador(), { tipo: 'Capacete' });
    assert.ok(svg, 'o SVG é criado');
    const atributos = Object.fromEntries(svg.atributos);
    assert.deepEqual([atributos['aria-hidden'], atributos.focusable], ['true', 'false']);
  });
});

describe('RED 7 — tamanho e encaixe: o pictograma não muda a estrutura das tabelas', () => {
  test('main.css: pictograma de 24 px, inline, sem crescer nem encolher, na cor neutra do tema', () => {
    const css = ler('css/main.css');
    const regra = (css.match(/\.pictograma-material\{([^}]*)\}/) || [])[1] || '';
    for (const decl of ['width:24px', 'height:24px', 'flex:none', 'vertical-align:middle', 'color:var(--on-surface-variant)']) {
      assert.ok(regra.includes(decl), `falta ${decl} em .pictograma-material`);
    }
    assert.equal(/display:\s*block/.test(regra), false);
  });

  test('nenhuma coluna nova: os cabeçalhos das três tabelas continuam os mesmos', () => {
    const ths = (arquivo, corpo) => {
      const html = ler(arquivo);
      const tabela = html.slice(0, html.indexOf(`id="${corpo}"`));
      return (tabela.slice(tabela.lastIndexOf('<thead>')).match(/<th[\s>]/g) || []).length;
    };
    assert.equal(ths('pages/available-items.html', 'itensDisponiveisCorpo'), 13);
    assert.equal(ths('pages/stock-validity.html', 'validadeCorpo'), 9);
    assert.equal(ths('pages/materials.html', 'lotesCorpo'), 7);
  });
});

describe('RED 8 — publicação: módulo local na allowlist, carregado só nas três telas', () => {
  const scripts = (arquivo) => [...ler(arquivo).matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);

  test('o módulo está na allowlist da publicação', () => {
    const { arquivos } = JSON.parse(ler('publicacao/allowlist.json'));
    assert.ok(arquivos.includes('js/catalogo-visual.js'));
  });

  test('Materiais, Itens Disponíveis e Validade carregam o catálogo antes de quem o usa', () => {
    for (const [arquivo, usuario] of [['pages/available-items.html', '../js/itens-disponiveis.js'], ['pages/stock-validity.html', '../js/validade-estoque.js']]) {
      const lista = scripts(arquivo);
      assert.ok(lista.includes('../js/catalogo-visual.js'), arquivo);
      assert.ok(lista.indexOf('../js/catalogo-visual.js') < lista.indexOf(usuario), `${arquivo}: catálogo antes de ${usuario}`);
    }
    assert.ok(scripts('pages/materials.html').includes('../js/catalogo-visual.js'));
  });

  test('as demais telas ficam como estão: nenhuma carrega o catálogo', () => {
    for (const p of ['request', 'supervisor-approval', 'stock-requests', 'epi-ficha', 'operations', 'dashboard', 'user-admin']) {
      assert.equal(scripts(`pages/${p}.html`).includes('../js/catalogo-visual.js'), false, p);
    }
  });
});
