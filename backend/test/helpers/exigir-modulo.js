'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

/**
 * Carrega um módulo de src/ no momento em que o teste o usa. Se o próprio
 * módulo ainda não existe, o teste falha dizendo isso; qualquer outro erro
 * de carga (dependência ausente, erro de sintaxe) é propagado como está,
 * para não ser confundido com ausência de implementação.
 *
 * @param {string} caminho caminho relativo à raiz do backend, sem extensão
 */
function exigirModulo(caminho) {
  const absoluto = path.join(__dirname, '..', '..', caminho);
  try {
    // eslint-disable-next-line global-require
    return require(absoluto);
  } catch (erro) {
    if (erro && erro.code === 'MODULE_NOT_FOUND' && typeof erro.message === 'string' && erro.message.startsWith(`Cannot find module '${absoluto}'`)) {
      assert.fail(`módulo ainda não implementado: ${caminho}.js`);
    }
    throw erro;
  }
}

module.exports = { exigirModulo };
