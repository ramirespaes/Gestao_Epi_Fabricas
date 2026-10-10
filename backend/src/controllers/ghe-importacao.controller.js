'use strict';

const gheImportacaoService = require('../services/ghe-importacao.service');
const { pool } = require('../config/database');

/**
 * Controller da importação GHE/EPI (Incremento 5B). Traduz a requisição em chamada de serviço e não decide nada:
 * `empresaId` só de req.empresa (exigirSessao); autorização (criar E editar GHE) e leitura do corpo já aconteceram na rota.
 */

function criarGheImportacaoController({ pool: poolInjetado }) {
  return {
    async previa(req, res) {
      const resultado = await gheImportacaoService.previa(poolInjetado, { empresaId: req.empresa.id, linhas: req.validado.body.linhas });
      res.status(200).json({ status: 'ok', ...resultado });
    },

    async confirmar(req, res) {
      const resultado = await gheImportacaoService.confirmar(poolInjetado, {
        empresaId: req.empresa.id, atorId: req.usuario.id, linhas: req.validado.body.linhas, ip: req.ip, dispositivo: req.headers['user-agent'],
      });
      res.status(200).json({ status: 'ok', ...resultado });
    },
  };
}

const gheImportacaoController = criarGheImportacaoController({ pool });

module.exports = { criarGheImportacaoController, gheImportacaoController };
