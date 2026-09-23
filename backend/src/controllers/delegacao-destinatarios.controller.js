'use strict';

const delegacaoDestinatariosService = require('../services/delegacao-destinatarios.service');
const { pool } = require('../config/database');

/**
 * Controller da consulta de destinatários para delegação (Subetapa 3V —
 * complemento). Traduz requisição em chamada de serviço e resultado em
 * resposta HTTP; não decide nada. Sem try/catch: Express 5 encaminha a
 * Promise rejeitada ao errorHandler.
 *
 * `empresaId` e `atorId` saem EXCLUSIVAMENTE de req.empresa.id e
 * req.usuario.id. Da query vem apenas `busca`.
 */

function criarDelegacaoDestinatariosController({ pool: poolInjetado }) {
  return {
    async listar(req, res) {
      const { busca } = req.validado.query;

      const resultado = await delegacaoDestinatariosService.listarDestinatarios(poolInjetado, {
        empresaId: req.empresa.id,
        atorId: req.usuario.id,
        busca: busca ?? null,
      });

      res.status(200).json({ status: 'ok', ...resultado });
    },
  };
}

const delegacaoDestinatariosController = criarDelegacaoDestinatariosController({ pool });

module.exports = { criarDelegacaoDestinatariosController, delegacaoDestinatariosController };
