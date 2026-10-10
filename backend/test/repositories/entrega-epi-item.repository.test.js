'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * Contrato do item da entrega de EPI (entregas_epi_itens) na parte que a 12C
 * acrescenta: o vínculo com o item da solicitação. O vínculo nasce no INSERT
 * (a tabela só aceita INSERT), é nulo na entrega DIRETA e volta no mapeamento
 * e na leitura. As regras (empresa, material, tamanho, trabalhador, aprovado,
 * pendente) são do banco, provadas na integração; aqui confiro SQL, parâmetros
 * e mapeamento, e que a entrega DIRETA grava como antes.
 */

const repo = () => exigirModulo('src/repositories/entrega-epi-item.repository');

const EMPRESA = 7;
const MATERIAL = { nome: 'Botina', tipo: null, codigoInterno: null, unidade: 'par', prazoUsoDias: 180, oculosComGrau: null, exigeCa: true };

const executorFalso = (...respostas) => {
  const chamadas = [];
  return {
    chamadas,
    query: async (texto, valores) => {
      chamadas.push({ texto, valores });
      return { rows: respostas.length > 0 ? respostas.shift() : [] };
    },
  };
};

const linha = (extra = {}) => ({
  id: 21, empresa_id: EMPRESA, entrega_id: 11, material_id: 30, lote_id: 5, quantidade: 2, motivo: 'ADMISSAO', justificativa: null,
  previsto_no_ghe: true, justificativa_fora_ghe: null, material_nome: 'Botina', material_tipo: null, material_codigo_interno: null,
  material_unidade: 'par', material_prazo_uso_dias: 180, material_oculos_com_grau: null, material_exige_ca: true, solicitacao_item_id: null, ...extra,
});

const novo = (extra = {}) => ({
  empresaId: EMPRESA, entregaId: 11, materialId: 30, loteId: 5, quantidade: 2, motivo: 'ADMISSAO', previstoNoGhe: true, material: MATERIAL, ...extra,
});

describe('criar — vínculo com o item da solicitação', () => {
  test('sem vínculo (entrega DIRETA) grava solicitacao_item_id nulo, como parâmetro, e o item volta com solicitacaoItemId nulo', async () => {
    const executor = executorFalso([linha()]);
    const item = await repo().criar(executor, novo());
    assert.equal(item.solicitacaoItemId, null);
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /^INSERT INTO entregas_epi_itens\b/);
    assert.match(texto.split('VALUES')[0], /solicitacao_item_id/);
    assert.equal(valores.length, 18);
    assert.equal(valores[16], null);
    assert.equal(valores[17], null, 'material_grupo_protecao (V2): nulo sem classificação, como parâmetro');
    assert.deepEqual(valores.slice(0, 7), [EMPRESA, 11, 30, 5, 2, 'ADMISSAO', null], 'os 16 valores de antes seguem nas mesmas posições');
  });

  test('com vínculo grava o id do item da solicitação e o devolve', async () => {
    const executor = executorFalso([linha({ solicitacao_item_id: 88 })]);
    const item = await repo().criar(executor, novo({ solicitacaoItemId: 88 }));
    assert.equal(item.solicitacaoItemId, 88);
    assert.equal(executor.chamadas[0].valores[16], 88);
  });

  test('vínculo inválido é recusado antes de consultar', async () => {
    const executor = executorFalso();
    for (const solicitacaoItemId of [0, -1, 1.5, '88', {}, NaN]) {
      await assert.rejects(() => repo().criar(executor, novo({ solicitacaoItemId })), /solicitação/, String(solicitacaoItemId));
    }
    assert.equal(executor.chamadas.length, 0);
  });

  test('a validação que já existia continua: quantidade, motivo e cópia do material', async () => {
    const executor = executorFalso();
    await assert.rejects(() => repo().criar(executor, novo({ quantidade: 0 })), /quantidade/);
    await assert.rejects(() => repo().criar(executor, novo({ motivo: 'OUTRA' })), /motivo/);
    await assert.rejects(() => repo().criar(executor, novo({ material: { ...MATERIAL, exigeCa: 'sim' } })), /material/);
    assert.equal(executor.chamadas.length, 0);
  });
});

describe('leitura — o vínculo volta junto do item', () => {
  test('listarPorEntrega e listarPorEntregas trazem solicitacaoItemId; DIRETA volta nulo, SOLICITACAO volta o id', async () => {
    const lida = (extra) => linha({ tamanho: '40', ca_numero: '123', ca_validade: '2099-12-31', operacao_id: '900', ...extra });
    const executor = executorFalso([lida({ id: 21 }), lida({ id: 22, solicitacao_item_id: 88 })], [lida({ id: 22, solicitacao_item_id: 88 })]);
    const doIndividual = await repo().listarPorEntrega(executor, EMPRESA, 11);
    assert.deepEqual(doIndividual.map((i) => [i.id, i.solicitacaoItemId]), [[21, null], [22, 88]]);
    const deVarias = await repo().listarPorEntregas(executor, EMPRESA, [11, 12]);
    assert.deepEqual(deVarias.map((i) => [i.id, i.solicitacaoItemId]), [[22, 88]]);
    for (const { texto } of executor.chamadas) assert.match(texto.split('FROM')[0], /i\.solicitacao_item_id/);
  });
});
