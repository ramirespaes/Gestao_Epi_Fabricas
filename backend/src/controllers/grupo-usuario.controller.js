'use strict';

const grupoUsuarioService = require('../services/grupo-usuario.service');
const { pool } = require('../config/database');

/**
 * Controller de vinculação de usuários aos grupos de acesso (Bloco 8,
 * Incremento 8, Etapa 5A, Subetapa 3O).
 *
 * Traduz requisição em chamada de serviço e resultado em resposta HTTP.
 * Não decide NADA: existência de usuário/grupo, autoridade administrativa
 * (inclusive na consulta, desde este ajuste da 3O), a proibição de
 * autovínculo, a recusa de vincular MASTER, grupo/usuário inativo e a
 * substituição do vínculo anterior (transferência) já estão resolvidos em
 * grupo-usuario.service.js, aprovado na Subetapa 3L e inalterado em suas
 * três operações. Sem try/catch: Express 5 encaminha a Promise rejeitada
 * ao errorHandler.
 *
 * `grupoUsuarioService.funcao(...)` é chamado por namespace, nunca
 * desestruturado — mesma razão dos demais controllers deste bloco.
 *
 * FONTE DE AUTORIDADE: `empresaId` e `atorId` saem EXCLUSIVAMENTE de
 * req.empresa.id e req.usuario.id. O usuário afetado (e o grupo de
 * destino, quando a operação usa um) vêm inteiramente dos parâmetros
 * da própria URL — nenhum dado de negócio chega pelo corpo (ver
 * grupo-usuario.schema.js).
 *
 * VINCULAR USA :id (grupo) E :usuarioId; DESVINCULAR SÓ USA
 * :usuarioId (correção pós-auditoria da Subetapa 3O): a operação de
 * desvincular do serviço da 3L não recebe grupoId — ela sempre remove
 * o vínculo ATUAL do usuário, seja ele qual for (ver o comentário do
 * próprio serviço: "retirar pode aumentar acesso"). Por isso a rota de
 * desvincular (DELETE /api/usuarios/:usuarioId/grupo-acesso,
 * grupo-usuario.routes.js) não vive sob `/grupos-acesso/:id`: não
 * existe `params.id` para ler aqui, só `params.usuarioId`. A resposta
 * devolve `grupoAnteriorId` para que o chamador sempre veja qual era o
 * vínculo efetivamente removido.
 *
 * O pool real de config/database.js entra pela fábrica, nunca importado
 * por service ou repository — mesma decisão arquitetural do Bloco 8.
 */

function criarGrupoUsuarioController({ pool: poolInjetado }) {
  return {
    async listar(req, res) {
      const usuarios = await grupoUsuarioService.listarUsuariosDoGrupo(poolInjetado, {
        empresaId: req.empresa.id,
        atorId: req.usuario.id,
        grupoId: req.validado.params.id,
      });

      res.status(200).json({ status: 'ok', usuarios });
    },

    async vincular(req, res) {
      const { alterado, ...vinculo } = await grupoUsuarioService.vincular(poolInjetado, {
        empresaId: req.empresa.id,
        atorId: req.usuario.id,
        usuarioId: req.validado.params.usuarioId,
        grupoId: req.validado.params.id,
        ip: req.ip,
        dispositivo: req.headers['user-agent'],
      });

      res.status(200).json({ status: 'ok', vinculo, alterado });
    },

    async desvincular(req, res) {
      const { alterado, ...vinculo } = await grupoUsuarioService.desvincular(poolInjetado, {
        empresaId: req.empresa.id,
        atorId: req.usuario.id,
        usuarioId: req.validado.params.usuarioId,
        ip: req.ip,
        dispositivo: req.headers['user-agent'],
      });

      res.status(200).json({ status: 'ok', vinculo, alterado });
    },
  };
}

const grupoUsuarioController = criarGrupoUsuarioController({ pool });

module.exports = { criarGrupoUsuarioController, grupoUsuarioController };
