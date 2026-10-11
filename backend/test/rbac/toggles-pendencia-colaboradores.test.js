'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { TOGGLES, PENDENCIAS } = require('../../src/rbac/toggles');

/**
 * Gestão de Usuários — correção pontual (RED): a pendência `gestaoColaboradores` do catálogo dizia que a página e as rotas
 * "ainda não existem". Já existem (Cadastro de Colaboradores, rotas /funcionarios) e são cobertas pelos acessos Cadastrar
 * Funcionário e Editar Funcionário (employeeHistory). Corrige-se só a informação: chave, rótulo, permissões e regras ficam.
 */
describe('catálogo — pendência Gestão de Colaboradores com a informação atual', () => {
  const p = PENDENCIAS.find((x) => x.id === 'gestaoColaboradores');

  test('CAT1 a chave e o rótulo continuam os mesmos', () => {
    assert.ok(p, 'a pendência gestaoColaboradores continua no catálogo');
    assert.equal(p.rotulo, 'Gestão de Colaboradores');
  });

  test('CAT2 a descrição não diz mais que a página e as rotas não existem', () => {
    assert.equal(/ainda não existem|não existe/i.test(p.motivo), false, p.motivo);
  });

  test('CAT3 a descrição aponta os acessos que já cobrem a gestão: Cadastrar Funcionário e Editar Funcionário', () => {
    for (const id of ['cadastrarFuncionario', 'editarFuncionario']) {
      const t = TOGGLES.find((x) => x.id === id);
      assert.ok(t, id);
      assert.ok(p.motivo.includes(t.rotulo), `a descrição cita "${t.rotulo}": ${p.motivo}`);
    }
  });

  test('CAT4 nada mais mudou nos acessos de Colaboradores (regras e dependências)', () => {
    const regra = (id) => TOGGLES.find((x) => x.id === id).regra;
    assert.deepEqual(regra('historicoFuncionarios'), { tipo: 'RECURSO', recurso: 'employeeHistory', operacoes: ['visualizar'] });
    assert.deepEqual(regra('cadastrarFuncionario'), { tipo: 'RECURSO', recurso: 'employeeHistory', operacoes: ['criar'] });
    assert.deepEqual(regra('editarFuncionario'), { tipo: 'RECURSO', recurso: 'employeeHistory', operacoes: ['editar'] });
    assert.deepEqual(regra('gestaoUsuarios'), { tipo: 'ACAO', codigo: 'GERENCIAR_USUARIOS' });
  });
});
