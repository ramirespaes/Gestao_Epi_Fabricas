'use strict';

const { Router } = require('express');
const { validar } = require('../middleware/validar');
const schemas = require('../schemas/lgpd-encarregado.schema');
const { lgpdEncarregadoController } = require('../controllers/lgpd-encarregado.controller');
const { exigirSessao } = require('../middleware/autenticacao');
const { criarExigirPermissaoRecurso } = require('../middleware/autorizacao');
const { pool } = require('../config/database');

/**
 * Encarregado pelo tratamento de dados pessoais (DPO), Portal — Pacote LGPD-1. Recurso RBAC `lgpdEncarregado`, EXCLUSIVO do
 * MASTER (rbac/recursos.js):
 *
 *   GET  /api/lgpd/encarregados                   (lgpdEncarregado.visualizar) principal e substituto vigentes
 *   GET  /api/lgpd/encarregados/historico         (lgpdEncarregado.visualizar) todas as designações, mais recentes primeiro
 *   POST /api/lgpd/encarregados                   (visualizar E editar) designar principal ou substituto
 *   POST /api/lgpd/encarregados/:id/substituir    (visualizar E editar) encerra a vigente e designa a sucessora
 *   POST /api/lgpd/encarregados/:id/contato       (visualizar E editar) corrige contatos por nova designação (histórico)
 *   POST /api/lgpd/encarregados/:id/encerrar      (visualizar E editar) encerra a designação vigente
 *
 * Só GET e POST: nada é apagado. A escrita ainda exige, no serviço, a autoridade administrativa com ator MASTER.
 */

const RECURSO = 'lgpdEncarregado';

function criarLgpdEncarregadoRoutes({ controller, exigirSessao: exigirSessaoInjetado, pool: poolInjetado }) {
  const router = Router();
  const exigirVisualizar = criarExigirPermissaoRecurso({ pool: poolInjetado }, RECURSO, 'visualizar');
  const exigirEditar = criarExigirPermissaoRecurso({ pool: poolInjetado }, RECURSO, 'editar');

  router.get('/lgpd/encarregados', exigirSessaoInjetado, exigirVisualizar, controller.consultar);
  router.get('/lgpd/encarregados/historico', exigirSessaoInjetado, exigirVisualizar, controller.historico);
  router.post('/lgpd/encarregados', exigirSessaoInjetado, exigirVisualizar, exigirEditar, validar({ body: schemas.designar.body }), controller.designar);
  router.post('/lgpd/encarregados/:id/substituir', exigirSessaoInjetado, exigirVisualizar, exigirEditar, validar({ params: schemas.substituir.params, body: schemas.substituir.body }), controller.substituir);
  router.post('/lgpd/encarregados/:id/contato', exigirSessaoInjetado, exigirVisualizar, exigirEditar, validar({ params: schemas.contato.params, body: schemas.contato.body }), controller.contato);
  router.post('/lgpd/encarregados/:id/encerrar', exigirSessaoInjetado, exigirVisualizar, exigirEditar, validar({ params: schemas.encerrar.params, body: schemas.encerrar.body }), controller.encerrar);
  return router;
}

const lgpdEncarregadoRoutes = criarLgpdEncarregadoRoutes({ controller: lgpdEncarregadoController, exigirSessao, pool });

module.exports = { criarLgpdEncarregadoRoutes, lgpdEncarregadoRoutes, RECURSO };
