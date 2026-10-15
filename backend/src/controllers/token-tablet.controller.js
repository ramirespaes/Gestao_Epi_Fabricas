'use strict';

const tokenTabletService = require('../services/token-tablet.service');
const { serializarCookieDispositivo } = require('../security/cookie');
const { ipDaRequisicao } = require('../utils/ip');
const { pool } = require('../config/database');

/**
 * Rotas do tablet. A empresa e o tablet vêm da ativação/credencial no servidor, nunca do cliente. A credencial só vai em
 * Set-Cookie (HttpOnly); o corpo traz apenas os dados mínimos de localização do próprio tablet.
 */
function criarTokenTabletController({ pool: poolInjetado }) {
  return {
    async ativar(req, res) {
      const { credencial, dispositivo } = await tokenTabletService.ativar(poolInjetado, {
        codigo: req.validado.body.codigo,
        ip: ipDaRequisicao(req),
        agente: req.headers['user-agent'],
      });
      res.append('Set-Cookie', serializarCookieDispositivo(credencial));
      res.status(200).json({ status: 'ok', dispositivo });
    },

    estado(req, res) {
      const { nome, unidade, setor, localInstalacao } = req.dispositivo;
      res.status(200).json({ status: 'ok', dispositivo: { nome, unidade, setor, localInstalacao } });
    },
  };
}

const tokenTabletController = criarTokenTabletController({ pool });

module.exports = { criarTokenTabletController, tokenTabletController };
