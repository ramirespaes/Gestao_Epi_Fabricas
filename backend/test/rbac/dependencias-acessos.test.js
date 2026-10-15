'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { TOGGLES } = require('../../src/rbac/toggles');
const { descreverDependencia } = require('../../src/rbac/dependencias-acessos');

/**
 * Etapa H — transparência das dependências: cada dependência de um toggle tem uma identidade estável (para auditoria e para o
 * aviso) e um rótulo legível. NÃO decide autorização: a regra de dependência continua sendo a de `toggles.js`.
 */
const comDependencia = TOGGLES.filter((t) => (t.dependencias ?? []).length > 0);

describe('DEP1 — descritor das dependências', () => {
  test('DEP1.1 os nove toggles com dependência são exatamente os de Funcionários, Estoque e Atendimento Token', () => {
    assert.deepEqual(comDependencia.map((t) => t.id).sort(), [
      'cadastrarFuncionario', 'cadastrarProduto', 'editarFuncionario', 'entradaLote', 'registrarBaixa',
      'tokenCadastrar', 'tokenEditar', 'tokenGerarAtivacao', 'tokenRevogar',
    ].sort());
  });

  test('DEP1.2 Atendimento Token: a dependência é o toggle Consultar, com o módulo no rótulo', () => {
    for (const id of ['tokenCadastrar', 'tokenEditar', 'tokenRevogar', 'tokenGerarAtivacao']) {
      const [dep] = TOGGLES.find((t) => t.id === id).dependencias;
      assert.deepEqual(descreverDependencia(dep), { chave: 'atendimentoToken.visualizar', toggleId: 'tokenVisualizar', rotulo: 'Atendimento Token: Consultar' }, id);
    }
  });

  test('DEP1.3 Funcionários: a dependência é o Histórico de Funcionários', () => {
    for (const id of ['cadastrarFuncionario', 'editarFuncionario']) {
      const [dep] = TOGGLES.find((t) => t.id === id).dependencias;
      assert.deepEqual(descreverDependencia(dep), { chave: 'employeeHistory.visualizar', toggleId: 'historicoFuncionarios', rotulo: 'Funcionários: Histórico de Funcionários' }, id);
    }
  });

  test('DEP1.4 Estoque: a leitura de materiais não tem toggle próprio; a identidade é a chave do recurso, sem inventar toggle', () => {
    for (const id of ['cadastrarProduto', 'entradaLote', 'registrarBaixa']) {
      const [dep] = TOGGLES.find((t) => t.id === id).dependencias;
      assert.deepEqual(descreverDependencia(dep), { chave: 'materials.visualizar', toggleId: null, rotulo: 'Materiais (leitura)' }, id);
    }
  });

  test('DEP1.5 o toggleId devolvido, quando existe, é sempre um toggle do catálogo cuja regra é a própria dependência', () => {
    for (const t of comDependencia) {
      for (const dep of t.dependencias) {
        const d = descreverDependencia(dep);
        if (d.toggleId === null) continue;
        const alvo = TOGGLES.find((x) => x.id === d.toggleId);
        assert.ok(alvo, d.toggleId);
        assert.deepEqual(JSON.parse(JSON.stringify(alvo.regra)), JSON.parse(JSON.stringify(dep)));
      }
    }
  });

  test('DEP1.6 entrada inválida é recusada em vez de produzir uma identidade falsa', () => {
    assert.throws(() => descreverDependencia(null), TypeError);
    assert.throws(() => descreverDependencia({ tipo: 'OUTRO' }), TypeError);
  });
});
