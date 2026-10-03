'use strict';

const { HttpError } = require('../errors/HttpError');
const { chaveDoTamanho } = require('../utils/lock-par-estoque');

/**
 * Regra do saldo livre (Modelo A, 12C-3). Por empresa, material e tamanho (o
 * par): U físico utilizável, D demanda aprovada pendente, C = min(U, D)
 * comprometido, L = max(0, U − D) livre, G = max(0, D − U) sem cobertura. Os
 * números vêm sempre da posição da cobertura (solicitacao-epi-cobertura.
 * repository), a única definição de "utilizável"; aqui só se decide com eles.
 *
 * A entrega DIRETA e a baixa discricionária só podem usar o livre. O evento
 * físico nunca é recusado por reserva: a realidade física se registra e a
 * cobertura se recalcula depois.
 */

const CODIGO = 'SALDO_LIVRE_INSUFICIENTE';
const MENSAGEM = 'Saldo livre insuficiente para esta operação';

// Fatos do mundo: o estoque já mudou, ou o CA já venceu. Recusar não os desfaz.
const MOTIVOS_FISICOS = Object.freeze(['CA_VENCIDO', 'AVARIA', 'DESCARTE', 'PERDA', 'AJUSTE_INVENTARIO']);
// Escolhas do operador: o estoque comprometido não pode ser o preço delas.
const MOTIVOS_DISCRICIONARIOS = Object.freeze(['DEVOLUCAO_FORNECEDOR', 'OUTRO']);

const ehMotivoDiscricionario = (motivo) => MOTIVOS_DISCRICIONARIOS.includes(motivo);

/**
 * 409 genérico. O que explica a recusa (par, posição, lote, motivo) fica em
 * `recusa`, só para a auditoria: corpoResposta() nunca o leva ao cliente.
 */
function recusaPorSaldoLivre({
  operacao, recusas, loteId = null, motivo = null,
}) {
  const erro = HttpError.conflict(CODIGO, MENSAGEM);
  erro.recusa = {
    operacao, recusas, loteId, motivo,
  };
  return erro;
}

const ehRecusaPorSaldoLivre = (erro) => HttpError.ehHttpError(erro) && erro.codigo === CODIGO && erro.recusa !== undefined;

const posicaoPublica = (p) => ({
  fisicoUtilizavel: p.fisicoUtilizavel,
  demandaPendente: p.demandaPendente,
  comprometido: p.comprometido,
  saldoLivre: p.saldoLivre,
  semCobertura: p.semCobertura,
});

// A cobertura se perdeu quando o comprometido caiu; a queda do físico sozinha não diz isso.
const reduziuCobertura = (antes, depois) => depois.comprometido < antes.comprometido;

const chaveDoPar = (materialId, tamanho) => `${materialId}\n${chaveDoTamanho(tamanho)}`;

/** Soma do ato por par, na ordem em que cada par apareceu: a conferência nunca é item a item. */
function somarPorPar(itens) {
  const somas = new Map();
  for (const { materialId, tamanho, quantidade } of itens) {
    const chave = chaveDoPar(materialId, tamanho);
    const atual = somas.get(chave);
    if (atual === undefined) somas.set(chave, { materialId, tamanho, quantidade });
    else atual.quantidade += quantidade;
  }
  return somas;
}

/**
 * Pares cuja soma pedida passa do saldo livre, na ordem das posições
 * recebidas. Par pedido sem posição é erro de programação: nunca um passe
 * silencioso.
 */
function recusasPorSaldoLivre(posicoes, somas) {
  const lidas = new Set(posicoes.map((p) => chaveDoPar(p.materialId, p.tamanho)));
  for (const chave of somas.keys()) {
    if (!lidas.has(chave)) throw new TypeError('par sem posição de estoque lida');
  }
  const recusas = [];
  for (const posicao of posicoes) {
    const soma = somas.get(chaveDoPar(posicao.materialId, posicao.tamanho));
    if (soma === undefined || soma.quantidade <= posicao.saldoLivre) continue;
    recusas.push({
      materialId: posicao.materialId,
      tamanho: posicao.tamanho,
      quantidadeSolicitada: soma.quantidade,
      fisicoUtilizavel: posicao.fisicoUtilizavel,
      demandaPendente: posicao.demandaPendente,
      comprometido: posicao.comprometido,
      saldoLivre: posicao.saldoLivre,
    });
  }
  return recusas;
}

module.exports = {
  CODIGO,
  MOTIVOS_FISICOS,
  MOTIVOS_DISCRICIONARIOS,
  ehMotivoDiscricionario,
  recusaPorSaldoLivre,
  ehRecusaPorSaldoLivre,
  posicaoPublica,
  reduziuCobertura,
  chaveDoPar,
  somarPorPar,
  recusasPorSaldoLivre,
};
