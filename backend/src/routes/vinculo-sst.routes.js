'use strict';

const { Router } = require('express');
const { validar } = require('../middleware/validar');
const schemas = require('../schemas/vinculo-sst.schema');
const { criarVinculoSstController } = require('../controllers/vinculo-sst.controller');
const { exigirSessao } = require('../middleware/autenticacao');
const { pool } = require('../config/database');

/**
 * Vínculos SST pela camada HTTP: listagem (12F-1), concessão e remoção (12F-2).
 * Quem pode listar, conceder e remover é o MASTER ativo da própria empresa,
 * decidido pelo serviço (vinculo-sst.service.js, sem ação de catálogo própria,
 * como decidido na 12B); qualquer outro recebe o mesmo 403. O vínculo não
 * concede ação nenhuma: as ações da SST continuam exigindo autorização
 * individual.
 *
 * Caminhos, quando montado por app.js sob /api:
 *   GET    /api/vinculos-sst
 *   POST   /api/vinculos-sst
 *   DELETE /api/vinculos-sst/:usuarioId
 */
function criarVinculoSstRoutes({ controller, exigirSessao: exigirSessaoInjetado }) {
  const router = Router();
  router.get(
    '/vinculos-sst',
    exigirSessaoInjetado,
    validar({ query: schemas.listar.query }),
    controller.listar,
  );
  router.post(
    '/vinculos-sst',
    exigirSessaoInjetado,
    validar({ body: schemas.conceder.body }),
    controller.conceder,
  );
  router.delete(
    '/vinculos-sst/:usuarioId',
    exigirSessaoInjetado,
    validar({ params: schemas.remover.params }),
    controller.remover,
  );
  return router;
}

const vinculoSstRoutes = criarVinculoSstRoutes({ controller: criarVinculoSstController({ pool }), exigirSessao });

module.exports = { criarVinculoSstRoutes, vinculoSstRoutes };
