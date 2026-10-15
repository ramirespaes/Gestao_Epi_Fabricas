'use strict';

const tokenAtivacaoService = require('../services/token-ativacao.service');
const { pool } = require('../config/database');

/** Geração do código de ativação: empresa e ator SÓ de req.empresa/req.usuario (sessão), nunca do corpo. */
function criarTokenAtivacaoController({ pool: poolInjetado }) {
  return {
    async gerar(req, res) {
      const ativacao = await tokenAtivacaoService.gerar(poolInjetado, {
        empresaId: req.empresa.id,
        atorId: req.usuario.id,
        dispositivoId: req.validado.params.id,
        ip: req.ip,
        dispositivo: req.headers['user-agent'],
      });
      res.status(201).json({ status: 'ok', ativacao });
    },
  };
}

const tokenAtivacaoController = criarTokenAtivacaoController({ pool });

module.exports = { criarTokenAtivacaoController, tokenAtivacaoController };
