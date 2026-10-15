'use strict';

const { Router } = require('express');
const { validar } = require('../middleware/validar');
const { criarLimitador } = require('../middleware/rate-limit');
const { criarExigirDispositivo } = require('../middleware/autenticacao-dispositivo');
const { LIMITE_ESTADO_POR_IP, LIMITE_POR_DISPOSITIVO, chavePorDispositivo } = require('./token-tablet.routes');
const schemas = require('../schemas/token-pedido.schema');
const { tokenPedidoController } = require('../controllers/token-pedido.controller');
const { pool } = require('../config/database');

/**
 * Atendimento Token — pedido do funcionário identificado (Etapa F).
 *
 *   POST /api/atendimento-token/tablet/atendimento/pedido          { chaveIdempotencia, itens }   finaliza (cria a solicitação AUTOATENDIMENTO)
 *   GET  /api/atendimento-token/tablet/atendimento/pedidos/:chave  resultado da finalização com a chave (nunca cria, nunca renova)
 *
 * Sob o prefixo do atendimento da Etapa D: o cookie `gepi_atendimento` chega a elas; só GET e POST. Ordem: limite por IP (folgado; o NAT soma vários
 * tablets) → validação (antes do banco) → tablet autenticado (Etapa C) → limite POR TABLET (chave do servidor) → controller. O limite por tablet é
 * SEPARADO para finalizar e para consultar o resultado: o abuso de uma rota não impede a recuperação legítima pela outra. Os contadores são em
 * memória do processo (com várias instâncias o limite efetivo se multiplica). Sem sessão administrativa nem RBAC: quem pede é o funcionário
 * identificado pelo atendimento.
 */

const RAIZ = '/atendimento-token/tablet/atendimento';

function criarTokenPedidoRoutes({ controller, pool: poolInjetado, limitador, limitadorDispositivo }) {
  const router = Router();
  const porIp = limitador ?? criarLimitador(LIMITE_ESTADO_POR_IP);
  const porTabletFinalizar = limitadorDispositivo ?? criarLimitador({ ...LIMITE_POR_DISPOSITIVO, chave: chavePorDispositivo });
  const porTabletResultado = limitadorDispositivo ?? criarLimitador({ ...LIMITE_POR_DISPOSITIVO, chave: chavePorDispositivo });
  const exigirDispositivo = criarExigirDispositivo({ pool: poolInjetado });

  router.post(`${RAIZ}/pedido`, porIp, validar({ query: schemas.finalizar.query, body: schemas.finalizar.body }), exigirDispositivo, porTabletFinalizar, controller.finalizar);
  router.get(`${RAIZ}/pedidos/:chave`, porIp, validar({ params: schemas.resultado.params, query: schemas.resultado.query }), exigirDispositivo, porTabletResultado, controller.resultado);
  return router;
}

const tokenPedidoRoutes = criarTokenPedidoRoutes({ controller: tokenPedidoController, pool });

module.exports = { criarTokenPedidoRoutes, tokenPedidoRoutes };
