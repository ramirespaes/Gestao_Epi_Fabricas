'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const s = require('../../src/schemas/usuario-administracao.schema');

/** Schemas das funções da Gestão de Usuários além do Novo: alterar, senha, permissões, copiar e duplicar. */
const ok = (schema, v) => schema.safeParse(v);
const campos = (r) => r.error.issues.map((i) => i.path.join('.'));
const codigos = (r) => r.error.issues.map((i) => i.params?.codigo ?? i.message);

describe('alterar usuário', () => {
  test('todos os campos editáveis; horário null limpa; IPs [] limpam; grupo null retira; e-mail normalizado', () => {
    const r = ok(s.alterar.body, { nome: ' Ana ', email: 'ANA@Example.invalid', tipoConta: 'USUARIO', matricula: ' M1 ', setor: ' RH ', horarioTrabalho: null, ipsPermitidos: [], grupoAcessoId: null });
    assert.equal(r.success, true, JSON.stringify(r.error?.issues));
    assert.deepEqual(r.data, { nome: 'Ana', email: 'ana@example.invalid', tipoConta: 'USUARIO', matricula: 'M1', setor: 'RH', horarioTrabalho: null, ipsPermitidos: [], grupoAcessoId: null });
  });
  test('CPF, senha, empresa, perfil, identidade e ativo nunca entram; corpo vazio é ALTERACAO_VAZIA; formatos inválidos recusados', () => {
    for (const extra of [{ cpf: '52998224725' }, { senhaProvisoria: 'x'.repeat(14) }, { empresaId: 1 }, { perfil: 'MASTER' }, { identidadeId: 1 }, { ativo: false }]) {
      assert.equal(ok(s.alterar.body, { nome: 'Ana', ...extra }).success, false, JSON.stringify(extra));
    }
    assert.ok(codigos(ok(s.alterar.body, {})).includes('ALTERACAO_VAZIA'));
    assert.ok(campos(ok(s.alterar.body, { setor: '  ' })).includes('setor'));
    assert.ok(campos(ok(s.alterar.body, { ipsPermitidos: ['10.0.0.0/8'] })).includes('ipsPermitidos.0'));
    assert.ok(campos(ok(s.alterar.body, { horarioTrabalho: { inicio: '8', fim: '18:00' } })).includes('horarioTrabalho.inicio'));
    assert.equal(ok(s.alterar.body, { grupoAcessoId: 0 }).success, false);
  });
});

describe('redefinir senha, permissões e copiar', () => {
  test('senha: só senhaProvisoria; confirmação e outros campos recusados', () => {
    assert.equal(ok(s.redefinirSenha.body, { senhaProvisoria: 'girassol-quartzo-bussola-58' }).success, true);
    assert.equal(ok(s.redefinirSenha.body, { senhaProvisoria: 'x', confirmacao: 'x' }).success, false);
    assert.equal(ok(s.redefinirSenha.body, { senhaProvisoria: '' }).success, false);
  });
  test('permissões de recurso: tri-state por operação, ao menos uma; de ação: só os três estados; copiar: origemId inteiro positivo', () => {
    assert.equal(ok(s.permissoesRecurso.body, { visualizar: true, criar: null, editar: false }).success, true);
    assert.ok(codigos(ok(s.permissoesRecurso.body, {})).includes('ALTERACAO_VAZIA'));
    assert.equal(ok(s.permissoesRecurso.body, { visualizar: 'sim' }).success, false);
    assert.equal(ok(s.permissoesRecurso.body, { admin: true }).success, false);
    for (const e of ['PADRAO', 'CONCEDIDA', 'BLOQUEADA']) assert.equal(ok(s.permissoesAcao.body, { estado: e }).success, true, e);
    assert.equal(ok(s.permissoesAcao.body, { estado: 'TALVEZ' }).success, false);
    assert.equal(ok(s.permissoesAcao.params, { id: '3', codigo: 'MOVIMENTAR_ESTOQUE' }).success, true);
    assert.equal(ok(s.permissoesAcao.params, { id: '3', codigo: "x'; DROP" }).success, false);
    assert.equal(ok(s.permissoesRecurso.params, { id: '3', recurso: 'materials' }).success, true);
    assert.equal(ok(s.permissoesRecurso.params, { id: '3', recurso: '../x' }).success, false);
    assert.equal(ok(s.permissoesCopiar.body, { origemId: 4 }).success, true);
    for (const ruim of [{ origemId: 0 }, { origemId: '4' }, {}, { origemId: 4, perfil: 'MASTER' }]) assert.equal(ok(s.permissoesCopiar.body, ruim).success, false, JSON.stringify(ruim));
  });
  test('duplicar: usuarioModeloId opcional e inteiro positivo no criar', () => {
    const base = { nome: 'A', email: 'a@example.invalid', tipoConta: 'USUARIO', senhaProvisoria: 'girassol-quartzo-bussola-58', cpf: '52998224725', matricula: 'M', setor: 'S' };
    assert.equal(ok(s.criar.body, { ...base, usuarioModeloId: 7 }).success, true);
    assert.equal(ok(s.criar.body, { ...base, usuarioModeloId: 0 }).success, false);
  });
});
