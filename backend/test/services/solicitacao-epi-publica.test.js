'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * Forma pública da solicitação de EPI: só o que a tela e as demais camadas
 * precisam. Nunca saem a chave de idempotência nem o hash da requisição. Os
 * números derivados (pendente, cobertura, posição) vêm de fora e nada é
 * gravado por aqui.
 */

const modulo = () => exigirModulo('src/services/solicitacao-epi-publica');

const CRIADA = new Date('2026-10-02T12:00:00Z');
const DECIDIDA = new Date('2026-10-02T13:00:00Z');

const cabecalho = (extra = {}) => ({
  id: 17, empresaId: 42, numero: 5, funcionarioId: 30, gheId: 9, origemSolicitacao: 'USUARIO_INTERNO', solicitanteUsuarioId: 11,
  status: 'PENDENTE', quantidadeItens: 2, observacao: 'Admissão', chaveIdempotencia: '3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c',
  requisicaoHash: 'a'.repeat(64), criadaEm: CRIADA, decididaPor: null, decididaEm: null, canceladaPor: null, canceladaEm: null,
  justificativaCancelamento: null, entregueEm: null, ...extra,
});
const itemGravado = (extra = {}) => ({
  id: 1, empresaId: 42, solicitacaoId: 17, materialId: 30, tamanho: '40', quantidade: 4, motivo: 'ADMISSAO', justificativa: null,
  previstoNoGhe: true, decisao: null, quantidadeAprovada: null, justificativaDecisao: null, ...extra,
});

describe('solicitacaoPublica', () => {
  test('PENDENTE: cabeçalho sem decisão nem cancelamento; sem empresa, chave nem hash', () => {
    const { solicitacaoPublica } = modulo();
    const publica = solicitacaoPublica(cabecalho(), null);
    assert.deepEqual(publica, {
      id: 17, numero: 5, status: 'PENDENTE', origemSolicitacao: 'USUARIO_INTERNO', solicitanteUsuarioId: 11, funcionarioId: 30, gheId: 9,
      quantidadeItens: 2, observacao: 'Admissão', criadaEm: CRIADA, decisao: null, cancelamento: null, entregueEm: null, situacaoOperacional: null,
    });
    for (const proibida of ['chaveIdempotencia', 'requisicaoHash', 'empresaId']) assert.equal(proibida in publica, false, proibida);
  });

  test('decidida: quem e quando; situação operacional recebida', () => {
    const { solicitacaoPublica } = modulo();
    const publica = solicitacaoPublica(cabecalho({ status: 'APROVADA', decididaPor: 12, decididaEm: DECIDIDA }), 'AGUARDANDO_ESTOQUE');
    assert.deepEqual(publica.decisao, { decididaPor: 12, decididaEm: DECIDIDA });
    assert.equal(publica.situacaoOperacional, 'AGUARDANDO_ESTOQUE');
    assert.equal(publica.cancelamento, null);
  });

  test('cancelada: quem, quando e a justificativa', () => {
    const { solicitacaoPublica } = modulo();
    const publica = solicitacaoPublica(cabecalho({ status: 'CANCELADA', canceladaPor: 11, canceladaEm: DECIDIDA, justificativaCancelamento: 'Duplicada' }), null);
    assert.deepEqual(publica.cancelamento, { canceladaPor: 11, canceladaEm: DECIDIDA, justificativa: 'Duplicada' });
    assert.equal(publica.decisao, null);
  });
});

describe('itemPublico', () => {
  test('item pendente de decisão: sem pendente, situação, cobertura nem posição', () => {
    const { itemPublico } = modulo();
    const publico = itemPublico(itemGravado(), { situacao: null, quantidadeEntregue: 0, cobertura: null, posicao: null });
    assert.deepEqual(publico, {
      id: 1, materialId: 30, tamanho: '40', quantidade: 4, motivo: 'ADMISSAO', justificativa: null, previstoNoGhe: true, decisao: null,
      quantidadeAprovada: null, justificativaDecisao: null, quantidadeEntregue: 0, quantidadePendente: null, situacao: null, cobertura: null, posicao: null,
    });
    assert.equal('empresaId' in publico, false);
    assert.equal('solicitacaoId' in publico, false);
  });

  test('item aprovado: o pendente é a aprovada menos a entregue, e cobertura e posição saem como recebidas', () => {
    const { itemPublico } = modulo();
    const cobertura = { coberta: 1, semCobertura: 2, acumuladoAnterior: 3, fisicoUtilizavel: 4 };
    const posicao = { fisicoUtilizavel: 4, demandaPendente: 6, comprometido: 4, saldoLivre: 0, semCobertura: 2 };
    const publico = itemPublico(
      itemGravado({ decisao: 'APROVADO', quantidadeAprovada: 3, justificativaDecisao: 'Reduzida' }),
      { situacao: 'PARCIALMENTE_COBERTA', quantidadeEntregue: 0, cobertura, posicao },
    );
    assert.equal(publico.quantidadePendente, 3);
    assert.equal(publico.situacao, 'PARCIALMENTE_COBERTA');
    assert.deepEqual(publico.cobertura, cobertura);
    assert.deepEqual(publico.posicao, posicao);
    assert.notEqual(publico.cobertura, cobertura, 'cópia, não a mesma referência');
  });

  test('item reprovado: pendente nulo', () => {
    const { itemPublico } = modulo();
    const publico = itemPublico(
      itemGravado({ decisao: 'REPROVADO', quantidadeAprovada: 0, justificativaDecisao: 'Sem necessidade' }),
      { situacao: null, quantidadeEntregue: 0, cobertura: null, posicao: null },
    );
    assert.equal(publico.quantidadePendente, null);
  });
});
