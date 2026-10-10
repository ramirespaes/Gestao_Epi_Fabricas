(function (global) {
  'use strict';

  /**
   * EpiCatalogoVisual — pictogramas ilustrativos dos materiais (Bloco 12, 12G-7).
   *
   * Tipo conhecido → pictograma do tipo; tipo "Outro" ou desconhecido → o da
   * categoria; categoria desconhecida ou ausente → o genérico. Tipo e categoria
   * só escolhem uma chave: os desenhos são fixos, definidos aqui, e nenhum dado
   * do sistema entra no SVG. O pictograma é decorativo (aria-hidden) e mostra o
   * tipo, não o produto: o nome do material continua sendo a identificação.
   * Não há imagem, endereço externo, upload nem escolha gravada por material.
   */

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var GENERICO = 'material';

  // Nome do tipo → chave do desenho: os nomes do catálogo base da classificação
  // V2 (08/10/2026) que têm desenho adequado, os nomes oficiais da 12G-8 e os
  // anteriores, pelo material já cadastrado. Os demais caem no grupo.
  var TIPOS = [
    ['Sapatão / Botina', 'botina'],
    ['Botina de Segurança', 'botina'],
    ['Óculos de proteção', 'oculos'],
    ['Óculos de Proteção Incolor', 'oculos'],
    ['Óculos de Proteção Ampla Visão', 'oculos'],
    ['Óculos de Proteção Fumê', 'oculos'],
    ['Óculos de Proteção Sobrepor', 'oculos'],
    ['Luva', 'luva'],
    ['Luva de Segurança', 'luva'],
    ['Luva Isolante de Borracha', 'luva'],
    ['Luva de Segurança Nitrila', 'luva'],
    ['Luva para Proteção contra Agentes Térmicos', 'luva'],
    ['Protetor auricular', 'protetor-auricular'],
    ['Proteção Auricular Concha', 'protetor-auricular'],
    ['Protetor Auricular Concha', 'protetor-auricular'],
    ['Protetor Auricular Plug', 'protetor-auricular'],
    ['Capacete', 'capacete'],
    ['Capacete de Segurança', 'capacete'],
    ['Respirador', 'respirador'],
    ['Respirador PFF2', 'respirador'],
  ];
  // Grupo efetivo → chave. "Vestimenta" usa o desenho de vestimenta; "Uniforme"
  // é só o nome legado do mesmo grupo.
  var CATEGORIAS = [
    ['EPI', 'epi'],
    ['Vestimenta', 'uniforme'],
    ['Uniforme', 'uniforme'],
    ['Ferramenta', 'ferramenta'],
    ['Material de consumo', 'consumo'],
  ];

  // Desenhos em grade de 24 × 24, só traço, na cor do texto.
  var DESENHOS = {
    botina: [
      ['path', { d: 'M6 3h6.5v8.2l5.1 2.1A3 3 0 0 1 19.5 16v5H6Z' }],
      ['path', { d: 'M6 18h13.5M9.5 6.5h3M9.5 9h3' }],
    ],
    oculos: [
      ['rect', { x: '2.5', y: '9', width: '8', height: '7', rx: '3' }],
      ['rect', { x: '13.5', y: '9', width: '8', height: '7', rx: '3' }],
      ['path', { d: 'M10.5 12c1-.8 2-.8 3 0M4 6.5h16' }],
    ],
    luva: [
      ['path', { d: 'M7.5 21v-4.2L5 13.6a1.6 1.6 0 0 1 2.4-2.1l1.1 1.1V5.5a1.25 1.25 0 0 1 2.5 0V11V4.25a1.25 1.25 0 0 1 2.5 0V11V5.25a1.25 1.25 0 0 1 2.5 0v6.25V7.5a1.25 1.25 0 0 1 2.5 0v6.7a6 6 0 0 1-2 4.5V21' }],
      ['path', { d: 'M7 21h10' }],
    ],
    'protetor-auricular': [
      ['path', { d: 'M5.5 13v-2.5a6.5 6.5 0 0 1 13 0V13' }],
      ['rect', { x: '3', y: '12.5', width: '5', height: '8', rx: '2.5' }],
      ['rect', { x: '16', y: '12.5', width: '5', height: '8', rx: '2.5' }],
    ],
    capacete: [
      ['path', { d: 'M4.5 16.5V15a7.5 7.5 0 0 1 15 0v1.5M12 7.5v6' }],
      ['rect', { x: '2.5', y: '16.5', width: '19', height: '3', rx: '1.5' }],
    ],
    respirador: [
      ['path', { d: 'M12 6.5c-2.8 0-5.5 1.4-5.5 4.6 0 3.6 2.5 6.8 5.5 8.4 3-1.6 5.5-4.8 5.5-8.4 0-3.2-2.7-4.6-5.5-4.6Z' }],
      ['circle', { cx: '4.5', cy: '13.5', r: '2' }],
      ['circle', { cx: '19.5', cy: '13.5', r: '2' }],
      ['path', { d: 'M7 8.5 4.5 6M17 8.5 19.5 6M10.5 13.5h3' }],
    ],
    epi: [
      ['path', { d: 'M12 3 5 6v5.5c0 4.4 2.9 8.2 7 9.5 4.1-1.3 7-5.1 7-9.5V6Z' }],
      ['path', { d: 'm9 12.2 2.1 2.1 4-4.3' }],
    ],
    uniforme: [
      ['path', { d: 'M9 3.5 4 6l1.8 4.2 1.7-.8v11.1h9V9.4l1.7.8L20 6l-5-2.5a3 3 0 0 1-6 0Z' }],
    ],
    ferramenta: [
      ['path', { d: 'M14.5 4.5a4.5 4.5 0 0 0-4.3 5.9l-6.3 6.3a1.9 1.9 0 0 0 2.7 2.7l6.3-6.3a4.5 4.5 0 0 0 5.9-4.3l-2.6 2.6-2.4-.6-.6-2.4Z' }],
    ],
    consumo: [
      ['path', { d: 'M4 7.5 12 3.5l8 4v9l-8 4-8-4Z' }],
      ['path', { d: 'm4 7.5 8 4 8-4M12 11.5v9' }],
    ],
    material: [
      ['path', { d: 'M3.5 12V4.5a1 1 0 0 1 1-1H12l8.5 8.5a1 1 0 0 1 0 1.4l-7.1 7.1a1 1 0 0 1-1.4 0Z' }],
      ['circle', { cx: '8', cy: '8', r: '1.5' }],
    ],
  };

  var RAIZ = [
    ['class', 'pictograma-material'], ['viewBox', '0 0 24 24'], ['width', '24'], ['height', '24'], ['fill', 'none'],
    ['stroke', 'currentColor'], ['stroke-width', '1.6'], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round'],
    ['aria-hidden', 'true'], ['focusable', 'false'],
  ];

  // Trava do próprio catálogo: só estes elementos e atributos, só números e
  // comandos de traço como valor. Um desenho fora disso impede o módulo de carregar.
  var PERMITIDOS = { path: ['d'], rect: ['x', 'y', 'width', 'height', 'rx'], circle: ['cx', 'cy', 'r'] };
  var VALOR_TRACO = /^[MmLlHhVvCcSsQqTtAaZz0-9., -]+$/;
  var VALOR_NUMERO = /^\d+(\.\d+)?$/;
  var proprio = function (objeto, chave) { return Object.prototype.hasOwnProperty.call(objeto, chave); };

  Object.keys(DESENHOS).forEach(function (chave) {
    DESENHOS[chave].forEach(function (parte) {
      var nome = parte[0];
      var valido = proprio(PERMITIDOS, nome) && Object.keys(parte[1]).every(function (atributo) {
        return PERMITIDOS[nome].indexOf(atributo) !== -1 && (atributo === 'd' ? VALOR_TRACO : VALOR_NUMERO).test(parte[1][atributo]);
      });
      if (!valido) throw new Error('pictograma fora do catálogo: ' + chave);
    });
  });

  function normalizar(valor) {
    if (valor === null || valor === undefined) return '';
    return String(valor).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
      .replace(/\s+/g, ' ').trim().replace(/ ?\/ ?/g, '/');
  }

  function indice(pares) {
    var mapa = {};
    pares.forEach(function (par) { mapa[normalizar(par[0])] = par[1]; });
    return mapa;
  }
  var POR_TIPO = indice(TIPOS);
  var POR_CATEGORIA = indice(CATEGORIAS);

  /**
   * Grupo de exibição: o `grupo` que o servidor já resolveu (listas de estoque)
   * ou, no material, a categoria — a especificação quando o grupo é "Outros",
   * a mesma regra de grupoEfetivo (classificacao-material / js/materiais.js).
   */
  function grupoDe(m) {
    if (typeof m.grupo === 'string' && m.grupo) return m.grupo;
    return normalizar(m.categoria) === 'outros' && m.categoriaDescricao ? m.categoriaDescricao : m.categoria;
  }

  /** { chave, origem }: origem TIPO, CATEGORIA ou GENERICO. Só tipo e grupo contam. */
  function resolver(material) {
    var m = material || {};
    var tipo = normalizar(m.tipo);
    if (proprio(POR_TIPO, tipo)) return { chave: POR_TIPO[tipo], origem: 'TIPO' };
    var grupo = normalizar(grupoDe(m));
    if (proprio(POR_CATEGORIA, grupo)) return { chave: POR_CATEGORIA[grupo], origem: 'CATEGORIA' };
    return { chave: GENERICO, origem: 'GENERICO' };
  }

  function atributosDaRaiz(chave) { return RAIZ.concat([['data-pictograma', chave]]); }
  function atributosDa(parte) { return Object.keys(parte[1]).map(function (k) { return [k, parte[1][k]]; }); }
  function emTexto(pares) { return pares.map(function (par) { return ' ' + par[0] + '="' + par[1] + '"'; }).join(''); }

  // As onze marcações prontas, montadas uma vez só a partir dos desenhos fixos.
  var MARCACOES = {};
  Object.keys(DESENHOS).forEach(function (chave) {
    MARCACOES[chave] = '<svg' + emTexto(atributosDaRaiz(chave)) + '>'
      + DESENHOS[chave].map(function (parte) { return '<' + parte[0] + emTexto(atributosDa(parte)) + '/>'; }).join('')
      + '</svg>';
  });

  /** O SVG fixo do material, para as linhas de tabela montadas em texto. */
  function marcacao(material) { return MARCACOES[resolver(material).chave]; }

  /** O mesmo SVG, criado pelo DOM (createElementNS), para quem monta a tela por nós. */
  function elemento(documento, material) {
    var chave = resolver(material).chave;
    var svg = documento.createElementNS(SVG_NS, 'svg');
    atributosDaRaiz(chave).forEach(function (par) { svg.setAttribute(par[0], par[1]); });
    DESENHOS[chave].forEach(function (parte) {
      var no = documento.createElementNS(SVG_NS, parte[0]);
      atributosDa(parte).forEach(function (par) { no.setAttribute(par[0], par[1]); });
      svg.appendChild(no);
    });
    return svg;
  }

  global.EpiCatalogoVisual = {
    CHAVES: Object.freeze(Object.keys(DESENHOS)),
    normalizar: normalizar,
    resolver: resolver,
    marcacao: marcacao,
    elemento: elemento,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = global.EpiCatalogoVisual;
})(typeof window !== 'undefined' ? window : globalThis);
