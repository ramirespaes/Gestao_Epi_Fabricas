'use strict';

const grupoAcessoService = require('../services/grupo-acesso.service');
const { pool } = require('../config/database');

/**
 * Controller de grupos de acesso (Bloco 8, Incremento 8, Etapa 5A,
 * Subetapa 3M).
 *
 * Traduz requisição em chamada de serviço e resultado em resposta HTTP.
 * Não decide NADA: não sabe o que é MASTER, isolamento multiempresa,
 * unicidade de nome, tri-state de permissão ou auditoria — tudo isso já
 * está resolvido em grupo-acesso.service.js, aprovado na Subetapa 3J e
 * inalterado em suas regras. Sem try/catch: Express 5 encaminha a Promise
 * rejeitada ao errorHandler, que já traduz HttpError (403/404/409/400) e
 * erros genéricos sem vazar stack, SQL ou dado sensível.
 *
 * `grupoAcessoService.funcao(...)` é chamado por namespace, nunca
 * desestruturado — mesma razão de auth.controller.js: permite mock.method
 * nos testes sem alterar produção.
 *
 * FONTE DE AUTORIDADE — o ponto mais importante deste arquivo: `empresaId`
 * e `atorId` saem EXCLUSIVAMENTE de req.empresa.id e req.usuario.id, que
 * exigirSessao populou depois de validar o cookie contra o PostgreSQL.
 * Nada vindo de body, params ou query influencia quem é o ator ou de qual
 * empresa ele é — um `empresaId`, `isMaster`, `perfil` ou `usuarioId`
 * enviados no corpo sequer passam pelo schema (strictObject os rejeita), e
 * mesmo que passassem não seriam lidos aqui. O serviço ainda relê perfil e
 * `ativo` do banco por cima disso.
 *
 * O pool real de config/database.js entra pela fábrica, nunca importado
 * por service ou repository — mesma decisão arquitetural do Bloco 8.
 */

function criarGrupoAcessoController({ pool: poolInjetado }) {
  return {
    async criar(req, res) {
      const { nome, descricao } = req.validado.body;

      const grupo = await grupoAcessoService.criar(poolInjetado, {
        empresaId: req.empresa.id,
        atorId: req.usuario.id,
        nome,
        descricao: descricao ?? null,
        ip: req.ip,
        dispositivo: req.headers['user-agent'],
      });

      res.status(201).json({ status: 'ok', grupo });
    },

    async listar(req, res) {
      const grupos = await grupoAcessoService.listar(poolInjetado, {
        empresaId: req.empresa.id,
        atorId: req.usuario.id,
        // Ausente vira null: lista ativos E inativos.
        ativo: req.validado.query.ativo ?? null,
      });

      res.status(200).json({ status: 'ok', grupos });
    },

    async buscar(req, res) {
      const grupo = await grupoAcessoService.buscar(poolInjetado, {
        empresaId: req.empresa.id,
        atorId: req.usuario.id,
        grupoId: req.validado.params.id,
      });

      res.status(200).json({ status: 'ok', grupo });
    },

    /**
     * Só nome e descrição. `descricao` ausente no corpo não é repassada, e
     * o serviço a preserva; `descricao: null` é repassada e limpa o campo.
     * A distinção entre "ausente" e "null" é o contrato de alterar() e
     * precisa atravessar este ponto sem ser achatada — por isso as chaves
     * são montadas condicionalmente, em vez de `?? null`.
     */
    async alterar(req, res) {
      const { nome, descricao } = req.validado.body;

      const grupo = await grupoAcessoService.alterar(poolInjetado, {
        empresaId: req.empresa.id,
        atorId: req.usuario.id,
        grupoId: req.validado.params.id,
        ...(Object.hasOwn(req.validado.body, 'nome') ? { nome } : {}),
        ...(Object.hasOwn(req.validado.body, 'descricao') ? { descricao } : {}),
        ip: req.ip,
        dispositivo: req.headers['user-agent'],
      });

      res.status(200).json({ status: 'ok', grupo });
    },

    async inativar(req, res) {
      const { grupo, alterado } = await grupoAcessoService.inativar(poolInjetado, {
        empresaId: req.empresa.id,
        atorId: req.usuario.id,
        grupoId: req.validado.params.id,
        ip: req.ip,
        dispositivo: req.headers['user-agent'],
      });

      // `alterado: false` (já estava inativo) é sucesso idempotente, não
      // erro: o estado pedido é o estado atual.
      res.status(200).json({ status: 'ok', grupo, alterado });
    },

    async reativar(req, res) {
      const { grupo, alterado } = await grupoAcessoService.reativar(poolInjetado, {
        empresaId: req.empresa.id,
        atorId: req.usuario.id,
        grupoId: req.validado.params.id,
        ip: req.ip,
        dispositivo: req.headers['user-agent'],
      });

      res.status(200).json({ status: 'ok', grupo, alterado });
    },
  };
}

const grupoAcessoController = criarGrupoAcessoController({ pool });

module.exports = { criarGrupoAcessoController, grupoAcessoController };
