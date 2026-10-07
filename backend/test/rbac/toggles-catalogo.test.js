'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { TOGGLES, PENDENCIAS, GRUPOS, buscar } = require('../../src/rbac/toggles');
const { RECURSOS_COM_EFEITO, ACOES_COM_EFEITO } = require('../../src/rbac/recursos');

describe('catálogo binário de acessos', () => {
  test('os 19 acessos aprovados mais Aprovar e Reprovar solicitações estão contabilizados, sem repetição e sem CRUD automático', () => {
    const ids = [...TOGGLES, ...PENDENCIAS].map((t) => t.id);
    assert.equal(ids.length, 22);
    assert.equal(new Set(ids).size, 22);
  });

  test('Entregas por solicitação reutiliza a ação REALIZAR_ENTREGA, sem bloqueio ao desligar e sem acoplar à SST', () => {
    assert.deepEqual(buscar('entregasSolicitacao').regra, { tipo: 'ACAO', codigo: 'REALIZAR_ENTREGA', semBloqueio: true });
    assert.equal(buscar('entregasSolicitacao').grupo, 'EPIS');
  });

  test('Aprovar e Reprovar solicitações mapeiam para as ações da SST como CONCESSÃO individual (o vínculo é outra dimensão)', () => {
    assert.deepEqual(buscar('aprovarSolicitacoes').regra, { tipo: 'ACAO', codigo: 'APROVAR_SOLICITACAO', concessao: true });
    assert.deepEqual(buscar('reprovarSolicitacoes').regra, { tipo: 'ACAO', codigo: 'REPROVAR_SOLICITACAO', concessao: true });
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
