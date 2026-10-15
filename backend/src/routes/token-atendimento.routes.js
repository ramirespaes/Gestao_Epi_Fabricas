'use strict';

const { Router } = require('express');
const { validar } = require('../middleware/validar');
const { criarLimitador } = require('../middleware/rate-limit');
const { criarExigirDispositivo } = require('../middleware/autenticacao-dispositivo');
const { LIMITE_ESTADO_POR_IP, LIMITE_POR_DISPOSITIVO, chavePorDispositivo } = require('./token-tablet.routes');
const schemas = require('../schemas/token-atendimento.schema');
const { tokenAtendimentoController } = require('../controllers/token-atendimento.controller');
const { pool } = require('../config/database');

/**
 * Atendimento Token — atendimento temporário do funcionário no tablet (Etapa D). O tablet é autenticado pela credencial da Etapa C
 * (exigirDispositivo: credencial, empresa ativa, rede IP_FIXO); não há sessão administrativa nem RBAC aqui.
 *
 *   POST /api/atendimento-token/tablet/atendimento            { tipo: 'CPF'|'MATRICULA', valor }  identifica e abre (Set-Cookie)
 *   GET  /api/atendimento-token/tablet/atendimento            estado; NÃO renova
 *   POST /api/atendimento-token/tablet/atendimento/atividade  interação válida: reinicia os 60 s (e renova o cookie)
 *   POST /api/atendimento-token/tablet/atendimento/encerrar   saída voluntária
 *
 * Ordem: limite por IP (folgado, contra inundação; o NAT soma vários tablets) → validação do corpo (antes do banco) → tablet
 * autenticado → limite POR TABLET (chave do servidor) → controller. A identificação tem o limite próprio de 10 tentativas por
 * minuto por tablet, contadas também quando falham; sem cooldown persistente. O contador é em memória do processo: com várias
 * instâncias o limite efetivo é multiplicado (mesma limitação documentada do limitador geral). Só GET e POST (nenhum verbo novo no CORS).
 */

const LIMITE_IDENTIFICACAO_POR_DISPOSITIVO = Object.freeze({ limite: 10, janelaSegundos: 60 });
const RAIZ = '/atendimento-token/tablet/atendimento';

function criarTokenAtendimentoRoutes({ controller, pool: poolInjetado, limitador, limitadorIdentificacao, limitadorDispositivo }) {
  const router = Router();
  const porIp = limitador ?? criarLimitador(LIMITE_ESTADO_POR_IP);
  const porTabletIdentificacao = limitadorIdentificacao ?? criarLimitador({ ...LIMITE_IDENTIFICACAO_POR_DISPOSITIVO, chave: chavePorDispositivo });
  const porTablet = limitadorDispositivo ?? criarLimitador({ ...LIMITE_POR_DISPOSITIVO, chave: chavePorDispositivo });
  const exigirDispositivo = criarExigirDispositivo({ pool: poolInjetado });

  router.post(RAIZ, porIp, validar({ query: schemas.identificar.query, body: schemas.identificar.body }), exigirDispositivo, porTabletIdentificacao, controller.identificar);
  router.get(RAIZ, porIp, validar({ query: schemas.estado.query }), exigirDispositivo, porTablet, controller.estado);
  router.post(`${RAIZ}/atividade`, porIp, validar({ query: schemas.operacao.query, body: schemas.operacao.body }), exigirDispositivo, porTablet, controller.atividade);
  router.post(`${RAIZ}/encerrar`, porIp, validar({ query: schemas.operacao.query, body: schemas.operacao.body }), exigirDispositivo, porTablet, controller.encerrar);
  return router;
}

const tokenAtendimentoRoutes = criarTokenAtendimentoRoutes({ controller: tokenAtendimentoController, pool });

module.exports = { LIMITE_IDENTIFICACAO_POR_DISPOSITIVO, criarTokenAtendimentoRoutes, tokenAtendimentoRoutes };
