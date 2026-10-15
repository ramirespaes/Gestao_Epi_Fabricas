'use strict';

const { Router } = require('express');
const { validar } = require('../middleware/validar');
const { criarLimitador } = require('../middleware/rate-limit');
const { criarExigirDispositivo } = require('../middleware/autenticacao-dispositivo');
const schemas = require('../schemas/token-heartbeat.schema');

/**
 * Atendimento Token — heartbeat do tablet (Etapa J, J2a). Sem sessão administrativa; a autenticação, a rede e a rotação da
 * credencial são as do exigirDispositivo EXISTENTE (D17), sem reimplementação.
 *
 *   POST /api/atendimento-token/tablet/heartbeat   cookie do tablet; corpo e query vazios
 *
 * Esta rota AINDA NÃO é montada em app.js: a montagem é uma etapa própria. Os limites seguem o das demais rotas do tablet: o
 * limite por IP é só contenção de inundação (vários tablets dividem o IP de saída) e o fino é por tablet, com a chave vinda do
 * servidor depois da autenticação. A ordem (limite por IP, validação, autenticação) é a do /estado.
 */

const LIMITE_POR_IP = Object.freeze({ limite: 600, janelaSegundos: 60 });
const LIMITE_POR_DISPOSITIVO = Object.freeze({ limite: 120, janelaSegundos: 60 });
const RAIZ = '/atendimento-token/tablet';

const chavePorDispositivo = (req) => `dispositivo:${req.dispositivo.empresaId}:${req.dispositivo.id}`;

function criarTokenHeartbeatRoutes({ controller, pool, limitador, limitadorDispositivo }) {
  const router = Router();
  const porIp = limitador ?? criarLimitador(LIMITE_POR_IP);
  const porDispositivo = limitadorDispositivo ?? criarLimitador({ ...LIMITE_POR_DISPOSITIVO, chave: chavePorDispositivo });
  const exigirDispositivo = criarExigirDispositivo({ pool });

  router.post(`${RAIZ}/heartbeat`, porIp, validar({ query: schemas.heartbeat.query, body: schemas.heartbeat.body }), exigirDispositivo, porDispositivo, controller.heartbeat);
  return router;
}

module.exports = { LIMITE_POR_IP, LIMITE_POR_DISPOSITIVO, chavePorDispositivo, criarTokenHeartbeatRoutes };
