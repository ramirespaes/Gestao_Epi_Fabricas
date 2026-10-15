'use strict';

const { Router } = require('express');
const { validar } = require('../middleware/validar');
const { criarLimitador } = require('../middleware/rate-limit');
const { criarExigirDispositivo } = require('../middleware/autenticacao-dispositivo');
const { LIMITE_ESTADO_POR_IP, LIMITE_POR_DISPOSITIVO, chavePorDispositivo } = require('./token-tablet.routes');
const schemas = require('../schemas/token-solicitacoes.schema');
const { tokenSolicitacoesController } = require('../controllers/token-solicitacoes.controller');
const { pool } = require('../config/database');

/**
 * Atendimento Token — solicitações existentes do funcionário do atendimento atual (Etapa G).
 *
 *   GET /api/atendimento-token/tablet/atendimento/solicitacoes      sem parâmetros; só leitura
 *
 * Não é a recuperação da resposta original do pedido (Etapa F, `…/pedidos/:chave`): é a consulta posterior a uma identificação válida.
 * Sob o prefixo do atendimento da Etapa D: o cookie `gepi_atendimento` chega aqui; nenhum cookie, verbo ou autenticação novos. Ordem: limite
 * por IP (folgado; o NAT soma vários tablets) → validação (query vazia, ANTES de qualquer consulta ao banco) → tablet autenticado (Etapa C) →
 * limite POR TABLET (chave do servidor; em memória do processo) → controller. Não há sessão administrativa nem RBAC.
 */

const RAIZ = '/atendimento-token/tablet/atendimento/solicitacoes';

function criarTokenSolicitacoesRoutes({ controller, pool: poolInjetado, limitador, limitadorDispositivo }) {
  const router = Router();
  const porIp = limitador ?? criarLimitador(LIMITE_ESTADO_POR_IP);
  const porTablet = limitadorDispositivo ?? criarLimitador({ ...LIMITE_POR_DISPOSITIVO, chave: chavePorDispositivo });
  const exigirDispositivo = criarExigirDispositivo({ pool: poolInjetado });

  router.get(RAIZ, porIp, validar({ query: schemas.obter.query }), exigirDispositivo, porTablet, controller.obter);
  return router;
}

const tokenSolicitacoesRoutes = criarTokenSolicitacoesRoutes({ controller: tokenSolicitacoesController, pool });

module.exports = { criarTokenSolicitacoesRoutes, tokenSolicitacoesRoutes };
