'use strict';

const { criarRepositorioDeRedefinicao } = require('./redefinicao-senha.base');

/**
 * Pedidos de redefinição de senha dos administradores da plataforma
 * (migration 062, Painel Privado). O contrato está em
 * redefinicao-senha.base.js; nada aqui se liga ao MFA.
 */
module.exports = criarRepositorioDeRedefinicao({
  tabela: 'redefinicoes_senha_plataforma',
  colunaConta: 'administrador_id',
  campoConta: 'administradorId',
  rotuloConta: 'administrador',
});
