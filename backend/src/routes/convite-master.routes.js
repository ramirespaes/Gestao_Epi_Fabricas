'use strict';

const { Router } = require('express');
const { validar } = require('../middleware/validar');
const schemas = require('../schemas/convite-master.schema');
const { conviteMasterController } = require('../controllers/convite-master.controller');
const { exigirSessaoPlataforma } = require('../middleware/autenticacao-plataforma');
const { limitadorPlataformaConvite, limitadorPlataformaEnvioConvite } = require('../middleware/rate-limit');

/**
 * Rotas do convite do MASTER (Pacote 3), montadas na cadeia /api/plataforma.
 *
 * ADMINISTRATIVAS — atrás de exigirSessaoPlataforma:
 *   POST /empresas/:id/convites-master              criar convite
 *   GET  /empresas/:id/convites-master              listar convites da empresa
 *   GET  /convites-master/:id/:conviteId            situação de um convite
 *   POST /convites-master/:id/:conviteId/reenviar   cancelar o convite e enviar outro, com token novo
 *   POST /convites-master/:id/:conviteId/cancelar   cancelar
 * Criar e reenviar passam antes pelo limitador de envio (limitadorEnvio), que
 * divide um contador por IP entre as duas e vem antes da sessão.
 *
 * PÚBLICAS — SEM sessão (a autoridade é a posse do token), com limitador
 * por IP PRÓPRIO (limitadorPlataformaConvite) como camada COMPLEMENTAR ao
 * cooldown persistente por token (convite-master.service.js):
 *   POST /convite-master/consultar                  consultar antes do formulário (token no corpo)
 *   POST /convite-master/aceitar                    aceitar (token + nome + senha, no corpo)
 * O token NUNCA viaja em query string (sigilo: caminho é registrado em
 * console/logs de acesso; corpo JSON não) — correção pós-auditoria, item 1.
 *
 * Segmentos distintos de propósito (`convites-master` x `convite-master`):
 * nenhuma rota pública compartilha prefixo com uma administrativa.
 */
function criarConviteMasterRoutes({
  controller, exigirSessaoPlataforma: exigir, limitador, limitadorEnvio,
}) {
  const router = Router();

  router.post('/empresas/:id/convites-master', limitadorEnvio, exigir, validar({ params: schemas.criar.params, body: schemas.criar.body }), controller.criar);
  router.get('/empresas/:id/convites-master', exigir, validar({ params: schemas.listar.params }), controller.listar);
  router.get('/convites-master/:id/:conviteId', exigir, validar({ params: schemas.buscar.params }), controller.buscar);
  router.post('/convites-master/:id/:conviteId/reenviar', limitadorEnvio, exigir, validar({ params: schemas.reenviar.params, body: schemas.reenviar.body }), controller.reenviar);
  router.post('/convites-master/:id/:conviteId/cancelar', exigir, validar({ params: schemas.cancelar.params, body: schemas.cancelar.body }), controller.cancelar);

  router.post('/convite-master/consultar', limitador, validar({ body: schemas.consultar.body }), controller.consultar);
  router.post('/convite-master/aceitar', limitador, validar({ body: schemas.aceitar.body }), controller.aceitar);

  return router;
}

const conviteMasterRoutes = criarConviteMasterRoutes({
  controller: conviteMasterController,
  exigirSessaoPlataforma,
  limitador: limitadorPlataformaConvite,
  limitadorEnvio: limitadorPlataformaEnvioConvite,
});

module.exports = { criarConviteMasterRoutes, conviteMasterRoutes };
