'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { HttpError } = require('../../src/errors/HttpError');
const { MOTIVOS_BAIXA } = require('../../src/schemas/estoque.schema');

/**
 * Regra do saldo livre (12C-3), a parte que não precisa de banco.
 *
 * Por empresa, material e tamanho (o par): U = físico utilizável, D = demanda
 * aprovada pendente, C = min(U, D) comprometido, L = max(0, U − D) livre e
 * G = max(0, D − U) sem cobertura. A entrega DIRETA e a baixa discricionária
 * não podem consumir o comprometido; o evento físico (avaria, perda,
 * descarte, ajuste de inventário, CA vencido) nunca é recusado por reserva,
 * porque a realidade física não se recusa.
 */

const regra = () => exigirModulo('src/services/saldo-livre');

const posicao = (U, D, extra = {}) => ({
  materialId: 30,
  tamanho: '40',
  fisicoUtilizavel: U,
  demandaPendente: D,
  comprometido: Math.min(U, D),
  saldoLivre: Math.max(0, U - D),
  semCobertura: Math.max(0, D - U),
  ...extra,
});

describe('classificação dos motivos da baixa', () => {
  test('eventos físicos e atos discricionários: duas classes fechadas, sem sobra nem sobreposição, que juntas são os motivos da baixa', () => {
    const { MOTIVOS_FISICOS, MOTIVOS_DISCRICIONARIOS } = regra();
    assert.deepEqual([...MOTIVOS_FISICOS], ['CA_VENCIDO', 'AVARIA', 'DESCARTE', 'PERDA', 'AJUSTE_INVENTARIO']);
    assert.deepEqual([...MOTIVOS_DISCRICIONARIOS], ['DEVOLUCAO_FORNECEDOR', 'OUTRO']);
    assert.ok(Object.isFrozen(MOTIVOS_FISICOS) && Object.isFrozen(MOTIVOS_DISCRICIONARIOS));
    assert.deepEqual([...MOTIVOS_FISICOS, ...MOTIVOS_DISCRICIONARIOS].sort(), [...MOTIVOS_BAIXA].sort());
    assert.equal(MOTIVOS_FISICOS.some((m) => MOTIVOS_DISCRICIONARIOS.includes(m)), false);
  });

  test('só DEVOLUCAO_FORNECEDOR e OUTRO são discricionários; qualquer outro valor não é', () => {
    const { ehMotivoDiscricionario } = regra();
    for (const motivo of ['DEVOLUCAO_FORNECEDOR', 'OUTRO']) assert.equal(ehMotivoDiscricionario(motivo), true, motivo);
    for (const motivo of ['CA_VENCIDO', 'AVARIA', 'DESCARTE', 'PERDA', 'AJUSTE_INVENTARIO', 'outro', '', null, undefined]) {
      assert.equal(ehMotivoDiscricionario(motivo), false, String(motivo));
    }
  });
});

describe('o erro e a identificação do evento', () => {
  test('SALDO_LIVRE_INSUFICIENTE é 409, com texto público genérico, e a recusa estruturada fica só no objeto de erro', () => {
    const { CODIGO, recusaPorSaldoLivre } = regra();
    assert.equal(CODIGO, 'SALDO_LIVRE_INSUFICIENTE');
    const recusas = [{ materialId: 30, tamanho: '40', quantidadeSolicitada: 4, fisicoUtilizavel: 5, demandaPendente: 2, comprometido: 2, saldoLivre: 3 }];
    const erro = recusaPorSaldoLivre({ operacao: 'ENTREGA_DIRETA', recusas });
    assert.ok(HttpError.ehHttpError(erro));
    assert.deepEqual([erro.status, erro.codigo], [409, 'SALDO_LIVRE_INSUFICIENTE']);
    assert.deepEqual(erro.recusa, { operacao: 'ENTREGA_DIRETA', recusas, loteId: null, motivo: null });
    const publico = erro.corpoResposta();
    assert.deepEqual(Object.keys(publico).sort(), ['codigo', 'message', 'status']);
    assert.doesNotMatch(JSON.stringify(publico), /demanda|comprometid|solicitac|\b30\b|\b5\b/i, 'nada sobre solicitações ou estoque de terceiros');
  });

  test('na baixa a recusa leva o lote e o motivo (valores estruturados, não texto livre)', () => {
    const { recusaPorSaldoLivre } = regra();
    const erro = recusaPorSaldoLivre({ operacao: 'BAIXA', recusas: [], loteId: 55, motivo: 'OUTRO' });
    assert.deepEqual([erro.recusa.operacao, erro.recusa.loteId, erro.recusa.motivo], ['BAIXA', 55, 'OUTRO']);
  });
});

