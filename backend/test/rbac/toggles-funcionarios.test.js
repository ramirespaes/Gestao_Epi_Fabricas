'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { TOGGLES, buscar } = require('../../src/rbac/toggles');
const { RECURSOS_COM_EFEITO, ACOES_COM_EFEITO, ESCOPO_PROVISIONAMENTO_MASTER } = require('../../src/rbac/recursos');

/**
 * RBAC da Gestão de Funcionários (RED): catálogo binário e provisionamento. Reutiliza as três operações de employeeHistory que
 * as rotas já exigem; os acessos novos só as expõem como toggles (com a dependência de leitura pelo campo `dependencias`
 * existente, o mesmo da Gestão de Estoque). Nenhuma ação nem recurso novo.
 */
const LEITURA = { tipo: 'RECURSO', recurso: 'employeeHistory', operacoes: ['visualizar'] };

describe('Gestão de Funcionários — catálogo de acessos', () => {
  test('cadastrar e editar funcionário: toggles do grupo Colaboradores sobre employeeHistory.criar / .editar, cada um com a leitura como dependência', () => {
    const cadastrar = buscar('cadastrarFuncionario');
    const editar = buscar('editarFuncionario');
    assert.ok(cadastrar, 'toggle cadastrarFuncionario ausente');
    assert.ok(editar, 'toggle editarFuncionario ausente');
    assert.deepEqual(cadastrar.regra, { tipo: 'RECURSO', recurso: 'employeeHistory', operacoes: ['criar'] });
    assert.deepEqual(editar.regra, { tipo: 'RECURSO', recurso: 'employeeHistory', operacoes: ['editar'] });
    assert.deepEqual(cadastrar.dependencias, [LEITURA]);
    assert.deepEqual(editar.dependencias, [LEITURA]);
    for (const t of [cadastrar, editar]) {
      assert.equal(t.grupo, 'COLABORADORES');
      assert.ok(typeof t.rotulo === 'string' && t.rotulo.length > 0);
    }
  });

  test('Histórico de Funcionários continua só a leitura e a Importação continua a ação própria, sem dependências (preservados)', () => {
    assert.deepEqual(buscar('historicoFuncionarios').regra, { tipo: 'RECURSO', recurso: 'employeeHistory', operacoes: ['visualizar'] });
    assert.equal(buscar('historicoFuncionarios').dependencias, undefined);
    assert.deepEqual(buscar('importacaoFuncionarios').regra, { tipo: 'ACAO', codigo: 'IMPORTAR_FUNCIONARIOS' });
    assert.deepEqual(buscar('importacaoFuncionarios').dependencias, []);
  });

  test('nenhuma permissão nova: employeeHistory segue com visualizar/criar/editar e não há ação de GHE, situação ou funcionário além da importação', () => {
    assert.deepEqual(RECURSOS_COM_EFEITO.find((r) => r.recurso === 'employeeHistory').operacoes, ['visualizar', 'criar', 'editar']);
    assert.deepEqual(ACOES_COM_EFEITO.filter((c) => /FUNCIONARIO|COLABORADOR|GHE|SITUACAO/.test(c)), ['IMPORTAR_FUNCIONARIOS']);
    assert.equal(TOGGLES.filter((t) => t.regra.tipo === 'RECURSO' && t.regra.recurso === 'employeeHistory').length, 3, 'visualizar, criar e editar: um toggle cada');
  });

  test('provisionamento do MASTER: as três operações de employeeHistory juntas (visualizar sempre presente quando há criar ou editar) e a importação como ação', () => {
    const escopo = ESCOPO_PROVISIONAMENTO_MASTER.recursos.find((r) => r.recurso === 'employeeHistory');
    assert.deepEqual([...escopo.operacoes], ['visualizar', 'criar', 'editar']);
    assert.ok(ESCOPO_PROVISIONAMENTO_MASTER.acoes.includes('IMPORTAR_FUNCIONARIOS'));
  });

  test('toda dependência de toggle aponta para operação que o servidor aplica (sem dependência órfã)', () => {
    for (const t of TOGGLES) {
      for (const d of t.dependencias ?? []) {
        const r = RECURSOS_COM_EFEITO.find((x) => x.recurso === d.recurso);
        assert.ok(r, `${t.id} depende de ${d.recurso}`);
        for (const op of d.operacoes) assert.ok(r.operacoes.includes(op), `${t.id}.${op}`);
      }
    }
  });
});
