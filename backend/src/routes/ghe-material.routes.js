'use strict';

const { Router } = require('express');
const { validar } = require('../middleware/validar');
const schemas = require('../schemas/ghe-material.schema');
const { gheMaterialController } = require('../controllers/ghe-material.controller');
const { exigirSessao } = require('../middleware/autenticacao');
const { criarExigirPermissaoRecurso } = require('../middleware/autorizacao');
const { pool } = require('../config/database');

/**
 * Rotas da matriz GHE × EPI (Bloco 9, Etapa C, Parte C5), sob o recurso do
 * próprio GHE. Mesmo desenho de grupo-homogeneo-exposicao.routes.js:
 * exigirSessao -> criarExigirPermissaoRecurso -> validar -> controller.
 *
 * RBAC: reutiliza `employeeGroups` (nenhum recurso novo) — visualizar
 * consulta a matriz; editar inclui e remove vínculos.
 *
 * Caminhos, sob /api:
 *   GET    /api/grupos-homogeneos/:id/materiais
 *   POST   /api/grupos-homogeneos/:id/materiais
 *   DELETE /api/grupos-homogeneos/:id/materiais/:materialId
 */

const RECURSO = 'employeeGroups';

function criarGheMaterialRoutes({ controller, exigirSessao: exigirSessaoInjetado, pool: poolInjetado }) {
  const router = Router();

  const exigirVisualizar = criarExigirPermissaoRecurso({ pool: poolInjetado }, RECURSO, 'visualizar');
  const exigirEditar = criarExigirPermissaoRecurso({ pool: poolInjetado }, RECURSO, 'editar');

  router.get('/grupos-homogeneos/:id/materiais', exigirSessaoInjetado, exigirVisualizar, validar({ params: schemas.consultar.params }), controller.consultar);
  router.post('/grupos-homogeneos/:id/materiais', exigirSessaoInjetado, exigirEditar, validar({ params: schemas.vincular.params, body: schemas.vincular.body }), controller.vincular);
  router.delete('/grupos-homogeneos/:id/materiais/:materialId', exigirSessaoInjetado, exigirEditar, validar({ params: schemas.desvincular.params, body: schemas.desvincular.body }), controller.desvincular);

  return router;
}

const gheMaterialRoutes = criarGheMaterialRoutes({ controller: gheMaterialController, exigirSessao, pool });

module.exports = { criarGheMaterialRoutes, gheMaterialRoutes, RECURSO };
