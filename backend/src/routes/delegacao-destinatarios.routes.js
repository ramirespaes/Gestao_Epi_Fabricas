'use strict';

const { Router } = require('express');
const { validar } = require('../middleware/validar');
const schemas = require('../schemas/delegacao-destinatarios.schema');
const { delegacaoDestinatariosController } = require('../controllers/delegacao-destinatarios.controller');
const { exigirSessao } = require('../middleware/autenticacao');

/**
 * Rota de destinatários para delegação (Subetapa 3V — complemento).
 *
 * Uma única rota, de leitura, atrás de exigirSessao, com `validar` na
 * query. A autoridade — "pode delegar ao menos uma autorização agora",
 * recalculada como a 3I recalcularia — mora em
 * delegacao-destinatarios.service.js. A rota garante autenticação; o
 * serviço garante autorização.
 *
 * Caminho final, quando montado por app.js sob /api:
 *   GET /api/delegacao/destinatarios?busca=
 *
 * Prefixo próprio (`/delegacao/`), e não `/usuarios`, de propósito: não
 * é a consulta administrativa de pessoas da 3U, não tem a mesma
 * autoridade nem a mesma projeção, e não deve ser confundida com ela.
 * A consulta da 3U NÃO foi tocada.
 *
 * SOMENTE LEITURA: não concede, não delega, não revoga. O POST de
 * delegação continua sendo o da 3P, com as regras da 3I.
 */

function criarDelegacaoDestinatariosRoutes({ controller, exigirSessao: exigirSessaoInjetado }) {
  const router = Router();

  router.get(
    '/delegacao/destinatarios',
    exigirSessaoInjetado,
    validar({ query: schemas.listar.query }),
    controller.listar,
  );

  return router;
}

const delegacaoDestinatariosRoutes = criarDelegacaoDestinatariosRoutes({
  controller: delegacaoDestinatariosController,
  exigirSessao,
});

module.exports = { criarDelegacaoDestinatariosRoutes, delegacaoDestinatariosRoutes };
