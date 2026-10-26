'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const recursos = require('../../src/rbac/recursos');
const { TOGGLES, GRUPOS, buscar } = require('../../src/rbac/toggles');
const { descreverDependencia } = require('../../src/rbac/dependencias-acessos');
const { RECURSO } = require('../../src/routes/empresa-dados.routes');

describe('Dados da Empresa — recurso companyData no RBAC', () => {
  test('é recurso conhecido, tem rótulo e entra no escopo do MASTER só com visualizar e editar', () => {
    assert.equal(RECURSO, 'companyData');
    assert.ok(recursos.recursoConhecido('companyData'));
    assert.equal(recursos.ROTULOS_RECURSOS.companyData, 'Dados da Empresa');
    const escopo = recursos.ESCOPO_PROVISIONAMENTO_MASTER.recursos.find((r) => r.recurso === 'companyData');
    assert.deepEqual([...escopo.operacoes], ['visualizar', 'editar']);
    assert.ok(recursos.RECURSOS_COM_EFEITO.some((r) => r.recurso === 'companyData'));
  });

  test('dois toggles no grupo ADMINISTRACAO; Editar depende da leitura e Visualizar não depende de nada', () => {
    const ver = buscar('dadosEmpresaVisualizar');
    const editar = buscar('dadosEmpresaEditar');
    assert.deepEqual([ver.grupo, ver.regra, ver.dependencias], ['ADMINISTRACAO', { tipo: 'RECURSO', recurso: 'companyData', operacoes: ['visualizar'] }, undefined]);
    assert.deepEqual([editar.grupo, editar.regra], ['ADMINISTRACAO', { tipo: 'RECURSO', recurso: 'companyData', operacoes: ['editar'] }]);
    assert.equal(editar.dependencias.length, 1);
    assert.deepEqual(descreverDependencia(editar.dependencias[0]), { chave: 'companyData.visualizar', toggleId: 'dadosEmpresaVisualizar', rotulo: 'Dados da Empresa: Dados da Empresa — Visualizar' });
    assert.ok(GRUPOS.includes('ADMINISTRACAO'));
  });

  test('nenhum toggle de criar ou excluir existe para o recurso, e não há ação nova', () => {
    const doRecurso = TOGGLES.filter((t) => t.regra.tipo === 'RECURSO' && t.regra.recurso === 'companyData');
    assert.deepEqual(doRecurso.flatMap((t) => t.regra.operacoes).sort(), ['editar', 'visualizar']);
  });

  test('as rotas aplicam o recurso e o PATCH exige as DUAS operações, visualizar antes de editar', () => {
    const fonte = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'routes', 'empresa-dados.routes.js'), 'utf8');
    assert.match(fonte, /criarExigirPermissaoRecurso\(\{ pool: poolInjetado \}, RECURSO, 'visualizar'\)/);
    assert.match(fonte, /criarExigirPermissaoRecurso\(\{ pool: poolInjetado \}, RECURSO, 'editar'\)/);
    const patch = fonte.slice(fonte.indexOf("router.patch("));
    assert.ok(patch.indexOf('exigirVisualizar') >= 0, 'o PATCH aplica visualizar');
    assert.ok(patch.indexOf('exigirEditar') >= 0, 'o PATCH aplica editar');
    assert.ok(patch.indexOf('exigirVisualizar') < patch.indexOf('exigirEditar'), 'visualizar vem antes de editar no PATCH');
    assert.ok(patch.indexOf('exigirEditar') < patch.indexOf('validar('), 'autorização antes da validação');
    assert.doesNotMatch(fonte, /router\.(post|put|delete)\(/, 'sem criação, troca total ou exclusão');
  });
});
