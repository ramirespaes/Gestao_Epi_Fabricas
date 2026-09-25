'use strict';

const { Router } = require('express');
const { validar } = require('../middleware/validar');
const authSchemas = require('../schemas/auth.schema');
const { limitadorAutenticacao } = require('../middleware/rate-limit');
const { authController } = require('../controllers/auth.controller');
const { exigirSessao } = require('../middleware/autenticacao');

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
 * teste, só `controller`, `limitador` e `exigirSessao` legitimamente
 * precisam variar (nos testes, cada um é construído com um pool/limite
 * exclusivo daquele arquivo — nunca o pool global nem o limitador de
 * produção).
 *
 * Ordem dos middlewares em /auth/login: limitador (barra volume por IP
 * antes de qualquer outro custo) -> validar (rejeita corpo malformado
 * antes do controller) -> controller.login.
 *
 * /auth/me fica atrás de exigirSessao: só alcança o controller quando o
 * cookie corresponde a uma sessão validada no PostgreSQL. Não leva
 * `validar` (não tem corpo) nem `limitadorAutenticacao` (não envolve
 * verificação de senha, só herda limitadorGeral já aplicado a todo /api
 * em app.js).
 *
 * /auth/logout NÃO fica atrás de exigirSessao, de propósito: o controller
 * já trata cookie ausente/malformado/duplicado/sessão inválida de forma
 * idempotente (200, sem revogar nada) — colocá-la atrás do middleware
 * estrito produziria 401 exatamente nesses casos, que aqui são sucesso.
 * Não leva `validar` (sem corpo) nem `limitadorAutenticacao` (mesma razão
 * de /me). A proteção de origem/CSRF de app.js (verificarOrigem) continua
 * se aplicando: POST não é método seguro, e essa camada é global a /api,
 * anterior a esta rota.
 *
 * Caminhos finais, quando montado por app.js sob /api:
 *   POST /api/auth/login
 *   GET  /api/auth/me
 *   GET  /api/auth/permissoes   (Bloco 9, Etapa C, Parte C1)
 *   POST /api/auth/logout
 */

function criarAuthRoutes({ controller, limitador, exigirSessao: exigirSessaoInjetado }) {
  const router = Router();

  router.post('/auth/login', limitador, validar({ body: authSchemas.login.body }), controller.login);
  router.get('/auth/me', exigirSessaoInjetado, controller.me);
  // Bloco 9, Etapa C, Parte C1: permissões efetivas do usuário da sessão.
  // Só leitura, sem corpo/query/params: empresa e usuário vêm da sessão.
  router.get('/auth/permissoes', exigirSessaoInjetado, controller.permissoes);
  router.post('/auth/logout', controller.logout);

  return router;
}

const authRoutes = criarAuthRoutes({ controller: authController, limitador: limitadorAutenticacao, exigirSessao });

module.exports = { criarAuthRoutes, authRoutes };
