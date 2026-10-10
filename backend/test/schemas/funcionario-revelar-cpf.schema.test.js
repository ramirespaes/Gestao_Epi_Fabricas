'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const f = require('../../src/schemas/funcionario.schema');

/**
 * Revelação do CPF na edição (RED): `POST /api/funcionarios/:id/cpf/revelar`. O corpo é um objeto vazio ESTRITO — empresa e
 * ator vêm só da sessão — e o id da URL é um inteiro positivo.
 */

const alvo = new Proxy({}, {
  get: (_, parte) => {
    assert.ok(f.revelarCpf, 'o schema revelarCpf ainda não existe');
    return f.revelarCpf[parte];
  },
});

describe('revelarCpf.params', () => {
  test('aceita id inteiro positivo (texto da URL vira número)', () => {
    const r = alvo.params.safeParse({ id: '70' });
    assert.equal(r.success, true);
    assert.equal(r.data.id, 70);
  });

  test('recusa id zero, negativo, decimal, texto e vazio, e campo extra no caminho', () => {
    for (const id of ['0', '-1', '1.5', 'abc', '', '1e3', ' 7']) {
      assert.equal(alvo.params.safeParse({ id }).success, false, `id ${JSON.stringify(id)}`);
    }
    assert.equal(alvo.params.safeParse({ id: '7', empresaId: '1' }).success, false);
  });
});

describe('revelarCpf.body', () => {
  test('aceita só o objeto vazio', () => {
    assert.equal(alvo.body.safeParse({}).success, true);
  });

  test('recusa qualquer campo: empresaId, usuarioId, identidadeId, funcionarioId, cpf e outro desconhecido', () => {
    for (const campo of ['empresaId', 'usuarioId', 'identidadeId', 'funcionarioId', 'cpf', 'finalidade', 'qualquerCoisa']) {
      assert.equal(alvo.body.safeParse({ [campo]: 1 }).success, false, campo);
      assert.equal(alvo.body.safeParse({ [campo]: '52998224725' }).success, false, `${campo} texto`);
    }
  });

  test('a query também é vazia e estrita: empresa e CPF nunca vêm pela URL', () => {
    assert.equal(alvo.query.safeParse({}).success, true);
    for (const campo of ['empresaId', 'usuarioId', 'cpf', 'x']) {
      assert.equal(alvo.query.safeParse({ [campo]: '1' }).success, false, campo);
    }
  });

  test('recusa corpo que não seja objeto', () => {
    for (const corpo of [null, [], 'x', 7, undefined]) {
      assert.equal(alvo.body.safeParse(corpo).success, false, JSON.stringify(corpo));
    }
  });
});
