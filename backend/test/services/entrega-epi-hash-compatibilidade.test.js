'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');
const direta = require('../../src/services/entrega-epi.service');

/**
 * Hash de conteúdo histórico da entrega (060) e hash da requisição, com a
 * entrega por solicitação (12C-2).
 *
 * A DIRETA mantém o cálculo byte a byte: os valores abaixo foram calculados
 * com o código da 12C-1 (antes de qualquer alteração da 12C-2) e congelados.
 * Se um deles mudar, uma entrega DIRETA gravada deixou de ser verificável.
 *
 * Na entrega SOLICITACAO o vínculo com o item da solicitação entra no
 * conteúdo; só nela: o campo é omitido quando não há vínculo, e por isso a
 * DIRETA não muda.
 */

const GOLDEN = Object.freeze({
  conteudoUmItem: 'dfbeb34812bdc3055f21a5cbb46983e5127196aec921c77e7f503b38f3912606',
  conteudoDoisItensForaDoGhe: '462080bda6e402b417fdd9c6d89c667e1cff0463379d53ebf96a55e7d2018bdc',
  requisicaoDireta: '1aed46e5926c48f9e02d24f047f8f1d577e72b0580c42daec7acdbc42b912532',
  // Congelado na 12C-2: protege a tag ENTREGA_SOLICITACAO, a ordem canônica e os campos que entram na requisição.
  requisicaoSolicitacao: 'f460f5c2ec9b7649bac1f60abefd31c40b75d88c254b73c19cdfc2b91a48f359',
});

const entrega = {
  empresaId: 7,
  chaveIdempotencia: '3f6a2b1c-0d4e-4f5a-8b7c-9d0e1f2a3b4c',
  origem: 'DIRETA',
  entregueEmCanonico: '2026-10-02T15:00:00.123456Z',
  dataOperacional: '2026-10-02',
  empresa: { nome: 'Empresa Fictícia Ltda', cnpj: '11222333000181', endereco: 'Rua 1, 100', cidade: 'Cidade', uf: 'SP' },
  trabalhador: { nome: 'Trabalhador Fictício', matricula: 'M-1', funcao: 'Operador', setor: 'Produção' },
  ghe: { id: 2, nome: 'GHE Produção' },
  responsavel: { id: 9, nome: 'Responsável Fictício' },
};
const ficha = { numero: 3 };
const item = (extra = {}) => ({
  materialId: 30,
  loteId: 5,
  lote: { tamanho: '40', caNumero: '12345', caValidade: '2099-12-31' },
  quantidade: 2,
  motivo: 'ADMISSAO',
  justificativa: null,
  previstoNoGhe: true,
  justificativaForaGhe: null,
  material: { nome: 'Botina', tipo: null, codigoInterno: 'BOT-01', unidade: 'par', prazoUsoDias: 180, oculosComGrau: null, exigeCa: true },
  ...extra,
});
const itemSemGhe = () => item({
  materialId: 31,
  loteId: 6,
  lote: { tamanho: null, caNumero: null, caValidade: null },
  quantidade: 1,
  previstoNoGhe: false,
  justificativaForaGhe: 'Exceção técnica',
  material: { nome: 'Luva', tipo: null, codigoInterno: null, unidade: 'par', prazoUsoDias: 90, oculosComGrau: null, exigeCa: false },
});
const confirmacao = {
  modo: 'DESENHO',
  tracos: [[[10, 10], [20, 12]], [[40, 40]]],
  declaracaoVersao: 'NR6-2026-09',
  declaracaoTexto: 'Declaro que recebi os EPIs (texto fictício).',
};

const conteudo = (itens, extra = {}) => direta.calcularHashConteudo({ entrega: { ...entrega, ...extra }, ficha, itens, confirmacao });
const porSolicitacao = (itens) => conteudo(itens, { origem: 'SOLICITACAO' });

describe('hash de conteúdo — a entrega DIRETA fica byte a byte compatível', () => {
  test('os hashes calculados com o código da 12C-1 continuam os mesmos', () => {
    assert.equal(conteudo([item()]), GOLDEN.conteudoUmItem);
    assert.equal(conteudo([item(), itemSemGhe()]), GOLDEN.conteudoDoisItensForaDoGhe);
  });

  test('o vínculo nulo ou ausente não entra no conteúdo: o item lido do banco (solicitacaoItemId null) dá o mesmo hash', () => {
    assert.equal(conteudo([item({ solicitacaoItemId: null })]), GOLDEN.conteudoUmItem);
    assert.equal(conteudo([item({ solicitacaoItemId: undefined })]), GOLDEN.conteudoUmItem);
    assert.equal(conteudo([item({ solicitacaoItemId: null }), itemSemGhe()]), GOLDEN.conteudoDoisItensForaDoGhe);
  });

  test('o hash da requisição DIRETA não mudou', () => {
    assert.equal(direta.hashDaRequisicao({
      funcionarioId: 11,
      itens: [{ materialId: 30, loteId: 5, quantidade: 2, motivo: 'ADMISSAO', justificativa: null, justificativaForaGhe: null }],
      confirmacao: { modo: 'ACEITE_PRESENCIAL', tracos: null, declaracaoVersao: 'NR6-2026-09', declaracaoTexto: 'Declaro que recebi os EPIs (texto fictício).' },
    }), GOLDEN.requisicaoDireta);
  });
});

