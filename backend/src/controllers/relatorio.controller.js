'use strict';

const service = require('../services/relatorio.service');
const { pool } = require('../config/database');

function criarRelatorioController({ pool: poolInjetado }) {
  const rota = (funcao) => async (req, res) => {
    const resultado = await funcao(poolInjetado, { empresaId: req.empresa.id, ...req.validado.query });
    res.status(200).json({ status: 'ok', ...resultado });
  };
  return {
    estoque: rota(service.estoque),
    proximoVencimento: rota(service.proximoVencimento),
    vencidos: rota(service.vencidos),
    entregues: rota(service.entregues),
  };
}

module.exports = { criarRelatorioController, relatorioController: criarRelatorioController({ pool }) };
