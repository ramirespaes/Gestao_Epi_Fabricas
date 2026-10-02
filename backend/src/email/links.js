'use strict';

const { httpConfig } = require('../config/http');

/**
 * Links públicos dos e-mails. A origem vem de PORTAL_URL_PUBLICA e
 * PAINEL_URL_PUBLICA (httpConfig.urlsPublicas), nunca da ordem de uma
 * allowlist de CORS. O token vai só no FRAGMENTO (#token=): o navegador não o
 * envia a servidor algum, e a página o retira da barra de endereço antes de
 * qualquer requisição.
 */

const CAMINHOS = Object.freeze({
  REDEFINICAO: Object.freeze({ PORTAL: '/portal/redefinir-senha.html', PLATAFORMA: '/painel-privado/redefinir-senha.html' }),
  CONVITE: Object.freeze({ USUARIO: '/portal/aceitar-convite.html', MASTER: '/painel-privado/aceitar-convite.html' }),
});

const PORTAL_DE = Object.freeze({ PORTAL: 'portal', PLATAFORMA: 'painel', USUARIO: 'portal', MASTER: 'painel' });

function montar(familia, chave, token, urls) {
  if (typeof chave !== 'string' || !Object.hasOwn(CAMINHOS[familia], chave)) {
    throw new TypeError(`escopo de link inválido`);
  }
  if (typeof token !== 'string' || token.length === 0) {
    throw new TypeError('token inválido');
  }
  return `${urls[PORTAL_DE[chave]]}${CAMINHOS[familia][chave]}#token=${encodeURIComponent(token)}`;
}

const linkRedefinicao = (escopo, token, urls = httpConfig.urlsPublicas) => montar('REDEFINICAO', escopo, token, urls);
const linkConvite = (tipo, token, urls = httpConfig.urlsPublicas) => montar('CONVITE', tipo, token, urls);

module.exports = { linkRedefinicao, linkConvite, CAMINHOS };
