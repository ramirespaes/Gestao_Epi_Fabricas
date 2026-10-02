'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { lockDaChave } = require('../../src/utils/idempotencia');

/**
 * Trava lógica do par (empresa, material, tamanho): advisory lock de 64 bits
 * num espaço próprio. Serializa quem confere ou consome o saldo livre do par.
 * O tamanho ausente tem uma forma canônica só, igual à dos índices
 * (COALESCE(tamanho, '')): como o banco recusa tamanho vazio, ela não colide
 * com nenhum tamanho real.
 */

const util = () => exigirModulo('src/utils/lock-par-estoque');

const CHAVE = '3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c';
const referencia = (empresa, material, tamanhoCanonico) => crypto
  .createHash('sha256').update(`estoque_pares\n${empresa}\n${material}\n${tamanhoCanonico}`).digest().readBigInt64BE(0).toString();

describe('lockDoPar', () => {
  test('inteiro de 64 bits com sinal, em texto, derivado do espaço próprio, da empresa, do material e do tamanho', () => {
    const { lockDoPar, ESPACO_PARES_ESTOQUE } = util();
    assert.equal(ESPACO_PARES_ESTOQUE, 'estoque_pares');
    const lock = lockDoPar(42, 30, '40');
    assert.match(lock, /^-?\d{1,19}$/);
    assert.ok(BigInt(lock) >= -(2n ** 63n) && BigInt(lock) < 2n ** 63n);
    assert.equal(lock, referencia(42, 30, '40'));
    assert.equal(lock, lockDoPar(42, 30, '40'), 'determinístico');
  });

  test('o espaço é separado dos de idempotência: o sorteio de chaves dos outros domínios não o aceita', () => {
    const { ESPACO_PARES_ESTOQUE } = util();
    assert.throws(() => lockDaChave(ESPACO_PARES_ESTOQUE, 42, CHAVE), /espaço/);
    for (const existente of ['estoque_operacoes', 'entregas_epi', 'solicitacoes_epi']) {
      assert.notEqual(ESPACO_PARES_ESTOQUE, existente);
    }
  });

  test('empresas, materiais e tamanhos diferentes dão locks diferentes', () => {
    const { lockDoPar } = util();
    const base = lockDoPar(42, 30, '40');
    assert.notEqual(base, lockDoPar(43, 30, '40'));
    assert.notEqual(base, lockDoPar(42, 31, '40'));
    assert.notEqual(base, lockDoPar(42, 30, '41'));
    assert.notEqual(base, lockDoPar(42, 30, null));
  });

  test('tamanho ausente é um par próprio: não colide com nenhum tamanho real, nem com os que parecem vazios ou zero', () => {
    const { lockDoPar } = util();
    const semTamanho = lockDoPar(42, 30, null);
    assert.equal(semTamanho, referencia(42, 30, ''));
    for (const real of ['Único', '0', ' ', 'null', 'NULL', 'undefined']) {
      assert.notEqual(semTamanho, lockDoPar(42, 30, real), real);
    }
  });

  test('o separador evita ambiguidade entre os campos numéricos e o tamanho', () => {
    const { lockDoPar } = util();
    const locks = new Set([lockDoPar(1, 23, '4'), lockDoPar(12, 3, '4'), lockDoPar(1, 2, '34'), lockDoPar(123, 4, null), lockDoPar(1, 234, null)]);
    assert.equal(locks.size, 5);
  });

  test('recusa empresa, material e tamanho inválidos; tamanho é obrigatório (null quando o material não usa)', () => {
    const { lockDoPar } = util();
    for (const invalido of [0, -1, 1.5, '42', null, undefined]) {
      assert.throws(() => lockDoPar(invalido, 30, '40'), /empresa/, `empresa ${invalido}`);
      assert.throws(() => lockDoPar(42, invalido, '40'), /material/, `material ${invalido}`);
    }
    for (const invalido of ['', 'x'.repeat(21), 40, undefined, {}]) {
      assert.throws(() => lockDoPar(42, 30, invalido), /tamanho/, String(invalido));
    }
    assert.doesNotThrow(() => lockDoPar(42, 30, 'x'.repeat(20)));
    assert.doesNotThrow(() => lockDoPar(42, 30, '\u{1D400}'.repeat(20)), 'o limite conta caracteres, como o VARCHAR(20)');
  });
});

describe('parOrdenados', () => {
  const par = (materialId, tamanho) => ({ materialId, tamanho });

  test('ordena por material e depois por tamanho (ausente primeiro, os demais em ordem de código), sem repetir', () => {
    const { parOrdenados } = util();
    const ordenados = parOrdenados([par(31, 'M'), par(30, '9'), par(30, null), par(30, '10'), par(31, 'G'), par(30, '9'), par(31, 'GG'), par(30, 'Único')]);
    assert.deepEqual(ordenados, [
      par(30, null), par(30, '10'), par(30, '9'), par(30, 'Único'), par(31, 'G'), par(31, 'GG'), par(31, 'M'),
    ]);
  });

  test('o resultado não depende da ordem de entrada: toda permutação dá a mesma sequência (é o que impede deadlock entre transações)', () => {
    const { parOrdenados } = util();
    const conjunto = [par(30, '40'), par(30, null), par(31, '41'), par(29, 'M')];
    const permutacoes = (lista) => (lista.length <= 1 ? [lista] : lista.flatMap((item, i) => permutacoes([...lista.slice(0, i), ...lista.slice(i + 1)]).map((resto) => [item, ...resto])));
    const esperado = parOrdenados(conjunto);
    const todas = permutacoes(conjunto);
    assert.equal(todas.length, 24);
    for (const entrada of todas) assert.deepEqual(parOrdenados(entrada), esperado);
  });

  test('devolve objetos novos, sem alterar a entrada; vazio devolve vazio', () => {
    const { parOrdenados } = util();
    const entrada = [par(31, '41'), par(30, '40')];
    const copia = JSON.parse(JSON.stringify(entrada));
    const saida = parOrdenados(entrada);
    assert.deepEqual(entrada, copia);
    assert.notEqual(saida[0], entrada[1]);
    assert.deepEqual(parOrdenados([]), []);
  });

  test('recusa o que não é lista de pares válidos', () => {
    const { parOrdenados } = util();
    assert.throws(() => parOrdenados('x'), /pares/);
    assert.throws(() => parOrdenados(null), /pares/);
    assert.throws(() => parOrdenados([par(0, '40')]), /material/);
    assert.throws(() => parOrdenados([par(30, '')]), /tamanho/);
    assert.throws(() => parOrdenados([{ materialId: 30 }]), /tamanho/);
    assert.throws(() => parOrdenados([null]), /par/);
  });
});
