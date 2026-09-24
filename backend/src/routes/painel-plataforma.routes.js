'use strict';

const { Router } = require('express');
const { painelPlataformaController } = require('../controllers/painel-plataforma.controller');
const { exigirSessaoPlataforma } = require('../middleware/autenticacao-plataforma');

/**
 * Área administrativa protegida inicial (Autenticação Global — Pacote 2,
 * item 4). Uma única rota, atrás de exigirSessaoPlataforma — qualquer
 * expansão (empresas, MASTER, etc.) fica para pacotes futuros.
 *
 * Caminho final, quando montado por app.js sob /api/plataforma:
 *   GET /api/plataforma/painel
 */
function criarPainelPlataformaRoutes({ controller, exigirSessaoPlataforma: exigirSessaoInjetado }) {
  const router = Router();

  router.get('/painel', exigirSessaoInjetado, controller.resumo);

  return router;
}

const painelPlataformaRoutes = criarPainelPlataformaRoutes({
  controller: painelPlataformaController,
  exigirSessaoPlataforma,
});

module.exports = { criarPainelPlataformaRoutes, painelPlataformaRoutes };
