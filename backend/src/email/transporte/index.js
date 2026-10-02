'use strict';

const { criarDesativado } = require('./desativado');
const { criarArquivo } = require('./arquivo');
const { criarSmtp } = require('./smtp');

/**
 * Escolhe a implementação de transporte pelo modo da configuração. Todo
 * transporte expõe `modo`, `enviar(mensagem)` e `fechar()`, e só devolve um
 * estado (ENVIADO, GRAVADO, NAO_ENVIADO) ou lança ErroEntrega.
 */
function criarTransporte(config, dependencias = {}) {
  switch (config && config.modo) {
    case 'desativado':
      return criarDesativado();
    case 'arquivo':
      return criarArquivo(config);
    case 'smtp':
      return criarSmtp(config, dependencias);
    default:
      throw new TypeError('modo de e-mail inválido');
  }
}

module.exports = { criarTransporte };
