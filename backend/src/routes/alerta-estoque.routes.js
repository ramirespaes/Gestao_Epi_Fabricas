'use strict';

const { Router } = require('express');
const { validar } = require('../middleware/validar');
const schemas = require('../schemas/alerta-estoque.schema');
const { alertaEstoqueController } = require('../controllers/alerta-estoque.controller');
const { exigirSessao } = require('../middleware/autenticacao');
const { criarExigirPermissaoAcao } = require('../middleware/autorizacao');
const { pool } = require('../config/database');

/**
 * Alerta manual de falta de estoque ("Gerar alerta", 12G-6):
 *   POST /api/alertas-estoque/falta   { solicitacaoId }
 * exigirSessao -> AÇÃO `REALIZAR_ENTREGA` pela autorização central (sem ação
 * nova) -> validar -> controller. Quem recebe (ENTRADA_ESTOQUE efetiva) e a
 * supressão do clique repetido são do serviço. O aviso automático de
 * disponibilidade não tem rota: é o processador por cron externo.
 */

const ACAO = 'REALIZAR_ENTREGA';

function criarAlertaEstoqueRoutes({ controller, exigirSessao: exigirSessaoInjetado, pool: poolInjetado }) {
  const router = Router();
  const exigirEntregar = criarExigirPermissaoAcao({ pool: poolInjetado }, ACAO);
  router.post('/alertas-estoque/falta', exigirSessaoInjetado, exigirEntregar, validar({ body: schemas.falta.body }), controller.falta);
  return router;
}

const alertaEstoqueRoutes = criarAlertaEstoqueRoutes({ controller: alertaEstoqueController, exigirSessao, pool });

module.exports = { criarAlertaEstoqueRoutes, alertaEstoqueRoutes, ACAO };
