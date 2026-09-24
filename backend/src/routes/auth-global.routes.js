'use strict';

const { Router } = require('express');
const { validar } = require('../middleware/validar');
const authGlobalSchemas = require('../schemas/auth-global.schema');
const { limitadorAutenticacao } = require('../middleware/rate-limit');
const { authGlobalController } = require('../controllers/auth-global.controller');
const { exigirSessaoGlobal } = require('../middleware/autenticacao-global');

/**
 * Rotas de autenticação GLOBAL do Portal do Cliente (Autenticação Global —
 * Pacote 4). Mesma fábrica de auth.routes.js: só caminho + middlewares +
 * controller, montável com dependências de teste.
 *
 * Vivem na MESMA cadeia /api do cliente (CORS/Origin do cliente,
 * limitadorGeral, política de conteúdo) — são rotas do Portal do Cliente,
 * nunca do Painel Privado (/api/plataforma, allowlist disjunta).
 *
 *   POST /auth/global/login                      e-mail + senha -> cookie global (+ empresarial se 1 empresa)
 *   GET  /auth/global/me                         identidade, empresas autorizadas e contexto atual
 *   POST /auth/global/empresas/:id/selecionar    seleciona/troca de empresa -> cookie empresarial
 *   POST /auth/global/logout                     sair completamente (idempotente; remove os dois cookies)
 *
 * "Sair da empresa" (manter a global, permitir reselecionar sem senha) é o
 * POST /auth/logout já existente — não há rota nova para isso.
 *
 * /login leva o limitadorAutenticacao (o mesmo do login legado: contador
 * por IP compartilhado entre os dois contratos de login do cliente — ambos
 * verificam senha). /logout não fica atrás de exigirSessaoGlobal, de
 * propósito (idempotente), e a verificação de origem da cadeia /api já
 * protege o POST.
 */

function criarAuthGlobalRoutes({ controller, limitador, exigirSessaoGlobal: exigirInjetado }) {
  const router = Router();

  router.post('/auth/global/login', limitador, validar({ body: authGlobalSchemas.login.body }), controller.login);
  router.get('/auth/global/me', exigirInjetado, controller.me);
  router.post(
    '/auth/global/empresas/:id/selecionar',
    exigirInjetado,
    validar({ params: authGlobalSchemas.selecionarEmpresa.params }),
    controller.selecionarEmpresa,
  );
  router.post('/auth/global/logout', controller.logout);

  return router;
}

const authGlobalRoutes = criarAuthGlobalRoutes({
  controller: authGlobalController,
  limitador: limitadorAutenticacao,
  exigirSessaoGlobal,
});

module.exports = { criarAuthGlobalRoutes, authGlobalRoutes };
