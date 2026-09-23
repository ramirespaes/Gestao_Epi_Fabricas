'use strict';

const { Router } = require('express');
const { validar } = require('../middleware/validar');
const funcionarioSchemas = require('../schemas/funcionario.schema');
const { funcionarioController } = require('../controllers/funcionario.controller');
const { exigirSessao } = require('../middleware/autenticacao');
const { criarExigirPermissaoRecurso } = require('../middleware/autorizacao');
const { pool } = require('../config/database');

/**
 * Rotas de funcionários (Bloco 9, Etapa B). Mesmo desenho de
 * material.routes.js: exigirSessao -> criarExigirPermissaoRecurso ->
 * validar -> controller.
 *
 * Recurso `'employeeHistory'` — o identificador que a página legada de
 * funcionários já usa (js/main.js, convenção da migration 009). Nenhuma
 * destas rotas alcança `usuarios`: funcionário (quem recebe EPI) e usuário
 * (conta de acesso) são cadastros separados, cada um com seu recurso RBAC.
 *
 * Sem rota de exclusão: funcionário é inativado; matrícula e CPF
 * continuam reservados (migration 006).
 *
 * Caminhos, sob /api:
 *   POST  /api/funcionarios
 *   GET   /api/funcionarios
 *   GET   /api/funcionarios/:id
 *   PATCH /api/funcionarios/:id
 *   POST  /api/funcionarios/:id/inativar
 *   POST  /api/funcionarios/:id/reativar
 */

const RECURSO = 'employeeHistory';

function criarFuncionarioRoutes({ controller, exigirSessao: exigirSessaoInjetado, pool: poolInjetado }) {
  const router = Router();

  const exigirVisualizar = criarExigirPermissaoRecurso({ pool: poolInjetado }, RECURSO, 'visualizar');
  const exigirCriar = criarExigirPermissaoRecurso({ pool: poolInjetado }, RECURSO, 'criar');
  const exigirEditar = criarExigirPermissaoRecurso({ pool: poolInjetado }, RECURSO, 'editar');

  router.post('/funcionarios', exigirSessaoInjetado, exigirCriar, validar({ body: funcionarioSchemas.criar.body }), controller.criar);
  router.get('/funcionarios', exigirSessaoInjetado, exigirVisualizar, validar({ query: funcionarioSchemas.listar.query }), controller.listar);
  router.get('/funcionarios/:id', exigirSessaoInjetado, exigirVisualizar, validar({ params: funcionarioSchemas.buscar.params }), controller.buscar);
  router.patch('/funcionarios/:id', exigirSessaoInjetado, exigirEditar, validar({ params: funcionarioSchemas.alterar.params, body: funcionarioSchemas.alterar.body }), controller.alterar);
  router.post('/funcionarios/:id/inativar', exigirSessaoInjetado, exigirEditar, validar({ params: funcionarioSchemas.inativar.params, body: funcionarioSchemas.inativar.body }), controller.inativar);
  router.post('/funcionarios/:id/reativar', exigirSessaoInjetado, exigirEditar, validar({ params: funcionarioSchemas.reativar.params, body: funcionarioSchemas.reativar.body }), controller.reativar);

  return router;
}

const funcionarioRoutes = criarFuncionarioRoutes({ controller: funcionarioController, exigirSessao, pool });

module.exports = { criarFuncionarioRoutes, funcionarioRoutes, RECURSO };
