'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { HttpError } = require('../../src/errors/HttpError');

/**
 * Contrato de entrada do serviço da entrega por solicitação (12C-2), só a
 * parte que não precisa de banco: a validação acontece antes de abrir a
 * transação. O comportamento com PostgreSQL real (travas, cobertura FIFO,
 * ficha, estoque, confirmação, auditoria e fechamento) está na integração.
 *
 * O chamador informa o mínimo: empresa e ator (da sessão), a solicitação, a
 * chave de idempotência, os itens (item da solicitação, lote e quantidade) e
 * a confirmação. Trabalhador, material, tamanho, motivo, justificativas,
 * previsão no GHE e GHE vêm da solicitação e das relações persistidas, e por
 * isso o serviço recusa qualquer um deles no item.
 */

const servico = () => exigirModulo('src/services/entrega-solicitacao.service');

const poolProibido = () => ({
  connect: async () => { throw new Error('a validação de entrada tem de recusar antes de abrir a transação'); },
});

const CONFIRMACAO = {
  modo: 'ACEITE_PRESENCIAL',
  declaracaoVersao: 'NR6-2026-09',
  declaracaoTexto: 'Declaro que recebi os EPIs relacionados e fui orientado sobre o uso correto (texto fictício).',
};
const dados = (extra = {}) => ({
  empresaId: 7,
  atorId: 9,
  solicitacaoId: 17,
  itens: [{ solicitacaoItemId: 5, loteId: 11, quantidade: 2 }],
  confirmacao: CONFIRMACAO,
  chaveIdempotencia: crypto.randomUUID(),
  ...extra,
});
const registrar = (extra) => servico().registrarEntregaPorSolicitacao(poolProibido(), dados(extra));

async function esperarValidacao(promessa, campo, codigo) {
  await assert.rejects(promessa, (erro) => {
    assert.ok(HttpError.ehHttpError(erro), `esperado HttpError, veio ${erro && erro.name}: ${erro && erro.message}`);
    assert.deepEqual([erro.status, erro.codigo], [400, 'VALIDACAO']);
    assert.ok(erro.detalhes.some((d) => d.campo === campo && d.codigo === codigo), JSON.stringify(erro.detalhes));
    for (const detalhe of erro.detalhes) {
      assert.deepEqual(Object.keys(detalhe).sort(), ['campo', 'codigo', 'mensagem'], 'o erro não devolve o valor recebido');
    }
    return true;
  });
}

describe('identificadores da sessão e da solicitação', () => {
  test('empresa, ator e solicitação inválidos são erro de programação (TypeError), sem abrir transação', async () => {
    for (const extra of [{ empresaId: 0 }, { empresaId: '7' }, { atorId: -1 }, { atorId: null }, { solicitacaoId: 1.5 }, { solicitacaoId: undefined }]) {
      await assert.rejects(() => registrar(extra), TypeError, JSON.stringify(extra));
    }
  });
});

