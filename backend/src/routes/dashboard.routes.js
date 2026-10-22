'use strict';

const { Router } = require('express');
const { validar } = require('../middleware/validar');
const schemas = require('../schemas/dashboard.schema');
const { dashboardController } = require('../controllers/dashboard.controller');
const { exigirSessao } = require('../middleware/autenticacao');
const { criarExigirPermissaoRecurso } = require('../middleware/autorizacao');
const { pool } = require('../config/database');

/**
 * Rotas do dashboard (Bloco 9, Etapa C, Parte C6; gráficos na 12I), somente leitura:
 *   GET /api/dashboard/indicadores
 *   GET /api/dashboard/graficos/setores?periodo=
 *   GET /api/dashboard/graficos/epis-entregues?periodo=
 * exigirSessao -> criarExigirPermissaoRecurso('dashboard', 'visualizar')
 * -> validar -> controller. Recurso `dashboard` já existente no catálogo
 * (frontend legado); cada indicador ainda exige a permissão da sua fonte.
 */

const RECURSO = 'dashboard';

function criarDashboardRoutes({ controller, exigirSessao: exigirSessaoInjetado, pool: poolInjetado }) {
  const router = Router();
  const exigirVisualizar = criarExigirPermissaoRecurso({ pool: poolInjetado }, RECURSO, 'visualizar');
  router.get('/dashboard/indicadores', exigirSessaoInjetado, exigirVisualizar, validar({ query: schemas.indicadores.query }), controller.indicadores);
  // 12I — gráficos (mesma autoridade da página; cada gráfico ainda exige a permissão da sua fonte, no serviço).
  const validarGrafico = validar({ query: schemas.graficos.query });
  router.get('/dashboard/graficos/setores', exigirSessaoInjetado, exigirVisualizar, validarGrafico, controller.graficoSetores);
  router.get('/dashboard/graficos/epis-entregues', exigirSessaoInjetado, exigirVisualizar, validarGrafico, controller.graficoEpisEntregues);
  return router;
}

const dashboardRoutes = criarDashboardRoutes({ controller: dashboardController, exigirSessao, pool });

module.exports = { criarDashboardRoutes, dashboardRoutes, RECURSO };
