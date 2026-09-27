'use strict';

const { httpConfig } = require('../config/http');
const entregaConvite = require('./entrega-convite.service');

/**
 * Entrega do convite de USUÁRIO (Bloco 9, parte F). Mesmo modo do convite
 * do MASTER (entrega-convite.service.js): sem provedor de e-mail, o link
 * volta para quem convidou, só fora de produção. Em produção a criação é
 * recusada antes de gravar qualquer coisa (exigirDisponivel), até existir
 * o envio real por e-mail.
 *
 * O link aponta para a página pública de aceite do Portal do Cliente, na
 * primeira origem permitida do cliente (CORS_ORIGIN). O token vai no
 * FRAGMENTO (#token=), que o navegador nunca envia a servidor algum.
 *
 * O log operacional registra só o fato: nem token, nem link, nem e-mail.
 */

const CAMINHO_PAGINA_ACEITE = '/portal/aceitar-convite.html';

function montarLinkAceite(token) {
  const origem = httpConfig.cors.origens[0];
  return `${origem}${CAMINHO_PAGINA_ACEITE}#token=${encodeURIComponent(token)}`;
}

async function entregar({ conviteId, empresaId, token, expiraEm }) {
  entregaConvite.exigirDisponivel();
  if (typeof token !== 'string' || token.length === 0) {
    throw new TypeError('token de convite inválido');
  }
  const linkAceite = montarLinkAceite(token);

  console.log('[convite-usuario] convite gerado (modo desenvolvimento, sem envio de e-mail)', { empresaId, conviteId });

  return { modo: entregaConvite.MODO, linkAceite, expiraEm };
}

module.exports = {
  entregar,
  exigirDisponivel: entregaConvite.exigirDisponivel,
  montarLinkAceite,
  CAMINHO_PAGINA_ACEITE,
};
