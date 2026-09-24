'use strict';

const conviteMasterService = require('../services/convite-master.service');
const entregaConvite = require('../services/entrega-convite.service');
const { pool } = require('../config/database');

/**
 * Controller do convite do MASTER (Pacote 3).
 *
 * Rotas ADMINISTRATIVAS (criar/listar/buscar/cancelar): `administradorId`
 * vem só de req.administradorPlataforma. A resposta de `criar` carrega o
 * resultado de entrega-convite.service.js (mecanismo de DESENVOLVIMENTO:
 * o link de aceite volta na resposta; nenhum e-mail real é enviado — ver
 * aquele módulo e o relatório do pacote). O token NUNCA vai para log.
 *
 * Rotas PÚBLICAS (consultar/aceitar): sem sessão de nenhum tipo — a
 * autoridade é a posse do token. Não emitem cookie nem sessão: o login da
 * pessoa é o Pacote 4.
 */

const comContexto = (req) => ({ administradorId: req.administradorPlataforma.id, ip: req.ip, dispositivo: req.headers['user-agent'] });

function criarConviteMasterController({ pool: poolInjetado, entregar = entregaConvite.entregar }) {
  return {
    async criar(req, res) {
      const { convite, token, empresa } = await conviteMasterService.criar(poolInjetado, {
        ...comContexto(req), empresaId: req.validado.params.id, email: req.validado.body.email,
      });
      const entrega = await entregar({ emailConvite: convite.emailConvite, token, expiraEm: convite.expiraEm, empresa });
      res.status(201).json({ status: 'ok', convite, empresa, entrega });
    },

    async listar(req, res) {
      const convites = await conviteMasterService.listarPorEmpresa(poolInjetado, { empresaId: req.validado.params.id });
      res.status(200).json({ status: 'ok', convites });
    },

    async buscar(req, res) {
      const convite = await conviteMasterService.buscar(poolInjetado, { empresaId: req.validado.params.id, conviteId: req.validado.params.conviteId });
      res.status(200).json({ status: 'ok', convite });
    },

    async cancelar(req, res) {
      const convite = await conviteMasterService.cancelar(poolInjetado, {
        ...comContexto(req), empresaId: req.validado.params.id, conviteId: req.validado.params.conviteId,
      });
      res.status(200).json({ status: 'ok', convite });
    },

    async consultar(req, res) {
      const resultado = await conviteMasterService.consultarPorToken(poolInjetado, { token: req.validado.body.token });
      res.status(200).json({ status: 'ok', ...resultado });
    },

    async aceitar(req, res) {
      const { token, nome, senha } = req.validado.body;
      const resultado = await conviteMasterService.aceitar(poolInjetado, {
        token, nome, senha, ip: req.ip, dispositivo: req.headers['user-agent'],
      });
      res.status(201).json({ status: 'ok', ...resultado });
    },
  };
}

const conviteMasterController = criarConviteMasterController({ pool });

module.exports = { criarConviteMasterController, conviteMasterController };
