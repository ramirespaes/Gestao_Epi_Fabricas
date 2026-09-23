'use strict';

const { Router } = require('express');
const { validar } = require('../middleware/validar');
const autorizacaoIndividualSchemas = require('../schemas/autorizacao-individual.schema');
const { autorizacaoIndividualController } = require('../controllers/autorizacao-individual.controller');
const { exigirSessao } = require('../middleware/autenticacao');

/**
 * Rotas de autorizações individuais de ação (Bloco 8, Incremento 8,
 * Etapa 5A, Subetapa 3P).
 *
 * Mesma fábrica de grupo-acesso.routes.js (3M), grupo-permissao.routes.js
 * (3N) e grupo-usuario.routes.js (3O): só conecta caminho + middlewares
 * + um controller já pronto. As duas rotas ficam atrás de exigirSessao.
 *
 * A AUTORIDADE ADMINISTRATIVA NÃO MORA AQUI, de propósito: quem decide
 * se o ator pode conceder (só MASTER), delegar (só não-MASTER, com
 * origem própria e pode_delegar = true) ou revogar (MASTER, ou quem
 * concedeu aquela linha) é autorizacao-individual.service.js (Subetapa
 * 3I), relendo perfil e `ativo` do banco a cada chamada. Este serviço
 * NÃO usa autoridade-administrativa.js — a autoridade de conceder/
 * delegar/revogar autorização individual é decidida por regras
 * próprias da 3I (MASTER, ou a cadeia de origem/pode_delegar), diferente
 * da autoridade administrativa de grupos (3J/3K/3L). A rota garante
 * autenticação; o serviço garante autorização.
 *
 * SEM ROTA DE CONSULTA/LISTAGEM: o serviço da 3I não expõe nenhuma
 * função de leitura administrativa — só as três de escrita
 * (concederDireta, delegar, revogar). Nada aqui inventa uma.
 *
 * UM ÚNICO POST PARA AS DUAS FORMAS DE CONCESSÃO: o corpo (validado por
 * z.discriminatedUnion em autorizacao-individual.schema.js) decide, via
 * `tipo`, se o controller chama concederDireta ou delegar — evita dois
 * endpoints quase idênticos, mesma disciplina que já evitou uma rota
 * separada de "transferir" na Subetapa 3O.
 *
 * DELETE também cobre "revogação por origem": revogar uma autorização
 * que é origem de outras aciona a cascata da FK da migration 023 sobre
 * os descendentes — não existe um caminho HTTP separado para isso.
 *
 * Ordem dos middlewares: exigirSessao -> validar -> controller. Rate
 * limit, CORS, verificação de origem e política de conteúdo JSON já se
 * aplicam a todo /api em app.js, antes destas rotas.
 *
 * Caminhos finais, quando montado por app.js sob /api:
 *   POST   /api/autorizacoes-individuais
 *   DELETE /api/autorizacoes-individuais/:id
 */

function criarAutorizacaoIndividualRoutes({ controller, exigirSessao: exigirSessaoInjetado }) {
  const router = Router();

  router.post(
    '/autorizacoes-individuais',
    exigirSessaoInjetado,
    validar({ body: autorizacaoIndividualSchemas.criar.body }),
    controller.criar,
  );
  router.delete(
    '/autorizacoes-individuais/:id',
    exigirSessaoInjetado,
    validar({ params: autorizacaoIndividualSchemas.revogar.params, body: autorizacaoIndividualSchemas.revogar.body }),
    controller.revogar,
  );

  return router;
}

const autorizacaoIndividualRoutes = criarAutorizacaoIndividualRoutes({ controller: autorizacaoIndividualController, exigirSessao });

module.exports = { criarAutorizacaoIndividualRoutes, autorizacaoIndividualRoutes };
