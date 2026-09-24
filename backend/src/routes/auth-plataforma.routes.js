'use strict';

const { Router } = require('express');
const { validar } = require('../middleware/validar');
const authPlataformaSchemas = require('../schemas/auth-plataforma.schema');
const { limitadorPlataformaAutenticacao } = require('../middleware/rate-limit');
const { authPlataformaController } = require('../controllers/auth-plataforma.controller');
const { exigirSessaoPlataforma } = require('../middleware/autenticacao-plataforma');

/**
 * Rotas de autenticação do Painel Privado da plataforma (Autenticação
 * Global — Pacote 2). Espelha auth.routes.js: só conecta caminho +
 * middlewares + controller, sem saber como cada um foi construído — permite
 * montar com dependências de teste (pool/limitador exclusivos) sem duplicar
 * a definição de rota.
 *
 * /auth/login: limitadorPlataformaAutenticacao (instância PRÓPRIA, contador
 * separado do limitadorAutenticacao do cliente) -> validar -> controller.
 * /auth/me: atrás de exigirSessaoPlataforma.
 * /auth/logout: sem exigirSessaoPlataforma, de propósito — idempotente,
 * mesma razão de auth.routes.js. A verificação de origem do namespace
 * /api/plataforma (montada em app.js) já protege POST.
 *
 * Caminhos finais, quando montado por app.js sob /api/plataforma:
 *   POST /api/plataforma/auth/login
 *   GET  /api/plataforma/auth/me
 *   POST /api/plataforma/auth/logout
 */

function criarAuthPlataformaRoutes({ controller, limitador, exigirSessaoPlataforma: exigirSessaoInjetado }) {
  const router = Router();

  router.post('/auth/login', limitador, validar({ body: authPlataformaSchemas.login.body }), controller.login);
  router.get('/auth/me', exigirSessaoInjetado, controller.me);
  router.post('/auth/logout', controller.logout);

  return router;
}

const authPlataformaRoutes = criarAuthPlataformaRoutes({
  controller: authPlataformaController,
  limitador: limitadorPlataformaAutenticacao,
  exigirSessaoPlataforma,
});

module.exports = { criarAuthPlataformaRoutes, authPlataformaRoutes };
