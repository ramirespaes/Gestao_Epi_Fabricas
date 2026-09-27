'use strict';

const usuarioAdministracaoService = require('../services/usuario-administracao.service');
const { pool } = require('../config/database');

/**
 * Administração de usuários da empresa (Bloco 9, parte F). Empresa e ator
 * vêm sempre da sessão (req.empresa, req.usuario); nada disso é lido do
 * corpo ou da query.
 */
function criarUsuarioAdministracaoController({ pool: poolInjetado }) {
  const daSessao = (req) => ({ empresaId: req.empresa.id, atorId: req.usuario.id });
  const doDispositivo = (req) => ({ ip: req.ip, dispositivo: req.headers['user-agent'] });

  return {
    async listar(req, res) {
      const { busca, situacao, perfil, ordem, pagina, limite } = req.validado.query;
      const resultado = await usuarioAdministracaoService.listar(poolInjetado, {
        ...daSessao(req), busca: busca ?? null, situacao: situacao ?? null, perfil: perfil ?? null, ordem, pagina, limite,
      });
      res.status(200).json({ status: 'ok', ...resultado });
    },

    async buscar(req, res) {
      const usuario = await usuarioAdministracaoService.buscar(poolInjetado, { ...daSessao(req), usuarioId: req.validado.params.id });
      res.status(200).json({ status: 'ok', usuario });
    },

    async alterar(req, res) {
      const { nome, tipoConta } = req.validado.body;
      const { usuario, alterado } = await usuarioAdministracaoService.alterar(poolInjetado, {
        ...daSessao(req), ...doDispositivo(req), usuarioId: req.validado.params.id, nome, perfil: tipoConta,
      });
      res.status(200).json({ status: 'ok', usuario, alterado });
    },

    async inativar(req, res) {
      const usuario = await usuarioAdministracaoService.inativar(poolInjetado, {
        ...daSessao(req), ...doDispositivo(req), usuarioId: req.validado.params.id,
      });
      res.status(200).json({ status: 'ok', usuario });
    },

    async reativar(req, res) {
      const usuario = await usuarioAdministracaoService.reativar(poolInjetado, {
        ...daSessao(req), ...doDispositivo(req), usuarioId: req.validado.params.id,
      });
      res.status(200).json({ status: 'ok', usuario });
    },
  };
}

const usuarioAdministracaoController = criarUsuarioAdministracaoController({ pool });

module.exports = { criarUsuarioAdministracaoController, usuarioAdministracaoController };
