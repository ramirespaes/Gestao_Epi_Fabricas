'use strict';

const { Router } = require('express');
const { validar } = require('../middleware/validar');
const schemas = require('../schemas/convite-usuario.schema');
const { conviteUsuarioController } = require('../controllers/convite-usuario.controller');
const { exigirSessao } = require('../middleware/autenticacao');
const { limitadorConviteUsuario } = require('../middleware/rate-limit');

/**
 * Convite de usuário (Bloco 9, parte F):
 *
 *   GET  /administracao/convites-usuario                     convites em aberto da empresa da sessão
 *   POST /administracao/convites-usuario                     convidar (e-mail, nome, perfil)
 *   POST /administracao/convites-usuario/:conviteId/cancelar cancelar
 *   POST /convite-usuario/consultar                          público: dados do convite pelo token
 *   POST /convite-usuario/aceitar                            público: aceitar com a senha
 *
 * As administrativas exigem sessão empresarial; GERENCIAR_USUARIOS e as
 * regras de perfil são do serviço. As públicas não têm sessão: o token no
 * corpo é a autoridade, com limitador próprio e cooldown por token.
 */
function criarConviteUsuarioRoutes({ controller, exigirSessao: exigirSessaoInjetado, limitador }) {
  const router = Router();

  router.get('/administracao/convites-usuario', exigirSessaoInjetado, validar({ query: schemas.listar.query }), controller.listar);
  router.post('/administracao/convites-usuario', exigirSessaoInjetado, validar({ body: schemas.criar.body }), controller.criar);
  router.post(
    '/administracao/convites-usuario/:conviteId/cancelar',
    exigirSessaoInjetado,
    validar({ params: schemas.cancelar.params, body: schemas.cancelar.body }),
    controller.cancelar,
  );

  router.post('/convite-usuario/consultar', limitador, validar({ body: schemas.consultar.body }), controller.consultar);
  router.post('/convite-usuario/aceitar', limitador, validar({ body: schemas.aceitar.body }), controller.aceitar);

  return router;
}

const conviteUsuarioRoutes = criarConviteUsuarioRoutes({
  controller: conviteUsuarioController,
  exigirSessao,
  limitador: limitadorConviteUsuario,
});

module.exports = { criarConviteUsuarioRoutes, conviteUsuarioRoutes };
