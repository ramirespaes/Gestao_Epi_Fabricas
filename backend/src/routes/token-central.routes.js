'use strict';

const { Router } = require('express');
const { validar } = require('../middleware/validar');
const schemas = require('../schemas/token-central.schema');
const { tokenCentralController } = require('../controllers/token-central.controller');
const { exigirSessao } = require('../middleware/autenticacao');
const { criarExigirPermissaoRecurso, criarExigirPermissaoAcao } = require('../middleware/autorizacao');
const { pool } = require('../config/database');

/**
 * Atendimento Token — Central Administrativa (Etapa H). Sessão ADMINISTRATIVA (nunca a credencial do tablet nem o atendimento do
 * funcionário). Três leituras e o gerenciamento mínimo de redes, todos sob o prefixo /api/atendimento-token:
 *
 *   GET  /visao-geral                       recurso atendimentoToken.visualizar
 *   GET  /dispositivos/:id/ativacao         recurso atendimentoToken.visualizar   (estado derivado da ativação mais recente)
 *   GET  /previa/catalogo?funcionarioId=    ação TOKEN_PREVIA_CATALOGO_REAL        (catálogo real; somente leitura + auditoria)
 *   GET  /redes                             ação TOKEN_GERENCIAR_REDES (OBRIGATORIA)
 *   POST /redes                             ação TOKEN_GERENCIAR_REDES             { rede: IP exato, descricao? }
 *   POST /redes/:id/desativar               ação TOKEN_GERENCIAR_REDES             {}
 *
 * Ordem: sessão → permissão → validação (a negação vem antes de qualquer detalhe do pedido). Sem DELETE/PUT/PATCH; sem monitoramento nem
 * histórico (Etapa J). A rota de ativação (POST) e as cinco da Etapa B continuam nos seus arquivos.
 */

const RECURSO = 'atendimentoToken';
const ACAO_PREVIA = 'TOKEN_PREVIA_CATALOGO_REAL';
const ACAO_REDES = 'TOKEN_GERENCIAR_REDES';
const RAIZ = '/atendimento-token';

function criarTokenCentralRoutes({ controller, exigirSessao: exigirSessaoInjetado, pool: poolInjetado }) {
  const router = Router();
  const exigirVisualizar = criarExigirPermissaoRecurso({ pool: poolInjetado }, RECURSO, 'visualizar');
  const exigirPrevia = criarExigirPermissaoAcao({ pool: poolInjetado }, ACAO_PREVIA);
  const exigirRedes = criarExigirPermissaoAcao({ pool: poolInjetado }, ACAO_REDES);

  router.get(`${RAIZ}/visao-geral`, exigirSessaoInjetado, exigirVisualizar, validar({ query: schemas.visaoGeral.query }), controller.visaoGeral);
  router.get(`${RAIZ}/dispositivos/:id/ativacao`, exigirSessaoInjetado, exigirVisualizar, validar({ params: schemas.estadoAtivacao.params, query: schemas.estadoAtivacao.query }), controller.estadoAtivacao);
  router.get(`${RAIZ}/previa/catalogo`, exigirSessaoInjetado, exigirPrevia, validar({ query: schemas.previa.query }), controller.previaCatalogo);
  router.get(`${RAIZ}/redes`, exigirSessaoInjetado, exigirRedes, validar({ query: schemas.listarRedes.query }), controller.listarRedes);
  router.post(`${RAIZ}/redes`, exigirSessaoInjetado, exigirRedes, validar({ query: schemas.cadastrarRede.query, body: schemas.cadastrarRede.body }), controller.cadastrarRede);
  router.post(`${RAIZ}/redes/:id/desativar`, exigirSessaoInjetado, exigirRedes, validar({ params: schemas.desativarRede.params, query: schemas.desativarRede.query, body: schemas.desativarRede.body }), controller.desativarRede);
  return router;
}

const tokenCentralRoutes = criarTokenCentralRoutes({ controller: tokenCentralController, exigirSessao, pool });

module.exports = {
  criarTokenCentralRoutes, tokenCentralRoutes, RECURSO, ACAO_PREVIA, ACAO_REDES,
};
