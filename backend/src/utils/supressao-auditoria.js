'use strict';

const crypto = require('node:crypto');
const { TAMANHO_MAXIMO } = require('./lock-par-estoque');

/**
 * Supressão da auditoria de recusa por saldo livre: no máximo um registro por
 * empresa, ator, tipo de operação, material e tamanho dentro da janela. O
 * evento tem forma canônica única, que também é a `referencia` gravada
 * (VARCHAR(150)), e a trava é um advisory lock de transação de 64 bits num
 * espaço PRÓPRIO, para a auditoria secundária nunca esperar nem atrasar a
 * trava do par de estoque.
 */

const JANELA_SUPRESSAO_SEGUNDOS = 60;
const OPERACOES = Object.freeze(['ENTREGA_DIRETA', 'BAIXA']);
const ESPACO_SUPRESSAO = 'auditoria_recusa_saldo_livre';
const EVENTO_MAXIMO = 150;

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) throw new TypeError(`identificador de ${nome} inválido`);
}

/** `OPERACAO:materialId:tamanho`; tamanho ausente é o texto vazio, como nos pares de estoque. */
function chaveDoEvento(operacao, materialId, tamanho) {
  if (!OPERACOES.includes(operacao)) throw new TypeError('operação inválida');
  exigirId(materialId, 'material');
  if (tamanho !== null && (typeof tamanho !== 'string' || tamanho.length === 0 || Array.from(tamanho).length > TAMANHO_MAXIMO)) {
    throw new TypeError('tamanho inválido');
  }
  return `${operacao}:${materialId}:${tamanho ?? ''}`;
}

/** Lock de 64 bits (texto, para o bigint do PostgreSQL) por empresa, ator e evento. */
function lockDaSupressao(empresaId, atorId, chaveEvento) {
  exigirId(empresaId, 'empresa');
  exigirId(atorId, 'ator');
  if (typeof chaveEvento !== 'string' || chaveEvento.length === 0 || chaveEvento.length > EVENTO_MAXIMO) {
    throw new TypeError('evento de supressão inválido');
  }
  return crypto.createHash('sha256')
    .update(`${ESPACO_SUPRESSAO}\n${empresaId}\n${atorId}\n${chaveEvento}`)
    .digest().readBigInt64BE(0).toString();
}

module.exports = {
  JANELA_SUPRESSAO_SEGUNDOS, OPERACOES, chaveDoEvento, lockDaSupressao,
};
