'use strict';

const { entregarConvite, exigirDisponivel, MODO_DESENVOLVIMENTO, CAMINHOS } = require('../email/convite');
const { linkConvite } = require('../email/links');

/**
 * Entrega do convite do primeiro MASTER. Camada fina sobre o serviço único de
 * e-mail (src/email): o link aponta para a página pública de aceite do Painel
 * Privado, na PAINEL_URL_PUBLICA, com o token só no fragmento (#token=).
 *
 * Em production o link NUNCA volta na resposta HTTP: o token só chega à
 * pessoa convidada pelo e-mail. Nos modos de desenvolvimento a resposta
 * continua levando `linkAceite` (mecanismo manual controlado).
 */

const MODO = MODO_DESENVOLVIMENTO;
const CAMINHO_PAGINA_ACEITE = CAMINHOS.CONVITE.MASTER;

const montarLinkAceite = (token) => linkConvite('MASTER', token);

/**
 * @param {{conviteId: string, token: string, expiraEm: Date, email: string, empresa: {id: number, razaoSocial: string}, reenvio?: boolean}} dados
 * @returns {Promise<{modo: string, estado: string, expiraEm: Date, linkAceite?: string}>}
 */
async function entregar({
  token, expiraEm, email, empresa, reenvio = false,
}, dependencias) {
  return entregarConvite({
    tipo: 'MASTER', token, expiraEm, email, empresa: empresa.razaoSocial, reenvio,
  }, dependencias);
}

module.exports = {
  entregar, exigirDisponivel, montarLinkAceite, MODO, CAMINHO_PAGINA_ACEITE,
};
