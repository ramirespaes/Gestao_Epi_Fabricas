'use strict';

const { Router } = require('express');
const { validar } = require('../middleware/validar');
const schemas = require('../schemas/relatorio.schema');
const { relatorioController } = require('../controllers/relatorio.controller');
const { exigirSessao } = require('../middleware/autenticacao');
const { criarExigirPermissaoRecurso } = require('../middleware/autorizacao');
const { pool } = require('../config/database');

/**
 * Relatórios (12K-D, etapa 1), só leitura. Autoridade por fonte, sem permissão nova:
 *   estoque            -> `materials`.visualizar (ver saldo é parte de ver o material)
 *   entregas (3 abas)  -> `epiFicha`.visualizar (a mesma do histórico da 12K-C)
 *   GET /api/relatorios/estoque
 *   GET /api/relatorios/proximo-vencimento
 *   GET /api/relatorios/vencidos
 *   GET /api/relatorios/epis-entregues
 */
function criarRelatorioRoutes({ controller, exigirSessao: sessao, pool: poolInjetado }) {
  const router = Router();
  const exigirVisualizarMaterial = criarExigirPermissaoRecurso({ pool: poolInjetado }, 'materials', 'visualizar');
  const exigirVisualizarFicha = criarExigirPermissaoRecurso({ pool: poolInjetado }, 'epiFicha', 'visualizar');

  router.get('/relatorios/estoque', sessao, exigirVisualizarMaterial, validar({ query: schemas.estoque.query }), controller.estoque);
  router.get('/relatorios/proximo-vencimento', sessao, exigirVisualizarFicha, validar({ query: schemas.proximoVencimento.query }), controller.proximoVencimento);
  router.get('/relatorios/vencidos', sessao, exigirVisualizarFicha, validar({ query: schemas.vencidos.query }), controller.vencidos);
  router.get('/relatorios/epis-entregues', sessao, exigirVisualizarFicha, validar({ query: schemas.entregues.query }), controller.entregues);
  return router;
}

const relatorioRoutes = criarRelatorioRoutes({ controller: relatorioController, exigirSessao, pool });

module.exports = { criarRelatorioRoutes, relatorioRoutes };
