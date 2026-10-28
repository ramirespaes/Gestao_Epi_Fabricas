'use strict';

const emailGestaoService = require('../services/email-gestao.service');
const { emailConfig: configPadrao } = require('../config/email');
const { pool } = require('../config/database');

/** Gestão de E-mails (Portal). A empresa vem SÓ de req.empresa (sessão); a configuração de entrega é a do ambiente. */
function criarEmailGestaoController({ pool: poolInjetado, emailConfig = configPadrao }) {
  return {
    async resumo(req, res) {
      const resumo = await emailGestaoService.resumir(poolInjetado, { empresaId: req.empresa.id }, { emailConfig });
      res.status(200).json({ status: 'ok', resumo });
    },
  };
}

const emailGestaoController = criarEmailGestaoController({ pool });

module.exports = { criarEmailGestaoController, emailGestaoController };
