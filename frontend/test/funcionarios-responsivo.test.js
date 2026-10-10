'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Responsividade de pages/funcionarios.html (Tarefa 3, RED).
 *
 * Diagnóstico medido no Chrome com a página real (scripts reais, API simulada): o DOCUMENTO não rola na horizontal em nenhuma
 * largura de 500 a 1440 px (body com overflow-x:hidden no main.css e nenhum elemento fora da viewport). O que força rolagem
 * horizontal é a TABELA: `min-width:760px` (mais cabeçalhos em nowrap e valores sem quebra) é maior que a área útil do cartão
 * em toda a faixa de 500 a ~1130 px — inclusive na janela dividida do Mac (~720–870 px) —, então a coluna Ação e a Situação
 * ficam atrás da rolagem do contêiner da tabela. A correção é de layout (a tabela passa a caber e a quebrar linha), sem
 * esconder rolagem e sem reduzir fonte ou controles; o contêiner da tabela continua sendo o único lugar onde pode haver rolagem
 * horizontal, e só em tela realmente pequena.
 *
 * As checagens no navegador (largura de 500 a 1440, lista e modal) ficam nas evidências; aqui ficam os contratos de CSS que as
 * sustentam e que o CI consegue verificar sem navegador.
 */

const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const pagina = ler('pages/funcionarios.html');
const mainCss = ler('css/main.css');
const css = pagina.match(/<style>([\s\S]*?)<\/style>/)[1].replace(/\/\*[\s\S]*?\*\//g, '');

/** Regras de nível 1 e as de dentro de @media: [{ contexto, seletores, corpo }]. */
function regras(texto, contexto = '') {
  const saida = [];
  let i = 0;
  while (i < texto.length) {
    const a = texto.indexOf('{', i);
    if (a < 0) break;
    const cabeca = texto.slice(i, a).trim();
    let nivel = 1;
    let j = a + 1;
    while (nivel && j < texto.length) { if (texto[j] === '{') nivel += 1; else if (texto[j] === '}') nivel -= 1; j += 1; }
    const corpo = texto.slice(a + 1, j - 1);
    if (cabeca.startsWith('@media')) saida.push(...regras(corpo, cabeca));
    else if (!cabeca.startsWith('@')) saida.push({ contexto, seletores: cabeca.split(',').map((s) => s.trim()), corpo });
    i = j;
  }
  return saida;
}
const todas = regras(css);
const declaracoes = (corpo) => Object.fromEntries(corpo.split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
  const k = d.indexOf(':');
  return [d.slice(0, k).trim(), d.slice(k + 1).trim()];
}));
/** Declarações efetivas de um seletor exato, no contexto indicado ('' = sem @media). */
const de = (seletor, contexto = '') => Object.assign({}, ...todas.filter((r) => r.contexto === contexto && r.seletores.includes(seletor)).map((r) => declaracoes(r.corpo)));
const px = (v) => (v === undefined ? null : Number.parseFloat(v));

describe('funcionarios.html — a tabela cabe antes de rolar (causa do overflow)', () => {
  test('a tabela não impõe largura mínima de desktop: sem min-width de 760 px fora do celular', () => {
    const base = de('.fn table');
    // main.css impõe `table{min-width:720px}` a toda tabela (foi ele que manteve 720 px na janela dividida de 756 px): a página
    // precisa anulá-lo explicitamente, e não só deixar de declarar o próprio min-width.
    assert.match(mainCss, /\n\s*table\{[^}]*min-width:720px/);
    assert.equal(base['min-width'], '0', `min-width base ${base['min-width']}`);
    assert.equal(base.width, '100%');
  });

  test('só em tela de celular (≤600) a tabela pode ficar mais larga que o cartão (e então a rolagem é a do contêiner da tabela); na janela dividida não há piso', () => {
    const celular = de('.fn table', '@media (max-width:600px)');
    assert.ok(px(celular['min-width']) >= 520 && px(celular['min-width']) <= 600, `min-width no celular: ${celular['min-width']}`);
    assert.equal(de('.fn table', '@media (max-width:720px)')['min-width'], undefined, 'sem piso de largura na faixa 601–720');
    // Janela dividida: padding das células e dos botões diminui (fonte não), para a coluna Ação caber sem rolagem.
    assert.equal(de('.fn tbody td', '@media (max-width:900px)').padding, '10px 8px');
    assert.equal(de('.fn tbody td', '@media (max-width:720px)').padding, '8px 5px');
    assert.equal(de('.fn .btn-sm', '@media (max-width:720px)').padding, '0 8px');
    for (const ctx of ['@media (max-width:900px)', '@media (max-width:720px)']) {
      assert.equal(de('.fn tbody td', ctx)['font-size'], undefined, `${ctx}: fonte das células não muda`);
      assert.equal(de('.fn .btn-sm', ctx)['font-size'], undefined, `${ctx}: fonte dos botões não muda`);
    }
    const wrap = de('.fn .table-wrap');
    assert.match(wrap['overflow-x'] ?? '', /auto/);
    assert.equal(wrap['max-width'], '100%');
  });

  test('cabeçalhos e valores quebram linha em vez de alargar a tabela', () => {
    assert.notEqual(de('.fn thead th')['white-space'], 'nowrap');
    const celula = de('.fn tbody td');
    assert.match(celula['overflow-wrap'] ?? celula['word-break'] ?? '', /anywhere|break-word|break-all/);
    assert.notEqual(celula['white-space'], 'nowrap');
  });

  test('a coluna Ação ocupa só o necessário e os botões se reorganizam em coluna estreita (sem encolher fonte nem controles)', () => {
    assert.match(pagina, /<th style="width:1%">Ação<\/th>/);
    const acoes = de('.fn .acoes');
    assert.equal(acoes.display, 'flex');
    assert.equal(acoes['flex-wrap'], 'wrap');
    assert.equal(de('.fn .btn-sm')['font-size'], '13px');
    assert.equal(de('.fn .btn-sm').height, '34px');
    assert.equal(de('.fn .btn')['font-size'], '14px');
  });
});

