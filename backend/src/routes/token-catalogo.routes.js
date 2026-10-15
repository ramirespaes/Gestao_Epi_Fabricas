'use strict';

const { Router } = require('express');
const { validar } = require('../middleware/validar');
const { criarLimitador } = require('../middleware/rate-limit');
const { criarExigirDispositivo } = require('../middleware/autenticacao-dispositivo');
const { LIMITE_ESTADO_POR_IP, LIMITE_POR_DISPOSITIVO, chavePorDispositivo } = require('./token-tablet.routes');
const schemas = require('../schemas/token-catalogo.schema');
const { tokenCatalogoController } = require('../controllers/token-catalogo.controller');
const { pool } = require('../config/database');

/**
 * Atendimento Token — catálogo de materiais do atendimento (Etapa E).
 *
 *   GET /api/atendimento-token/tablet/atendimento/catalogo      sem parâmetros; só leitura
 *
 * Sob o prefixo do atendimento da Etapa D: o cookie `gepi_atendimento` (Path = a base do atendimento) chega aqui; nenhum cookie, verbo ou
 * autenticação novos. Ordem: limite por IP (folgado; o NAT soma vários tablets) → validação (query vazia, ANTES de qualquer consulta ao
 * banco) → tablet autenticado (Etapa C) → limite POR TABLET (chave do servidor) → controller. Não há sessão administrativa nem RBAC.
 */

const RAIZ = '/atendimento-token/tablet/atendimento/catalogo';

function criarTokenCatalogoRoutes({ controller, pool: poolInjetado, limitador, limitadorDispositivo }) {
  const router = Router();
  const porIp = limitador ?? criarLimitador(LIMITE_ESTADO_POR_IP);
  const porTablet = limitadorDispositivo ?? criarLimitador({ ...LIMITE_POR_DISPOSITIVO, chave: chavePorDispositivo });
  const exigirDispositivo = criarExigirDispositivo({ pool: poolInjetado });

  router.get(RAIZ, porIp, validar({ query: schemas.obter.query }), exigirDispositivo, porTablet, controller.obter);
  return router;
}

const tokenCatalogoRoutes = criarTokenCatalogoRoutes({ controller: tokenCatalogoController, pool });

module.exports = { criarTokenCatalogoRoutes, tokenCatalogoRoutes };
