'use strict';

const { Router } = require('express');
const { lgpdController } = require('../controllers/lgpd.controller');
const { exigirSessao } = require('../middleware/autenticacao');
const { criarExigirPermissaoRecurso } = require('../middleware/autorizacao');
const { pool } = require('../config/database');

/**
 * Privacidade e LGPD (Portal). Recurso RBAC `lgpd`, operação `visualizar` (Bloco A1):
 *
 *   GET /api/lgpd/resumo   (lgpd.visualizar)
 *
 * Única rota do módulo nesta etapa, somente de leitura. Escrita (editar) e ações sensíveis são decisão futura.
 */

const RECURSO = 'lgpd';

function criarLgpdRoutes({ controller, exigirSessao: exigirSessaoInjetado, pool: poolInjetado }) {
  const router = Router();
  const exigirVisualizar = criarExigirPermissaoRecurso({ pool: poolInjetado }, RECURSO, 'visualizar');

  router.get('/lgpd/resumo', exigirSessaoInjetado, exigirVisualizar, controller.resumo);
  return router;
}

const lgpdRoutes = criarLgpdRoutes({ controller: lgpdController, exigirSessao, pool });

module.exports = { criarLgpdRoutes, lgpdRoutes, RECURSO };
