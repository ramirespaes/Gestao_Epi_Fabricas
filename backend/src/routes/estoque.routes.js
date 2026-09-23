'use strict';

const { Router } = require('express');
const { validar } = require('../middleware/validar');
const estoqueSchemas = require('../schemas/estoque.schema');
const { estoqueController } = require('../controllers/estoque.controller');
const { exigirSessao } = require('../middleware/autenticacao');
const { criarExigirPermissaoRecurso, criarExigirPermissaoAcao } = require('../middleware/autorizacao');
const { pool } = require('../config/database');

/**
 * Rotas de estoque por tamanho (Bloco 9, Etapa A).
 *
 * DUAS DIMENSÕES DE AUTORIZAÇÃO DIFERENTES NA MESMA TABELA, por decisão
 * funcional aprovada em 23/09/2026 (planejamento do Bloco 9, seção 9.4):
 *   - consultar (GET)   -> permissão de RECURSO `'materials'`, visualizar
 *     — a mesma que protege o cadastro; ver o saldo é parte de ver o
 *     material.
 *   - movimentar (POST) -> permissão de AÇÃO `MOVIMENTAR_ESTOQUE` — já
 *     cadastrada no catálogo `acoes` desde a migration 003, já configurada
 *     pela migration 017 com `exige_sst = false` e
 *     `modo_autorizacao_individual = 'ALTERNATIVA'`. Um usuário pode ter
 *     autoridade para movimentar estoque sem ter permissão de EDITAR o
 *     cadastro do material (e vice-versa) — as duas concessões são
 *     independentes, de propósito.
 *
 * Nenhum identificador foi inventado nesta rota: `'materials'` e
 * `MOVIMENTAR_ESTOQUE` já existiam no catálogo real antes desta etapa.
 *
 * Caminhos finais, quando montado por app.js sob /api:
 *   GET  /api/materiais/:id/estoque
 *   POST /api/materiais/:id/estoque/movimentar
 */

const RECURSO = 'materials';
const ACAO_MOVIMENTAR_ESTOQUE = 'MOVIMENTAR_ESTOQUE';

function criarEstoqueRoutes({ controller, exigirSessao: exigirSessaoInjetado, pool: poolInjetado }) {
  const router = Router();

  const exigirVisualizarMaterial = criarExigirPermissaoRecurso({ pool: poolInjetado }, RECURSO, 'visualizar');
  const exigirMovimentarEstoque = criarExigirPermissaoAcao({ pool: poolInjetado }, ACAO_MOVIMENTAR_ESTOQUE);

  router.get(
    '/materiais/:id/estoque',
    exigirSessaoInjetado, exigirVisualizarMaterial,
    validar({ params: estoqueSchemas.consultar.params }),
    controller.consultar,
  );
  router.post(
    '/materiais/:id/estoque/movimentar',
    exigirSessaoInjetado, exigirMovimentarEstoque,
    validar({ params: estoqueSchemas.movimentar.params, body: estoqueSchemas.movimentar.body }),
    controller.movimentar,
  );

  return router;
}

const estoqueRoutes = criarEstoqueRoutes({ controller: estoqueController, exigirSessao, pool });

module.exports = { criarEstoqueRoutes, estoqueRoutes, RECURSO, ACAO_MOVIMENTAR_ESTOQUE };
