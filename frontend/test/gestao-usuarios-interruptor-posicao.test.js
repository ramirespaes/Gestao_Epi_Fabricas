'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { ler } = require('./helpers/dom-pagina');

/**
 * Gestão de Usuários — posicionamento do interruptor da janela "Configurar permissões".
 *
 * Defeito comprovado em Chrome real (fase 14): o checkbox oculto do interruptor é `position:absolute`, mas o rótulo `.switch` ficava
 * `position:static` (o neutralizador do `.switch` do main.css). Sem um ancestral posicionado, o checkbox não rola junto com a lista e
 * fica abaixo da tela; ao clicar, o foco o leva à vista rolando o `#overlay`, e a janela sai da área visível (só o fundo escurecido
 * aparece). A correção é o rótulo ser o ancestral posicionado: `position:relative` na regra final de `.gu .switch`.
 *
 * O DOM de teste não calcula layout, por isso este teste lê a CASCATA da folha de estilos da página (a última declaração vence entre
 * regras de mesma especificidade) e a verificação de comportamento é feita em navegador real (ver o relatório da correção).
 */
const ARQUIVO = 'pages/gestao-usuarios.html';

function regras(css) {
  const lista = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    const declaracoes = {};
    for (const parte of m[2].split(';')) {
      const i = parte.indexOf(':');
      if (i > 0) declaracoes[parte.slice(0, i).trim().toLowerCase()] = parte.slice(i + 1).trim().replace(/\s*!important$/i, '');
    }
    for (const seletor of m[1].split(',')) lista.push({ seletor: seletor.trim().replace(/\s+/g, ' '), declaracoes });
  }
  return lista;
}
const folha = () => {
  const html = ler(ARQUIVO);
  return [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1].replace(/\/\*[\s\S]*?\*\//g, '')).join('\n');
};
/** Valor final de uma propriedade para um seletor exato: a última regra que a declara. */
const valorFinal = (seletor, propriedade) => {
  const doSeletor = regras(folha()).filter((r) => r.seletor === seletor && Object.hasOwn(r.declaracoes, propriedade));
  return doSeletor.length === 0 ? null : doSeletor[doSeletor.length - 1].declaracoes[propriedade];
};

describe('IP — interruptor da janela de permissões', () => {
  test('IP1 o rótulo `.gu .switch` é o ancestral posicionado do checkbox: o valor final de `position` é `relative`', () => {
    assert.equal(valorFinal('.gu .switch', 'position'), 'relative');
  });

  test('IP2 o checkbox oculto continua absoluto, invisível e de 1 px (a correção não muda o componente)', () => {
    assert.equal(valorFinal('.gu .switch input', 'position'), 'absolute');
    assert.equal(valorFinal('.gu .switch input', 'opacity'), '0');
    assert.equal(valorFinal('.gu .switch input', 'width'), '1px');
    assert.equal(valorFinal('.gu .switch input', 'height'), '1px');
  });

  test('IP3 o resto do rótulo não mudou: continua `inline-flex`, com o mesmo alinhamento, espaçamento e cursor', () => {
    assert.equal(valorFinal('.gu .switch', 'display'), 'inline-flex');
    assert.equal(valorFinal('.gu .switch', 'align-items'), 'center');
    assert.equal(valorFinal('.gu .switch', 'gap'), '10px');
    assert.equal(valorFinal('.gu .switch', 'cursor'), 'pointer');
    assert.equal(valorFinal('.gu .switch', 'padding-top'), '6px');
  });

  test('IP4 o neutralizador do `.switch` do main.css permanece (largura, altura, fundo e borda do componente antigo continuam anulados)', () => {
    for (const [p, v] of [['width', 'auto'], ['height', 'auto'], ['background', 'transparent'], ['border', '0']]) {
      assert.equal(valorFinal('.gu .switch', p), v, p);
    }
  });

  test('IP5 a trilha visual do interruptor (`.t`) continua com o seu próprio `position:relative` e o mesmo tamanho', () => {
    assert.equal(valorFinal('.gu .switch .t', 'position'), 'relative');
    assert.equal(valorFinal('.gu .switch .t', 'width'), '51px');
    assert.equal(valorFinal('.gu .switch .t', 'height'), '31px');
  });
});
