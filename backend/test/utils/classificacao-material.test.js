'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../../src/utils/classificacao-material');

/**
 * 12G-8 — Categoria → Tipo: as listas oficiais, a regra de "Outros" para as
 * categorias sem lista própria e os tipos de óculos (os dois novos e o nome
 * histórico, que só vale para o que já existe).
 */

const OUTROS = 'Outros';
const EPI = [
  'Botina de Segurança', 'Capacete', 'Creme de Proteção', 'Luva', 'Mangote', 'Óculos de Proteção Ampla Visão',
  'Óculos de Proteção Incolor', OUTROS, 'Palmilha', 'Proteção Auricular Concha', 'Proteção Auricular Descartável',
  'Respirador PFF2', 'Sapato de Segurança', 'Viseira Película Ouro',
];
const UNIFORME = ['Calça', 'Calça de Forneiro', 'Calça Eletricista', 'Camisa', 'Camisa de Forneiro', 'Camisa Eletricista', 'Camiseta', OUTROS];
const ordenado = (lista) => [...lista].sort((a, b) => a.localeCompare(b, 'pt-BR'));

describe('classificação do material — listas por categoria', () => {
  test('EPI e Uniforme: listas exatas, em ordem alfabética, cada uma com "Outros" e sem tipo da outra', () => {
    assert.equal(C.OUTROS, OUTROS);
    assert.deepEqual(C.TIPOS_POR_CATEGORIA.EPI, EPI);
    assert.deepEqual(C.TIPOS_POR_CATEGORIA.Uniforme, UNIFORME);
    assert.deepEqual(ordenado(EPI), EPI);
    assert.deepEqual(ordenado(UNIFORME), UNIFORME);
    for (const tipo of UNIFORME) if (tipo !== OUTROS) assert.equal(EPI.includes(tipo), false, tipo);
    for (const tipo of EPI) if (tipo !== OUTROS) assert.equal(UNIFORME.includes(tipo), false, tipo);
    for (const antigo of ['Sapatão / Botina', 'Óculos de proteção', 'Protetor auricular', 'Respirador', 'Outro']) {
      assert.equal(EPI.includes(antigo), false, antigo);
    }
    assert.ok(Object.isFrozen(C.TIPOS_POR_CATEGORIA.EPI) && Object.isFrozen(C.TIPOS_POR_CATEGORIA.Uniforme));
  });

  test('Material de consumo, Ferramenta, sem categoria e categoria desconhecida: só "Outros"', () => {
    assert.deepEqual(C.TIPOS_POR_CATEGORIA['Material de consumo'], [OUTROS]);
    assert.deepEqual(C.TIPOS_POR_CATEGORIA.Ferramenta, [OUTROS]);
    assert.deepEqual(Object.keys(C.TIPOS_POR_CATEGORIA).sort(), ['EPI', 'Ferramenta', 'Material de consumo', 'Uniforme']);
    for (const categoria of ['Material de consumo', 'Ferramenta', null, undefined, '', 'Brinde', 'epi', '__proto__', 'constructor']) {
      assert.deepEqual(C.tiposDe(categoria), [OUTROS], String(categoria));
    }
    assert.deepEqual(C.tiposDe('EPI'), EPI);
    assert.deepEqual(C.tiposDe('Uniforme'), UNIFORME);
  });

  test('tipoPermitido: exato, só na categoria certa; "Outros" vale em todas; nome antigo não vale em nenhuma', () => {
    assert.equal(C.tipoPermitido('EPI', 'Luva'), true);
    assert.equal(C.tipoPermitido('Uniforme', 'Luva'), false);
    assert.equal(C.tipoPermitido('EPI', 'Camisa'), false);
    assert.equal(C.tipoPermitido('Uniforme', 'Camisa de Forneiro'), true);
    assert.equal(C.tipoPermitido('EPI', 'luva'), false, 'comparação exata');
    for (const categoria of ['EPI', 'Uniforme', 'Material de consumo', 'Ferramenta', null, 'Brinde']) {
      assert.equal(C.tipoPermitido(categoria, OUTROS), true, String(categoria));
      assert.equal(C.tipoPermitido(categoria, 'Sapatão / Botina'), false, String(categoria));
      assert.equal(C.tipoPermitido(categoria, 'Óculos de proteção'), false, String(categoria));
      assert.equal(C.tipoPermitido(categoria, null), false, String(categoria));
    }
  });
});

describe('classificação do material — óculos de proteção', () => {
  test('Incolor e Ampla Visão são tipos distintos de óculos; o nome histórico segue reconhecido; o resto não', () => {
    assert.deepEqual(C.TIPOS_OCULOS, ['Óculos de Proteção Incolor', 'Óculos de Proteção Ampla Visão']);
    assert.equal(C.TIPO_OCULOS_LEGADO, 'Óculos de proteção');
    assert.notEqual(C.TIPOS_OCULOS[0], C.TIPOS_OCULOS[1]);
    for (const tipo of [...C.TIPOS_OCULOS, C.TIPO_OCULOS_LEGADO]) assert.equal(C.ehOculos(tipo), true, tipo);
    for (const tipo of [OUTROS, 'óculos de proteção incolor', 'Óculos', 'Óculos de Proteção', 'Luva', '', null, undefined]) {
      assert.equal(C.ehOculos(tipo), false, String(tipo));
    }
    assert.ok(C.TIPOS_POR_CATEGORIA.EPI.includes(C.TIPOS_OCULOS[0]) && C.TIPOS_POR_CATEGORIA.EPI.includes(C.TIPOS_OCULOS[1]));
    assert.equal(C.TIPOS_POR_CATEGORIA.EPI.includes(C.TIPO_OCULOS_LEGADO), false, 'o nome histórico não é oferecido');
  });
});
