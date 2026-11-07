'use strict';

class ErroInstalador extends Error {
  constructor(codigo, mensagem, detalhes = {}) {
    super(mensagem);
    this.name = 'ErroInstalador';
    this.codigo = codigo;
    this.detalhes = detalhes;
  }
}
const erro = (codigo, mensagem, detalhes) => new ErroInstalador(codigo, mensagem, detalhes);
const config = (mensagem) => erro('CONFIG_INVALIDA', mensagem);

module.exports = { ErroInstalador, erro, config };
