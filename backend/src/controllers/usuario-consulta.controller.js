'use strict';

const usuarioConsultaService = require('../services/usuario-consulta.service');
const { pool } = require('../config/database');

/**
 * Controller da consulta de usuários (Bloco 8, Incremento 8, Etapa 5A,
 * Subetapa 3U).
 *
 * Traduz requisição em chamada de serviço e resultado em resposta HTTP.
 * Não decide nada: autoridade, filtro e paginação já estão resolvidos em
 * usuario-consulta.service.js e no repositório. Sem try/catch — Express 5
 * encaminha a Promise rejeitada ao errorHandler.
 *
 * FONTE DE AUTORIDADE: `empresaId` e `atorId` saem EXCLUSIVAMENTE de
 * req.empresa.id e req.usuario.id, populados por exigirSessao. Da query
 * vêm apenas filtros de apresentação — busca, situação do vínculo e
 * paginação —, nada que influencie QUEM pode ver o quê.
 */

function criarUsuarioConsultaController({ pool: poolInjetado }) {
  return {
    async listar(req, res) {
      const { busca, vinculo, pagina, limite } = req.validado.query;

      const resultado = await usuarioConsultaService.listar(poolInjetado, {
        empresaId: req.empresa.id,
        atorId: req.usuario.id,
        busca: busca ?? null,
        vinculo: vinculo ?? 'todos',
        pagina,
        limite,
      });

      res.status(200).json({ status: 'ok', ...resultado });
    },
  };
}

const usuarioConsultaController = criarUsuarioConsultaController({ pool });

module.exports = { criarUsuarioConsultaController, usuarioConsultaController };