describe('funcionarios.html — filtros e cabeçalho reorganizam em vez de empurrar a página', () => {
  test('a barra de busca + Situação quebra de linha e nenhum controle impõe largura fixa maior que a coluna', () => {
    const barra = de('.fn .toolbar');
    assert.equal(barra['flex-wrap'], 'wrap');
    const busca = de('.fn .search');
    assert.ok(px(busca['min-width']) <= 220);
    assert.match(busca.flex ?? '', /^1( 1)?/);
    const filtro = de('.fn .toolbar select');
    assert.ok(px(filtro['min-width']) <= 160);
    assert.ok(px(filtro['max-width'] ?? '100%') > 0 || filtro['max-width'] === '100%', 'o filtro nunca passa da largura da barra');
  });

  test('em tela pequena o filtro de Situação ocupa a linha inteira (busca e filtro empilham)', () => {
    const pequeno = Object.assign({}, ...todas.filter((r) => /max-width:\s*(5\d\d|6\d\d|720)px/.test(r.contexto) && r.seletores.includes('.fn .toolbar select')).map((r) => declaracoes(r.corpo)));
    assert.equal(pequeno.width, '100%');
  });

  test('o contêiner da página nunca fixa largura em px (só max-width) e o cartão e o cabeçalho respeitam a coluna', () => {
    const fn = de('.fn');
    assert.equal(fn.width, undefined);
    assert.equal(fn['max-width'], '1100px');
    assert.equal(fn['min-width'] ?? '0', '0');
    for (const s of ['.fn .card', '.fn .toolbar', '.fn .page-head']) assert.equal(de(s).width, undefined, `${s} sem largura fixa`);
  });
});

describe('funcionarios.html — nada esconde o problema', () => {
  test('nenhuma regra da página usa overflow-x:hidden / overflow:hidden na moldura (html, body, .content, .fn, .card)', () => {
    for (const r of todas) {
      for (const s of r.seletores) {
        if (!/^(html|body|\.content|main\.content|\.fn|\.fn \.card|\.layout)$/.test(s)) continue;
        const d = declaracoes(r.corpo);
        for (const k of ['overflow', 'overflow-x']) assert.doesNotMatch(d[k] ?? '', /hidden|clip/, `${s} { ${k}: ${d[k]} }`);
      }
    }
  });
});

describe('funcionarios.html — modal e fundo acompanham o ponto de quebra da barra lateral', () => {
  test('o deslocamento do fundo igual à largura da barra só vale onde a barra é fixa (mesmo ponto de quebra e mesma largura do main.css)', () => {
    const quebra = Number(mainCss.match(/@media \(min-width:\s*(\d+)px\)\s*\{\s*\.sidebar \{ transform: translateX\(0\) !important; width: 260px; \}/)[1]);
    const largura = px(mainCss.match(/\.sidebar\{[^}]*?width:(\d+)px/)[1]);
    assert.equal(quebra, 1025);
    assert.equal(largura, 260);
    assert.equal(de('.fn .overlay').left, undefined, 'sem deslocamento fixo fora do desktop');
    assert.equal(de('.fn .overlay', `@media (min-width:${quebra}px)`).left, `${largura}px`);
  });

  test('o modal usa a largura disponível: width 100% até o máximo, com respiro lateral e rolagem própria quando for alto', () => {
    const modal = de('.fn .modal');
    assert.equal(modal.width, '100%');
    assert.equal(modal['max-width'], '640px');
    assert.equal(modal['max-height'], '92vh');
    assert.equal(de('.fn .overlay').padding, '16px');
    assert.match(de('.fn .modal-body')['overflow-y'], /auto/);
  });
});
