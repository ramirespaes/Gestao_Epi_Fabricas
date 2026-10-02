'use strict';

const { HttpError } = require('../errors/HttpError');
const { httpConfig } = require('../config/http');
const { emailConfig } = require('../config/email');
const { servicoPadrao } = require('./servico-email');
const { renderizar, TIPOS } = require('./templates');
const { linkConvite, CAMINHOS } = require('./links');

/**
 * Entrega de convite (usuário da empresa e primeiro MASTER) pelo serviço
 * único de e-mail, com o envio aguardado: quem convida precisa saber se o
 * e-mail saiu. O convite já está gravado quando se chega aqui; falha de
 * entrega não o desfaz, e ele continua pendente e pode ser reenviado.
 *
 * O LINK NUNCA VOLTA NA RESPOSTA em production nem com um provedor de e-mail
 * real. Só nos modos de desenvolvimento (desativado e arquivo) fora de
 * production a resposta carrega `linkAceite`, o mecanismo manual controlado
 * que os testes e a tela de desenvolvimento usam.
 */

const MODO_EMAIL = 'EMAIL';
const MODO_DESENVOLVIMENTO = 'DESENVOLVIMENTO_SEM_EMAIL';
const MSG_INDISPONIVEL = 'Entrega de convites indisponível: nenhum provedor de e-mail configurado';

const POR_TIPO = Object.freeze({
  USUARIO: { template: TIPOS.CONVITE_USUARIO, escopo: 'PORTAL' },
  MASTER: { template: TIPOS.CONVITE_MASTER, escopo: 'PLATAFORMA' },
});

/**
 * Em production só o provedor real de e-mail serve: sem ele a criação do
 * convite é recusada antes de gravar qualquer coisa (defesa em profundidade;
 * a configuração já impede subir sem SMTP). `ambiente` e `modo` são
 * injetáveis só para teste.
 */
function exigirDisponivel(ambiente = httpConfig.ambiente, modo = emailConfig.modo) {
  if (ambiente === 'production' && modo !== 'smtp') {
    throw new HttpError(503, 'CONVITE_ENTREGA_INDISPONIVEL', MSG_INDISPONIVEL);
  }
}

const mostraLink = (ambiente, modo) => ambiente !== 'production' && modo !== 'smtp';

/**
 * @param {{tipo: 'USUARIO'|'MASTER', token: string, expiraEm: Date, email: string, empresa: string,
 *          nome?: string, perfil?: string, reenvio?: boolean}} dados
 * @returns {Promise<{modo: string, estado: string, expiraEm: Date, linkAceite?: string}>}
 */
async function entregarConvite(dados, {
  servico = servicoPadrao(), ambiente = httpConfig.ambiente, config = emailConfig, urls = httpConfig.urlsPublicas,
} = {}) {
  exigirDisponivel(ambiente, config.modo);
  const {
    tipo, token, expiraEm, email, empresa, nome, perfil, reenvio = false,
  } = dados;
  if (!Object.hasOwn(POR_TIPO, tipo)) {
    throw new TypeError('tipo de convite inválido');
  }
  if (typeof token !== 'string' || token.length === 0) {
    throw new TypeError('token de convite inválido');
  }
  const link = linkConvite(tipo, token, urls);
  const { template, escopo } = POR_TIPO[tipo];
  const conteudo = renderizar(template, {
    link, expiraEm, empresa, nome, perfil, reenvio,
  }, { suporte: config.suporte });

  const { estado } = await servico.enviarAguardando({ tipo: template, escopo, para: email, conteudo });

  const modo = config.modo === 'smtp' ? MODO_EMAIL : MODO_DESENVOLVIMENTO;
  const entrega = { modo, estado, expiraEm };
  if (mostraLink(ambiente, config.modo)) {
    entrega.linkAceite = link;
  }
  return entrega;
}

module.exports = {
  entregarConvite, exigirDisponivel, MODO_EMAIL, MODO_DESENVOLVIMENTO, CAMINHOS,
};
