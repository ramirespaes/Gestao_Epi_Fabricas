'use strict';

const grupoPermissaoService = require('../services/grupo-permissao.service');
const { pool } = require('../config/database');

/**
 * Controller de permissões de grupo (Bloco 8, Incremento 8, Etapa 5A,
 * Subetapa 3N).
 *
 * Traduz requisição em chamada de serviço e resultado em resposta HTTP.
 * Não decide NADA: existência do grupo, autoridade administrativa
 * (inclusive nas duas listagens, desde este ajuste da 3N), tri-state,
 * modo da ação (NENHUMA/ALTERNATIVA/OBRIGATORIA), auditoria e
 * transação já estão resolvidos em grupo-permissao.service.js, aprovado
 * na Subetapa 3K e inalterado em suas quatro operações. Sem try/catch:
 * Express 5 encaminha a Promise rejeitada ao errorHandler, que já
 * traduz HttpError (400/403/404/409) e erros genéricos sem vazar stack,
 * SQL ou dado sensível.
 *
 * `grupoPermissaoService.funcao(...)` é chamado por namespace, nunca
 * desestruturado — mesma razão de grupo-acesso.controller.js: permite
 * mock.method nos testes sem alterar produção.
 *
 * FONTE DE AUTORIDADE — o ponto mais importante deste arquivo: `empresaId`
 * e `atorId` saem EXCLUSIVAMENTE de req.empresa.id e req.usuario.id, que
 * exigirSessao populou depois de validar o cookie contra o PostgreSQL.
 * Nada vindo de body, params ou query influencia quem é o ator ou de qual
 * empresa ele é — um `empresaId`, `isMaster`, `perfil` ou `atorId`
 * enviados no corpo sequer passam pelo schema (strictObject os rejeita), e
 * mesmo que passassem não seriam lidos aqui.
 *
 * DISTINÇÃO AUSENTE/NULL PRESERVADA ATÉ O SERVIÇO: em configurarRecurso,
 * cada uma das quatro operações só é incluída na chamada ao serviço
 * quando a chave realmente veio no corpo validado (`Object.hasOwn`) — é
 * assim que "campo ausente preserva o valor atual" (decisão do serviço)
 * chega intacta até lá, mesmo depois de passar por Zod.
 *
 * O pool real de config/database.js entra pela fábrica, nunca importado
 * por service ou repository — mesma decisão arquitetural do Bloco 8.
 */

function criarGrupoPermissaoController({ pool: poolInjetado }) {
  return {
    async listarRecursos(req, res) {
      const recursos = await grupoPermissaoService.listarRecursos(poolInjetado, {
        empresaId: req.empresa.id,
        atorId: req.usuario.id,
        grupoId: req.validado.params.id,
      });

      res.status(200).json({ status: 'ok', recursos });
    },

    async listarAcoes(req, res) {
      const acoes = await grupoPermissaoService.listarAcoes(poolInjetado, {
        empresaId: req.empresa.id,
        atorId: req.usuario.id,
        grupoId: req.validado.params.id,
      });

      res.status(200).json({ status: 'ok', acoes });
    },

    async configurarRecurso(req, res) {
      const { podeVisualizar, podeCriar, podeEditar, podeExcluir } = req.validado.body;

      const { configuracao, alterado } = await grupoPermissaoService.configurarRecurso(poolInjetado, {
        empresaId: req.empresa.id,
        atorId: req.usuario.id,
        grupoId: req.validado.params.id,
        recurso: req.validado.params.recurso,
        ...(Object.hasOwn(req.validado.body, 'podeVisualizar') ? { podeVisualizar } : {}),
        ...(Object.hasOwn(req.validado.body, 'podeCriar') ? { podeCriar } : {}),
        ...(Object.hasOwn(req.validado.body, 'podeEditar') ? { podeEditar } : {}),
        ...(Object.hasOwn(req.validado.body, 'podeExcluir') ? { podeExcluir } : {}),
        ip: req.ip,
        dispositivo: req.headers['user-agent'],
      });

      res.status(200).json({ status: 'ok', configuracao, alterado });
    },

    async configurarAcao(req, res) {
      const { permitido } = req.validado.body;

      const { configuracao, alterado } = await grupoPermissaoService.configurarAcao(poolInjetado, {
        empresaId: req.empresa.id,
        atorId: req.usuario.id,
        grupoId: req.validado.params.id,
        acaoCodigo: req.validado.params.acaoCodigo,
        permitido,
        ip: req.ip,
        dispositivo: req.headers['user-agent'],
      });

      res.status(200).json({ status: 'ok', configuracao, alterado });
    },
  };
}

const grupoPermissaoController = criarGrupoPermissaoController({ pool });

module.exports = { criarGrupoPermissaoController, grupoPermissaoController };
