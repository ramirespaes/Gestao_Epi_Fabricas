'use strict';

const { Router } = require('express');
const { validar } = require('../middleware/validar');
const { criarLimitador } = require('../middleware/rate-limit');
const { criarExigirDispositivo } = require('../middleware/autenticacao-dispositivo');
const schemas = require('../schemas/token-tablet.schema');
const { tokenTabletController } = require('../controllers/token-tablet.controller');
const { pool } = require('../config/database');

/**
 * Atendimento Token — rotas do tablet (Etapa C). Sem sessão administrativa.
 *
 *   POST /api/atendimento-token/tablet/ativar   { codigo }  consome o código de uso único e emite a credencial (Set-Cookie)
 *   GET  /api/atendimento-token/tablet/estado   cookie do tablet; query vazia
 *
 * LIMITES (D-C8). Vários tablets corporativos compartilham o mesmo IP público de saída (NAT), então o limite por IP é só a
 * contenção de inundação, folgado; o limite fino é POR TABLET e depois da autenticação, com a chave vinda do servidor (o id do
 * tablet que a credencial provou), nunca de cabeçalho ou campo do cliente. A ativação é rara e tem o limite por IP mais
 * apertado. Estas rotas não passam pelo limitador geral de /api (app.js), que somaria todos os tablets do NAT numa cota só.
 * Em testes um `limitador` injetado vale para as duas rotas por IP.
 */

const LIMITE_ATIVACAO_POR_IP = Object.freeze({ limite: 30, janelaSegundos: 60 });
const LIMITE_ESTADO_POR_IP = Object.freeze({ limite: 600, janelaSegundos: 60 });
const LIMITE_POR_DISPOSITIVO = Object.freeze({ limite: 120, janelaSegundos: 60 });
const RAIZ = '/atendimento-token/tablet';

const chavePorDispositivo = (req) => `dispositivo:${req.dispositivo.empresaId}:${req.dispositivo.id}`;

function criarTokenTabletRoutes({ controller, pool: poolInjetado, limitador, limitadorAtivacao, limitadorDispositivo }) {
  const router = Router();
  const porIpEstado = limitador ?? criarLimitador(LIMITE_ESTADO_POR_IP);
  const porIpAtivacao = limitadorAtivacao ?? limitador ?? criarLimitador(LIMITE_ATIVACAO_POR_IP);
  const porDispositivo = limitadorDispositivo ?? criarLimitador({ ...LIMITE_POR_DISPOSITIVO, chave: chavePorDispositivo });
  const exigirDispositivo = criarExigirDispositivo({ pool: poolInjetado });

  router.post(`${RAIZ}/ativar`, porIpAtivacao, validar({ body: schemas.ativar.body }), controller.ativar);
  router.get(`${RAIZ}/estado`, porIpEstado, validar({ query: schemas.estado.query }), exigirDispositivo, porDispositivo, controller.estado);
  return router;
}

const tokenTabletRoutes = criarTokenTabletRoutes({ controller: tokenTabletController, pool });

module.exports = {
  LIMITE_ATIVACAO_POR_IP, LIMITE_ESTADO_POR_IP, LIMITE_POR_DISPOSITIVO, chavePorDispositivo, criarTokenTabletRoutes, tokenTabletRoutes,
};
