'use strict';

const alertaFaltaSvc = require('../services/alerta-falta-estoque.service');
const { dataOperacional } = require('../utils/data-operacional');
const { pool } = require('../config/database');

/**
 * Controller do alerta manual de falta de estoque (12G-6). Empresa e ator só
 * da sessão; a rota já exigiu REALIZAR_ENTREGA. A resposta diz só quantos
 * receberam, nunca quem. Relógio e serviço de e-mail injetáveis para os testes.
 */

function criarAlertaEstoqueController({ pool: poolInjetado, relogio = () => new Date(), servicoEmail = undefined }) {
  return {
    async falta(req, res) {
      const { destinatarios } = await alertaFaltaSvc.gerarAlertaFalta(poolInjetado, {
        empresaId: req.empresa.id,
        atorId: req.usuario.id,
        solicitacaoId: req.validado.body.solicitacaoId,
        hoje: dataOperacional(relogio()),
        ip: req.ip,
      }, { servicoEmail });
      res.status(200).json({ status: 'ok', alerta: { destinatarios } });
    },
  };
}

const alertaEstoqueController = criarAlertaEstoqueController({ pool });

module.exports = { criarAlertaEstoqueController, alertaEstoqueController };
