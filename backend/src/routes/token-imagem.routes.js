'use strict';

const { Router } = require('express');
const { HttpError } = require('../errors/HttpError');
const { validar } = require('../middleware/validar');
const { criarLimitador } = require('../middleware/rate-limit');
const { credencialDaRequisicao } = require('../middleware/autenticacao-dispositivo');
const tabletService = require('../services/token-tablet.service');
const { ipDaRequisicao } = require('../utils/ip');
const schemas = require('../schemas/token-imagem.schema');
const { criarTokenImagemController } = require('../controllers/token-imagem.controller');
const { pool } = require('../config/database');

/**
 * Atendimento Token — imagens do material no tablet.
 *
 *   GET|HEAD /api/atendimento-token/tablet/atendimento/imagens/:origem/:id/:variante?v=<versao>
 *
 * Ordem: limite por IP, política sem cache, validação, autenticação do tablet SEM rotação, limite por tablet, controller. A autenticação é a do
 * serviço do tablet (credencial, empresa, rede, carência e eventos), chamada com `rotacionar: false`: a imagem nunca rotaciona a credencial nem emite
 * Set-Cookie (o tablet pede muitas imagens em paralelo; a rotação continua exclusiva das rotas existentes). NÃO renova o atendimento do funcionário.
 *
 * PRECONDIÇÃO DE REGISTRO: `tabletService.autenticar` ainda NÃO conhece a opção `rotacionar` (arquivo congelado da Etapa C); enquanto ela não existir,
 * a opção é ignorada e a credencial poderia ser rotacionada sem que esta rota entregue o novo cookie. Por isso a rota NÃO PODE ser registrada em app.js
 * antes da alteração do serviço. Também aguarda o autorizador baseado no catálogo (sem ele o serviço de imagem recusa tudo, 503).
 *
 * Limites PROPOSTOS (ainda não aprovados): por IP folgado (vários tablets atrás do mesmo NAT) e fino por tablet, com contadores PRÓPRIOS,
 * independentes dos das demais rotas do tablet. O excesso é o 429 LIMITE_REQUISICOES_EXCEDIDO padrão.
 */

const LIMITE_POR_IP = Object.freeze({ limite: 600, janelaSegundos: 60 });
const LIMITE_POR_DISPOSITIVO = Object.freeze({ limite: 240, janelaSegundos: 60 });
const RAIZ = '/atendimento-token/tablet/atendimento';

const chavePorDispositivo = (req) => `imagem:${req.dispositivo.empresaId}:${req.dispositivo.id}`;

/** Resposta sem cache e sem ETag, inclusive nos erros: o ETag é descartado NESTA resposta (res.json/res.send o recriariam), sem mexer na configuração do app. */
function semCacheSemEtag(_req, res, next) {
  const definir = res.setHeader.bind(res);
  res.setHeader = (nome, valor) => (String(nome).toLowerCase() === 'etag' ? res : definir(nome, valor));
  res.set('Cache-Control', 'private, no-store');
  res.vary('Cookie');
  next();
}

function criarExigirDispositivoSemRotacao({ pool: poolInjetado }) {
  return async function exigirDispositivoSemRotacao(req, _res, next) {
    try {
      const credencial = credencialDaRequisicao(req);
      // Mesmo erro que o serviço já lança para credencial ausente ou duplicada; aqui só evita a ida ao serviço.
      if (credencial === null) throw HttpError.unauthorized('DISPOSITIVO_NAO_AUTORIZADO', 'Dispositivo não autorizado');
      const { dispositivo } = await tabletService.autenticar(poolInjetado, { credencial, ip: ipDaRequisicao(req), rotacionar: false });
      req.dispositivo = dispositivo;
      next();
    } catch (erro) {
      next(erro);
    }
  };
}

function criarTokenImagemRoutes({ controller, pool: poolInjetado, limitador, limitadorDispositivo }) {
  const router = Router();
  const porIp = limitador ?? criarLimitador(LIMITE_POR_IP);
  const porDispositivo = limitadorDispositivo ?? criarLimitador({ ...LIMITE_POR_DISPOSITIVO, chave: chavePorDispositivo });
  const exigirDispositivo = criarExigirDispositivoSemRotacao({ pool: poolInjetado });

  router.get(`${RAIZ}/imagens/:origem/:id/:variante`, porIp, semCacheSemEtag, validar({ params: schemas.obter.params, query: schemas.obter.query }), exigirDispositivo, porDispositivo, controller.obter);
  return router;
}

const tokenImagemRoutes = criarTokenImagemRoutes({ controller: criarTokenImagemController({ pool }), pool });

module.exports = { LIMITE_POR_IP, LIMITE_POR_DISPOSITIVO, chavePorDispositivo, criarTokenImagemRoutes, tokenImagemRoutes };
