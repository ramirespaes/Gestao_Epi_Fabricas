'use strict';

const autorizacaoConsultaService = require('../services/autorizacao-consulta.service');
const { pool } = require('../config/database');

/**
 * Controller da consulta de autorizações individuais (Bloco 8,
 * Incremento 8, Etapa 5A, Subetapa 3V).
 *
 * Traduz requisição em chamada de serviço e resultado em resposta HTTP.
 * Não decide nada: a autoridade de leitura — que espelha a de escrita da
 * 3I — já está resolvida em autorizacao-consulta.service.js. Sem
 * try/catch: Express 5 encaminha a Promise rejeitada ao errorHandler.
 *
 * FONTE DE AUTORIDADE: `empresaId` e `atorId` saem EXCLUSIVAMENTE de
 * req.empresa.id e req.usuario.id, populados por exigirSessao. Da query
 * vem apenas `usuarioId` — QUEM se quer olhar, nunca com que poder.
 *
 * `escopo` acompanha a resposta para que a tela possa dizer à pessoa o
 * que ela está vendo ("todas", "as suas", "as que você concedeu") em vez
 * de apresentar uma lista possivelmente parcial sem explicação.
 */

function criarAutorizacaoConsultaController({ pool: poolInjetado }) {
  return {
    async listar(req, res) {
      const { autorizacoes, escopo } = await autorizacaoConsultaService.listarPorUsuario(poolInjetado, {
        empresaId: req.empresa.id,
        atorId: req.usuario.id,
        usuarioId: req.validado.query.usuarioId,
      });

      res.status(200).json({ status: 'ok', autorizacoes, escopo });
    },
  };
}

const autorizacaoConsultaController = criarAutorizacaoConsultaController({ pool });

module.exports = { criarAutorizacaoConsultaController, autorizacaoConsultaController };
