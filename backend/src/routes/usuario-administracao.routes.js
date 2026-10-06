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
  router.post('/administracao/usuarios', exigirSessaoInjetado, validar({ body: schemas.criar.body }), controller.criar);
  router.get('/administracao/usuarios/:id', exigirSessaoInjetado, validar({ params: schemas.buscar.params }), controller.buscar);
  router.get('/administracao/usuarios/:id/permissoes', exigirSessaoInjetado, validar({ params: schemas.buscar.params }), controller.permissoes);
  router.patch('/administracao/usuarios/:id/permissoes/recursos/:recurso', exigirSessaoInjetado, validar({ params: schemas.permissoesRecurso.params, body: schemas.permissoesRecurso.body }), controller.permissaoRecurso);
  router.put('/administracao/usuarios/:id/permissoes/acoes/:codigo', exigirSessaoInjetado, validar({ params: schemas.permissoesAcao.params, body: schemas.permissoesAcao.body }), controller.permissaoAcao);
  router.get('/administracao/usuarios/:id/acessos', exigirSessaoInjetado, validar({ params: schemas.buscar.params }), controller.acessos);
  router.put('/administracao/usuarios/:id/acessos/:toggle', exigirSessaoInjetado, validar({ params: schemas.acessoToggle.params, body: schemas.acessoToggle.body }), controller.acesso);
  router.post('/administracao/usuarios/:id/permissoes/copiar', exigirSessaoInjetado, validar({ params: schemas.permissoesCopiar.params, body: schemas.permissoesCopiar.body }), controller.copiarPermissoes);
  router.post('/administracao/usuarios/:id/senha-provisoria', exigirSessaoInjetado, validar({ params: schemas.redefinirSenha.params, body: schemas.redefinirSenha.body }), controller.redefinirSenha);
  router.get('/administracao/usuarios/:id/edicao', exigirSessaoInjetado, validar({ params: schemas.buscar.params }), controller.edicao);
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
