'use strict';

const lgpdService = require('../services/lgpd.service');
const { pool } = require('../config/database');

/** Privacidade e LGPD (Portal). A empresa vem SÓ de req.empresa (sessão). */
function criarLgpdController({ pool: poolInjetado }) {
  return {
    async resumo(req, res) {
      const resumo = await lgpdService.resumir(poolInjetado, { empresaId: req.empresa.id });
      res.status(200).json({ status: 'ok', resumo });
    },
  };
}

const lgpdController = criarLgpdController({ pool });

module.exports = { criarLgpdController, lgpdController };
