'use strict';

/** Descarta a mensagem: sem provedor e sem arquivo. É o padrão fora de production. */
function criarDesativado() {
  return {
    modo: 'desativado',
    async enviar() {
      return { estado: 'NAO_ENVIADO' };
    },
    fechar() {},
  };
}

module.exports = { criarDesativado };
