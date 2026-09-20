'use strict';

const assert = require('node:assert/strict');

/**
 * Garante que nenhum dos valores sensíveis aparece no texto (resposta HTTP,
 * mensagem de erro ou linha de log). Ignora valores vazios ou muito curtos,
 * que gerariam falsos positivos.
 */
function assertSemSensiveis(texto, valores, rotulo = 'texto') {
  assert.equal(typeof texto, 'string', `${rotulo}: esperado string`);
  for (const valor of valores) {
    if (typeof valor !== 'string' || valor.length < 3) {
      continue;
    }
    assert.equal(texto.includes(valor), false, `${rotulo} contém valor sensível`);
  }
}

module.exports = { assertSemSensiveis };
