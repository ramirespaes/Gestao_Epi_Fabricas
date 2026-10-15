'use strict';

const { Router } = require('express');
const { validar } = require('../middleware/validar');
const schemas = require('../schemas/token-ativacao.schema');
const { tokenAtivacaoController } = require('../controllers/token-ativacao.controller');
const { exigirSessao } = require('../middleware/autenticacao');
const { criarExigirPermissaoAcao } = require('../middleware/autorizacao');
const { pool } = require('../config/database');

/**
 * Atendimento Token — geração administrativa do código de ativação (Etapa C). Sessão administrativa + ação
 * TOKEN_GERAR_ATIVACAO (sem recurso próprio, sem SST). Rota separada das cinco rotas da Etapa B, que ficam como estão.
 *
 *   POST /api/atendimento-token/dispositivos/:id/ativacao   corpo {} estrito
 */

const ACAO_GERAR_ATIVACAO = 'TOKEN_GERAR_ATIVACAO';
const RAIZ = '/atendimento-token/dispositivos';

function criarTokenAtivacaoRoutes({ controller, exigirSessao: exigirSessaoInjetado, pool: poolInjetado }) {
  const router = Router();
  const exigirGerar = criarExigirPermissaoAcao({ pool: poolInjetado }, ACAO_GERAR_ATIVACAO);
  router.post(`${RAIZ}/:id/ativacao`, exigirSessaoInjetado, exigirGerar, validar({ params: schemas.gerar.params, body: schemas.gerar.body }), controller.gerar);
  return router;
}

const tokenAtivacaoRoutes = criarTokenAtivacaoRoutes({ controller: tokenAtivacaoController, exigirSessao, pool });

module.exports = { ACAO_GERAR_ATIVACAO, criarTokenAtivacaoRoutes, tokenAtivacaoRoutes };
