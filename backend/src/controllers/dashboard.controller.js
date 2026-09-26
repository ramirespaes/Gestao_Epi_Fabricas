'use strict';

const dashboardService = require('../services/dashboard.service');
const { pool } = require('../config/database');

/**
 * Controller do dashboard (Bloco 9, Etapa C, Parte C6). Empresa, usuário e
 * perfil só de req.empresa/req.usuario (exigirSessao); a rota já exigiu
 * `dashboard.visualizar`, e o serviço decide cada indicador pela fonte.
 */

function criarDashboardController({ pool: poolInjetado }) {
  return {
    async indicadores(req, res) {
      const indicadores = await dashboardService.consultar(poolInjetado, {
        empresaId: req.empresa.id, usuarioId: req.usuario.id, perfil: req.usuario.perfil,
      });
      res.status(200).json({ status: 'ok', indicadores });
    },
  };
}

const dashboardController = criarDashboardController({ pool });

module.exports = { criarDashboardController, dashboardController };
