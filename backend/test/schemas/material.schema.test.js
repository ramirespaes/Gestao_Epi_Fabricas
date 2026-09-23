'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const material = require('../../src/schemas/material.schema');

/**
 * Testes do schema de materiais (Bloco 9, Etapa A — correção pós-auditoria
 * de 23/09/2026). Cobre especificamente os dois pontos apontados pela
 * auditoria independente:
 *
 *   1. Validade do CA deve ser uma verificação ESTRITA de calendário —
 *      Date.parse() sozinho "rola" datas inexistentes para o próximo mês
 *      (2026-02-30 vira 2026-03-02) em vez de rejeitar.
 *   2. prazoUsoDias e estoqueMinimo não podem exceder o teto do tipo
 *      INTEGER do PostgreSQL (2147483647) — um valor maior chegaria ao
 *      banco e estouraria como erro não tratado (500), em vez de um 400
 *      de validação.
 */

function unica(resultado, esperado) {
  assert.equal(resultado.success, false);
  assert.equal(resultado.error.issues.length, 1);
  const issue = resultado.error.issues[0];
  assert.equal(issue.code, esperado.code);
  if (esperado.codigo !== undefined) {
    assert.equal(issue.params?.codigo, esperado.codigo);
  }
}

describe('caValidade — verificação estrita de calendário', () => {
  test('aceita datas reais, incluindo o último dia de meses de 31, 30 e fevereiro em ano bissexto', () => {
    for (const data of ['2026-01-31', '2026-04-30', '2024-02-29', '2000-02-29']) {
      const r = material.criar.body.safeParse({ nome: 'Botina', caValidade: data });
      assert.equal(r.success, true, `${data} deveria ser aceita`);
      assert.equal(r.data.caValidade, data);
    }
  });

  test('rejeita 30 de fevereiro (mês sem esse dia, em qualquer ano)', () => {
    unica(material.criar.body.safeParse({ nome: 'Botina', caValidade: '2026-02-30' }), { code: 'custom', codigo: 'CA_VALIDADE_INVALIDA' });
  });

  test('rejeita 29 de fevereiro em ano NÃO bissexto', () => {
    unica(material.criar.body.safeParse({ nome: 'Botina', caValidade: '2023-02-29' }), { code: 'custom', codigo: 'CA_VALIDADE_INVALIDA' });
  });

  test('rejeita 29 de fevereiro em ano múltiplo de 100 mas não de 400 (1900 não é bissexto)', () => {
    unica(material.criar.body.safeParse({ nome: 'Botina', caValidade: '1900-02-29' }), { code: 'custom', codigo: 'CA_VALIDADE_INVALIDA' });
  });

  test('aceita 29 de fevereiro em ano múltiplo de 400 (2000 é bissexto)', () => {
    const r = material.criar.body.safeParse({ nome: 'Botina', caValidade: '2000-02-29' });
    assert.equal(r.success, true);
  });

  test('rejeita 31 de abril (mês de 30 dias)', () => {
    unica(material.criar.body.safeParse({ nome: 'Botina', caValidade: '2026-04-31' }), { code: 'custom', codigo: 'CA_VALIDADE_INVALIDA' });
  });

  test('rejeita mês 13 e mês 00', () => {
    unica(material.criar.body.safeParse({ nome: 'Botina', caValidade: '2026-13-01' }), { code: 'custom', codigo: 'CA_VALIDADE_INVALIDA' });
    unica(material.criar.body.safeParse({ nome: 'Botina', caValidade: '2026-00-10' }), { code: 'custom', codigo: 'CA_VALIDADE_INVALIDA' });
  });

  test('rejeita dia 00 e dia 32', () => {
    unica(material.criar.body.safeParse({ nome: 'Botina', caValidade: '2026-01-00' }), { code: 'custom', codigo: 'CA_VALIDADE_INVALIDA' });
    unica(material.criar.body.safeParse({ nome: 'Botina', caValidade: '2026-01-32' }), { code: 'custom', codigo: 'CA_VALIDADE_INVALIDA' });
  });

  test('rejeita o ano 0000, mesmo com mês e dia válidos — ano mínimo é 1 (auditoria v2)', () => {
    unica(material.criar.body.safeParse({ nome: 'Botina', caValidade: '0000-01-01' }), { code: 'custom', codigo: 'CA_VALIDADE_INVALIDA' });
    unica(material.alterar.body.safeParse({ caValidade: '0000-01-01' }), { code: 'custom', codigo: 'CA_VALIDADE_INVALIDA' });
  });

  test('rejeita 0000-02-29: o ano 0 seria "bissexto" pela aritmética (0 % 400 === 0), mas o ano mínimo é 1 (auditoria v2)', () => {
    unica(material.criar.body.safeParse({ nome: 'Botina', caValidade: '0000-02-29' }), { code: 'custom', codigo: 'CA_VALIDADE_INVALIDA' });
    unica(material.alterar.body.safeParse({ caValidade: '0000-02-29' }), { code: 'custom', codigo: 'CA_VALIDADE_INVALIDA' });
  });

  test('aceita o ano 0001, o menor permitido', () => {
    const r = material.criar.body.safeParse({ nome: 'Botina', caValidade: '0001-01-01' });
    assert.equal(r.success, true);
    assert.equal(r.data.caValidade, '0001-01-01');
  });

  test('rejeita formato fora de YYYY-MM-DD', () => {
    unica(material.criar.body.safeParse({ nome: 'Botina', caValidade: '15/08/2026' }), { code: 'custom', codigo: 'CA_VALIDADE_INVALIDA' });
    unica(material.criar.body.safeParse({ nome: 'Botina', caValidade: '2026-8-15' }), { code: 'custom', codigo: 'CA_VALIDADE_INVALIDA' });
  });

  test('null explícito é aceito (limpa o campo em alterar)', () => {
    const r = material.alterar.body.safeParse({ caValidade: null });
    assert.equal(r.success, true);
    assert.equal(r.data.caValidade, null);
  });
});

describe('prazoUsoDias e estoqueMinimo — teto do INTEGER do PostgreSQL', () => {
  test('aceita exatamente o teto do INTEGER (2147483647)', () => {
    const r = material.criar.body.safeParse({ nome: 'Botina', prazoUsoDias: 2147483647, estoqueMinimo: 2147483647 });
    assert.equal(r.success, true);
  });

  test('rejeita prazoUsoDias acima do teto do INTEGER', () => {
    const r = material.criar.body.safeParse({ nome: 'Botina', prazoUsoDias: 2147483648 });
    assert.equal(r.success, false);
  });

  test('rejeita estoqueMinimo acima do teto do INTEGER', () => {
    const r = material.criar.body.safeParse({ nome: 'Botina', estoqueMinimo: 9999999999 });
    assert.equal(r.success, false);
  });
});
