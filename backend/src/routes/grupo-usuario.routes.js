'use strict';

const { Router } = require('express');
const { validar } = require('../middleware/validar');
const grupoUsuarioSchemas = require('../schemas/grupo-usuario.schema');
const { grupoUsuarioController } = require('../controllers/grupo-usuario.controller');
const { exigirSessao } = require('../middleware/autenticacao');

/**
 * Rotas de vinculação de usuários aos grupos de acesso (Bloco 8,
 * Incremento 8, Etapa 5A, Subetapa 3O).
 *
 * Mesma fábrica de grupo-acesso.routes.js (3M) e grupo-permissao.routes.js
 * (3N): só conecta caminho + middlewares + um controller já pronto.
 * TODAS as rotas ficam atrás de exigirSessao — inclusive a de consulta.
 *
 * A AUTORIDADE ADMINISTRATIVA NÃO MORA AQUI, de propósito: quem exige
 * MASTER ativo da própria empresa é grupo-usuario.service.js (Subetapa
 * 3L), pelo ponto único autoridade-administrativa.js, relendo perfil e
 * `ativo` do banco a cada chamada — inclusive na listagem, que passou a
 * exigir essa mesma autoridade como ajuste mínimo desta rodada (mesma
 * decisão já tomada para grupo-acesso.service.js na 3M e
 * grupo-permissao.service.js na 3N). A rota garante autenticação; o
 * serviço garante autorização.
 *
 * PUT para vincular (também cobre transferência, por substituição do
 * vínculo anterior — o próprio serviço da 3L já resolve isso) e DELETE
 * para desvincular: verbos idempotentes para operações idempotentes —
 * "definir o vínculo" e "remover o vínculo", a primeira vez que este
 * projeto usa PUT/DELETE, pela mesma disciplina que já escolhe POST
 * para ações e PATCH para atualização parcial em outros pontos. Não
 * existe endpoint separado de "transferir": criar um duplicaria
 * exatamente o que vincular() já faz.
 *
 * DUAS FORMAS DE URL DIFERENTES, DE PROPÓSITO (correção pós-auditoria
 * da Subetapa 3O): vincular() do serviço da 3L recebe um grupo de
 * destino, então PUT continua sob `/grupos-acesso/:id/usuarios/:usuarioId`
 * — o `:id` ali é significativo (é para ONDE o usuário vai). Já
 * desvincular() NÃO recebe grupoId — ela sempre remove o vínculo ATUAL
 * do usuário, seja ele qual for, então a rota de DELETE não fica sob
 * `/grupos-acesso/:id`: colocar um id de grupo na URL de uma operação
 * que não usa grupo nenhum era estruturalmente enganoso (nada garantia
 * que o `:id` da URL correspondesse ao vínculo real removido). O
 * recurso é modelado como o vínculo do PRÓPRIO usuário
 * (`/usuarios/:usuarioId/grupo-acesso`), e DELETE o remove — sem
 * nenhuma referência a um grupo específico, porque a operação
 * genuinamente não precisa de uma.
 *
 * Ordem dos middlewares: exigirSessao -> validar -> controller. Rate
 * limit, CORS, verificação de origem e política de conteúdo JSON já se
 * aplicam a todo /api em app.js, antes destas rotas.
 *
 * Caminhos finais, quando montado por app.js sob /api:
 *   GET    /api/grupos-acesso/:id/usuarios
 *   PUT    /api/grupos-acesso/:id/usuarios/:usuarioId
 *   DELETE /api/usuarios/:usuarioId/grupo-acesso
 *
 * Nenhuma rota de exclusão física de usuário ou grupo: DELETE aqui só
 * remove o VÍNCULO (usuarios.grupo_acesso_id = NULL), nunca a linha do
 * usuário nem a do grupo.
 */

function criarGrupoUsuarioRoutes({ controller, exigirSessao: exigirSessaoInjetado }) {
  const router = Router();

  router.get(
    '/grupos-acesso/:id/usuarios',
    exigirSessaoInjetado,
    validar({ params: grupoUsuarioSchemas.listar.params }),
    controller.listar,
  );
  router.put(
    '/grupos-acesso/:id/usuarios/:usuarioId',
    exigirSessaoInjetado,
    validar({ params: grupoUsuarioSchemas.vincular.params, body: grupoUsuarioSchemas.vincular.body }),
    controller.vincular,
  );
  router.delete(
    '/usuarios/:usuarioId/grupo-acesso',
    exigirSessaoInjetado,
    validar({ params: grupoUsuarioSchemas.desvincular.params, body: grupoUsuarioSchemas.desvincular.body }),
    controller.desvincular,
  );

  return router;
}

const grupoUsuarioRoutes = criarGrupoUsuarioRoutes({ controller: grupoUsuarioController, exigirSessao });

module.exports = { criarGrupoUsuarioRoutes, grupoUsuarioRoutes };
