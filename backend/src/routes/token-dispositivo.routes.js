'use strict';

const { Router } = require('express');
const { validar } = require('../middleware/validar');
const schemas = require('../schemas/token-dispositivo.schema');
const { tokenDispositivoController } = require('../controllers/token-dispositivo.controller');
const { exigirSessao } = require('../middleware/autenticacao');
const { criarExigirPermissaoRecurso, criarExigirPermissaoAcao } = require('../middleware/autorizacao');
const { pool } = require('../config/database');

/**
 * Atendimento Token — administração dos tablets (Etapa B). Recurso RBAC `atendimentoToken`: consultar = visualizar;
 * cadastrar = criar; editar = editar. A revogação é uma AÇÃO (TOKEN_REVOGAR_DISPOSITIVO), independente das operações do recurso.
 * Sem rota de exclusão: o dispositivo é revogado, nunca apagado. Nenhuma rota do tablet nem de autenticação do dispositivo
 * (Etapa C).
 *
 *   GET   /api/atendimento-token/dispositivos
 *   GET   /api/atendimento-token/dispositivos/:id
 *   POST  /api/atendimento-token/dispositivos
 *   PATCH /api/atendimento-token/dispositivos/:id
 *   POST  /api/atendimento-token/dispositivos/:id/revogar
 */

const RECURSO = 'atendimentoToken';
const ACAO_REVOGAR_DISPOSITIVO = 'TOKEN_REVOGAR_DISPOSITIVO';
const RAIZ = '/atendimento-token/dispositivos';

function criarTokenDispositivoRoutes({ controller, exigirSessao: exigirSessaoInjetado, pool: poolInjetado }) {
  const router = Router();
  const exigirVisualizar = criarExigirPermissaoRecurso({ pool: poolInjetado }, RECURSO, 'visualizar');
  const exigirCriar = criarExigirPermissaoRecurso({ pool: poolInjetado }, RECURSO, 'criar');
  const exigirEditar = criarExigirPermissaoRecurso({ pool: poolInjetado }, RECURSO, 'editar');
  const exigirRevogar = criarExigirPermissaoAcao({ pool: poolInjetado }, ACAO_REVOGAR_DISPOSITIVO);

  router.get(RAIZ, exigirSessaoInjetado, exigirVisualizar, validar({ query: schemas.listar.query }), controller.listar);
  router.get(`${RAIZ}/:id`, exigirSessaoInjetado, exigirVisualizar, validar({ params: schemas.consultar.params }), controller.consultar);
  router.post(RAIZ, exigirSessaoInjetado, exigirCriar, validar({ body: schemas.criar.body }), controller.cadastrar);
  router.patch(`${RAIZ}/:id`, exigirSessaoInjetado, exigirEditar, validar({ params: schemas.editar.params, body: schemas.editar.body }), controller.editar);
  router.post(`${RAIZ}/:id/revogar`, exigirSessaoInjetado, exigirRevogar, validar({ params: schemas.revogar.params, body: schemas.revogar.body }), controller.revogar);
  return router;
}

const tokenDispositivoRoutes = criarTokenDispositivoRoutes({ controller: tokenDispositivoController, exigirSessao, pool });

module.exports = { criarTokenDispositivoRoutes, tokenDispositivoRoutes, RECURSO, ACAO_REVOGAR_DISPOSITIVO };
