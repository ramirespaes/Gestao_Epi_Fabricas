'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { calcularHashConteudo } = require('../../src/services/entrega-epi-comum');

/**
 * Classificação V2 (07/10/2026) — o grupo de proteção do material entra no conteúdo histórico da entrega SÓ quando
 * existe. Baseline calculada com o código anterior sobre uma entrega sintética fixa: a entrega sem grupo de proteção
 * (todo o histórico) continua byte a byte igual. Caracterização de calcularHashConteudo isolada; não prova persistência.
 */

const BASELINE = 'be948e21137ced677d217ffc18e0607c9d08d15507211a70fa648ebb0a290104';
const base = (extraItem) => ({
  entrega: {
    empresaId: 1, chaveIdempotencia: 'chave-1', origem: 'DIRETA', entregueEmCanonico: '2026-01-02T03:04:05.000Z', dataOperacional: '2026-01-02',
    empresa: { nome: 'Empresa', cnpj: '11222333000181', endereco: null, cidade: null, uf: null },
    trabalhador: { nome: 'Fulano', matricula: 'M-1', funcao: null, setor: null }, ghe: null, responsavel: { id: 2, nome: 'Resp' },
  },
  ficha: { numero: 1 },
  itens: [{
    materialId: 3, loteId: 4, lote: { tamanho: '40', caNumero: '123', caValidade: '2030-01-01' }, quantidade: 1, motivo: 'ADMISSAO', previstoNoGhe: true,
    material: { nome: 'Botina', unidade: 'par', prazoUsoDias: 90, exigeCa: true, ...extraItem },
  }],
  confirmacao: { modo: 'ACEITE_PRESENCIAL', declaracaoVersao: 'v', declaracaoTexto: 't' },
});

test('sem grupo de proteção (ausente ou null) o hash é a baseline: nenhuma entrega antiga muda', () => {
  assert.equal(calcularHashConteudo(base({})), BASELINE);
  assert.equal(calcularHashConteudo(base({ grupoProtecao: null })), BASELINE);
  assert.equal(calcularHashConteudo(base({ grupoProtecao: undefined })), BASELINE);
});

test('com grupo de proteção o hash muda, e é estável e determinístico', () => {
  const com = calcularHashConteudo(base({ grupoProtecao: 'Proteção ocular' }));
  assert.notEqual(com, BASELINE, 'o grupo de proteção faz parte do conteúdo quando existe');
  assert.equal(com, calcularHashConteudo(base({ grupoProtecao: 'Proteção ocular' })));
  assert.notEqual(com, calcularHashConteudo(base({ grupoProtecao: 'Proteção facial' })));
});
