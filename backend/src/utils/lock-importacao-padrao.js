'use strict';

const crypto = require('node:crypto');

/**
 * Trava lógica da importação da biblioteca padrão: advisory lock de 64 bits num espaço próprio, separado das travas de estoque e da biblioteca de
 * imagens das empresas. Serializa duas importações simultâneas (a biblioteca padrão é global, então a trava também é uma só). Mesmo desenho de
 * lock-biblioteca-imagens.js: texto do inteiro de 64 bits, derivado de um espaço nomeado.
 */

const ESPACO_IMPORTACAO_PADRAO = 'imagens_importacao_padrao';

function lockDaImportacaoPadrao() {
  return crypto.createHash('sha256').update(ESPACO_IMPORTACAO_PADRAO).digest().readBigInt64BE(0).toString();
}

module.exports = { ESPACO_IMPORTACAO_PADRAO, lockDaImportacaoPadrao };
