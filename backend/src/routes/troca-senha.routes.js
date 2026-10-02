'use strict';

const { Router } = require('express');
const { validar } = require('../middleware/validar');
const schemas = require('../schemas/troca-senha.schema');
const { limitadorTrocaSenha, limitadorPlataformaTrocaSenha } = require('../middleware/rate-limit');
const { exigirSessaoGlobal } = require('../middleware/autenticacao-global');
const { exigirSessaoPlataforma } = require('../middleware/autenticacao-plataforma');
const {
  trocaSenhaGlobalController,
  trocaSenhaPlataformaController,
} = require('../controllers/troca-senha.controller');

/**
 * Rotas da troca de senha autenticada, uma fábrica por portal.
 *
 *   Portal do Cliente (cadeia /api):          POST /auth/global/senha
 *   Painel Privado (cadeia /api/plataforma):  POST /auth/senha
 *
 * A cadeia de cada rota é fixa: limitador próprio, sessão do próprio portal,
 * validação, controller. O 429 vem antes do 401, e o 401 antes de qualquer
 * leitura do corpo. Sem Turnstile: quem troca a senha já tem sessão.
 */

function conferir({ controller, limitador, exigirSessao }, nomeSessao) {
  if (!controller || typeof controller.trocar !== 'function') {
    throw new TypeError('controller é obrigatório na troca de senha');
  }
  if (typeof limitador !== 'function') {
    throw new TypeError('limitador é obrigatório na troca de senha');
  }
  if (typeof exigirSessao !== 'function') {
    throw new TypeError(`${nomeSessao} é obrigatório na troca de senha`);
  }
}

function criarTrocaSenhaGlobalRoutes({ controller, limitador, exigirSessaoGlobal: exigirSessao } = {}) {
  conferir({ controller, limitador, exigirSessao }, 'exigirSessaoGlobal');
  const router = Router();
  router.post(
    '/auth/global/senha',
    limitador,
    exigirSessao,
    validar({ query: schemas.trocarPortal.query, body: schemas.trocarPortal.body }),
    controller.trocar,
  );
  return router;
}

function criarTrocaSenhaPlataformaRoutes({ controller, limitador, exigirSessaoPlataforma: exigirSessao } = {}) {
  conferir({ controller, limitador, exigirSessao }, 'exigirSessaoPlataforma');
  const router = Router();
  router.post(
    '/auth/senha',
    limitador,
    exigirSessao,
    validar({ query: schemas.trocarPlataforma.query, body: schemas.trocarPlataforma.body }),
    controller.trocar,
  );
  return router;
}

const trocaSenhaGlobalRoutes = criarTrocaSenhaGlobalRoutes({
  controller: trocaSenhaGlobalController,
  limitador: limitadorTrocaSenha,
  exigirSessaoGlobal,
});

const trocaSenhaPlataformaRoutes = criarTrocaSenhaPlataformaRoutes({
  controller: trocaSenhaPlataformaController,
  limitador: limitadorPlataformaTrocaSenha,
  exigirSessaoPlataforma,
});

module.exports = {
  criarTrocaSenhaGlobalRoutes,
  criarTrocaSenhaPlataformaRoutes,
  trocaSenhaGlobalRoutes,
  trocaSenhaPlataformaRoutes,
};
