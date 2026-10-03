'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { lockDoPar } = require('../../src/utils/lock-par-estoque');
const { lockDaChave, ESPACO_ESTOQUE, ESPACO_ENTREGAS, ESPACO_SOLICITACOES } = require('../../src/utils/idempotencia');

/**
 * Identificação do evento e trava da supressão da auditoria de recusa por
 * saldo livre (12C-3). A janela é de 60 segundos por empresa, ator, tipo de
 * operação, material e tamanho. A trava é um advisory lock de transação de 64
 * bits em namespace PRÓPRIO: não pode ser o dos pares de estoque, para a
 * auditoria secundária nunca atrasar uma operação normal de estoque.
 */

const util = () => exigirModulo('src/utils/supressao-auditoria');

const limites64 = (valor) => BigInt(valor) >= -(2n ** 63n) && BigInt(valor) < 2n ** 63n;

describe('janela e operações', () => {
  test('a janela é de 60 segundos e as operações são ENTREGA_DIRETA e BAIXA, congeladas', () => {
    assert.equal(util().JANELA_SUPRESSAO_SEGUNDOS, 60);
    assert.deepEqual([...util().OPERACOES], ['ENTREGA_DIRETA', 'BAIXA']);
    assert.ok(Object.isFrozen(util().OPERACOES));
  });
});

describe('chaveDoEvento', () => {
  test('canônica e determinística: operação, material e tamanho; tamanho ausente é o texto vazio; cabe na referência de 150 caracteres', () => {
    const { chaveDoEvento } = util();
    assert.equal(chaveDoEvento('ENTREGA_DIRETA', 30, '40'), 'ENTREGA_DIRETA:30:40');
    assert.equal(chaveDoEvento('BAIXA', 30, null), 'BAIXA:30:');
    assert.equal(chaveDoEvento('BAIXA', 30, null), chaveDoEvento('BAIXA', 30, null));
    assert.ok(chaveDoEvento('ENTREGA_DIRETA', 2147483647, 'X'.repeat(20)).length <= 150);
  });

  test('cada componente muda a chave', () => {
    const { chaveDoEvento } = util();
    const base = chaveDoEvento('BAIXA', 30, '40');
    for (const outra of [chaveDoEvento('ENTREGA_DIRETA', 30, '40'), chaveDoEvento('BAIXA', 31, '40'), chaveDoEvento('BAIXA', 30, '41'), chaveDoEvento('BAIXA', 30, null)]) {
      assert.notEqual(outra, base);
    }
  });

  test('operação fora de ENTREGA_DIRETA e BAIXA, material e tamanho inválidos são erro de programação', () => {
    const { chaveDoEvento } = util();
    for (const operacao of ['ENTREGA', 'baixa', '', null, undefined]) assert.throws(() => chaveDoEvento(operacao, 30, '40'), TypeError, String(operacao));
    for (const material of [0, -1, 1.5, '30', null]) assert.throws(() => chaveDoEvento('BAIXA', material, '40'), TypeError, String(material));
    for (const tamanho of ['', 7, undefined, 'X'.repeat(21)]) assert.throws(() => chaveDoEvento('BAIXA', 30, tamanho), TypeError, String(tamanho));
  });
});

describe('lockDaSupressao', () => {
  test('64 bits em texto, determinístico, e diferente para cada empresa, ator, operação, material e tamanho', () => {
    const { lockDaSupressao, chaveDoEvento } = util();
    const evento = chaveDoEvento('BAIXA', 30, '40');
    const base = lockDaSupressao(1, 9, evento);
    assert.equal(typeof base, 'string');
    assert.ok(limites64(base));
    assert.equal(lockDaSupressao(1, 9, evento), base);
    const outros = [
      lockDaSupressao(2, 9, evento),
      lockDaSupressao(1, 10, evento),
      lockDaSupressao(1, 9, chaveDoEvento('ENTREGA_DIRETA', 30, '40')),
      lockDaSupressao(1, 9, chaveDoEvento('BAIXA', 31, '40')),
      lockDaSupressao(1, 9, chaveDoEvento('BAIXA', 30, '41')),
      lockDaSupressao(1, 9, chaveDoEvento('BAIXA', 30, null)),
    ];
    assert.equal(new Set([base, ...outros]).size, 7);
  });

  test('o separador evita ambiguidade: (1, 23) e (12, 3) não colidem', () => {
    const { lockDaSupressao, chaveDoEvento } = util();
    const evento = chaveDoEvento('BAIXA', 30, '40');
    assert.notEqual(lockDaSupressao(1, 23, evento), lockDaSupressao(12, 3, evento));
  });

  test('namespace próprio: nunca coincide com a trava do par nem com as de idempotência para os mesmos dados', () => {
    const { lockDaSupressao, chaveDoEvento } = util();
    const lock = lockDaSupressao(1, 9, chaveDoEvento('BAIXA', 30, '40'));
    assert.notEqual(lock, lockDoPar(1, 30, '40'));
    for (const espaco of [ESPACO_ESTOQUE, ESPACO_ENTREGAS, ESPACO_SOLICITACOES]) {
      assert.notEqual(lock, lockDaChave(espaco, 1, '3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c'));
    }
  });

  test('identificadores e evento inválidos são erro de programação', () => {
    const { lockDaSupressao } = util();
    for (const [empresa, ator, evento] of [[0, 9, 'BAIXA:30:40'], [1, 0, 'BAIXA:30:40'], [1.5, 9, 'BAIXA:30:40'], [1, 9, ''], [1, 9, 7], [1, 9, 'x'.repeat(151)]]) {
      assert.throws(() => lockDaSupressao(empresa, ator, evento), TypeError, JSON.stringify([empresa, ator, evento]));
    }
  });
});
