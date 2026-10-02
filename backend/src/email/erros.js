'use strict';

/**
 * Falha de entrega de e-mail com mensagem fixa e só um código de uma lista
 * conhecida. O erro bruto do provedor nunca é repassado: ele pode trazer o
 * destinatário, o host, a credencial ou o conteúdo da mensagem.
 */

const CODIGO_DESCONHECIDO = 'ERRO_DESCONHECIDO';

const CODIGOS_DE_REDE = Object.freeze(new Set([
  'ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EENVELOPE', 'EMESSAGE', 'ETLS', 'EDNS', 'EAUTH', 'EPROTOCOL', 'EREQUIRETLS',
  'ESTREAM', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'EPIPE',
]));

const CODIGO_DE_SISTEMA_DE_ARQUIVOS = /^E[A-Z0-9]{2,12}$/;

class ErroEntrega extends Error {
  constructor(codigo = CODIGO_DESCONHECIDO) {
    super('falha na entrega do e-mail');
    this.name = 'ErroEntrega';
    this.codigo = typeof codigo === 'string' && /^[A-Z][A-Z0-9_]{0,39}$/.test(codigo) ? codigo : CODIGO_DESCONHECIDO;
  }
}

/** Erro do nodemailer: só o código, e só se estiver na lista conhecida. */
function erroDeRede(erro) {
  return new ErroEntrega(erro && CODIGOS_DE_REDE.has(erro.code) ? erro.code : CODIGO_DESCONHECIDO);
}

/** Erro do sistema de arquivos: só o código de errno, como EACCES. */
function erroDeArquivo(erro) {
  return new ErroEntrega(erro && typeof erro.code === 'string' && CODIGO_DE_SISTEMA_DE_ARQUIVOS.test(erro.code) ? erro.code : CODIGO_DESCONHECIDO);
}

const codigoDe = (erro) => (erro instanceof ErroEntrega ? erro.codigo : CODIGO_DESCONHECIDO);

module.exports = { ErroEntrega, erroDeRede, erroDeArquivo, codigoDe, CODIGO_DESCONHECIDO };
