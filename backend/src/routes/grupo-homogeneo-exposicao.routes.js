'use strict';

const { Router } = require('express');
const { validar } = require('../middleware/validar');
const gheSchemas = require('../schemas/grupo-homogeneo-exposicao.schema');
const { grupoHomogeneoExposicaoController } = require('../controllers/grupo-homogeneo-exposicao.controller');
const { exigirSessao } = require('../middleware/autenticacao');
const { criarExigirPermissaoRecurso } = require('../middleware/autorizacao');
const { pool } = require('../config/database');

/**
 * Rotas de GHE (Bloco 9, Etapa B). Mesmo desenho de material.routes.js:
 * exigirSessao -> criarExigirPermissaoRecurso -> validar -> controller.
 *
 * Recurso `'employeeGroups'` — identificador definido no planejamento do
 * Bloco 9 (seção 10.2), conferido contra FORMATO_RECURSO do middleware e
 * contra os identificadores do frontend legado (não colide com nenhum).
 * Distinto de `'employeeHistory'` de propósito: administrar GHE e
 * administrar funcionários são autoridades independentes.
 *
 * Sem rota de exclusão: GHE é inativado.
 *
 * Caminhos, sob /api:
 *   POST  /api/grupos-homogeneos
 *   GET   /api/grupos-homogeneos
 *   GET   /api/grupos-homogeneos/:id
 *   PATCH /api/grupos-homogeneos/:id
 *   POST  /api/grupos-homogeneos/:id/inativar
 *   POST  /api/grupos-homogeneos/:id/reativar
 */

const RECURSO = 'employeeGroups';

function criarGrupoHomogeneoExposicaoRoutes({ controller, exigirSessao: exigirSessaoInjetado, pool: poolInjetado }) {
  const router = Router();

  const exigirVisualizar = criarExigirPermissaoRecurso({ pool: poolInjetado }, RECURSO, 'visualizar');
  const exigirCriar = criarExigirPermissaoRecurso({ pool: poolInjetado }, RECURSO, 'criar');
  const exigirEditar = criarExigirPermissaoRecurso({ pool: poolInjetado }, RECURSO, 'editar');

  router.post('/grupos-homogeneos', exigirSessaoInjetado, exigirCriar, validar({ body: gheSchemas.criar.body }), controller.criar);
  router.get('/grupos-homogeneos', exigirSessaoInjetado, exigirVisualizar, validar({ query: gheSchemas.listar.query }), controller.listar);
  router.get('/grupos-homogeneos/:id', exigirSessaoInjetado, exigirVisualizar, validar({ params: gheSchemas.buscar.params }), controller.buscar);
  router.patch('/grupos-homogeneos/:id', exigirSessaoInjetado, exigirEditar, validar({ params: gheSchemas.alterar.params, body: gheSchemas.alterar.body }), controller.alterar);
  router.post('/grupos-homogeneos/:id/inativar', exigirSessaoInjetado, exigirEditar, validar({ params: gheSchemas.inativar.params, body: gheSchemas.inativar.body }), controller.inativar);
  router.post('/grupos-homogeneos/:id/reativar', exigirSessaoInjetado, exigirEditar, validar({ params: gheSchemas.reativar.params, body: gheSchemas.reativar.body }), controller.reativar);

  return router;
}

const grupoHomogeneoExposicaoRoutes = criarGrupoHomogeneoExposicaoRoutes({ controller: grupoHomogeneoExposicaoController, exigirSessao, pool });

module.exports = { criarGrupoHomogeneoExposicaoRoutes, grupoHomogeneoExposicaoRoutes, RECURSO };
