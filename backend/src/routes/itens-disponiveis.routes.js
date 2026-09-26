'use strict';

const { Router } = require('express');
const { validar } = require('../middleware/validar');
const schemas = require('../schemas/itens-disponiveis.schema');
const { criarItensDisponiveisController } = require('../controllers/itens-disponiveis.controller');
const { exigirSessao } = require('../middleware/autenticacao');
const { criarExigirPermissaoRecurso } = require('../middleware/autorizacao');
const { pool } = require('../config/database');

/**
 * GET /api/estoque/itens-disponiveis (Bloco 9, Etapa C, Parte C3).
 * Somente leitura. Permissão de RECURSO própria, `availableItems`
 * visualizar — independente de `materials`: ver itens disponíveis não
 * concede ver o cadastro, criar material nem movimentar estoque.
 * Caminho fora de /materiais para não colidir com GET /materiais/:id.
 */

const RECURSO = 'availableItems';

function criarItensDisponiveisRoutes({ controller, exigirSessao: exigirSessaoInjetado, pool: poolInjetado }) {
  const router = Router();
  const exigirVisualizar = criarExigirPermissaoRecurso({ pool: poolInjetado }, RECURSO, 'visualizar');
  router.get(
    '/estoque/itens-disponiveis',
    exigirSessaoInjetado, exigirVisualizar,
    validar({ query: schemas.listar.query }),
    controller.listar,
  );
  return router;
}

const itensDisponiveisRoutes = criarItensDisponiveisRoutes({ controller: criarItensDisponiveisController({ pool }), exigirSessao, pool });

module.exports = { criarItensDisponiveisRoutes, itensDisponiveisRoutes, RECURSO };