describe('chave de idempotência e itens', () => {
  test('a chave precisa ser um UUID', async () => {
    for (const chaveIdempotencia of [undefined, null, '', 'abc', 123, '3f6a2b1c-0d4e-4f5a-8b7c']) {
      await esperarValidacao(registrar({ chaveIdempotencia }), 'body.chaveIdempotencia', 'FORMATO_INVALIDO');
    }
  });

  test('de 1 a 20 itens (itens do ato: um por lote)', async () => {
    const um = { solicitacaoItemId: 5, loteId: 11, quantidade: 1 };
    for (const itens of [undefined, null, 'x', {}, []]) {
      await esperarValidacao(registrar({ itens }), 'body.itens', 'ITENS_FORA_DO_LIMITE');
    }
    const vinteEUm = Array.from({ length: 21 }, (_, i) => ({ ...um, loteId: 100 + i }));
    await esperarValidacao(registrar({ itens: vinteEUm }), 'body.itens', 'ITENS_FORA_DO_LIMITE');
  });

  test('cada item é um objeto com solicitacaoItemId, loteId e quantidade inteiros positivos', async () => {
    const base = { solicitacaoItemId: 5, loteId: 11, quantidade: 2 };
    await esperarValidacao(registrar({ itens: [null] }), 'body.itens[0]', 'FORMATO_INVALIDO');
    await esperarValidacao(registrar({ itens: [[1, 2, 3]] }), 'body.itens[0]', 'FORMATO_INVALIDO');
    await esperarValidacao(registrar({ itens: ['x'] }), 'body.itens[0]', 'FORMATO_INVALIDO');
    for (const solicitacaoItemId of [0, -1, 1.5, '5', null, undefined]) {
      await esperarValidacao(registrar({ itens: [{ ...base, solicitacaoItemId }] }), 'body.itens[0].solicitacaoItemId', 'FORMATO_INVALIDO');
    }
    for (const loteId of [0, -3, 2.5, '11', null, undefined]) {
      await esperarValidacao(registrar({ itens: [{ ...base, loteId }] }), 'body.itens[0].loteId', 'FORMATO_INVALIDO');
    }
  });

  test('a quantidade é inteira positiva e cabe no INTEGER do PostgreSQL', async () => {
    const base = { solicitacaoItemId: 5, loteId: 11 };
    for (const quantidade of [0, -1, 1.5, '2', null, undefined, 2147483648, Number.NaN]) {
      await esperarValidacao(registrar({ itens: [{ ...base, quantidade }] }), 'body.itens[0].quantidade', 'QUANTIDADE_INVALIDA');
    }
  });

  test('o mesmo lote duas vezes na entrega é recusado, também para o mesmo item (a 058 permite um item por lote)', async () => {
    const mesmoLote = [{ solicitacaoItemId: 5, loteId: 11, quantidade: 1 }, { solicitacaoItemId: 5, loteId: 11, quantidade: 1 }];
    await esperarValidacao(registrar({ itens: mesmoLote }), 'body.itens', 'LOTE_REPETIDO');
    const outroItem = [{ solicitacaoItemId: 5, loteId: 11, quantidade: 1 }, { solicitacaoItemId: 6, loteId: 11, quantidade: 1 }];
    await esperarValidacao(registrar({ itens: outroItem }), 'body.itens', 'LOTE_REPETIDO');
  });
});

describe('o que o servidor deriva não vem do chamador', () => {
  test('trabalhador, material, tamanho, motivo, justificativas, previsão no GHE, GHE e empresa no item são recusados, sem ecoar o valor', async () => {
    const proibidos = [
      'funcionarioId', 'materialId', 'tamanho', 'motivo', 'justificativa', 'previstoNoGhe', 'justificativaForaGhe', 'gheId', 'empresaId', 'solicitacaoId',
    ];
    for (const campo of proibidos) {
      const itens = [{ solicitacaoItemId: 5, loteId: 11, quantidade: 2, [campo]: 'texto-do-cliente-que-nao-pode-voltar' }];
      await assert.rejects(() => registrar({ itens }), (erro) => {
        assert.ok(HttpError.ehHttpError(erro));
        assert.deepEqual([erro.status, erro.codigo], [400, 'VALIDACAO']);
        assert.ok(erro.detalhes.some((d) => d.campo === `body.itens[0].${campo}` && d.codigo === 'CAMPO_NAO_PERMITIDO'), campo);
        assert.doesNotMatch(JSON.stringify(erro.detalhes), /texto-do-cliente/);
        return true;
      }, campo);
    }
  });
});

describe('confirmação', () => {
  test('a mesma validação da entrega DIRETA: modo, traços e declaração', async () => {
    await esperarValidacao(registrar({ confirmacao: null }), 'body.confirmacao', 'FORMATO_INVALIDO');
    await esperarValidacao(registrar({ confirmacao: { ...CONFIRMACAO, modo: 'ASSINATURA' } }), 'body.confirmacao.modo', 'VALOR_NAO_PERMITIDO');
    await esperarValidacao(registrar({ confirmacao: { ...CONFIRMACAO, modo: 'DESENHO' } }), 'body.confirmacao.tracos', 'TRACOS_OBRIGATORIOS');
    await esperarValidacao(registrar({ confirmacao: { ...CONFIRMACAO, tracos: [[[1, 1]]] } }), 'body.confirmacao.tracos', 'TRACOS_NAO_SE_APLICAM');
    await esperarValidacao(registrar({ confirmacao: { ...CONFIRMACAO, declaracaoVersao: 'x' } }), 'body.confirmacao.declaracaoVersao', 'FORMATO_INVALIDO');
    await esperarValidacao(registrar({ confirmacao: { ...CONFIRMACAO, declaracaoTexto: '' } }), 'body.confirmacao.declaracaoTexto', 'DECLARACAO_INVALIDA');
  });
});

describe('exports', () => {
  test('expõe o serviço e o hash da requisição, e o limite de itens é o da entrega', () => {
    assert.equal(typeof servico().registrarEntregaPorSolicitacao, 'function');
    assert.equal(typeof servico().hashDaRequisicao, 'function');
    assert.equal(servico().LIMITE_ITENS, 20);
  });
});
