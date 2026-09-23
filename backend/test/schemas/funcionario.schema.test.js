'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const f = require('../../src/schemas/funcionario.schema');

/** Schema de funcionários (Bloco 9, Etapa B). Nenhum campo de usuário do sistema. */

const base = { matricula: 'MAT-000171', nome: 'Marcos Silva', cpf: '529.982.247-25' };

describe('criar', () => {
  test('CPF com máscara sai normalizado (11 dígitos) e com DV conferido', () => {
    const r = f.criar.body.safeParse(base);
    assert.equal(r.success, true);
    assert.equal(r.data.cpf, '52998224725');
  });

  test('CPF com DV inválido: CPF_DV_INVALIDO; estrutura inválida: CPF_INVALIDO', () => {
    const dv = f.criar.body.safeParse({ ...base, cpf: '529.982.247-26' });
    assert.equal(dv.success, false);
    assert.equal(dv.error.issues[0].params.codigo, 'CPF_DV_INVALIDO');

    const estrutura = f.criar.body.safeParse({ ...base, cpf: '123' });
    assert.equal(estrutura.success, false);
    assert.equal(estrutura.error.issues[0].params.codigo, 'CPF_INVALIDO');
  });

  test('dataNascimento usa calendário estrito (30/fev, ano 0000 recusados; bissexto real aceito)', () => {
    assert.equal(f.criar.body.safeParse({ ...base, dataNascimento: '2024-02-29' }).success, true);
    for (const data of ['2023-02-29', '2026-02-30', '0000-01-01', '15/03/1990']) {
      const r = f.criar.body.safeParse({ ...base, dataNascimento: data });
      assert.equal(r.success, false, data);
      assert.equal(r.error.issues[0].params.codigo, 'DATA_NASCIMENTO_INVALIDA');
    }
  });

  test('grupoHomogeneoId aceita inteiro positivo ou null; recusa 0, negativo e string', () => {
    assert.equal(f.criar.body.safeParse({ ...base, grupoHomogeneoId: 50 }).success, true);
    assert.equal(f.criar.body.safeParse({ ...base, grupoHomogeneoId: null }).success, true);
    for (const ruim of [0, -1, '50']) {
      assert.equal(f.criar.body.safeParse({ ...base, grupoHomogeneoId: ruim }).success, false, String(ruim));
    }
  });

  test('campos de usuário do sistema e campos internos são recusados', () => {
    for (const chave of ['email', 'senha', 'perfil', 'usuarioId', 'id', 'empresaId', 'ativo']) {
      const r = f.criar.body.safeParse({ ...base, [chave]: 'x' });
      assert.equal(r.success, false, chave);
      assert.equal(r.error.issues[0].code, 'unrecognized_keys');
    }
  });
});

describe('alterar / listar', () => {
  test('alterar: todos opcionais; null limpa; conteúdo inválido devolve o código do campo', () => {
    assert.equal(f.alterar.body.safeParse({}).success, true);
    assert.deepEqual(f.alterar.body.safeParse({ grupoHomogeneoId: null, telefone: null }).data, { grupoHomogeneoId: null, telefone: null });
    const r = f.alterar.body.safeParse({ cracha: 'x'.repeat(31) });
    assert.equal(r.success, false);
    assert.equal(r.error.issues[0].params.codigo, 'CRACHA_INVALIDO');
  });

  test('alterar: cpf NÃO faz parte do contrato — igual ou diferente, é chave não reconhecida (CPF imutável após o cadastro)', () => {
    for (const corpo of [
      { cpf: '529.982.247-25' },
      { cpf: '52998224725' },
      { cpf: '111.444.777-35' },
      { nome: 'Marcos S.', cpf: '529.982.247-25' },
    ]) {
      const r = f.alterar.body.safeParse(corpo);
      assert.equal(r.success, false, JSON.stringify(Object.keys(corpo)));
      assert.equal(r.error.issues.length, 1, 'uma única issue: a chave, não o valor');
      assert.equal(r.error.issues[0].code, 'unrecognized_keys');
      assert.deepEqual(r.error.issues[0].keys, ['cpf']);
    }
  });

  test('criar continua exigindo cpf (a imutabilidade não muda a criação)', () => {
    const r = f.criar.body.safeParse({ matricula: 'MAT-000171', nome: 'Marcos Silva' });
    assert.equal(r.success, false);
    assert.deepEqual(r.error.issues[0].path, ['cpf']);
  });

  test('listar: grupoHomogeneoId em query chega como string decimal canônica', () => {
    const r = f.listar.query.safeParse({ grupoHomogeneoId: '50', busca: 'silva' });
    assert.equal(r.success, true);
    assert.deepEqual(r.data, { pagina: 1, limite: 20, grupoHomogeneoId: 50, busca: 'silva' });
    assert.equal(f.listar.query.safeParse({ grupoHomogeneoId: '0' }).success, false);
  });
});
