'use strict';

const tipoMaterialService = require('../services/tipo-material.service');
const { pool } = require('../config/database');

/** Controller do catálogo de tipos: empresa e ator SÓ de req.empresa/req.usuario (sessão), nunca do corpo. */
function criarTipoMaterialController({ pool: poolInjetado }) {
  const contexto = (req) => ({ empresaId: req.empresa.id, atorId: req.usuario.id, ip: req.ip, dispositivo: req.headers['user-agent'] });
  return {
    async listar(req, res) {
      const { grupo, grupoProtecao, ativo, busca, pagina, limite } = req.validado.query;
      const resultado = await tipoMaterialService.listar(poolInjetado, {
        empresaId: req.empresa.id, grupo: grupo ?? null, grupoProtecao: grupoProtecao ?? null, ativo: ativo ?? null, busca: busca ?? null, pagina, limite,
      });
      res.status(200).json({ status: 'ok', ...resultado });
    },
    async criar(req, res) {
      const { grupo, grupoProtecao, nome } = req.validado.body;
      const tipo = await tipoMaterialService.criar(poolInjetado, { ...contexto(req), grupo, grupoProtecao, nome });
      res.status(201).json({ status: 'ok', tipo });
    },
    async inativar(req, res) {
      const { tipo, alterado } = await tipoMaterialService.inativar(poolInjetado, { ...contexto(req), tipoId: req.validado.params.id });
      res.status(200).json({ status: 'ok', tipo, alterado });
    },
    async reativar(req, res) {
      const { tipo, alterado } = await tipoMaterialService.reativar(poolInjetado, { ...contexto(req), tipoId: req.validado.params.id });
      res.status(200).json({ status: 'ok', tipo, alterado });
    },
  };
}

const tipoMaterialController = criarTipoMaterialController({ pool });

module.exports = { criarTipoMaterialController, tipoMaterialController };
