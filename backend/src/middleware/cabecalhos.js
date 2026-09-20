'use strict';

const helmet = require('helmet');
const { httpConfig } = require('../config/http');

/**
 * Cabeçalhos HTTP de segurança para uma API JSON que não serve páginas.
 * Configuração explícita do Helmet, revisada política a política:
 * - CSP mínima e restritiva (useDefaults: false), só com as diretivas que
 *   fazem sentido para respostas que nunca são documentos legítimos;
 * - X-Frame-Options DENY, Referrer-Policy no-referrer, nosniff;
 * - COOP e CORP same-origin: CORP bloqueia carregamentos no-cors por outros
 *   sites e NÃO interfere no fetch com CORS do frontend, que continua
 *   condicionado aos cabeçalhos CORS;
 * - COEP deliberadamente desativado: a API não incorpora recursos;
 * - HSTS somente com hstsAtivo (production), max-age de um ano, sem
 *   includeSubDomains e sem preload até a topologia real do deploy ser
 *   definida.
 * X-Powered-By é removido pelo app (app.disable), não aqui.
 */

const UM_ANO_EM_SEGUNDOS = 31536000;

function criarCabecalhosSeguranca({ hstsAtivo }) {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'none'"],
        'frame-ancestors': ["'none'"],
        'base-uri': ["'none'"],
        'form-action': ["'none'"],
      },
    },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    crossOriginEmbedderPolicy: false,
    originAgentCluster: true,
    referrerPolicy: { policy: 'no-referrer' },
    strictTransportSecurity: hstsAtivo
      ? { maxAge: UM_ANO_EM_SEGUNDOS, includeSubDomains: false, preload: false }
      : false,
    xContentTypeOptions: true,
    xDnsPrefetchControl: { allow: false },
    xDownloadOptions: true,
    xFrameOptions: { action: 'deny' },
    xPermittedCrossDomainPolicies: { permittedPolicies: 'none' },
    xXssProtection: true,
  });
}

const cabecalhosSeguranca = criarCabecalhosSeguranca({ hstsAtivo: httpConfig.hstsAtivo });

// Respostas do namespace /api nunca devem ser armazenadas em cache: haverá
// dados de usuário e respostas autenticadas.
function semCache(req, res, next) {
  res.set('Cache-Control', 'no-store');
  next();
}

module.exports = { criarCabecalhosSeguranca, cabecalhosSeguranca, semCache };
