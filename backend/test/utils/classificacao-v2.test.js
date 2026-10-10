'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const classificacao = require('../../src/utils/classificacao-material');
const { GRUPOS_PROTECAO, CATALOGO_BASE } = require('../integracao/helpers/classificacao-v2');

/**
 * RED — vocabulário e helpers centrais da classificação V2 (07/10/2026) em src/utils/classificacao-material.js:
 * grupos de cadastro novo (EPI, Vestimenta, Outros), os 12 grupos de proteção, o catálogo base de 26 tipos (fonte única
 * do seed e do provisionamento), a regra de óculos com grau por classificação (V2) ou por nome (LEGADO), e o "valor
 * efetivo de exibição" (um helper só, reutilizado por filtros, telas e relatórios — nunca COALESCE espalhado).
 */

const esperarFuncao = (nome) => assert.equal(typeof classificacao[nome], 'function', `classificacao-material.${nome} ainda não existe`);

describe('vocabulário V2', () => {
  test('GRUPOS, GRUPOS_PROTECAO e OUTROS', () => {
    assert.deepEqual(classificacao.GRUPOS, ['EPI', 'Vestimenta', 'Outros']);
    assert.deepEqual(classificacao.GRUPOS_CATALOGO, ['EPI', 'Vestimenta']);
    assert.deepEqual(classificacao.GRUPOS_PROTECAO, [...GRUPOS_PROTECAO]);
    assert.equal(classificacao.OUTROS, 'Outros');
    assert.ok(Object.isFrozen(classificacao.GRUPOS_PROTECAO));
  });

  test('CATALOGO_BASE: as 26 linhas aprovadas, sem "Outros", sem duplicado lógico, só com grupos e proteções do vocabulário', () => {
    assert.ok(Array.isArray(classificacao.CATALOGO_BASE), 'CATALOGO_BASE ainda não existe');
    const linhas = classificacao.CATALOGO_BASE.map((t) => [t.grupo, t.grupoProtecao, t.nome]);
    assert.deepEqual(linhas, CATALOGO_BASE.map((t) => [...t]));
    assert.equal(new Set(linhas.map(([g, , n]) => `${g}|${n.toLowerCase()}`)).size, 26);
    for (const [g, p, n] of linhas) {
      assert.ok(classificacao.GRUPOS_CATALOGO.includes(g), g);
      assert.ok(classificacao.GRUPOS_PROTECAO.includes(p), p);
      assert.notEqual(n.toLowerCase(), 'outros');
    }
  });

  test('normalizarNomeTipo: espaço, tab, CR e LF viram um espaço; pontas aparadas; caixa, acentos e pontuação intactos; chave de unicidade em minúsculas', () => {
    esperarFuncao('normalizarNomeTipo');
    assert.equal(classificacao.normalizarNomeTipo('  Luva\r\n de  Segurança\t'), 'Luva de Segurança');
    assert.equal(classificacao.normalizarNomeTipo('Óculos - Fumê'), 'Óculos - Fumê');
    esperarFuncao('chaveDoTipo');
    assert.equal(classificacao.chaveDoTipo('  LUVA  de Segurança '), 'luva de segurança');
  });
});

describe('óculos com grau por classificação', () => {
  test('V2: EPI + Proteção ocular exige a resposta para qualquer tipo; fora disso nunca; LEGADO continua pelos três nomes', () => {
    esperarFuncao('exigeOculosComGrau');
    const f = classificacao.exigeOculosComGrau;
    assert.equal(f({ modeloClassificacao: 'V2', categoria: 'EPI', grupoProtecao: 'Proteção ocular', tipo: 'Visor Qualquer' }), true);
    assert.equal(f({ modeloClassificacao: 'V2', categoria: 'EPI', grupoProtecao: 'Proteção ocular', tipo: 'Outros' }), true);
    assert.equal(f({ modeloClassificacao: 'V2', categoria: 'EPI', grupoProtecao: 'Proteção facial', tipo: 'Óculos de Proteção Incolor' }), false, 'nome não manda');
    assert.equal(f({ modeloClassificacao: 'V2', categoria: 'Vestimenta', grupoProtecao: 'Proteção ocular', tipo: 'Outros' }), false, 'só EPI');
    assert.equal(f({ modeloClassificacao: 'V2', categoria: 'Outros', categoriaDescricao: 'Ferramenta', tipo: 'Outros' }), false);
    for (const tipo of ['Óculos de proteção', 'Óculos de Proteção Incolor', 'Óculos de Proteção Ampla Visão']) {
      assert.equal(f({ modeloClassificacao: 'LEGADO', categoria: 'EPI', tipo }), true, tipo);
    }
    assert.equal(f({ modeloClassificacao: 'LEGADO', categoria: 'EPI', tipo: 'Capacete' }), false);
    assert.equal(f({ categoria: 'EPI', tipo: 'Óculos de proteção' }), true, 'sem modelo = legado');
    assert.equal(classificacao.ehOculos('Óculos de Proteção Ampla Visão'), true, 'o predicado por nome continua para o legado');
  });
});

