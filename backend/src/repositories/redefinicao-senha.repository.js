'use strict';

const { criarRepositorioDeRedefinicao } = require('./redefinicao-senha.base');

/**
 * Pedidos de redefinição de senha das identidades globais (migration 061,
 * Portal do Cliente). O contrato está em redefinicao-senha.base.js.
 */
module.exports = criarRepositorioDeRedefinicao({
  tabela: 'redefinicoes_senha',
  colunaConta: 'identidade_id',
  campoConta: 'identidadeId',
  rotuloConta: 'identidade',
});
