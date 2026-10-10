'use strict';

const { Router } = require('express');
const { validar } = require('../middleware/validar');
const schemas = require('../schemas/ghe-tipo-material.schema');
const { gheTipoMaterialController } = require('../controllers/ghe-tipo-material.controller');
const { exigirSessao } = require('../middleware/autenticacao');
const { criarExigirPermissaoRecurso } = require('../middleware/autorizacao');
const { pool } = require('../config/database');

/**
 * Rotas do vínculo GHE × tipo de material (evolução GHE / importação GHE-EPI, Incremento 3), no desenho de
 * ghe-material.routes.js: exigirSessao -> criarExigirPermissaoRecurso -> validar -> controller.
 *
 * RBAC: reutiliza `employeeGroups` (nenhum recurso novo) — visualizar consulta a matriz; editar vincula, troca a
 * classificação e remove.
 *
 * Caminhos, sob /api:
 *   GET    /api/grupos-homogeneos/:id/tipos-material
 *   PUT    /api/grupos-homogeneos/:id/tipos-material/:tipoId   { classificacao }
 *   DELETE /api/grupos-homogeneos/:id/tipos-material/:tipoId
 */

const RECURSO = 'employeeGroups';

function criarGheTipoMaterialRoutes({ controller, exigirSessao: exigirSessaoInjetado, pool: poolInjetado }) {
  const router = Router();

  const exigirVisualizar = criarExigirPermissaoRecurso({ pool: poolInjetado }, RECURSO, 'visualizar');
  const exigirEditar = criarExigirPermissaoRecurso({ pool: poolInjetado }, RECURSO, 'editar');

  router.get('/grupos-homogeneos/:id/tipos-material', exigirSessaoInjetado, exigirVisualizar, validar({ params: schemas.consultar.params }), controller.consultar);
  router.put('/grupos-homogeneos/:id/tipos-material/:tipoId', exigirSessaoInjetado, exigirEditar, validar({ params: schemas.definir.params, body: schemas.definir.body }), controller.definir);
  router.delete('/grupos-homogeneos/:id/tipos-material/:tipoId', exigirSessaoInjetado, exigirEditar, validar({ params: schemas.desvincular.params, body: schemas.desvincular.body }), controller.desvincular);

  return router;
}

const gheTipoMaterialRoutes = criarGheTipoMaterialRoutes({ controller: gheTipoMaterialController, exigirSessao, pool });

module.exports = { criarGheTipoMaterialRoutes, gheTipoMaterialRoutes, RECURSO };
