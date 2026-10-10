'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const P = require('../js/permissoes-efetivas');

/**
 * RBAC da Gestão de Funcionários (RED) — representação da página no mapa PAGINAS.
 *
 * A página nova usa a chave `funcionarios` (o identificador da página, como `employeeGroups` ou `gestaoUsuarios`); o Histórico
 * (`employeeHistory`) e a Importação (`importEmployees`) continuam como estão, sem chave concorrente. Abrir exige
 * employeeHistory.visualizar; "alterar" exige employeeHistory.editar; criar é consultado à parte pela página, por operação
 * (`EpiPermissoes.recurso`). A importação segue com a ação própria. O servidor continua a autoridade; isto só decide menu e botões.
 */
const perm = (ops, importar = false) => ({
  recursos: { employeeHistory: { visualizar: ops.includes('v'), criar: ops.includes('c'), editar: ops.includes('e'), excluir: false } },
  acoes: { IMPORTAR_FUNCIONARIOS: importar },
  administracao: {},
});

describe('PAGINAS.funcionarios', () => {
  test('a chave existe e usa só as operações de employeeHistory: abrir = visualizar, alterar = editar', () => {
    assert.ok(Object.hasOwn(P.PAGINAS, 'funcionarios'), 'PAGINAS.funcionarios ausente');
    assert.deepEqual(P.PAGINAS.funcionarios, {
      abrir: [{ recurso: 'employeeHistory', operacao: 'visualizar' }],
      alterar: [{ recurso: 'employeeHistory', operacao: 'editar' }],
    });
  });

  test('abre com visualizar; sem visualizar não abre, mesmo com criar ou editar (a dependência é garantida na atribuição, não inventada no menu)', () => {
    assert.equal(P.podeAbrir(perm('v'), 'funcionarios'), true);
    assert.equal(P.podeAbrir(perm(''), 'funcionarios'), false);
    assert.equal(P.podeAbrir(perm('c'), 'funcionarios'), false);
    assert.equal(P.podeAbrir(perm('e'), 'funcionarios'), false);
    assert.equal(P.podeAbrir(null, 'funcionarios'), false);
  });

  test('alterar (editar, troca de GHE, situação) só com visualizar + editar; criar é decidido à parte, por operação', () => {
    assert.equal(P.podeAlterar(perm('v'), 'funcionarios'), false);
    assert.equal(P.podeAlterar(perm('vc'), 'funcionarios'), false, 'criar não é editar');
    assert.equal(P.podeAlterar(perm('ve'), 'funcionarios'), true);
    assert.equal(P.podeAlterar(perm('e'), 'funcionarios'), false, 'sem a leitura a página nem abre');
    assert.equal(P.recurso(perm('vc'), 'employeeHistory', 'criar'), true);
    assert.equal(P.recurso(perm('ve'), 'employeeHistory', 'criar'), false);
  });

  test('a importação não abre a página de Funcionários nem depende de criar/editar; o Histórico e a Importação ficam como estavam', () => {
    assert.equal(P.podeAbrir(perm('', true), 'funcionarios'), false, 'importar não é consultar');
    assert.equal(P.podeAbrir(perm('vce', false), 'importEmployees'), false, 'criar/editar não é importar');
    assert.deepEqual(P.PAGINAS.employeeHistory, { abrir: [{ recurso: 'employeeHistory', operacao: 'visualizar' }], alterar: [] });
    assert.deepEqual(P.PAGINAS.importEmployees, { abrir: [{ acao: 'IMPORTAR_FUNCIONARIOS' }], alterar: [{ acao: 'IMPORTAR_FUNCIONARIOS' }] });
  });

  test('nenhuma outra chave de PAGINAS duplica a representação da Gestão de Funcionários', () => {
    const quemExigeEditar = Object.entries(P.PAGINAS)
      .filter(([, p]) => (p.alterar ?? []).some((e) => e.recurso === 'employeeHistory' && e.operacao === 'editar'))
      .map(([chave]) => chave);
    assert.deepEqual(quemExigeEditar, ['funcionarios']);
  });
});
