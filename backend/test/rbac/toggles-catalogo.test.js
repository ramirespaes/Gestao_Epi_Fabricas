'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { TOGGLES, PENDENCIAS, GRUPOS, buscar } = require('../../src/rbac/toggles');
const { RECURSOS_COM_EFEITO, ACOES_COM_EFEITO } = require('../../src/rbac/recursos');

describe('catálogo binário de acessos', () => {
  test('os 19 acessos aprovados estão contabilizados, sem repetição e sem CRUD automático', () => {
    const ids = [...TOGGLES, ...PENDENCIAS].map((t) => t.id);
    assert.equal(ids.length, 19);
    assert.equal(new Set(ids).size, 19);
  });

  test('todo toggle aponta para recurso/operação ou ação que o servidor realmente aplica', () => {
    for (const t of TOGGLES) {
      assert.ok(GRUPOS.includes(t.grupo), t.id);
      if (t.regra.tipo === 'ACAO') {
        assert.ok(ACOES_COM_EFEITO.includes(t.regra.codigo), t.id);
      } else {
        const r = RECURSOS_COM_EFEITO.find((x) => x.recurso === t.regra.recurso);
        assert.ok(r, t.id);
        for (const op of t.regra.operacoes) assert.ok(r.operacoes.includes(op), `${t.id}.${op}`);
      }
    }
  });

  test('Gestão de GHE é só consulta e Gestão de Usuários é uma ação única', () => {
    assert.deepEqual(buscar('gestaoGhe').regra.operacoes, ['visualizar']);
    assert.deepEqual(buscar('gestaoUsuarios').regra, { tipo: 'ACAO', codigo: 'GERENCIAR_USUARIOS' });
  });

  test('os três da Gestão de Estoque e a Importação têm ação ou operação própria e independente', () => {
    assert.deepEqual(buscar('cadastrarProduto').regra, { tipo: 'RECURSO', recurso: 'materials', operacoes: ['criar'] });
    assert.deepEqual(buscar('entradaLote').regra, { tipo: 'ACAO', codigo: 'ENTRADA_ESTOQUE' });
    assert.deepEqual(buscar('registrarBaixa').regra, { tipo: 'ACAO', codigo: 'BAIXA_ESTOQUE' });
    assert.equal(TOGGLES.filter((t) => t.grupo === 'ESTOQUE' && ['cadastrarProduto', 'entradaLote', 'registrarBaixa'].includes(t.id)).length, 3);
    assert.equal(PENDENCIAS.some((p) => ['entradaLote', 'registrarBaixa'].includes(p.id)), false);
    assert.deepEqual(buscar('importacaoFuncionarios').regra, { tipo: 'ACAO', codigo: 'IMPORTAR_FUNCIONARIOS' });
    assert.equal(PENDENCIAS.some((p) => p.id === 'importacaoFuncionarios'), false);
  });
});
