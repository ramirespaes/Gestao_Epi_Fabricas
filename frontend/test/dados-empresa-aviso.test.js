'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const U = require('../js/permissoes-usuario');

/**
 * Dados da Empresa (F2) — a mensagem do aviso DADOS_EMPRESA_SEM_CONSULTAR (calculado pelo servidor) na Gestão de Usuários:
 * Editar ligado sem Visualizar. A tela só traduz o código; o texto informa que o acesso não vale sem a leitura e nunca afirma
 * perda de acesso nem revoga nada. O catálogo de acessos continua vindo da API (nenhum toggle é conhecido pelo navegador).
 */
const CODIGO = 'DADOS_EMPRESA_SEM_CONSULTAR';

describe('aviso DADOS_EMPRESA_SEM_CONSULTAR na Gestão de Usuários', () => {
  test('existe o texto do usuário e o do grupo, citando Dados da Empresa, Editar e Visualizar', () => {
    for (const textos of [U.TEXTOS.AVISOS, U.TEXTOS.AVISOS_GRUPO]) {
      assert.equal(typeof textos[CODIGO], 'string');
      assert.match(textos[CODIGO], /Dados da Empresa/);
      assert.match(textos[CODIGO], /Editar/);
      assert.match(textos[CODIGO], /Visualizar/);
      assert.match(textos[CODIGO], /duas permiss/i, 'explica que a alteração exige as duas');
    }
  });

  test('não afirma perda de acesso nem revogação (o aviso só informa)', () => {
    for (const textos of [U.TEXTOS.AVISOS, U.TEXTOS.AVISOS_GRUPO]) {
      assert.equal(/perde|perderam|perdem|revogad|removid/i.test(textos[CODIGO]), false);
    }
  });

  test('o texto do grupo fala da CONFIGURAÇÃO do grupo; o do usuário, do acesso do usuário', () => {
    assert.match(U.TEXTOS.AVISOS_GRUPO[CODIGO], /este grupo/i);
    assert.equal(/este grupo/i.test(U.TEXTOS.AVISOS[CODIGO]), false);
  });

  test('render.avisos mostra o aviso quando o servidor o envia e ignora código desconhecido', () => {
    const filhos = [];
    const doc = {
      createElement: (tag) => ({ tag, atributos: {}, filhos: [], setAttribute(k, v) { this.atributos[k] = v; }, appendChild(f) { this.filhos.push(f); return f; }, append(...fs) { fs.forEach((f) => this.filhos.push(f)); } }),
      createTextNode: (t) => ({ texto: t }),
    };
    const area = { style: {}, replaceChildren: (...itens) => { filhos.push(...itens); } };
    try {
      U.render.avisos(doc, area, [{ codigo: CODIGO }, { codigo: 'CODIGO_QUE_NAO_EXISTE' }], false);
    } catch (erro) {
      assert.fail(`render.avisos não pôde ser exercitado com um documento mínimo: ${erro.message}`);
    }
    assert.equal(filhos.length, 1);
    assert.equal(area.style.display, '');
  });
});
