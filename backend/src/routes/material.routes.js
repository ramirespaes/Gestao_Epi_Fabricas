'use strict';

const { Router } = require('express');
const { validar } = require('../middleware/validar');
const materialSchemas = require('../schemas/material.schema');
const { materialController } = require('../controllers/material.controller');
const { exigirSessao } = require('../middleware/autenticacao');
const { criarExigirPermissaoRecurso } = require('../middleware/autorizacao');
const { pool } = require('../config/database');

/**
 * Rotas de materiais (Bloco 9, Etapa A).
 *
 * PRIMEIRA ROTA DE PRODUÇÃO A MONTAR `criarExigirPermissaoRecurso` COMO
 * MIDDLEWARE: a fábrica existe desde o Bloco 8 (Subetapas 3D/3G) e já era
 * testada diretamente, mas nenhuma rota de negócio a usava — as telas do
 * Bloco 8 (grupos, permissões, vínculos, autorizações) são configuração de
 * RBAC e usam autoridade-administrativa.js. Materiais são um recurso de
 * negócio comum, então usam a cadeia geral perfil -> grupo -> exceção
 * individual, exatamente como o middleware já decide (ver
 * src/middleware/autorizacao.js).
 *
 * Ordem dos middlewares: exigirSessao (identidade) -> exigirPermissao*
 * (autorização, por recurso e operação) -> validar (formato) ->
 * controller. Rate limit por IP, CORS, verificação de origem e política de
 * conteúdo já se aplicam a todo /api em app.js, antes destas rotas.
 *
 * Recurso `'materials'` (mesmo identificador já usado no frontend legado,
 * convenção documentada na migration 009), quatro operações:
 *   visualizar -> GET (listar, buscar)
 *   criar      -> POST
 *   editar     -> PATCH, e as duas rotas de estado (inativar/reativar,
 *                 que são uma alteração do cadastro, não uma ação de
 *                 negócio separada)
 *
 * SEM ROTA DE EXCLUSÃO: materiais são inativados, nunca apagados — decisão
 * do Bloco 9, preservando o histórico de estoque e auditoria.
 *
 * Caminhos finais, quando montado por app.js sob /api:
 *   POST  /api/materiais
 *   GET   /api/materiais
 *   GET   /api/materiais/:id
 *   PATCH /api/materiais/:id
 *   POST  /api/materiais/:id/inativar
 *   POST  /api/materiais/:id/reativar
 */

const RECURSO = 'materials';

function criarMaterialRoutes({ controller, exigirSessao: exigirSessaoInjetado, pool: poolInjetado }) {
  const router = Router();

  const exigirVisualizar = criarExigirPermissaoRecurso({ pool: poolInjetado }, RECURSO, 'visualizar');
  const exigirCriar = criarExigirPermissaoRecurso({ pool: poolInjetado }, RECURSO, 'criar');
  const exigirEditar = criarExigirPermissaoRecurso({ pool: poolInjetado }, RECURSO, 'editar');

  router.post(
    '/materiais',
    exigirSessaoInjetado, exigirCriar,
    validar({ body: materialSchemas.criar.body }),
    controller.criar,
  );
  router.get(
    '/materiais',
    exigirSessaoInjetado, exigirVisualizar,
    validar({ query: materialSchemas.listar.query }),
    controller.listar,
  );
  router.get(
    '/materiais/:id',
    exigirSessaoInjetado, exigirVisualizar,
    validar({ params: materialSchemas.buscar.params }),
    controller.buscar,
  );
  router.patch(
    '/materiais/:id',
    exigirSessaoInjetado, exigirEditar,
    validar({ params: materialSchemas.alterar.params, body: materialSchemas.alterar.body }),
    controller.alterar,
  );
  router.post(
    '/materiais/:id/inativar',
    exigirSessaoInjetado, exigirEditar,
    validar({ params: materialSchemas.inativar.params, body: materialSchemas.inativar.body }),
    controller.inativar,
  );
  router.post(
    '/materiais/:id/reativar',
    exigirSessaoInjetado, exigirEditar,
    validar({ params: materialSchemas.reativar.params, body: materialSchemas.reativar.body }),
    controller.reativar,
  );

  return router;
}

const materialRoutes = criarMaterialRoutes({ controller: materialController, exigirSessao, pool });

module.exports = { criarMaterialRoutes, materialRoutes, RECURSO };