describe('posição pública e perda de cobertura', () => {
  test('posicaoPublica só leva os cinco números', () => {
    const { posicaoPublica } = regra();
    assert.deepEqual(posicaoPublica(posicao(5, 2)), { fisicoUtilizavel: 5, demandaPendente: 2, comprometido: 2, saldoLivre: 3, semCobertura: 0 });
  });

  test('reduziuCobertura = o comprometido caiu, e não o físico: U10 D2 baixa 1 não reduz; U2 D2 baixa 1 reduz', () => {
    const { reduziuCobertura } = regra();
    assert.equal(reduziuCobertura(posicao(10, 2), posicao(9, 2)), false, 'caso H');
    assert.equal(reduziuCobertura(posicao(2, 2), posicao(1, 2)), true, 'caso I');
    assert.equal(reduziuCobertura(posicao(5, 2), posicao(2, 2)), false, 'consumir só o livre não reduz');
    assert.equal(reduziuCobertura(posicao(5, 2), posicao(1, 2)), true, 'consumir além do livre reduz');
    assert.equal(reduziuCobertura(posicao(0, 0), posicao(0, 0)), false);
    assert.equal(reduziuCobertura(posicao(3, 0), posicao(2, 0)), false, 'sem demanda não há cobertura para perder');
  });
});

describe('saldo livre agregado por par', () => {
  test('somarPorPar junta as quantidades do mesmo par, com tamanho ausente como um par só', () => {
    const { somarPorPar, chaveDoPar } = regra();
    const somas = somarPorPar([
      { materialId: 30, tamanho: '40', quantidade: 2 },
      { materialId: 30, tamanho: '40', quantidade: 2 },
      { materialId: 30, tamanho: '41', quantidade: 1 },
      { materialId: 31, tamanho: null, quantidade: 3 },
      { materialId: 31, tamanho: null, quantidade: 1 },
    ]);
    assert.equal(somas.size, 3);
    assert.equal(somas.get(chaveDoPar(30, '40')).quantidade, 4);
    assert.equal(somas.get(chaveDoPar(31, null)).quantidade, 4);
    assert.deepEqual(
      [...somas.values()].map((p) => [p.materialId, p.tamanho, p.quantidade]),
      [[30, '40', 4], [30, '41', 1], [31, null, 4]],
    );
  });

  test('recusasPorSaldoLivre: a soma do ato por par é que conta, nunca item a item (2 + 2 sobre livre 3)', () => {
    const { somarPorPar, recusasPorSaldoLivre } = regra();
    const itens = [{ materialId: 30, tamanho: '40', quantidade: 2 }, { materialId: 30, tamanho: '40', quantidade: 2 }];
    const recusas = recusasPorSaldoLivre([posicao(5, 2)], somarPorPar(itens));
    assert.deepEqual(recusas, [{ materialId: 30, tamanho: '40', quantidadeSolicitada: 4, fisicoUtilizavel: 5, demandaPendente: 2, comprometido: 2, saldoLivre: 3 }]);
  });

  test('o saldo livre exato passa (caso A: 3 sobre L3) e um acima recusa (caso B: 4 sobre L3)', () => {
    const { somarPorPar, recusasPorSaldoLivre } = regra();
    const pedido = (quantidade) => somarPorPar([{ materialId: 30, tamanho: '40', quantidade }]);
    assert.deepEqual(recusasPorSaldoLivre([posicao(5, 2)], pedido(3)), []);
    assert.equal(recusasPorSaldoLivre([posicao(5, 2)], pedido(4)).length, 1);
    assert.equal(recusasPorSaldoLivre([posicao(2, 2)], pedido(1)).length, 1, 'L0: nada do comprometido');
    assert.deepEqual(recusasPorSaldoLivre([posicao(3, 0)], pedido(3)), [], 'sem demanda todo o físico utilizável é livre');
  });

  test('vários pares: só os insuficientes recusam, na ordem dos pares recebidos', () => {
    const { somarPorPar, recusasPorSaldoLivre } = regra();
    const somas = somarPorPar([
      { materialId: 30, tamanho: '40', quantidade: 4 },
      { materialId: 31, tamanho: null, quantidade: 1 },
      { materialId: 32, tamanho: 'G', quantidade: 9 },
    ]);
    const posicoes = [posicao(5, 2), posicao(5, 0, { materialId: 31, tamanho: null }), posicao(5, 0, { materialId: 32, tamanho: 'G' })];
    assert.deepEqual(recusasPorSaldoLivre(posicoes, somas).map((r) => [r.materialId, r.quantidadeSolicitada, r.saldoLivre]), [[30, 4, 3], [32, 9, 5]]);
  });

  test('par sem posição conhecida é erro de programação, não um passe silencioso', () => {
    const { somarPorPar, recusasPorSaldoLivre } = regra();
    assert.throws(() => recusasPorSaldoLivre([], somarPorPar([{ materialId: 30, tamanho: '40', quantidade: 1 }])), TypeError);
  });
});