describe('valor efetivo de exibição (helper central)', () => {
  test('grupoEfetivo: categoria, ou categoriaDescricao quando Outros; grupoProtecaoEfetivo e tipoEfetivo seguem a mesma regra', () => {
    for (const nome of ['grupoEfetivo', 'grupoProtecaoEfetivo', 'tipoEfetivo']) esperarFuncao(nome);
    assert.equal(classificacao.grupoEfetivo({ categoria: 'Ferramenta', modeloClassificacao: 'LEGADO' }), 'Ferramenta');
    assert.equal(classificacao.grupoEfetivo({ categoria: 'Outros', categoriaDescricao: 'Ferramenta', modeloClassificacao: 'V2' }), 'Ferramenta');
    assert.equal(classificacao.grupoEfetivo({ categoria: 'EPI' }), 'EPI');
    assert.equal(classificacao.grupoEfetivo({ categoria: null }), null);
    assert.equal(classificacao.grupoEfetivo({}), null);
    assert.equal(classificacao.grupoEfetivo({ categoria: 'Outros', categoriaDescricao: null }), 'Outros', 'legado "Outros" sem descrição mostra o que tem');
    assert.equal(classificacao.grupoProtecaoEfetivo({ grupoProtecao: 'Outros', grupoProtecaoDescricao: 'Arco elétrico' }), 'Arco elétrico');
    assert.equal(classificacao.grupoProtecaoEfetivo({ grupoProtecao: 'Proteção ocular' }), 'Proteção ocular');
    assert.equal(classificacao.grupoProtecaoEfetivo({}), null);
    assert.equal(classificacao.tipoEfetivo({ tipo: 'Outros', tipoDescricao: 'Chave isolada' }), 'Chave isolada');
    assert.equal(classificacao.tipoEfetivo({ tipo: 'Capacete' }), 'Capacete');
    assert.equal(classificacao.tipoEfetivo({ tipo: 'Outros', tipoDescricao: null }), 'Outros');
    assert.equal(classificacao.tipoEfetivo({}), null);
  });

  test('a mesma regra no SQL: FRAGMENTOS de valor efetivo exportados para os repositórios (uma definição só)', () => {
    assert.ok(classificacao.SQL && typeof classificacao.SQL.grupoEfetivo === 'function', 'SQL.grupoEfetivo(alias) ainda não existe');
    assert.match(classificacao.SQL.grupoEfetivo('m'), /CASE WHEN m\.categoria = 'Outros' THEN m\.categoria_descricao ELSE m\.categoria END/i);
    assert.match(classificacao.SQL.tipoEfetivo('m'), /tipo_descricao/);
  });

  test('o frontend (js/materiais.js) expõe os mesmos helpers com o mesmo resultado numa tabela de casos', () => {
    const front = require('../../../frontend/js/materiais').formulario; // eslint-disable-line global-require
    const casos = [
      { categoria: 'Ferramenta' }, { categoria: 'Outros', categoriaDescricao: 'Ferramenta' }, { categoria: 'EPI' }, { categoria: 'Vestimenta' }, { categoria: null }, {},
      { categoria: 'Outros', categoriaDescricao: null },
    ];
    for (const nome of ['grupoEfetivo', 'grupoProtecaoEfetivo', 'tipoEfetivo']) assert.equal(typeof front[nome], 'function', `frontend ${nome}`);
    for (const m of casos) assert.equal(front.grupoEfetivo(m), classificacao.grupoEfetivo(m), JSON.stringify(m));
    for (const m of [{ grupoProtecao: 'Outros', grupoProtecaoDescricao: 'X' }, { grupoProtecao: 'Proteção ocular' }, {}]) assert.equal(front.grupoProtecaoEfetivo(m), classificacao.grupoProtecaoEfetivo(m));
    for (const m of [{ tipo: 'Outros', tipoDescricao: 'Chave' }, { tipo: 'Capacete' }, { tipo: 'Outros' }, {}]) assert.equal(front.tipoEfetivo(m), classificacao.tipoEfetivo(m));
  });
});
