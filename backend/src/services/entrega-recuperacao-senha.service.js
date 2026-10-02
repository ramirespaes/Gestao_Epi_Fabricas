'use strict';

const { emailConfig } = require('../config/email');
const { criarServicoEmail, servicoPadrao } = require('../email/servico-email');
const { criarTransporte } = require('../email/transporte');
const { renderizar, TIPOS } = require('../email/templates');
const { linkRedefinicao } = require('../email/links');

/**
 * Entrega dos e-mails do ciclo de senha: o link de redefinição e o aviso de
 * senha alterada. É uma camada fina sobre o serviço único de e-mail.
 *
 * Quem chama (recuperacao-senha.service e os services da troca de senha) só
 * enfileira, e sempre depois do COMMIT. As funções de enfileirar são
 * síncronas e não devolvem promessa: a resposta ao cliente nunca espera a
 * entrega, para o tempo de resposta não distinguir conta existente de
 * inexistente. Falha de entrega não volta para quem enfileirou.
 *
 * ENTREGA PÓS-COMMIT = BEST EFFORT, sem fila durável: se o processo cair
 * depois do COMMIT e antes do envio, a mensagem se perde e a pessoa precisa
 * solicitar de novo (risco aceito e documentado). O token vai só no
 * fragmento do link (#token=). Nada aqui escreve token, link ou e-mail no
 * console: a falha de entrega registra só evento, tipo, escopo e um código.
 */

const ESCOPOS = Object.freeze(['PORTAL', 'PLATAFORMA']);
const ORIGENS_DO_AVISO = Object.freeze(['REDEFINICAO', 'TROCA']);

function exigirEscopo(escopo) {
  if (typeof escopo !== 'string' || !ESCOPOS.includes(escopo)) {
    throw new TypeError('escopo de entrega inválido');
  }
}

function exigirTexto(valor, nome) {
  if (typeof valor !== 'string' || valor.length === 0) {
    throw new TypeError(`${nome} inválido`);
  }
}

function montarLinkRedefinicao(escopo, token) {
  exigirEscopo(escopo);
  exigirTexto(token, 'token de redefinição');
  return linkRedefinicao(escopo, token);
}

function criarEntrega({ config = emailConfig, servico } = {}) {
  const servicoDeEmail = servico ?? criarServicoEmail({ transporte: criarTransporte(config) });

  function enfileirarRedefinicao({ escopo, email, token, expiraEm }) {
    exigirEscopo(escopo);
    exigirTexto(email, 'destinatário');
    exigirTexto(token, 'token de redefinição');
    if (!(expiraEm instanceof Date) || Number.isNaN(expiraEm.getTime())) {
      throw new TypeError('validade do link inválida');
    }
    const conteudo = renderizar(TIPOS.RECUPERACAO_SENHA, { escopo, link: linkRedefinicao(escopo, token), expiraEm }, { suporte: config.suporte });
    servicoDeEmail.enfileirar({ tipo: TIPOS.RECUPERACAO_SENHA, escopo, para: email, conteudo });
  }

  function enfileirarAvisoSenhaAlterada({ escopo, email, origem = 'REDEFINICAO' }) {
    exigirEscopo(escopo);
    exigirTexto(email, 'destinatário');
    if (typeof origem !== 'string' || !ORIGENS_DO_AVISO.includes(origem)) {
      throw new TypeError('origem do aviso inválida');
    }
    const conteudo = renderizar(TIPOS.SENHA_ALTERADA, { escopo, origem }, { suporte: config.suporte });
    servicoDeEmail.enfileirar({ tipo: TIPOS.SENHA_ALTERADA, escopo, para: email, conteudo });
  }

  /** Espera o que já foi enfileirado terminar. Para testes e encerramento do processo. */
  const aguardarOciosidade = (limiteMs) => servicoDeEmail.aguardarOciosidade(limiteMs);

  return { enfileirarRedefinicao, enfileirarAvisoSenhaAlterada, aguardarOciosidade, montarLinkRedefinicao };
}

// A instância da aplicação divide o serviço (fila e transporte) com os convites.
const padrao = criarEntrega({
  servico: {
    enfileirar: (mensagem) => servicoPadrao().enfileirar(mensagem),
    aguardarOciosidade: (limiteMs) => servicoPadrao().aguardarOciosidade(limiteMs),
  },
});

module.exports = {
  enfileirarRedefinicao: padrao.enfileirarRedefinicao,
  enfileirarAvisoSenhaAlterada: padrao.enfileirarAvisoSenhaAlterada,
  aguardarOciosidade: padrao.aguardarOciosidade,
  montarLinkRedefinicao,
  criarEntrega,
};
