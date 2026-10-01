'use strict';

const { Router } = require('express');
const { validar } = require('../middleware/validar');
const schemas = require('../schemas/recuperacao-senha.schema');
const {
  limitadorRecuperacaoSenhaSolicitar,
  limitadorRecuperacaoSenhaRedefinir,
  limitadorPlataformaRecuperacaoSenhaSolicitar,
  limitadorPlataformaRecuperacaoSenhaRedefinir,
} = require('../middleware/rate-limit');
const { exigirTurnstileRecuperacaoSenha } = require('../middleware/turnstile');
const { turnstileRecuperacaoSenhaController } = require('../controllers/turnstile.controller');
const {
  recuperacaoSenhaPortalController,
  recuperacaoSenhaPlataformaController,
} = require('../controllers/recuperacao-senha.controller');

/**
 * Rotas públicas da recuperação de senha, uma fábrica por portal.
 *
 * Portal do Cliente (cadeia /api):
 *   POST /auth/global/recuperacao-senha/solicitar   e-mail + token do Turnstile -> 202 genérico
 *   POST /auth/global/recuperacao-senha/redefinir   token + nova senha -> 200
 *   GET  /auth/global/recuperacao-senha/turnstile   site key e action do widget
 *
 * Painel Privado (cadeia /api/plataforma), sem Turnstile:
 *   POST /auth/recuperacao-senha/solicitar
 *   POST /auth/recuperacao-senha/redefinir
 *
 * Cada POST tem o próprio limitador por IP, sempre o primeiro da cadeia. O
 * token de redefinição só existe no corpo: a query é validada como vazia.
 */

function conferirBase({ controller, limitadorSolicitar, limitadorRedefinir }) {
  if (!controller || typeof controller.solicitar !== 'function' || typeof controller.redefinir !== 'function') {
    throw new TypeError('controller é obrigatório na recuperação de senha');
  }
  if (typeof limitadorSolicitar !== 'function' || typeof limitadorRedefinir !== 'function') {
    throw new TypeError('os dois limitadores são obrigatórios na recuperação de senha');
  }
  if (limitadorSolicitar === limitadorRedefinir) {
    throw new TypeError('solicitar e redefinir exigem limitadores independentes');
  }
}

function criarRecuperacaoSenhaPortalRoutes({
  controller, limitadorSolicitar, limitadorRedefinir, exigirTurnstile, turnstileController,
} = {}) {
  conferirBase({ controller, limitadorSolicitar, limitadorRedefinir });
  if (typeof exigirTurnstile !== 'function') {
    throw new TypeError('exigirTurnstile é obrigatório na solicitação do Portal');
  }
  if (!turnstileController || typeof turnstileController.configuracao !== 'function') {
    throw new TypeError('turnstileController é obrigatório na recuperação de senha do Portal');
  }
  const router = Router();

  router.post(
    '/auth/global/recuperacao-senha/solicitar',
    limitadorSolicitar,
    validar({ query: schemas.solicitarPortal.query, body: schemas.solicitarPortal.body }),
    exigirTurnstile,
    controller.solicitar,
  );
  router.post(
    '/auth/global/recuperacao-senha/redefinir',
    limitadorRedefinir,
    validar({ query: schemas.redefinir.query, body: schemas.redefinir.body }),
    controller.redefinir,
  );
  router.get('/auth/global/recuperacao-senha/turnstile', turnstileController.configuracao);

  return router;
}

function criarRecuperacaoSenhaPlataformaRoutes({ controller, limitadorSolicitar, limitadorRedefinir } = {}) {
  conferirBase({ controller, limitadorSolicitar, limitadorRedefinir });
  const router = Router();

  router.post(
    '/auth/recuperacao-senha/solicitar',
    limitadorSolicitar,
    validar({ query: schemas.solicitarPlataforma.query, body: schemas.solicitarPlataforma.body }),
    controller.solicitar,
  );
  router.post(
    '/auth/recuperacao-senha/redefinir',
    limitadorRedefinir,
    validar({ query: schemas.redefinir.query, body: schemas.redefinir.body }),
    controller.redefinir,
  );

  return router;
}

const recuperacaoSenhaPortalRoutes = criarRecuperacaoSenhaPortalRoutes({
  controller: recuperacaoSenhaPortalController,
  limitadorSolicitar: limitadorRecuperacaoSenhaSolicitar,
  limitadorRedefinir: limitadorRecuperacaoSenhaRedefinir,
  exigirTurnstile: exigirTurnstileRecuperacaoSenha,
  turnstileController: turnstileRecuperacaoSenhaController,
});

const recuperacaoSenhaPlataformaRoutes = criarRecuperacaoSenhaPlataformaRoutes({
  controller: recuperacaoSenhaPlataformaController,
  limitadorSolicitar: limitadorPlataformaRecuperacaoSenhaSolicitar,
  limitadorRedefinir: limitadorPlataformaRecuperacaoSenhaRedefinir,
});

module.exports = {
  criarRecuperacaoSenhaPortalRoutes,
  criarRecuperacaoSenhaPlataformaRoutes,
  recuperacaoSenhaPortalRoutes,
  recuperacaoSenhaPlataformaRoutes,
};
