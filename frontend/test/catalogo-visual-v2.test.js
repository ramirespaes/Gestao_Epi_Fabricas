'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const C = require('../js/catalogo-visual');
const { CATALOGO_BASE } = require('../../backend/test/integracao/helpers/classificacao-v2');

/**
 * RED — evolução funcional do catálogo visual (12G-7) para a classificação V2 (07/10/2026): "Vestimenta" e os nomes do
 * catálogo base. A baseline congelada da 12G-7 (test/catalogo-visual.test.js) NÃO é reescrita: este arquivo é a evolução
 * posterior. Regra preservada: tipo conhecido → desenho do tipo; senão → desenho do grupo EFETIVO; senão → genérico.
 * Nenhum SVG novo: continuam os onze desenhos.
 */

const DESENHO_DO_TIPO = {
  'Capacete de Segurança': 'capacete',
  'Luva de Segurança': 'luva', 'Luva Isolante de Borracha': 'luva', 'Luva de Segurança Nitrila': 'luva', 'Luva para Proteção contra Agentes Térmicos': 'luva',
  'Óculos de Proteção Fumê': 'oculos', 'Óculos de Proteção Incolor': 'oculos', 'Óculos de Proteção Sobrepor': 'oculos',
  'Protetor Auricular Concha': 'protetor-auricular', 'Protetor Auricular Plug': 'protetor-auricular',
  'Respirador PFF2': 'respirador',
};

describe('catálogo visual V2 — nomes do catálogo base e Vestimenta', () => {
  test('cada tipo do catálogo base com desenho adequado resolve pelo TIPO; os demais caem no grupo (EPI ou Vestimenta); onze desenhos, sem SVG novo', () => {
    for (const [grupo, , nome] of CATALOGO_BASE) {
      const esperado = Object.hasOwn(DESENHO_DO_TIPO, nome)
        ? { chave: DESENHO_DO_TIPO[nome], origem: 'TIPO' }
        : { chave: grupo === 'Vestimenta' ? 'uniforme' : 'epi', origem: 'CATEGORIA' };
      assert.deepEqual(C.resolver({ tipo: nome, categoria: grupo }), esperado, `${grupo} | ${nome}`);
    }
    assert.equal(C.CHAVES.length, 11, 'nenhum desenho novo');
  });

  test('"Vestimenta" resolve para o desenho de vestimenta (o mesmo do antigo "Uniforme", que continua reconhecido como legado)', () => {
    assert.deepEqual(C.resolver({ tipo: 'Outros', categoria: 'Vestimenta' }), { chave: 'uniforme', origem: 'CATEGORIA' });
    assert.deepEqual(C.resolver({ tipo: 'Avental de Segurança', categoria: 'Vestimenta' }), { chave: 'uniforme', origem: 'CATEGORIA' });
    assert.deepEqual(C.resolver({ tipo: 'Calça', categoria: 'Uniforme' }), { chave: 'uniforme', origem: 'CATEGORIA' }, 'legado');
  });

  test('Grupo Outros usa o grupo EFETIVO (categoriaDescricao) para escolher o desenho: Ferramenta e Material de consumo continuam com os seus; desconhecido cai no genérico', () => {
    assert.deepEqual(C.resolver({ tipo: 'Outros', categoria: 'Outros', categoriaDescricao: 'Ferramenta' }), { chave: 'ferramenta', origem: 'CATEGORIA' });
    assert.deepEqual(C.resolver({ tipo: 'Outros', categoria: 'Outros', categoriaDescricao: 'Material de consumo' }), { chave: 'consumo', origem: 'CATEGORIA' });
    assert.deepEqual(C.resolver({ tipo: 'Outros', categoria: 'Outros', categoriaDescricao: 'Insumo químico' }), { chave: 'material', origem: 'GENERICO' });
    assert.deepEqual(C.resolver({ tipo: 'Outros', categoria: 'Outros' }), { chave: 'material', origem: 'GENERICO' });
  });

  test('os nomes anteriores (12G-7/12G-8) continuam reconhecidos pelo material já gravado', () => {
    for (const [tipo, chave] of [['Botina de Segurança', 'botina'], ['Óculos de Proteção Ampla Visão', 'oculos'], ['Proteção Auricular Concha', 'protetor-auricular'], ['Capacete', 'capacete'], ['Luva', 'luva']]) {
      assert.deepEqual(C.resolver({ tipo, categoria: 'EPI' }), { chave, origem: 'TIPO' }, tipo);
    }
  });
});
