'use strict';

const { Router } = require('express');
const { validar } = require('../middleware/validar');
const schemas = require('../schemas/tipo-material.schema');
const { tipoMaterialController } = require('../controllers/tipo-material.controller');
const { exigirSessao } = require('../middleware/autenticacao');
const { criarExigirPermissaoRecurso } = require('../middleware/autorizacao');
const { pool } = require('../config/database');

/**
 * Catálogo de tipos de material (classificação V2), dentro de Materiais / Gestão de Estoque. Reusa o recurso RBAC
 * `materials` (decisão de 08/10/2026, sem recurso novo): consultar = visualizar; criar = criar; inativar/reativar = editar.
 * Sem rota de exclusão e sem importação em massa.
 *
 *   GET  /api/tipos-material
 *   POST /api/tipos-material
 *   POST /api/tipos-material/:id/inativar
 *   POST /api/tipos-material/:id/reativar
 */

const RECURSO = 'materials';

function criarTipoMaterialRoutes({ controller, exigirSessao: exigirSessaoInjetado, pool: poolInjetado }) {
  const router = Router();
  const exigirVisualizar = criarExigirPermissaoRecurso({ pool: poolInjetado }, RECURSO, 'visualizar');
  const exigirCriar = criarExigirPermissaoRecurso({ pool: poolInjetado }, RECURSO, 'criar');
  const exigirEditar = criarExigirPermissaoRecurso({ pool: poolInjetado }, RECURSO, 'editar');

  router.get('/tipos-material', exigirSessaoInjetado, exigirVisualizar, validar({ query: schemas.listar.query }), controller.listar);
  router.post('/tipos-material', exigirSessaoInjetado, exigirCriar, validar({ body: schemas.criar.body }), controller.criar);
  router.post('/tipos-material/:id/inativar', exigirSessaoInjetado, exigirEditar, validar({ params: schemas.inativar.params, body: schemas.inativar.body }), controller.inativar);
  router.post('/tipos-material/:id/reativar', exigirSessaoInjetado, exigirEditar, validar({ params: schemas.reativar.params, body: schemas.reativar.body }), controller.reativar);
  return router;
}

const tipoMaterialRoutes = criarTipoMaterialRoutes({ controller: tipoMaterialController, exigirSessao, pool });

module.exports = { criarTipoMaterialRoutes, tipoMaterialRoutes, RECURSO };
