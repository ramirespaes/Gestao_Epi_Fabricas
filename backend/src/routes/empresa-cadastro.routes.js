'use strict';

const { Router } = require('express');
const { validar } = require('../middleware/validar');
const schemas = require('../schemas/empresa-cadastro.schema');
const { empresaCadastroController } = require('../controllers/empresa-cadastro.controller');
const { exigirSessaoPlataforma } = require('../middleware/autenticacao-plataforma');

/**
 * Rotas do cadastro de empresas no Painel Privado (Pacote 3). TODAS atrás
 * de exigirSessaoPlataforma: só um administrador autenticado da plataforma
 * (cookie administrativo próprio) as alcança. Sem RBAC empresarial aqui —
 * esta é autoridade da PLATAFORMA sobre as empresas, não autoridade dentro
 * de uma empresa. Montadas por app.js na cadeia /api/plataforma (CORS,
 * Origin/Referer, Host e rate limit exclusivos).
 *
 * Sem rota de exclusão: empresa é inativada.
 *
 * Caminhos, sob /api/plataforma:
 *   POST  /empresas
 *   GET   /empresas
 *   GET   /empresas/:id
 *   GET   /empresas/:id/provisionamento   (situação das permissões do MASTER)
 *   PATCH /empresas/:id
 *   POST  /empresas/:id/inativar
 *   POST  /empresas/:id/reativar
 */
function criarEmpresaCadastroRoutes({ controller, exigirSessaoPlataforma: exigir }) {
  const router = Router();

  router.post('/empresas', exigir, validar({ body: schemas.criar.body }), controller.criar);
  router.get('/empresas', exigir, validar({ query: schemas.listar.query }), controller.listar);
  router.get('/empresas/:id', exigir, validar({ params: schemas.buscar.params }), controller.buscar);
  router.get('/empresas/:id/provisionamento', exigir, validar({ params: schemas.provisionamento.params }), controller.provisionamento);
  router.patch('/empresas/:id', exigir, validar({ params: schemas.alterar.params, body: schemas.alterar.body }), controller.alterar);
  router.post('/empresas/:id/inativar', exigir, validar({ params: schemas.inativar.params, body: schemas.inativar.body }), controller.inativar);
  router.post('/empresas/:id/reativar', exigir, validar({ params: schemas.reativar.params, body: schemas.reativar.body }), controller.reativar);

  return router;
}

const empresaCadastroRoutes = criarEmpresaCadastroRoutes({ controller: empresaCadastroController, exigirSessaoPlataforma });

module.exports = { criarEmpresaCadastroRoutes, empresaCadastroRoutes };
