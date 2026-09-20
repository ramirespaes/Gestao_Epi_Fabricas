'use strict';

const { Router } = require('express');
const { validar } = require('../middleware/validar');
const authSchemas = require('../schemas/auth.schema');
const { limitadorAutenticacao } = require('../middleware/rate-limit');
const { authController } = require('../controllers/auth.controller');

/**
 * Rotas de autenticação (Bloco 8, Incremento 6).
 *
 * Só conecta caminho + middlewares + um controller já pronto — não sabe de
 * onde `controller` ou `limitador` vieram, nem como foram construídos. Isso
 * permite montar a mesma rota em produção (com o pool e o limitador reais)
 * e em teste (com pool e limitador exclusivos), sem duplicar a definição da
 * rota em lugar nenhum.
 *
 * O schema de validação (`authSchemas.login.body`) fica fixo dentro da
 * fábrica: o contrato de entrada da rota nunca varia entre produção e
 * teste, só `controller` e `limitador` legitimamente precisam variar.
 *
 * Ordem dos middlewares: limitador (barra volume por IP antes de qualquer
 * outro custo) -> validar (rejeita corpo malformado antes do controller) ->
 * controller.login. O caminho final, quando montado por app.js sob /api,
 * é POST /api/auth/login.
 */

function criarAuthRoutes({ controller, limitador }) {
  const router = Router();

  router.post('/auth/login', limitador, validar({ body: authSchemas.login.body }), controller.login);

  return router;
}

const authRoutes = criarAuthRoutes({ controller: authController, limitador: limitadorAutenticacao });

module.exports = { criarAuthRoutes, authRoutes };
