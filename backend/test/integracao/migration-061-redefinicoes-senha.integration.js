'use strict';

const { descreverTabelaDeRedefinicao } = require('./helpers/redefinicao-senha-contrato');
const { criarIdentidade } = require('./helpers/recuperacao-senha');

/**
 * Migration 061 — redefinicoes_senha: pedidos de redefinição de senha das
 * identidades globais (Portal do Cliente). O contrato é o mesmo da 062 e
 * está em helpers/redefinicao-senha-contrato.js.
 */
descreverTabelaDeRedefinicao({
  titulo: 'migration 061 — redefinicoes_senha (identidades)',
  prefixo: '061',
  tabela: 'redefinicoes_senha',
  coluna: 'identidade_id',
  rotuloConta: 'identidade',
  tabelaConta: 'identidades',
  criarConta: criarIdentidade,
});
