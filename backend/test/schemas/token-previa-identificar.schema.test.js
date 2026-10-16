'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const schemas = require('../../src/schemas/token-central.schema');

/**
 * K7 — Consulta real da prévia do Totem (RED): contrato de entrada de POST /atendimento-token/previa/identificar. Mesma regra de
 * identificação do tablet (CPF só estrutura; matrícula do cadastro), em strictObject: empresa, ator, funcionário, GHE e qualquer outro
 * campo NUNCA vêm do cliente. Os valores usados aqui são fictícios (nenhum CPF real).
 */

const exigir = () => {
  assert.ok(schemas.previaIdentificar, 'RED K7: schemas.previaIdentificar ainda não existe (comportamento ausente)');
  return schemas.previaIdentificar;
};
const FICTICIO_CPF = '12345678901';
const corpo = (b) => exigir().body.safeParse(b);

describe('K7 — schema de previa/identificar', () => {
  test('aceita matrícula e CPF (estrutura), com o tipo explícito', () => {
    assert.equal(corpo({ tipo: 'MATRICULA', valor: 'M-1001' }).success, true);
    assert.equal(corpo({ tipo: 'CPF', valor: FICTICIO_CPF }).success, true);
    assert.equal(corpo({ tipo: 'CPF', valor: '123.456.789-01' }).success, true, 'pontuação opcional, como no tablet');
  });

  test('recusa campo extra: empresa, funcionário, GHE, ator e cpf/matricula soltos nunca vêm do cliente', () => {
    for (const extra of [{ empresaId: 1 }, { funcionarioId: 2 }, { gheId: 3 }, { usuarioId: 4 }, { cpf: FICTICIO_CPF }, { matricula: 'M-1' }]) {
      assert.equal(corpo({ tipo: 'MATRICULA', valor: 'M-1', ...extra }).success, false, JSON.stringify(Object.keys(extra)));
    }
  });

  test('recusa tipo desconhecido ou ausente, valor ausente, vazio ou fora do formato', () => {
    for (const ruim of [
      {}, { valor: 'M-1' }, { tipo: 'MATRICULA' }, { tipo: 'NOME', valor: 'Ana' }, { tipo: 'MATRICULA', valor: '' }, { tipo: 'MATRICULA', valor: 'x'.repeat(31) },
      { tipo: 'MATRICULA', valor: 1001 }, { tipo: 'CPF', valor: '1234567890' }, { tipo: 'CPF', valor: '1234567890a' }, { tipo: 'CPF', valor: '123456789012' },
    ]) {
      assert.equal(corpo(ruim).success, false, JSON.stringify(ruim));
    }
  });

  test('a query é estrita e vazia', () => {
    assert.equal(exigir().query.safeParse({}).success, true);
    assert.equal(exigir().query.safeParse({ funcionarioId: 1 }).success, false);
    assert.equal(exigir().query.safeParse({ cpf: FICTICIO_CPF }).success, false);
  });

  test('o erro de validação nunca repete o valor recebido', () => {
    const SEGREDO = 'VALOR-DIGITADO-QUE-NAO-PODE-VAZAR';
    for (const ruim of [{ tipo: 'MATRICULA', valor: SEGREDO.repeat(3) }, { tipo: 'CPF', valor: `${SEGREDO}` }, { tipo: SEGREDO, valor: 'x' }]) {
      const r = corpo(ruim);
      assert.equal(r.success, false);
      assert.equal(JSON.stringify(r.error.issues).includes(SEGREDO), false, JSON.stringify(ruim));
    }
  });

  test('os contratos da prévia por id e dos demais schemas da Central continuam como antes', () => {
    assert.ok(schemas.previa && schemas.visaoGeral && schemas.estadoAtivacao && schemas.listarRedes && schemas.cadastrarRede && schemas.desativarRede);
    assert.equal(schemas.previa.query.safeParse({ funcionarioId: '5' }).success, true, 'o id chega como texto na query');
  });
});
