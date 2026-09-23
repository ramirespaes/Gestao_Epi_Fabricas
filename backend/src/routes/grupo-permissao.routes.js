'use strict';

const { Router } = require('express');
const { validar } = require('../middleware/validar');
const grupoPermissaoSchemas = require('../schemas/grupo-permissao.schema');
const { grupoPermissaoController } = require('../controllers/grupo-permissao.controller');
const { exigirSessao } = require('../middleware/autenticacao');

/**
 * Rotas de permissões de grupo (Bloco 8, Incremento 8, Etapa 5A,
 * Subetapa 3N).
 *
 * Mesma fábrica de grupo-acesso.routes.js (Subetapa 3M): só conecta
 * caminho + middlewares + um controller já pronto, sem saber como foram
 * construídos — é isso que permite montar as mesmas rotas em produção
 * (pool real) e em teste (pool temporário exclusivo), sem duplicar a
 * definição em lugar nenhum.
 *
 * TODAS as rotas ficam atrás de exigirSessao — inclusive as duas de
 * consulta. Só se alcança o controller quando o cookie corresponde a uma
 * sessão validada no PostgreSQL, com usuário e empresa ativos.
 *
 * A AUTORIDADE ADMINISTRATIVA NÃO MORA AQUI, de propósito: quem exige
 * MASTER ativo da própria empresa é grupo-permissao.service.js (Subetapa
 * 3K), pelo ponto único autoridade-administrativa.js, relendo perfil e
 * `ativo` do banco a cada chamada (escrita sob FOR UPDATE, leitura sem
 * lock) — inclusive nas duas listagens, que passaram a exigir essa
 * mesma autoridade como ajuste mínimo desta rodada (mesma decisão já
 * tomada para grupo-acesso.service.js na Subetapa 3M). Repetir a regra
 * na rota criaria uma segunda definição de "quem administra". A rota
 * garante autenticação; o serviço garante autorização.
 *
 * Ordem dos middlewares: exigirSessao (identidade antes de qualquer
 * outro custo) -> validar (recusa params/body malformados antes do
 * controller) -> controller. Rate limit por IP, CORS com allowlist,
 * verificação de origem em métodos que alteram estado e política de
 * conteúdo JSON já se aplicam a todo /api em app.js, antes destas
 * rotas — nada disso é reconfigurado aqui.
 *
 * Caminhos finais, quando montado por app.js sob /api:
 *   GET   /api/grupos-acesso/:id/permissoes/recursos
 *   GET   /api/grupos-acesso/:id/permissoes/acoes
 *   PATCH /api/grupos-acesso/:id/permissoes/recursos/:recurso
 *   PATCH /api/grupos-acesso/:id/permissoes/acoes/:acaoCodigo
 *
 * Nenhuma rota de exclusão: retirar a opinião de um grupo sobre uma
 * operação ou ação é um PATCH com o campo em `null` (herdar do perfil),
 * nunca um DELETE — mesma decisão já registrada em
 * grupo-permissao.repository.js.
 */

function criarGrupoPermissaoRoutes({ controller, exigirSessao: exigirSessaoInjetado }) {
  const router = Router();

  router.get(
    '/grupos-acesso/:id/permissoes/recursos',
    exigirSessaoInjetado,
    validar({ params: grupoPermissaoSchemas.listarRecursos.params }),
    controller.listarRecursos,
  );
  router.get(
    '/grupos-acesso/:id/permissoes/acoes',
    exigirSessaoInjetado,
    validar({ params: grupoPermissaoSchemas.listarAcoes.params }),
    controller.listarAcoes,
  );
  router.patch(
    '/grupos-acesso/:id/permissoes/recursos/:recurso',
    exigirSessaoInjetado,
    validar({ params: grupoPermissaoSchemas.configurarRecurso.params, body: grupoPermissaoSchemas.configurarRecurso.body }),
    controller.configurarRecurso,
  );
  router.patch(
    '/grupos-acesso/:id/permissoes/acoes/:acaoCodigo',
    exigirSessaoInjetado,
    validar({ params: grupoPermissaoSchemas.configurarAcao.params, body: grupoPermissaoSchemas.configurarAcao.body }),
    controller.configurarAcao,
  );

  return router;
}

const grupoPermissaoRoutes = criarGrupoPermissaoRoutes({ controller: grupoPermissaoController, exigirSessao });

module.exports = { criarGrupoPermissaoRoutes, grupoPermissaoRoutes };
