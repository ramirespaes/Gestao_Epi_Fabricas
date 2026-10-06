'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const schemas = require('../../src/schemas/usuario-administracao.schema');

/**
 * Criação direta de usuário na Gestão de Usuários: corpo estrito com nome,
 * e-mail (login real da identidade), tipo de conta e SENHA PROVISÓRIA. A
 * empresa vem da sessão e nunca do corpo; perfil do ator, grupo, situação
 * e identidade não entram.
 */

// Usuário ADMINISTRATIVO (05/10/2026): CPF, matrícula e setor obrigatórios; horário, IPs e grupo opcionais.
const VALIDO = {
  nome: 'Pessoa Nova', email: 'Pessoa.Nova@Example.invalid', tipoConta: 'USUARIO', senhaProvisoria: 'planeta-nebulosa-ozonio-42',
  cpf: '529.982.247-25', matricula: ' ADM-001 ', setor: 'Recursos Humanos',
};
const codigos = (r) => r.error.issues.map((i) => i.params?.codigo ?? i.message);
const caminhos = (r) => r.error.issues.map((i) => i.path.join('.'));

describe('schema: criação direta de usuário (POST /administracao/usuarios)', () => {
  test('corpo válido: e-mail normalizado, CPF canônico, matrícula e setor aparados; opcionais ausentes não aparecem; a senha não é transformada', () => {
    const r = schemas.criar.body.safeParse(VALIDO);
    assert.equal(r.success, true, JSON.stringify(r.error?.issues));
    assert.deepEqual(r.data, {
      nome: 'Pessoa Nova', email: 'pessoa.nova@example.invalid', tipoConta: 'USUARIO', senhaProvisoria: 'planeta-nebulosa-ozonio-42',
      cpf: '52998224725', matricula: 'ADM-001', setor: 'Recursos Humanos',
    });
  });

  test('opcionais: horário de trabalho (HH:MM, os dois), IPs permitidos (IPv4/IPv6 normalizados, até 20) e grupo (id positivo)', () => {
    const r = schemas.criar.body.safeParse({ ...VALIDO, horarioTrabalho: { inicio: '08:00', fim: '18:00' }, ipsPermitidos: ['203.0.113.10', '2001:0DB8::0010', '::ffff:198.51.100.7'], grupoAcessoId: 4 });
    assert.equal(r.success, true, JSON.stringify(r.error?.issues));
    assert.deepEqual([r.data.horarioTrabalho, r.data.ipsPermitidos, r.data.grupoAcessoId], [{ inicio: '08:00', fim: '18:00' }, ['203.0.113.10', '2001:db8::10', '198.51.100.7'], 4]);
    assert.equal(schemas.criar.body.safeParse({ ...VALIDO, horarioTrabalho: null, ipsPermitidos: [] }).success, true);
    // Código null: issue nativa do Zod (obrigatório, chave extra, tamanho), que o middleware traduz.
    for (const [extra, caminho, codigo] of [
      [{ horarioTrabalho: { inicio: '08:00' } }, 'horarioTrabalho.fim', null],
      [{ horarioTrabalho: { inicio: '8:00', fim: '18:00' } }, 'horarioTrabalho.inicio', 'HORARIO_INVALIDO'],
      [{ horarioTrabalho: { inicio: '08:00', fim: '24:00' } }, 'horarioTrabalho.fim', 'HORARIO_INVALIDO'],
      [{ horarioTrabalho: { inicio: '08:00', fim: '18:00', extra: 1 } }, 'horarioTrabalho', null],
      [{ ipsPermitidos: ['203.0.113.0/24'] }, 'ipsPermitidos.0', 'IP_INVALIDO'],
      [{ ipsPermitidos: ['localhost'] }, 'ipsPermitidos.0', 'IP_INVALIDO'],
      [{ ipsPermitidos: Array.from({ length: 21 }, (_, i) => `203.0.113.${i + 1}`) }, 'ipsPermitidos', null],
      [{ grupoAcessoId: 0 }, 'grupoAcessoId', null],
      [{ grupoAcessoId: '4' }, 'grupoAcessoId', null],
    ]) {
      const r2 = schemas.criar.body.safeParse({ ...VALIDO, ...extra });
      assert.equal(r2.success, false, JSON.stringify(extra));
      assert.ok(caminhos(r2).includes(caminho), `${JSON.stringify(extra)}: ${JSON.stringify(caminhos(r2))}`);
      if (codigo) assert.ok(codigos(r2).includes(codigo), `${JSON.stringify(extra)}: ${JSON.stringify(codigos(r2))}`);
    }
  });

  test('CPF, matrícula e setor: obrigatórios, com código próprio; CPF com dígitos verificadores errados é recusado', () => {
    for (const campo of ['cpf', 'matricula', 'setor']) {
      const corpo = { ...VALIDO };
      delete corpo[campo];
      const r = schemas.criar.body.safeParse(corpo);
      assert.equal(r.success, false, campo);
      assert.ok(caminhos(r).includes(campo), campo);
    }
    assert.ok(codigos(schemas.criar.body.safeParse({ ...VALIDO, cpf: '529.982.247-26' })).some((c) => /^CPF_/.test(c)), 'DV errado');
    assert.ok(codigos(schemas.criar.body.safeParse({ ...VALIDO, cpf: '11111111111' })).some((c) => /^CPF_/.test(c)), 'todos iguais');
    assert.ok(codigos(schemas.criar.body.safeParse({ ...VALIDO, cpf: '1234' })).some((c) => /^CPF_/.test(c)), 'curto');
    assert.ok(codigos(schemas.criar.body.safeParse({ ...VALIDO, matricula: '   ' })).includes('MATRICULA_INVALIDA'));
    assert.ok(codigos(schemas.criar.body.safeParse({ ...VALIDO, matricula: 'M'.repeat(31) })).includes('MATRICULA_INVALIDA'));
    assert.ok(codigos(schemas.criar.body.safeParse({ ...VALIDO, setor: '' })).includes('SETOR_INVALIDO'));
    assert.ok(codigos(schemas.criar.body.safeParse({ ...VALIDO, setor: 'S'.repeat(101) })).includes('SETOR_INVALIDO'));
  });

  test('estrito: empresaId, perfil, identidadeId, ativo, senha (nome antigo) e confirmação de senha são recusados', () => {
    for (const extra of [{ empresaId: 1 }, { perfil: 'MASTER' }, { identidadeId: 3 }, { ativo: false }, { senha: 'x' }, { confirmarSenhaProvisoria: VALIDO.senhaProvisoria }, { funcionarioId: 1 }]) {
      const r = schemas.criar.body.safeParse({ ...VALIDO, ...extra });
      assert.equal(r.success, false, JSON.stringify(extra));
    }
  });

  test('obrigatórios: sem nome, e-mail, tipo de conta ou senha provisória falha com código próprio', () => {
    for (const campo of ['nome', 'email', 'tipoConta', 'senhaProvisoria']) {
      const corpo = { ...VALIDO };
      delete corpo[campo];
      assert.equal(schemas.criar.body.safeParse(corpo).success, false, campo);
    }
    assert.ok(codigos(schemas.criar.body.safeParse({ ...VALIDO, email: 'sem-arroba' })).includes('EMAIL_INVALIDO'));
    assert.ok(codigos(schemas.criar.body.safeParse({ ...VALIDO, nome: '' })).includes('NOME_INVALIDO'));
    assert.ok(codigos(schemas.criar.body.safeParse({ ...VALIDO, senhaProvisoria: '' })).includes('SENHA_VAZIA'));
    assert.ok(codigos(schemas.criar.body.safeParse({ ...VALIDO, senhaProvisoria: 'x'.repeat(1025) })).includes('SENHA_MUITO_LONGA'));
    assert.equal(schemas.criar.body.safeParse({ ...VALIDO, tipoConta: 'GERENTE' }).success, false);
  });

  test('os quatro tipos de conta reais são aceitos pelo schema (a regra de quem pode criar qual é do serviço)', () => {
    for (const tipoConta of ['MASTER', 'ADMINISTRADOR', 'SUPERVISOR', 'USUARIO']) {
      assert.equal(schemas.criar.body.safeParse({ ...VALIDO, tipoConta }).success, true, tipoConta);
    }
  });
});
