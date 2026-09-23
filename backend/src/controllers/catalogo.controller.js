'use strict';

const catalogoService = require('../services/catalogo.service');
const { pool } = require('../config/database');

/**
 * Controller do catálogo (Bloco 8, Incremento 8, Etapa 5A, Subetapa 3T).
 *
 * Traduz requisição em chamada de serviço e resultado em resposta HTTP.
 * Não decide nada: autoridade e conteúdo do catálogo já estão resolvidos
 * em catalogo.service.js. Sem try/catch — Express 5 encaminha a Promise
 * rejeitada ao errorHandler.
 *
 * `empresaId` e `atorId` saem EXCLUSIVAMENTE de req.empresa.id e
 * req.usuario.id, populados por exigirSessao. Esta rota não tem corpo,
 * params nem query: não há nada que o cliente possa influenciar.
 */

function criarCatalogoController({ pool: poolInjetado }) {
  return {
    async listarAcoes(req, res) {
      const acoes = await catalogoService.listarAcoes(poolInjetado, {
        empresaId: req.empresa.id,
        atorId: req.usuario.id,
      });

      res.status(200).json({ status: 'ok', acoes });
    },
  };
}

const catalogoController = criarCatalogoController({ pool });

module.exports = { criarCatalogoController, catalogoController };
