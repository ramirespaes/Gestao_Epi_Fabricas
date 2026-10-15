'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const recursos = require('../../src/rbac/recursos');

/**
 * Atendimento Token — Etapa B (RED): o recurso `atendimentoToken` e a ação de revogação no catálogo RBAC e no escopo de
 * provisionamento do MASTER (decisão de 11/10/2026: as permissões do Atendimento Token entram no escopo administrativo do
 * MASTER; nada é concedido por perfil e nada a perfis comuns).
 *
 * Contrato da Etapa B:
 *   - recurso `atendimentoToken` conhecido, com rótulo, nas três operações que as rotas exigem: visualizar (consultar),
 *     criar (cadastrar) e editar (editar). `excluir` não existe: o tablet nunca é apagado, só revogado;
 *   - TOKEN_REVOGAR_DISPOSITIVO é a única das seis ações novas com rota na Etapa B: entra em ACOES_COM_EFEITO e no escopo do
 *     MASTER. As outras cinco só entram quando a rota que as aplica existir — as regras que já valem (test/rbac/
 *     catalogo-com-efeito.test.js) recusam "controle sem efeito" no catálogo. Este arquivo não decide nada sobre elas.
 *
 * Enquanto o recurso e a ação não existirem em src/rbac/recursos.js, cada teste falha por asserção.
 */

const RECURSO = 'atendimentoToken';
const ACAO_REVOGAR = 'TOKEN_REVOGAR_DISPOSITIVO';
const escopoDoRecurso = () => recursos.ESCOPO_PROVISIONAMENTO_MASTER.recursos.find((r) => r.recurso === RECURSO);

describe('B — recurso atendimentoToken no catálogo RBAC', () => {
  test('é um recurso conhecido (formato válido e sem duplicata)', () => {
    assert.ok(recursos.RECURSOS_CONHECIDOS.includes(RECURSO), 'atendimentoToken fora de RECURSOS_CONHECIDOS');
    assert.equal(recursos.recursoConhecido(RECURSO), true);
    assert.match(RECURSO, recursos.FORMATO_RECURSO);
    assert.equal(new Set(recursos.RECURSOS_CONHECIDOS).size, recursos.RECURSOS_CONHECIDOS.length);
  });

  test('escopo do MASTER: exatamente visualizar, criar e editar (nunca excluir)', () => {
    const escopo = escopoDoRecurso();
    assert.ok(escopo, 'atendimentoToken fora de ESCOPO_PROVISIONAMENTO_MASTER.recursos');
    assert.deepEqual([...escopo.operacoes], ['visualizar', 'criar', 'editar']);
  });

  test('o catálogo da tela de permissões tem o recurso, com o rótulo e as mesmas operações do escopo', () => {
    assert.equal(recursos.ROTULOS_RECURSOS[RECURSO], 'Atendimento Token');
    const doCatalogo = recursos.RECURSOS_COM_EFEITO.find((r) => r.recurso === RECURSO);
    assert.ok(doCatalogo, 'atendimentoToken fora de RECURSOS_COM_EFEITO');
    assert.equal(doCatalogo.rotulo, 'Atendimento Token');
    assert.deepEqual([...doCatalogo.operacoes], ['visualizar', 'criar', 'editar']);
  });
});

describe('B — ação TOKEN_REVOGAR_DISPOSITIVO no catálogo RBAC', () => {
  test('entra no escopo de provisionamento do MASTER (única forma de o MASTER, que decide só pelo perfil, a exercer)', () => {
    assert.ok(recursos.ESCOPO_PROVISIONAMENTO_MASTER.acoes.includes(ACAO_REVOGAR), 'ação fora de ESCOPO_PROVISIONAMENTO_MASTER.acoes');
  });

  test('é uma ação com efeito real (a rota de revogação a aplica), então aparece na lista da tela de permissões', () => {
    assert.ok(recursos.ACOES_COM_EFEITO.includes(ACAO_REVOGAR), 'ação fora de ACOES_COM_EFEITO');
  });

  test('o escopo continua sem duplicata e só com ações do catálogo', () => {
    const acoes = recursos.ESCOPO_PROVISIONAMENTO_MASTER.acoes;
    assert.equal(new Set(acoes).size, acoes.length);
    assert.ok(acoes.includes(ACAO_REVOGAR), 'premissa: a ação nova está no escopo');
    assert.ok(acoes.includes('EXPORTAR_HISTORICO_FUNCIONARIOS'), 'as ações anteriores continuam');
  });
});
