'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const recursos = require('../../src/rbac/recursos');
const materialRoutes = require('../../src/routes/material.routes');
const estoqueRoutes = require('../../src/routes/estoque.routes');
const funcionarioRoutes = require('../../src/routes/funcionario.routes');
const gheRoutes = require('../../src/routes/grupo-homogeneo-exposicao.routes');

/**
 * Lista central de recursos RBAC (Bloco 9, Etapa B). O objetivo destes
 * testes é impedir que um identificador usado por uma rota de produção
 * fique fora da lista (e, portanto, fora do provisionamento) e que o
 * escopo do provisionamento cresça sem decisão explícita.
 */

describe('recursos conhecidos', () => {
  test('todos têm formato válido, sem duplicatas; legados são os 21 de allPages; Bloco 9 acrescenta employeeGroups', () => {
    for (const recurso of recursos.RECURSOS_CONHECIDOS) {
      assert.match(recurso, recursos.FORMATO_RECURSO);
    }
    assert.equal(new Set(recursos.RECURSOS_CONHECIDOS).size, recursos.RECURSOS_CONHECIDOS.length);
    assert.equal(recursos.RECURSOS_LEGADOS.length, 21);
    assert.deepEqual([...recursos.RECURSOS_BLOCO_9], ['employeeGroups']);
    assert.ok(recursos.RECURSOS_LEGADOS.includes('employeeHistory'), 'employeeHistory é identificador legado do frontend');
    assert.ok(!recursos.RECURSOS_LEGADOS.includes('employeeGroups'), 'employeeGroups não existe no frontend legado');
  });

  test('toda rota de produção do Bloco 9 usa um recurso conhecido (coerência rota ↔ lista)', () => {
    for (const modulo of [materialRoutes, estoqueRoutes, funcionarioRoutes, gheRoutes]) {
      assert.equal(typeof modulo.RECURSO, 'string');
      assert.ok(recursos.recursoConhecido(modulo.RECURSO), `${modulo.RECURSO} precisa estar em RECURSOS_CONHECIDOS`);
    }
    assert.equal(recursos.recursoConhecido('inventado'), false);
    assert.equal(recursos.recursoConhecido(42), false);
  });

  test('listas são congeladas', () => {
    assert.ok(Object.isFrozen(recursos.RECURSOS_CONHECIDOS));
    assert.ok(Object.isFrozen(recursos.ESCOPO_PROVISIONAMENTO_MASTER));
    assert.ok(Object.isFrozen(recursos.ESCOPO_PROVISIONAMENTO_MASTER.recursos));
    assert.ok(Object.isFrozen(recursos.ESCOPO_PROVISIONAMENTO_MASTER.acoes));
  });
});

describe('escopo do provisionamento do MASTER', () => {
  test('é EXATAMENTE o que as rotas do Bloco 9 exigem: 3 recursos com visualizar/criar/editar (sem excluir) e 1 ação', () => {
    const escopo = recursos.ESCOPO_PROVISIONAMENTO_MASTER;
    assert.equal(escopo.perfil, 'MASTER');
    assert.deepEqual(
      escopo.recursos.map((r) => [r.recurso, [...r.operacoes]]),
      [
        ['materials', ['visualizar', 'criar', 'editar']],
        ['employeeHistory', ['visualizar', 'criar', 'editar']],
        ['employeeGroups', ['visualizar', 'criar', 'editar']],
      ],
    );
    assert.deepEqual([...escopo.acoes], ['MOVIMENTAR_ESTOQUE']);
    for (const r of escopo.recursos) {
      assert.ok(!r.operacoes.includes('excluir'), 'nenhuma rota do Bloco 9 usa excluir');
    }
  });

  test('o escopo cobre os recursos/ação das rotas do Bloco 9 e NADA além deles (não concede "tudo" ao MASTER)', () => {
    const recursosDasRotas = new Set([materialRoutes.RECURSO, estoqueRoutes.RECURSO, funcionarioRoutes.RECURSO, gheRoutes.RECURSO]);
    const recursosDoEscopo = new Set(recursos.ESCOPO_PROVISIONAMENTO_MASTER.recursos.map((r) => r.recurso));
    assert.deepEqual([...recursosDoEscopo].sort(), [...recursosDasRotas].sort());
    assert.deepEqual([...recursos.ESCOPO_PROVISIONAMENTO_MASTER.acoes], [estoqueRoutes.ACAO_MOVIMENTAR_ESTOQUE]);
    assert.ok(recursosDoEscopo.size < recursos.RECURSOS_CONHECIDOS.length, 'escopo é menor que a lista de conhecidos');
    for (const legado of ['dashboard', 'userAdmin', 'config', 'lgpd', 'importEmployees']) {
      assert.ok(!recursosDoEscopo.has(legado), `${legado} não tem rota no backend e não entra no escopo`);
    }
  });
});
