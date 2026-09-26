'use strict';

const gheMaterialService = require('../services/ghe-material.service');
const { pool } = require('../config/database');

/**
 * Controller da matriz GHE × EPI (Bloco 9, Etapa C, Parte C5). Mesmo desenho
 * de grupo-homogeneo-exposicao.controller.js: traduz requisição em chamada
 * de serviço; `empresaId`/`atorId` só de req.empresa/req.usuario
 * (exigirSessao); autorização já aconteceu na rota (`employeeGroups`).
 */

const comContexto = (req) => ({ empresaId: req.empresa.id, atorId: req.usuario.id, ip: req.ip, dispositivo: req.headers['user-agent'] });

function criarGheMaterialController({ pool: poolInjetado }) {
  return {
    async consultar(req, res) {
      const resultado = await gheMaterialService.consultar(poolInjetado, { empresaId: req.empresa.id, gheId: req.validado.params.id });
      res.status(200).json({ status: 'ok', ...resultado });
    },

    async vincular(req, res) {
      const vinculo = await gheMaterialService.vincular(poolInjetado, {
        ...comContexto(req), gheId: req.validado.params.id, materialId: req.validado.body.materialId,
      });
      res.status(201).json({ status: 'ok', vinculo });
    },

    async desvincular(req, res) {
      const { removido } = await gheMaterialService.desvincular(poolInjetado, {
        ...comContexto(req), gheId: req.validado.params.id, materialId: req.validado.params.materialId,
      });
      res.status(200).json({ status: 'ok', removido });
    },
  };
}

const gheMaterialController = criarGheMaterialController({ pool });

module.exports = { criarGheMaterialController, gheMaterialController };
