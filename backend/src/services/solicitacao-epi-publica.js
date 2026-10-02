'use strict';

/**
 * Forma pública da solicitação de EPI: só o que a tela e as demais camadas
 * precisam. Nunca saem a chave de idempotência, o hash da requisição nem a
 * empresa da sessão. Pendente, cobertura e posição são derivados e chegam de
 * fora; nada é gravado por aqui.
 */

function solicitacaoPublica(s, situacaoOperacional) {
  return {
    id: s.id,
    numero: s.numero,
    status: s.status,
    origemSolicitacao: s.origemSolicitacao,
    solicitanteUsuarioId: s.solicitanteUsuarioId,
    funcionarioId: s.funcionarioId,
    gheId: s.gheId,
    quantidadeItens: s.quantidadeItens,
    observacao: s.observacao,
    criadaEm: s.criadaEm,
    decisao: s.decididaPor === null ? null : { decididaPor: s.decididaPor, decididaEm: s.decididaEm },
    cancelamento: s.canceladaPor === null
      ? null
      : { canceladaPor: s.canceladaPor, canceladaEm: s.canceladaEm, justificativa: s.justificativaCancelamento },
    entregueEm: s.entregueEm,
    situacaoOperacional,
  };
}

function itemPublico(i, {
  situacao, quantidadeEntregue, cobertura, posicao,
}) {
  return {
    id: i.id,
    materialId: i.materialId,
    tamanho: i.tamanho,
    quantidade: i.quantidade,
    motivo: i.motivo,
    justificativa: i.justificativa,
    previstoNoGhe: i.previstoNoGhe,
    decisao: i.decisao,
    quantidadeAprovada: i.quantidadeAprovada,
    justificativaDecisao: i.justificativaDecisao,
    quantidadeEntregue,
    quantidadePendente: i.decisao === 'APROVADO' ? i.quantidadeAprovada - quantidadeEntregue : null,
    situacao,
    cobertura: cobertura === null ? null : { ...cobertura },
    posicao: posicao === null ? null : { ...posicao },
  };
}

module.exports = { solicitacaoPublica, itemPublico };