describe('hash de conteúdo — o vínculo da entrega SOLICITACAO participa', () => {
  test('a origem SOLICITACAO e o vínculo mudam o hash em relação à DIRETA', () => {
    const base = conteudo([item()]);
    assert.notEqual(porSolicitacao([item({ solicitacaoItemId: 88 })]), base);
  });

  test('mudar somente solicitacaoItemId muda o hash da entrega SOLICITACAO', () => {
    const a = porSolicitacao([item({ solicitacaoItemId: 88 })]);
    const b = porSolicitacao([item({ solicitacaoItemId: 89 })]);
    assert.notEqual(a, b);
    assert.match(a, /^[0-9a-f]{64}$/);
  });

  test('o vínculo de cada item conta: com dois itens, trocar o vínculo de um deles muda o hash', () => {
    const a = porSolicitacao([item({ solicitacaoItemId: 88 }), { ...itemSemGhe(), solicitacaoItemId: 90 }]);
    const b = porSolicitacao([item({ solicitacaoItemId: 88 }), { ...itemSemGhe(), solicitacaoItemId: 91 }]);
    assert.notEqual(a, b);
  });

  test('o mesmo conteúdo ligado ao mesmo item dá sempre o mesmo hash', () => {
    assert.equal(porSolicitacao([item({ solicitacaoItemId: 88 })]), porSolicitacao([item({ solicitacaoItemId: 88 })]));
  });

  test('sem vínculo a entrega SOLICITACAO difere da mesma com vínculo (o vínculo não é opcional no conteúdo dela)', () => {
    assert.notEqual(porSolicitacao([item()]), porSolicitacao([item({ solicitacaoItemId: 88 })]));
  });
});

describe('hash da requisição da entrega por solicitação', () => {
  const servico = () => exigirModulo('src/services/entrega-solicitacao.service');
  const pedido = (extra = {}) => ({
    solicitacaoId: 17,
    itens: [{ solicitacaoItemId: 5, loteId: 11, quantidade: 2 }, { solicitacaoItemId: 5, loteId: 12, quantidade: 1 }, { solicitacaoItemId: 6, loteId: 13, quantidade: 4 }],
    confirmacao: { modo: 'ACEITE_PRESENCIAL', tracos: null, declaracaoVersao: 'NR6-2026-09', declaracaoTexto: 'Declaro que recebi os EPIs (texto fictício).' },
    ...extra,
  });

  test('é um sha-256 em hexadecimal, estável e com a tag própria: nunca coincide com a requisição DIRETA', () => {
    const hash = servico().hashDaRequisicao(pedido());
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.equal(servico().hashDaRequisicao(pedido()), hash);
    assert.notEqual(hash, GOLDEN.requisicaoDireta);
  });

  test('o valor congelado: tag, ordem canônica e campos não mudam sem querer (uma mudança aqui quebra a repetição idempotente de entregas já feitas)', () => {
    assert.equal(servico().hashDaRequisicao(pedido()), GOLDEN.requisicaoSolicitacao);
    assert.equal(servico().hashDaRequisicao(pedido({ itens: [...pedido().itens].reverse() })), GOLDEN.requisicaoSolicitacao);
  });

  test('a ordem dos itens não importa: a mesma entrega lógica vira a mesma requisição', () => {
    const embaralhada = pedido({ itens: [...pedido().itens].reverse() });
    assert.equal(servico().hashDaRequisicao(embaralhada), servico().hashDaRequisicao(pedido()));
  });

  test('solicitação, item da solicitação, lote, quantidade e confirmação mudam o hash', () => {
    const base = servico().hashDaRequisicao(pedido());
    const mudancas = [
      pedido({ solicitacaoId: 18 }),
      pedido({ itens: [{ solicitacaoItemId: 7, loteId: 11, quantidade: 2 }, ...pedido().itens.slice(1)] }),
      pedido({ itens: [{ solicitacaoItemId: 5, loteId: 99, quantidade: 2 }, ...pedido().itens.slice(1)] }),
      pedido({ itens: [{ solicitacaoItemId: 5, loteId: 11, quantidade: 3 }, ...pedido().itens.slice(1)] }),
      pedido({ confirmacao: { ...pedido().confirmacao, declaracaoVersao: 'NR6-2026-10' } }),
      pedido({ confirmacao: { modo: 'DESENHO', tracos: [[[1, 1]]], declaracaoVersao: 'NR6-2026-09', declaracaoTexto: pedido().confirmacao.declaracaoTexto } }),
    ];
    for (const mudanca of mudancas) assert.notEqual(servico().hashDaRequisicao(mudanca), base);
  });

  test('só entra o que o chamador informa: nada que o servidor deriva (trabalhador, material, motivo) nem metadados técnicos', () => {
    const base = servico().hashDaRequisicao(pedido());
    const comExtras = servico().hashDaRequisicao({
      ...pedido(), funcionarioId: 99, materialId: 123, motivo: 'OUTRO', ip: '203.0.113.10', dispositivo: 'X', atorId: 9, empresaId: 7,
    });
    assert.equal(comExtras, base);
  });
});
