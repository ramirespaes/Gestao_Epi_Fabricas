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
    encerramento: s.encerradaPor === null
      ? null
      : { encerradaPor: s.encerradaPor, encerradaEm: s.encerradaEm, justificativa: s.justificativaEncerramento },
    situacaoOperacional,
  };
}

// Na solicitação encerrada nada mais fica pendente: a entregue é a das entregas e o resto foi liberado.
function itemPublico(i, {
  situacao, quantidadeEntregue, cobertura, posicao, encerrada = false,
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
    quantidadePendente: i.decisao === 'APROVADO' ? (encerrada ? 0 : i.quantidadeAprovada - quantidadeEntregue) : null,
    situacao,
    cobertura: cobertura === null ? null : { ...cobertura },
    posicao: posicao === null ? null : { ...posicao },
  };
}

// Quem só pede (sem autoridade funcional) vê a própria solicitação sem a cobertura e a posição do estoque.
const itensSemEstoque = (itens) => itens.map(({ cobertura, posicao, ...item }) => item);

/**
 * Linha das listagens (12E-1): só identificação, situação, trabalhador sem CPF,
 * quantidades e carimbos. Nunca saem observação, justificativas, chave, hash,
 * empresa nem itens, mesmo que a linha recebida traga mais campos. A data do
 * encerramento entra só quando pedida ("minhas", 12F-1); a justificativa, nunca.
 */
function linhaDaLista(l, { situacaoOperacional, quantidades, comEncerramento = false }) {
  const encerramento = comEncerramento ? { encerradaEm: l.encerradaEm } : {};
  return {
    id: l.id,
    numero: l.numero,
    status: l.status,
    situacaoOperacional,
    solicitanteUsuarioId: l.solicitanteUsuarioId,
    funcionario: {
      id: l.funcionarioId, nome: l.trabalhador.nome, matricula: l.trabalhador.matricula, ativo: l.trabalhador.ativo,
    },
    quantidadeItens: l.quantidadeItens,
    quantidades: { ...quantidades },
    criadaEm: l.criadaEm,
    decididaEm: l.decididaEm,
    canceladaEm: l.canceladaEm,
    entregueEm: l.entregueEm,
    ...encerramento,
  };
}

module.exports = {
  solicitacaoPublica, itemPublico, itensSemEstoque, linhaDaLista,
};
