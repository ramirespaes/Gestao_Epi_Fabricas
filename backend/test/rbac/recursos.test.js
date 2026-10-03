'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const recursos = require('../../src/rbac/recursos');
const materialRoutes = require('../../src/routes/material.routes');
const estoqueRoutes = require('../../src/routes/estoque.routes');
const funcionarioRoutes = require('../../src/routes/funcionario.routes');
const gheRoutes = require('../../src/routes/grupo-homogeneo-exposicao.routes');
const itensDisponiveisRoutes = require('../../src/routes/itens-disponiveis.routes');
const dashboardRoutes = require('../../src/routes/dashboard.routes');
const entregaEpiRoutes = require('../../src/routes/entrega-epi.routes');

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
    for (const recurso of [estoqueRoutes.RECURSO_VALIDADE, estoqueRoutes.RECURSO_OPERACOES]) {
      assert.ok(recursos.recursoConhecido(recurso), `${recurso} precisa estar em RECURSOS_CONHECIDOS`);
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
  test('é EXATAMENTE o que as rotas exigem: 3 recursos com visualizar/criar/editar; availableItems, dashboard, stockValidity, operations e epiFicha só visualizar (C3, C6, E9 e 10I); nenhum excluir; 2 ações', () => {
    const escopo = recursos.ESCOPO_PROVISIONAMENTO_MASTER;
    assert.equal(escopo.perfil, 'MASTER');
    assert.deepEqual(
      escopo.recursos.map((r) => [r.recurso, [...r.operacoes]]),
      [
        ['materials', ['visualizar', 'criar', 'editar']],
        ['employeeHistory', ['visualizar', 'criar', 'editar']],
        ['employeeGroups', ['visualizar', 'criar', 'editar']],
        ['availableItems', ['visualizar']],
        ['dashboard', ['visualizar']],
        ['stockValidity', ['visualizar']],
        ['operations', ['visualizar']],
        ['epiFicha', ['visualizar']],
      ],
    );
    assert.deepEqual([...escopo.acoes], ['MOVIMENTAR_ESTOQUE', 'REALIZAR_ENTREGA']);
    for (const r of escopo.recursos) {
      assert.ok(!r.operacoes.includes('excluir'), 'nenhuma rota usa excluir');
    }
  });

  test('o escopo cobre os recursos/ações das rotas dos Blocos 9 e 10 e NADA além deles (não concede "tudo" ao MASTER)', () => {
    const recursosDasRotas = new Set([materialRoutes.RECURSO, estoqueRoutes.RECURSO, estoqueRoutes.RECURSO_VALIDADE, estoqueRoutes.RECURSO_OPERACOES,
      funcionarioRoutes.RECURSO, gheRoutes.RECURSO, itensDisponiveisRoutes.RECURSO, dashboardRoutes.RECURSO, entregaEpiRoutes.RECURSO_FICHA]);
    const recursosDoEscopo = new Set(recursos.ESCOPO_PROVISIONAMENTO_MASTER.recursos.map((r) => r.recurso));
    assert.deepEqual([...recursosDoEscopo].sort(), [...recursosDasRotas].sort());
    assert.deepEqual([...recursos.ESCOPO_PROVISIONAMENTO_MASTER.acoes], [estoqueRoutes.ACAO_MOVIMENTAR_ESTOQUE, entregaEpiRoutes.ACAO_REALIZAR_ENTREGA]);
    assert.ok(recursosDoEscopo.size < recursos.RECURSOS_CONHECIDOS.length, 'escopo é menor que a lista de conhecidos');
    for (const legado of ['userAdmin', 'config', 'lgpd', 'importEmployees']) {
      assert.ok(!recursosDoEscopo.has(legado), `${legado} não tem rota no backend e não entra no escopo`);
    }
  });

  test('Bloco 12 (12F-1): as consultas da solicitação usam o recurso conhecido `request`, e nem ele nem as ações da SST entram no escopo do MASTER', () => {
    const solicitacaoRoutes = require('../../src/routes/solicitacao-epi.routes');
    assert.equal(solicitacaoRoutes.RECURSO_SOLICITACAO, 'request');
    assert.ok(recursos.recursoConhecido(solicitacaoRoutes.RECURSO_SOLICITACAO));
    assert.deepEqual([solicitacaoRoutes.ACAO_FILA, solicitacaoRoutes.ACAO_ENTREGAVEIS], ['APROVAR_SOLICITACAO', 'REALIZAR_ENTREGA']);
    const recursosDoEscopo = recursos.ESCOPO_PROVISIONAMENTO_MASTER.recursos.map((r) => r.recurso);
    assert.equal(recursosDoEscopo.includes('request'), false, 'ampliar o escopo do MASTER é decisão explícita');
    for (const acao of ['APROVAR_SOLICITACAO', 'REPROVAR_SOLICITACAO', 'ENCERRAR_SOLICITACAO']) {
      assert.equal(recursos.ESCOPO_PROVISIONAMENTO_MASTER.acoes.includes(acao), false, acao);
    }
  });

  test('Bloco 12 (12F-2): criar é request.criar, cancelar é request.editar (nunca excluir); decidir, encerrar e entregar são ações do catálogo; nada disso entra no escopo do MASTER', () => {
    const solicitacaoRoutes = require('../../src/routes/solicitacao-epi.routes');
    assert.deepEqual([solicitacaoRoutes.OPERACAO_CRIAR, solicitacaoRoutes.OPERACAO_CANCELAR], ['criar', 'editar']);
    for (const operacao of [solicitacaoRoutes.OPERACAO_CRIAR, solicitacaoRoutes.OPERACAO_CANCELAR]) assert.ok(recursos.OPERACOES.includes(operacao), operacao);
    assert.deepEqual(
      [solicitacaoRoutes.ACAO_APROVAR, solicitacaoRoutes.ACAO_REPROVAR, solicitacaoRoutes.ACAO_ENCERRAR, solicitacaoRoutes.ACAO_ENTREGAR],
      ['APROVAR_SOLICITACAO', 'REPROVAR_SOLICITACAO', 'ENCERRAR_SOLICITACAO', 'REALIZAR_ENTREGA'],
    );
    assert.equal(recursos.ESCOPO_PROVISIONAMENTO_MASTER.recursos.some((r) => r.recurso === 'request'), false);
    assert.deepEqual([...recursos.ESCOPO_PROVISIONAMENTO_MASTER.acoes], ['MOVIMENTAR_ESTOQUE', 'REALIZAR_ENTREGA'], 'o escopo do MASTER não muda na 12F-2');
  });
});
