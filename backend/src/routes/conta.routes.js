'use strict';

const { Router } = require('express');
const { validar } = require('../middleware/validar');
const schemas = require('../schemas/conta.schema');
const { limitadorTrocaEmail } = require('../middleware/rate-limit');
const { exigirSessaoGlobal } = require('../middleware/autenticacao-global');
const { contaController } = require('../controllers/conta.controller');

/**
 * Rotas das Configurações (Portal do Cliente, sessão GLOBAL):
 *
 *   PATCH /api/auth/global/conta   telefone, tema e modo visual da própria identidade
 *   PATCH /api/auth/global/email   e-mail de acesso, com a senha atual (limitador próprio)
 *
 * A leitura é das rotas que já existiam: GET /auth/global/me (conta e
 * preferências da identidade) e GET /auth/me (preferências na sessão
 * empresarial). O cliente nunca informa identidade ou usuário: a sessão
 * decide quem é alterado.
 */

function conferir({ controller, limitadorEmail, exigirSessao }) {
  if (!controller || typeof controller.atualizar !== 'function' || typeof controller.trocarEmail !== 'function') {
    throw new TypeError('controller das Configurações é obrigatório');
  }
  if (typeof limitadorEmail !== 'function') {
    throw new TypeError('limitadorEmail é obrigatório');
  }
  if (typeof exigirSessao !== 'function') {
    throw new TypeError('exigirSessaoGlobal é obrigatório');
  }
}

function criarContaRoutes({ controller, limitadorEmail, exigirSessaoGlobal: exigirSessao } = {}) {
  conferir({ controller, limitadorEmail, exigirSessao });
  const router = Router();
  router.patch(
    '/auth/global/conta',
    exigirSessao,
    validar({ query: schemas.atualizar.query, body: schemas.atualizar.body }),
    controller.atualizar,
  );
  router.patch(
    '/auth/global/email',
    limitadorEmail,
    exigirSessao,
    validar({ query: schemas.trocarEmail.query, body: schemas.trocarEmail.body }),
    controller.trocarEmail,
  );
  return router;
}

const contaRoutes = criarContaRoutes({ controller: contaController, limitadorEmail: limitadorTrocaEmail, exigirSessaoGlobal });

module.exports = { criarContaRoutes, contaRoutes };
