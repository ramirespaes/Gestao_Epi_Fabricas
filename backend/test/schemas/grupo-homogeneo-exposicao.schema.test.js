'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const ghe = require('../../src/schemas/grupo-homogeneo-exposicao.schema');

/** Schema de GHE (Bloco 9, Etapa B). */
describe('criar / alterar', () => {
  test('nome obrigatório e aparado; opcionais aceitam null; campos internos são recusados', () => {
    const ok = ghe.criar.body.safeParse({ nome: '  Manutenção  ', setor: null, riscos: 'Ruído' });
    assert.equal(ok.success, true);
    assert.deepEqual(ok.data, { nome: 'Manutenção', setor: null, riscos: 'Ruído' });

    const semNome = ghe.criar.body.safeParse({ setor: 'X' });
    assert.equal(semNome.success, false);

    for (const interno of ['id', 'empresaId', 'ativo', 'criadoEm']) {
      const r = ghe.criar.body.safeParse({ nome: 'X', [interno]: 1 });
      assert.equal(r.success, false, interno);
      assert.equal(r.error.issues[0].code, 'unrecognized_keys');
    }
  });

  test('codigo é campo reconhecido: só o tipo é checado aqui (a regra é do serviço); o nulo só passa no PATCH', () => {
    assert.deepEqual(ghe.criar.body.parse({ nome: 'X', codigo: ' ghe-1 ' }), { nome: 'X', codigo: ' ghe-1 ' });
    assert.equal(ghe.criar.body.safeParse({ nome: 'X' }).success, true, 'a ausência é decidida pelo serviço (GHE_CODIGO_OBRIGATORIO)');
    assert.equal(ghe.criar.body.safeParse({ nome: 'X', codigo: null }).success, false);
    assert.equal(ghe.alterar.body.safeParse({ codigo: null }).success, true);
    for (const codigo of [123, {}, [], ['GHE-001'], true]) {
      for (const schema of [ghe.criar.body, ghe.alterar.body]) {
        const r = schema.safeParse({ nome: 'X', codigo });
        assert.equal(r.success, false);
        assert.equal(r.error.issues[0].code, 'invalid_type', JSON.stringify(codigo));
      }
    }
  });

  test('conteúdo inválido em opcional nullable devolve o código do campo, não invalid_union', () => {
    const r = ghe.alterar.body.safeParse({ setor: 'x'.repeat(101) });
    assert.equal(r.success, false);
    assert.equal(r.error.issues[0].code, 'custom');
    assert.equal(r.error.issues[0].params.codigo, 'SETOR_INVALIDO');
  });

  test('alterar aceita corpo vazio no schema (a regra "algo precisa mudar" é do serviço)', () => {
    assert.equal(ghe.alterar.body.safeParse({}).success, true);
  });
});

describe('listar / inativar', () => {
  test('query com paginação padrão, ativo e busca', () => {
    const r = ghe.listar.query.safeParse({ ativo: 'false', busca: 'manu' });
    assert.equal(r.success, true);
    assert.deepEqual(r.data, { pagina: 1, limite: 20, ativo: false, busca: 'manu' });
  });

  test('inativar/reativar recusam qualquer campo no corpo', () => {
    assert.equal(ghe.inativar.body.safeParse({}).success, true);
    assert.equal(ghe.reativar.body.safeParse({ ativo: true }).success, false);
  });
});
