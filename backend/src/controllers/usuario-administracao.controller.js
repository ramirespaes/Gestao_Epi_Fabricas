'use strict';

const usuarioAdministracaoService = require('../services/usuario-administracao.service');
const permissaoUsuarioService = require('../services/permissao-usuario.service');
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

    async criar(req, res) {
      const {
        nome, email, tipoConta, senhaProvisoria, cpf, matricula, setor, horarioTrabalho = null, ipsPermitidos = [], grupoAcessoId = null, usuarioModeloId = null, vinculoSst = false,
      } = req.validado.body;
      const resultado = await usuarioAdministracaoService.criar(poolInjetado, {
        ...daSessao(req), ...doDispositivo(req), nome, email, perfil: tipoConta, senhaProvisoria, cpf, matricula, setor, horarioTrabalho, ipsPermitidos, grupoAcessoId, usuarioModeloId, vinculoSst,
      });
      // A senha provisória não volta: só o usuário criado, até quando ela vale e
      // os dados administrativos gravados (CPF só mascarado).
      res.status(201).json({
        status: 'ok', usuario: resultado.usuario, senhaProvisoriaExpiraEm: resultado.senhaProvisoriaExpiraEm.toISOString(), administrativo: resultado.administrativo, copiaDeAcesso: resultado.copiaDeAcesso,
      });
    },

    async alterar(req, res) {
      const { tipoConta, ...resto } = req.validado.body;
      const { usuario, alterado } = await usuarioAdministracaoService.alterar(poolInjetado, {
        ...daSessao(req), ...doDispositivo(req), usuarioId: req.validado.params.id, ...resto, perfil: tipoConta,
      });
      res.status(200).json({ status: 'ok', usuario, alterado });
    },

    async permissoes(req, res) {
      const permissoes = await permissaoUsuarioService.detalhar(poolInjetado, { ...daSessao(req), usuarioId: req.validado.params.id });
      res.status(200).json({ status: 'ok', permissoes });
    },

    async permissaoRecurso(req, res) {
      const { id, recurso } = req.validado.params;
      const item = await permissaoUsuarioService.configurarRecurso(poolInjetado, {
        ...daSessao(req), ...doDispositivo(req), usuarioId: id, recurso, flags: req.validado.body,
      });
      res.status(200).json({ status: 'ok', recurso: item });
    },

    async permissaoAcao(req, res) {
      const { id, codigo } = req.validado.params;
      const item = await permissaoUsuarioService.configurarAcao(poolInjetado, {
        ...daSessao(req), ...doDispositivo(req), usuarioId: id, acaoCodigo: codigo, estado: req.validado.body.estado,
      });
      res.status(200).json({ status: 'ok', acao: item });
    },

    async acessos(req, res) {
      const acessos = await permissaoUsuarioService.detalharToggles(poolInjetado, { ...daSessao(req), usuarioId: req.validado.params.id });
      res.status(200).json({ status: 'ok', acessos });
    },

    async acesso(req, res) {
      const { id, toggle } = req.validado.params;
      const item = await permissaoUsuarioService.configurarToggle(poolInjetado, {
        ...daSessao(req), ...doDispositivo(req), usuarioId: id, toggleId: toggle, ligado: req.validado.body.ligado,
      });
      res.status(200).json({ status: 'ok', acesso: item });
    },

    async copiarPermissoes(req, res) {
      const resultado = await permissaoUsuarioService.copiar(poolInjetado, {
        ...daSessao(req), ...doDispositivo(req), destinoId: req.validado.params.id, origemId: req.validado.body.origemId,
      });
      res.status(200).json({ status: 'ok', copia: resultado });
    },

    async redefinirSenha(req, res) {
      const r = await usuarioAdministracaoService.redefinirSenhaProvisoria(poolInjetado, {
        ...daSessao(req), ...doDispositivo(req), usuarioId: req.validado.params.id, senhaProvisoria: req.validado.body.senhaProvisoria,
      });
      // A senha não volta: só até quando a provisória vale.
      res.status(200).json({ status: 'ok', senhaProvisoriaExpiraEm: r.senhaProvisoriaExpiraEm.toISOString() });
    },

    async edicao(req, res) {
      const usuario = await usuarioAdministracaoService.detalharEdicao(poolInjetado, {
        ...daSessao(req), ...doDispositivo(req), usuarioId: req.validado.params.id,
      });
      res.status(200).json({ status: 'ok', usuario });
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
