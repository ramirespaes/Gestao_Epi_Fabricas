'use strict';

const { Router } = require('express');
const { validar } = require('../middleware/validar');
const estoqueSchemas = require('../schemas/estoque.schema');
const { estoqueController } = require('../controllers/estoque.controller');
const { exigirSessao } = require('../middleware/autenticacao');
const { criarExigirPermissaoRecurso, criarExigirPermissaoAcao } = require('../middleware/autorizacao');
const { pool } = require('../config/database');

/**
 * Rotas de estoque por lote (Bloco 9).
 *
 * DUAS DIMENSÕES DE AUTORIZAÇÃO, por decisão funcional aprovada em
 * 23/09/2026 (planejamento do Bloco 9, seção 9.4):
 *   - leitura (GET)          -> permissão de RECURSO: `'materials'`,
 *     visualizar, para os lotes de um material — ver o saldo é parte de
 *     ver o material;
 *   - entrada (POST) -> AÇÃO `ENTRADA_ESTOQUE` e baixa (POST) -> AÇÃO
 *     `BAIXA_ESTOQUE`, independentes (migration 078, ambas `exige_sst = false`
 *     e `modo_autorizacao_individual = 'ALTERNATIVA'`). Um usuário pode ter
 *     autoridade para movimentar estoque sem ter permissão de EDITAR o
 *     cadastro do material (e vice-versa) — as duas concessões são
 *     independentes, de propósito.
 *
 * E10: o caminho antigo por tamanho (GET /materiais/:id/estoque e POST
 * /materiais/:id/estoque/movimentar, sobre estoque_tamanhos) saiu. Nenhuma
 * tela o usava, e ele alterava saldo fora dos lotes e do histórico.
 *
 * Caminhos finais, quando montado por app.js sob /api:
 *   GET  /api/materiais/:id/estoque/lotes
 *   POST /api/materiais/:id/estoque/entradas
 *   POST /api/estoque/lotes/:loteId/baixas
 *   GET  /api/estoque/validade          (E7: lotes com saldo e situação do CA)
 *   GET  /api/estoque/operacoes         (E8: histórico só de leitura de
 *                                        estoque_operacoes)
 *
 * E9: Validade e Operações de estoque têm permissão de RECURSO própria,
 * `stockValidity` e `operations` (visualizar), e não dependem de
 * `materials`. Ver a validade não autoriza baixa: a baixa continua exigindo
 * BAIXA_ESTOQUE.
 */

const RECURSO = 'materials';
const RECURSO_VALIDADE = 'stockValidity';
const RECURSO_OPERACOES = 'operations';
// A entrada e a baixa têm ações independentes (migration 078).
const ACAO_ENTRADA_ESTOQUE = 'ENTRADA_ESTOQUE';
const ACAO_BAIXA_ESTOQUE = 'BAIXA_ESTOQUE';

function criarEstoqueRoutes({ controller, exigirSessao: exigirSessaoInjetado, pool: poolInjetado }) {
  const router = Router();

  const exigirVisualizarMaterial = criarExigirPermissaoRecurso({ pool: poolInjetado }, RECURSO, 'visualizar');
  const exigirVisualizarValidade = criarExigirPermissaoRecurso({ pool: poolInjetado }, RECURSO_VALIDADE, 'visualizar');
  const exigirVisualizarOperacoes = criarExigirPermissaoRecurso({ pool: poolInjetado }, RECURSO_OPERACOES, 'visualizar');
  const exigirEntradaEstoque = criarExigirPermissaoAcao({ pool: poolInjetado }, ACAO_ENTRADA_ESTOQUE);
  const exigirBaixaEstoque = criarExigirPermissaoAcao({ pool: poolInjetado }, ACAO_BAIXA_ESTOQUE);

  router.get(
    '/estoque/validade',
    exigirSessaoInjetado, exigirVisualizarValidade,
    validar({ query: estoqueSchemas.validade.query }),
    controller.validade,
  );
  router.get(
    '/estoque/operacoes',
    exigirSessaoInjetado, exigirVisualizarOperacoes,
    validar({ query: estoqueSchemas.operacoes.query }),
    controller.operacoes,
  );
  router.get(
    '/materiais/:id/estoque/lotes',
    exigirSessaoInjetado, exigirVisualizarMaterial,
    validar({ params: estoqueSchemas.lotes.params }),
    controller.lotes,
  );
  router.post(
    '/materiais/:id/estoque/entradas',
    exigirSessaoInjetado, exigirEntradaEstoque,
    validar({ params: estoqueSchemas.entrada.params, body: estoqueSchemas.entrada.body }),
    controller.entrada,
  );
  router.post(
    '/estoque/lotes/:loteId/baixas',
    exigirSessaoInjetado, exigirBaixaEstoque,
    validar({ params: estoqueSchemas.baixa.params, body: estoqueSchemas.baixa.body }),
    controller.baixa,
  );

  return router;
}

const estoqueRoutes = criarEstoqueRoutes({ controller: estoqueController, exigirSessao, pool });

module.exports = {
  criarEstoqueRoutes, estoqueRoutes, RECURSO, RECURSO_VALIDADE, RECURSO_OPERACOES, ACAO_ENTRADA_ESTOQUE, ACAO_BAIXA_ESTOQUE,
};
