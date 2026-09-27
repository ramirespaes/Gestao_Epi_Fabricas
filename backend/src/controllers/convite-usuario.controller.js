'use strict';

const conviteUsuarioService = require('../services/convite-usuario.service');
const entregaConviteUsuario = require('../services/entrega-convite-usuario.service');
const { pool } = require('../config/database');

/**
 * Convite de usuário (Bloco 9, parte F). Nas rotas administrativas,
 * empresa e ator vêm da sessão; nas públicas, a autoridade é o token do
 * corpo. O token em claro só passa pela entrega e nunca volta num log.
 */
function criarConviteUsuarioController({ pool: poolInjetado, entregar = entregaConviteUsuario.entregar }) {
  const daSessao = (req) => ({ empresaId: req.empresa.id, atorId: req.usuario.id });
  const doDispositivo = (req) => ({ ip: req.ip, dispositivo: req.headers['user-agent'] });

  return {
    async criar(req, res) {
      const { email, nome, tipoConta } = req.validado.body;
      const { convite, token } = await conviteUsuarioService.criar(poolInjetado, {
        ...daSessao(req), ...doDispositivo(req), email, nome, perfil: tipoConta,
      });
      const entrega = await entregar({ conviteId: convite.id, empresaId: req.empresa.id, token, expiraEm: convite.expiraEm });
      res.status(201).json({ status: 'ok', convite, entrega });
    },

    async listar(req, res) {
      const { pagina, limite } = req.validado.query;
      const resultado = await conviteUsuarioService.listarEmAberto(poolInjetado, { ...daSessao(req), pagina, limite });
      res.status(200).json({ status: 'ok', ...resultado });
    },

    async cancelar(req, res) {
      const convite = await conviteUsuarioService.cancelar(poolInjetado, {
        ...daSessao(req), ...doDispositivo(req), conviteId: req.validado.params.conviteId,
      });
      res.status(200).json({ status: 'ok', convite });
    },

    async consultar(req, res) {
      const resultado = await conviteUsuarioService.consultarPorToken(poolInjetado, { token: req.validado.body.token });
      res.status(200).json({ status: 'ok', ...resultado });
    },

    async aceitar(req, res) {
      const { token, senha } = req.validado.body;
      const resultado = await conviteUsuarioService.aceitar(poolInjetado, { token, senha, ...doDispositivo(req) });
      res.status(201).json({ status: 'ok', ...resultado });
    },
  };
}

const conviteUsuarioController = criarConviteUsuarioController({ pool });

module.exports = { criarConviteUsuarioController, conviteUsuarioController };
