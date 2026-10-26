'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const U = require('../js/permissoes-usuario');

/**
 * Dados da Empresa — controle único: o aviso DADOS_EMPRESA_SEM_CONSULTAR deixou de existir (Editar já não é um acesso separado de
 * Visualizar). A tela não traduz esse código; se um servidor antigo o enviasse, `render.avisos` o ignora como qualquer código desconhecido.
 */
const CODIGO = 'DADOS_EMPRESA_SEM_CONSULTAR';

describe('Dados da Empresa — sem aviso de dependência na Gestão de Usuários', () => {
  test('não há texto para o código antigo, nem no usuário nem no grupo', () => {
    assert.equal(Object.hasOwn(U.TEXTOS.AVISOS, CODIGO), false);
    assert.equal(Object.hasOwn(U.TEXTOS.AVISOS_GRUPO, CODIGO), false);
  });

  test('acesso parcial legado: texto próprio para usuário e grupo, sem afirmar revogação, e a linha ganha a indicação só quando desligada e parcial', () => {
    for (const textos of [U.TEXTOS.AVISOS, U.TEXTOS.AVISOS_GRUPO]) {
      assert.match(textos.ACESSO_PARCIAL_LEGADO, /parcial legado/i);
      assert.match(textos.ACESSO_PARCIAL_LEGADO, /Nada muda até alguém agir/);
    }
    assert.match(U.TEXTOS.AVISOS_GRUPO.ACESSO_PARCIAL_LEGADO, /exceções individuais/);
    const doc = {
      createElement: (tag) => ({ tag, atributos: {}, filhos: [], setAttribute(k, v) { this.atributos[k] = v; }, appendChild(f) { this.filhos.push(f); return f; }, append(...fs) { fs.forEach((f) => this.filhos.push(f)); } }),
      createTextNode: (t) => ({ texto: t }),
    };
    const marca = (t) => JSON.stringify(U.render.linhaAcesso(doc, t, true)).includes('data-parcial');
    assert.equal(marca({ id: 'dadosEmpresa', rotulo: 'Dados da Empresa', ligado: false, parcial: true }), true);
    assert.equal(marca({ id: 'dadosEmpresa', rotulo: 'Dados da Empresa', ligado: false }), false);
    assert.equal(marca({ id: 'dadosEmpresa', rotulo: 'Dados da Empresa', ligado: true }), false);
  });

  test('render.avisos ignora o código antigo e não mostra nada', () => {
    const filhos = [];
    const doc = {
      createElement: (tag) => ({ tag, atributos: {}, filhos: [], setAttribute(k, v) { this.atributos[k] = v; }, appendChild(f) { this.filhos.push(f); return f; }, append(...fs) { fs.forEach((f) => this.filhos.push(f)); } }),
      createTextNode: (t) => ({ texto: t }),
    };
    const area = { style: {}, replaceChildren: (...itens) => { filhos.push(...itens); } };
    U.render.avisos(doc, area, [{ codigo: CODIGO }], false);
    assert.equal(filhos.length, 0);
  });
});
