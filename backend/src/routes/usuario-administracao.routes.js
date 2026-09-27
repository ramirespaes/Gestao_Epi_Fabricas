'use strict';

const { Router } = require('express');
const { validar } = require('../middleware/validar');
const schemas = require('../schemas/usuario-administracao.schema');
const { usuarioAdministracaoController } = require('../controllers/usuario-administracao.controller');
const { exigirSessao } = require('../middleware/autenticacao');

/**
 * Administração de usuários da empresa (Bloco 9, parte F):
 *
 *   GET   /administracao/usuarios              lista paginada da empresa da sessão
 *   GET   /administracao/usuarios/:id          um usuário (404 se de outra empresa)
 *   PATCH /administracao/usuarios/:id          nome e/ou perfil
 *   POST  /administracao/usuarios/:id/inativar inativação lógica
 *   POST  /administracao/usuarios/:id/reativar reativa o mesmo vínculo
 *
 * Todas exigem sessão empresarial; a autoridade (GERENCIAR_USUARIOS) e as
 * regras de perfil são decididas no serviço, que relê o ator do banco.
 */
function criarUsuarioAdministracaoRoutes({ controller, exigirSessao: exigirSessaoInjetado }) {
  const router = Router();

  router.get('/administracao/usuarios', exigirSessaoInjetado, validar({ query: schemas.listar.query }), controller.listar);
  router.get('/administracao/usuarios/:id', exigirSessaoInjetado, validar({ params: schemas.buscar.params }), controller.buscar);
  router.patch('/administracao/usuarios/:id', exigirSessaoInjetado, validar({ params: schemas.alterar.params, body: schemas.alterar.body }), controller.alterar);
  router.post('/administracao/usuarios/:id/inativar', exigirSessaoInjetado, validar({ params: schemas.inativar.params, body: schemas.inativar.body }), controller.inativar);
  router.post('/administracao/usuarios/:id/reativar', exigirSessaoInjetado, validar({ params: schemas.reativar.params, body: schemas.reativar.body }), controller.reativar);

  return router;
}

const usuarioAdministracaoRoutes = criarUsuarioAdministracaoRoutes({
  controller: usuarioAdministracaoController,
  exigirSessao,
});

module.exports = { criarUsuarioAdministracaoRoutes, usuarioAdministracaoRoutes };
