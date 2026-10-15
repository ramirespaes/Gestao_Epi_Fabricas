'use strict';

const tokenDispositivoService = require('../services/token-dispositivo.service');
const { pool } = require('../config/database');

/** Controller da administração dos tablets: empresa e ator SÓ de req.empresa/req.usuario (sessão), nunca do corpo. */
function criarTokenDispositivoController({ pool: poolInjetado }) {
  const contexto = (req) => ({ empresaId: req.empresa.id, atorId: req.usuario.id, ip: req.ip, dispositivo: req.headers['user-agent'] });
  return {
    async listar(req, res) {
      const { pagina, limite } = req.validado.query;
      const resultado = await tokenDispositivoService.listar(poolInjetado, { empresaId: req.empresa.id, pagina, limite });
      res.status(200).json({ status: 'ok', ...resultado });
    },
    async consultar(req, res) {
      const dispositivo = await tokenDispositivoService.consultar(poolInjetado, { empresaId: req.empresa.id, id: req.validado.params.id });
      res.status(200).json({ status: 'ok', dispositivo });
    },
    async cadastrar(req, res) {
      const dispositivo = await tokenDispositivoService.cadastrar(poolInjetado, { ...contexto(req), dados: req.validado.body });
      res.status(201).json({ status: 'ok', dispositivo });
    },
    async editar(req, res) {
      const { dispositivo, alterado } = await tokenDispositivoService.editar(poolInjetado, { ...contexto(req), id: req.validado.params.id, dados: req.validado.body });
      res.status(200).json({ status: 'ok', dispositivo, alterado });
    },
    async revogar(req, res) {
      const { dispositivo, alterado } = await tokenDispositivoService.revogar(poolInjetado, { ...contexto(req), id: req.validado.params.id });
      res.status(200).json({ status: 'ok', dispositivo, alterado });
    },
  };
}

const tokenDispositivoController = criarTokenDispositivoController({ pool });

module.exports = { criarTokenDispositivoController, tokenDispositivoController };
