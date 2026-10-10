'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  SITUACOES, TRANSICOES, situacaoDe, exigirPodeReceberEpi, exigirNaoInativo,
} = require('../../src/utils/situacao-funcionario');

const recusa = (funcionario, funcao) => {
  try {
    funcao(funcionario);
  } catch (erro) {
    return [erro.status, erro.codigo, erro.message];
  }
  return null;
};

describe('situação funcional do funcionário (S2)', () => {
  test('as três situações e as cinco transições permitidas; INATIVO não vai direto a AFASTADO', () => {
    assert.deepEqual([...SITUACOES], ['ATIVO', 'AFASTADO', 'INATIVO']);
    assert.deepEqual(Object.fromEntries(Object.entries(TRANSICOES).map(([de, para]) => [de, [...para]])), {
      ATIVO: ['AFASTADO', 'INATIVO'], AFASTADO: ['ATIVO', 'INATIVO'], INATIVO: ['ATIVO'],
    });
    for (const situacao of SITUACOES) assert.equal(TRANSICOES[situacao].includes(situacao), false, `${situacao} → ${situacao}`);
  });

  test('situacaoDe: a coluna manda; sem ela, `ativo` cobre objetos antigos', () => {
    assert.equal(situacaoDe({ situacao: 'AFASTADO', ativo: false }), 'AFASTADO');
    assert.equal(situacaoDe({ ativo: true }), 'ATIVO');
    assert.equal(situacaoDe({ ativo: false }), 'INATIVO');
  });

  test('receber EPI: só ATIVO; AFASTADO e INATIVO têm código e texto próprios', () => {
    assert.equal(recusa({ situacao: 'ATIVO' }, exigirPodeReceberEpi), null);
    const afastado = recusa({ situacao: 'AFASTADO' }, exigirPodeReceberEpi);
    assert.deepEqual(afastado.slice(0, 2), [409, 'FUNCIONARIO_AFASTADO']);
    assert.match(afastado[2], /afastad/i);
    assert.doesNotMatch(afastado[2], /inativ/i);
    const inativo = recusa({ situacao: 'INATIVO' }, exigirPodeReceberEpi);
    assert.deepEqual(inativo.slice(0, 2), [409, 'FUNCIONARIO_INATIVO']);
    assert.match(inativo[2], /inativo/i);
  });

  test('decisão administrativa: só o INATIVO é recusado; o afastado pode ter o pedido decidido', () => {
    assert.equal(recusa({ situacao: 'ATIVO' }, exigirNaoInativo), null);
    assert.equal(recusa({ situacao: 'AFASTADO' }, exigirNaoInativo), null);
    assert.deepEqual(recusa({ situacao: 'INATIVO' }, exigirNaoInativo).slice(0, 2), [409, 'FUNCIONARIO_INATIVO']);
  });
});
