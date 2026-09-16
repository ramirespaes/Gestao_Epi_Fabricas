'use strict';

const cors = require('cors');
const { httpConfig } = require('../config/http');

/**
 * CORS do namespace /api.
 *
 * - Allowlist: exclusivamente httpConfig.cors.origens, já validada e
 *   canonizada em config/http.js. Nenhuma leitura de process.env, nenhum
 *   parser ou canonicalização aqui. Comparação por igualdade exata.
 * - Origem permitida: Access-Control-Allow-Origin com a origem exata e
 *   Access-Control-Allow-Credentials: true (o cookie de sessão futuro exige
 *   credentials; "*" nunca é emitido porque a validação da allowlist o
 *   rejeita e a função de origem só devolve uma origem da lista ou false).
 * - Origem ausente, "null" ou fora da lista: nenhum Access-Control-*; a
 *   requisição segue normalmente. CORS controla o que o navegador pode ler
 *   cross-origin; a rejeição de métodos unsafe por origem é responsabilidade
 *   da verificação Origin/Referer, não deste middleware.
 * - Métodos e headers mínimos das rotas da API: GET, HEAD, POST, PATCH e
 *   Content-Type. Sem PUT, DELETE, Authorization, X-* ou exposedHeaders.
 * - Preflight encerrado aqui com 204 e Max-Age 600, antes de semCache.
 * - Vary: Origin em toda resposta que atravessa o middleware, inclusive sem
 *   cabeçalhos CORS, para que caches nunca reaproveitem entre origens.
 */

function criarCors({ origens }) {
  const permitidas = new Set(origens);
  const middleware = cors({
    origin: (origem, callback) => callback(null, permitidas.has(origem) ? origem : false),
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PATCH'],
    allowedHeaders: ['Content-Type'],
    maxAge: 600,
    optionsSuccessStatus: 204,
  });
  return function corsApiNamespace(req, res, next) {
    res.vary('Origin');
    middleware(req, res, next);
  };
}

const corsApi = criarCors({ origens: httpConfig.cors.origens });

module.exports = { criarCors, corsApi };
