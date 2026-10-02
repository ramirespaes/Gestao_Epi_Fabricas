'use strict';

const { entregarConvite, exigirDisponivel, CAMINHOS } = require('../email/convite');
const { linkConvite } = require('../email/links');

/**
 * Entrega do convite de USUÁRIO (Bloco 9, parte F). Camada fina sobre o
 * serviço único de e-mail (src/email): o link aponta para a página pública
 * de aceite do Portal do Cliente, na PORTAL_URL_PUBLICA, com o token só no
 * fragmento (#token=). Em production o link nunca volta na resposta HTTP.
 */

const CAMINHO_PAGINA_ACEITE = CAMINHOS.CONVITE.USUARIO;

const montarLinkAceite = (token) => linkConvite('USUARIO', token);

/**
 * @param {{token: string, expiraEm: Date, email: string, empresa: string, nome: string, perfil: string, reenvio?: boolean}} dados
 * @returns {Promise<{modo: string, estado: string, expiraEm: Date, linkAceite?: string}>}
 */
async function entregar({
  token, expiraEm, email, empresa, nome, perfil, reenvio = false,
}, dependencias) {
  return entregarConvite({
    tipo: 'USUARIO', token, expiraEm, email, empresa, nome, perfil, reenvio,
  }, dependencias);
}

module.exports = {
  entregar, exigirDisponivel, montarLinkAceite, CAMINHO_PAGINA_ACEITE,
};
