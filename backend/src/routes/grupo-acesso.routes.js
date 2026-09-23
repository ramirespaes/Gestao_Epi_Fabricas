'use strict';

const { Router } = require('express');
const { validar } = require('../middleware/validar');
const grupoAcessoSchemas = require('../schemas/grupo-acesso.schema');
const { grupoAcessoController } = require('../controllers/grupo-acesso.controller');
const { exigirSessao } = require('../middleware/autenticacao');

/**
 * Rotas de grupos de acesso (Bloco 8, Incremento 8, Etapa 5A, Subetapa 3M).
 *
 * Mesma fábrica de auth.routes.js: só conecta caminho + middlewares + um
 * controller já pronto, sem saber como foram construídos. É isso que
 * permite montar as mesmas rotas em produção (pool real) e em teste (pool
 * temporário exclusivo), sem duplicar a definição em lugar nenhum.
 *
 * TODAS as rotas ficam atrás de exigirSessao — inclusive as de consulta.
 * Só se alcança o controller quando o cookie corresponde a uma sessão
 * validada no PostgreSQL, com usuário e empresa ativos. Nenhuma rota aqui
 * é pública.
 *
 * A AUTORIDADE ADMINISTRATIVA NÃO MORA AQUI, de propósito: quem exige
 * MASTER ativo da própria empresa é grupo-acesso.service.js, relendo
 * perfil e `ativo` do banco a cada operação (escrita sob FOR UPDATE,
 * leitura sem lock) pelo ponto único autoridade-administrativa.js.
 * Repetir a regra na rota criaria uma segunda definição de "quem
 * administra" — exatamente o que se evitou desde a 3K. A rota garante
 * autenticação; o serviço garante autorização.
 *
 * Ordem dos middlewares: exigirSessao (identidade antes de qualquer outro
 * custo) -> validar (recusa params/query/body malformados antes do
 * controller) -> controller. Rate limit por IP, CORS com allowlist,
 * verificação de origem em métodos que alteram estado e política de
 * conteúdo JSON já se aplicam a todo /api em app.js, antes destas rotas —
 * nada disso é reconfigurado aqui.
 *
 * INATIVAR E REATIVAR SÃO ROTAS PRÓPRIAS, não um PATCH com `ativo`: a
 * Subetapa 3J separou essas operações justamente para que a reativação —
 * que pode restaurar concessões TRUE suspensas enquanto o grupo esteve
 * inativo — nunca aconteça junto de uma renomeação e tenha registro de
 * auditoria próprio. O contrato HTTP preserva essa separação. Não existe
 * rota de exclusão: grupos nunca são apagados fisicamente.
 *
 * Caminhos finais, quando montado por app.js sob /api:
 *   POST  /api/grupos-acesso
 *   GET   /api/grupos-acesso
 *   GET   /api/grupos-acesso/:id
 *   PATCH /api/grupos-acesso/:id
 *   POST  /api/grupos-acesso/:id/inativar
 *   POST  /api/grupos-acesso/:id/reativar
 */

function criarGrupoAcessoRoutes({ controller, exigirSessao: exigirSessaoInjetado }) {
  const router = Router();

  router.post('/grupos-acesso', exigirSessaoInjetado, validar({ body: grupoAcessoSchemas.criar.body }), controller.criar);
  router.get('/grupos-acesso', exigirSessaoInjetado, validar({ query: grupoAcessoSchemas.listar.query }), controller.listar);
  router.get('/grupos-acesso/:id', exigirSessaoInjetado, validar({ params: grupoAcessoSchemas.buscar.params }), controller.buscar);
  router.patch(
    '/grupos-acesso/:id',
    exigirSessaoInjetado,
    validar({ params: grupoAcessoSchemas.alterar.params, body: grupoAcessoSchemas.alterar.body }),
    controller.alterar,
  );
  router.post(
    '/grupos-acesso/:id/inativar',
    exigirSessaoInjetado,
    validar({ params: grupoAcessoSchemas.inativar.params, body: grupoAcessoSchemas.inativar.body }),
    controller.inativar,
  );
  router.post(
    '/grupos-acesso/:id/reativar',
    exigirSessaoInjetado,
    validar({ params: grupoAcessoSchemas.reativar.params, body: grupoAcessoSchemas.reativar.body }),
    controller.reativar,
  );

  return router;
}

const grupoAcessoRoutes = criarGrupoAcessoRoutes({ controller: grupoAcessoController, exigirSessao });

module.exports = { criarGrupoAcessoRoutes, grupoAcessoRoutes };
