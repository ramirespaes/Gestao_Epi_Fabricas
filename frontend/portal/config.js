(function (global) {
  'use strict';

  /**
   * Endereço da API do Portal do Cliente (Autenticação Global — Pacote 4).
   * Mesmo desenho de painel-privado/config.js, com o prefixo do CLIENTE:
   *
   * DESENVOLVIMENTO (página aberta em localhost/127.0.0.1/[::1], por
   * exemplo http://localhost:5500/portal/): http://localhost:3000/api.
   *
   * PRODUÇÃO: a MESMA origem que serve a página, sob /api (ex.: quando o
   * Portal existir em app.<domínio>, a API do cliente responderá em
   * app.<domínio>/api — planejamento v2 §6.1). Nenhum domínio de produção
   * é inventado aqui.
   *
   * Nunca aponta para /api/plataforma: o Portal do Cliente e o Painel
   * Privado têm allowlists de CORS/Origin disjuntas no backend.
   */

  var DESENVOLVIMENTO_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
  var API_BASE_DESENVOLVIMENTO = 'http://localhost:3000/api';
  var PREFIXO_API_CLIENTE = '/api';

  function resolverApiBaseUrl(location) {
    if (!location || typeof location.hostname !== 'string' || typeof location.origin !== 'string') {
      throw new TypeError('location inválido');
    }
    if (DESENVOLVIMENTO_HOSTS.indexOf(location.hostname) !== -1) {
      return API_BASE_DESENVOLVIMENTO;
    }
    return location.origin + PREFIXO_API_CLIENTE;
  }

  global.SafeworkPortalConfig = {
    resolverApiBaseUrl: resolverApiBaseUrl,
    API_BASE_DESENVOLVIMENTO: API_BASE_DESENVOLVIMENTO,
  };

  if (typeof global.location !== 'undefined') {
    global.SAFEWORK_PORTAL_API_BASE_URL = resolverApiBaseUrl(global.location);
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.SafeworkPortalConfig;
  }
})(typeof window !== 'undefined' ? window : globalThis);
