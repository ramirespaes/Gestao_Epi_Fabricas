'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { calcularHashConteudo } = require('../../src/services/entrega-epi-comum');

/**
 * 12K-E — a matrícula opcional não pode mudar o hash de entregas antigas. Os valores esperados foram
 * calculados com o código ANTERIOR à mudança, sobre uma entrega sintética fixa.
 */

const base = (matricula) => ({
  entrega: {
    empresaId: 1,
    chaveIdempotencia: 'chave-1',
    origem: 'DIRETA',
    entregueEmCanonico: '2026-01-02T03:04:05.000Z',
    dataOperacional: '2026-01-02',
    empresa: { nome: 'Empresa', cnpj: '11222333000181', endereco: null, cidade: null, uf: null },
    trabalhador: { nome: 'Fulano', matricula, funcao: null, setor: null },
    ghe: null,
    responsavel: { id: 2, nome: 'Resp' },
  },
  ficha: { numero: 1 },
  itens: [{
    materialId: 3,
    loteId: 4,
    lote: { tamanho: '40', caNumero: '123', caValidade: '2030-01-01' },
    quantidade: 1,
    motivo: 'ADMISSAO',
    previstoNoGhe: true,
    material: { nome: 'Botina', unidade: 'par', prazoUsoDias: 90, exigeCa: true },
  }],
  confirmacao: { modo: 'ACEITE_PRESENCIAL', declaracaoVersao: 'v', declaracaoTexto: 't' },
});

test('o hash de uma entrega com matrícula continua byte a byte o de antes', () => {
  assert.equal(calcularHashConteudo(base('M-1')), 'be948e21137ced677d217ffc18e0607c9d08d15507211a70fa648ebb0a290104');
});

test('o hash de uma entrega sem matrícula (NULL) é estável e diferente do de quem tem matrícula', () => {
  assert.equal(calcularHashConteudo(base(null)), 'ff54a63476a779aef68106eb922c81c2bd8e0bfd894cf144555bb0d032fcf127');
  assert.notEqual(calcularHashConteudo(base(null)), calcularHashConteudo(base('M-1')));
});
