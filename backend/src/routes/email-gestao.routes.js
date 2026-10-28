'use strict';

const { Router } = require('express');
const { emailGestaoController } = require('../controllers/email-gestao.controller');
const { exigirSessao } = require('../middleware/autenticacao');
const { criarExigirPermissaoRecurso } = require('../middleware/autorizacao');
const { pool } = require('../config/database');

/**
 * Gestão de E-mails (Portal). Recurso RBAC `emailsGestao`, operação `visualizar` (Bloco A1):
 *
 *   GET /api/emails/resumo   (emailsGestao.visualizar)
 *
 * Única rota do módulo nesta etapa, somente de leitura. Histórico, destinatários, reenvio e edição de template são decisão futura.
 */

const RECURSO = 'emailsGestao';

function criarEmailGestaoRoutes({ controller, exigirSessao: exigirSessaoInjetado, pool: poolInjetado }) {
  const router = Router();
  const exigirVisualizar = criarExigirPermissaoRecurso({ pool: poolInjetado }, RECURSO, 'visualizar');

  router.get('/emails/resumo', exigirSessaoInjetado, exigirVisualizar, controller.resumo);
  return router;
}

const emailGestaoRoutes = criarEmailGestaoRoutes({ controller: emailGestaoController, exigirSessao, pool });

module.exports = { criarEmailGestaoRoutes, emailGestaoRoutes, RECURSO };
