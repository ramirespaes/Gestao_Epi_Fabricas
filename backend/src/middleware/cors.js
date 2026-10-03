'use strict';

const cors = require('cors');
const { httpConfig } = require('../config/http');

/**
 * CORS do namespace /api e do /api/plataforma.
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
 *   da verificação Origin/Referer, não deste middleware. As duas camadas são
 *   separadas: anunciar PUT ou DELETE aqui NÃO os torna seguros para a origem.
 * - Métodos: SEMPRE explícitos, por namespace (menor privilégio). Um método
 *   que uma rota usa e o CORS não anuncia é bloqueado pelo navegador no
 *   preflight cross-origin; um método anunciado sem rota que o use é
 *   superfície à toa. test/middleware/cors-metodos-das-rotas.test.js compara
 *   as duas listas com as rotas realmente montadas. O Portal (/api) usa GET,
 *   POST, PUT, PATCH e DELETE (mais o HEAD, que o Express atende pelo GET); o
 *   Painel Privado (/api/plataforma) usa só GET, POST e PATCH (PATCH em
 *   /empresas/:id) — nunca PUT nem DELETE.
 * - Headers mínimos: Content-Type. Sem Authorization, X-* ou exposedHeaders.
 * - Preflight encerrado aqui com 204 e Max-Age 600, antes de semCache.
 * - Vary: Origin em toda resposta que atravessa o middleware, inclusive sem
 *   cabeçalhos CORS, para que caches nunca reaproveitem entre origens.
 */

// Verbos que uma lista de métodos pode conter; OPTIONS é o próprio preflight e nunca é listado.
const METODOS_ACEITOS = Object.freeze(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);

const METODOS_PORTAL = Object.freeze(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
const METODOS_PLATAFORMA = Object.freeze(['GET', 'HEAD', 'POST', 'PATCH']);

function exigirMetodos(metodos) {
  if (!Array.isArray(metodos) || metodos.length === 0) {
    throw new TypeError('criarCors exige a lista explícita de métodos do namespace');
  }
  if (new Set(metodos).size !== metodos.length) {
    throw new TypeError('lista de métodos do CORS com duplicata');
  }
  for (const metodo of metodos) {
    if (!METODOS_ACEITOS.includes(metodo)) {
      throw new TypeError('método fora da lista aceita pelo CORS');
    }
  }
}

function criarCors({ origens, metodos }) {
  exigirMetodos(metodos);
  const permitidas = new Set(origens);
  const middleware = cors({
    origin: (origem, callback) => callback(null, permitidas.has(origem) ? origem : false),
    credentials: true,
    methods: [...metodos],
    allowedHeaders: ['Content-Type'],
    maxAge: 600,
    optionsSuccessStatus: 204,
  });
  return function corsApiNamespace(req, res, next) {
    res.vary('Origin');
    middleware(req, res, next);
  };
}

const corsApi = criarCors({ origens: httpConfig.cors.origens, metodos: METODOS_PORTAL });

// CORS do namespace /api/plataforma (Autenticação Global — Pacote 2):
// mesma fábrica, allowlist SEPARADA (httpConfig.plataforma.corsOrigens) —
// nunca a mesma allowlist do cliente, mesma disciplina de isolamento do
// adendo v2.1 — e métodos próprios: o Painel Privado não herda o PUT e o
// DELETE do Portal.
const corsPlataforma = criarCors({ origens: httpConfig.plataforma.corsOrigens, metodos: METODOS_PLATAFORMA });

module.exports = {
  criarCors, corsApi, corsPlataforma, METODOS_PORTAL, METODOS_PLATAFORMA,
};
