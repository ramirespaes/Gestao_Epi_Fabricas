'use strict';

const { Router } = require('express');
const { validar } = require('../middleware/validar');
const schemas = require('../schemas/dashboard.schema');
const { dashboardController } = require('../controllers/dashboard.controller');
const { exigirSessao } = require('../middleware/autenticacao');
const { criarExigirPermissaoRecurso } = require('../middleware/autorizacao');
const { pool } = require('../config/database');

/**
 * Rota do dashboard (Bloco 9, Etapa C, Parte C6), somente leitura:
 *   GET /api/dashboard/indicadores
 * exigirSessao -> criarExigirPermissaoRecurso('dashboard', 'visualizar')
 * -> validar -> controller. Recurso `dashboard` já existente no catálogo
 * (frontend legado); cada indicador ainda exige a permissão da sua fonte.
 */

const RECURSO = 'dashboard';

function criarDashboardRoutes({ controller, exigirSessao: exigirSessaoInjetado, pool: poolInjetado }) {
  const router = Router();
  const exigirVisualizar = criarExigirPermissaoRecurso({ pool: poolInjetado }, RECURSO, 'visualizar');
  router.get('/dashboard/indicadores', exigirSessaoInjetado, exigirVisualizar, validar({ query: schemas.indicadores.query }), controller.indicadores);
  return router;
}

const dashboardRoutes = criarDashboardRoutes({ controller: dashboardController, exigirSessao, pool });

module.exports = { criarDashboardRoutes, dashboardRoutes, RECURSO };
