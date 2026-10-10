'use strict';

const gheTipoMaterialService = require('../services/ghe-tipo-material.service');
const { pool } = require('../config/database');

/**
 * Controller do vínculo GHE × tipo de material (Incremento 3). Mesmo desenho de ghe-material.controller.js: traduz
 * requisição em chamada de serviço; `empresaId`/`atorId` só de req.empresa/req.usuario (exigirSessao); a autorização
 * já aconteceu na rota (`employeeGroups`).
 */

const comContexto = (req) => ({ empresaId: req.empresa.id, atorId: req.usuario.id, ip: req.ip, dispositivo: req.headers['user-agent'] });

function criarGheTipoMaterialController({ pool: poolInjetado }) {
  return {
    async consultar(req, res) {
      const resultado = await gheTipoMaterialService.consultar(poolInjetado, { empresaId: req.empresa.id, gheId: req.validado.params.id });
      res.status(200).json({ status: 'ok', ...resultado });
    },

    async definir(req, res) {
      const { vinculo, criado, alterado } = await gheTipoMaterialService.definir(poolInjetado, {
        ...comContexto(req),
        gheId: req.validado.params.id,
        tipoId: req.validado.params.tipoId,
        classificacao: req.validado.body.classificacao,
      });
      res.status(criado ? 201 : 200).json({ status: 'ok', vinculo, criado, alterado });
    },

    async desvincular(req, res) {
      const { removido } = await gheTipoMaterialService.desvincular(poolInjetado, {
        ...comContexto(req), gheId: req.validado.params.id, tipoId: req.validado.params.tipoId,
      });
      res.status(200).json({ status: 'ok', removido });
    },
  };
}

const gheTipoMaterialController = criarGheTipoMaterialController({ pool });

module.exports = { criarGheTipoMaterialController, gheTipoMaterialController };
