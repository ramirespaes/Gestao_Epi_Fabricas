'use strict';

/**
 * Vocabulário do histórico de operações de estoque, numa fonte só para o
 * schema da rota e o repository (nenhum dos dois depende do outro). Os tipos
 * são os do CHECK de estoque_operacoes (059) e as origens, as de entregas_epi
 * (066). A origem só existe nas linhas ENTREGA.
 */

const TIPOS_OPERACAO = Object.freeze(['SALDO_INICIAL', 'ENTRADA', 'BAIXA', 'ENTREGA']);
const ORIGENS_ENTREGA = Object.freeze(['DIRETA', 'SOLICITACAO']);

module.exports = { TIPOS_OPERACAO, ORIGENS_ENTREGA };
