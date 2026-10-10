'use strict';

const { Router } = require('express');
const { validar } = require('../middleware/validar');
const schemas = require('../schemas/relatorio.schema');
const schemasAuditoria = require('../schemas/relatorio-auditoria.schema');
const schemasFiscal = require('../schemas/fiscalizacao.schema');
const { relatorioController } = require('../controllers/relatorio.controller');
const { exigirSessao } = require('../middleware/autenticacao');
const { criarExigirPermissaoRecurso } = require('../middleware/autorizacao');
const { pool } = require('../config/database');

/**
 * Relatórios (12K-D, etapa 1), só leitura. Autoridade por fonte, sem permissão nova:
 *   estoque            -> `materials`.visualizar (ver saldo é parte de ver o material)
 *   entregas (3 abas)  -> `epiFicha`.visualizar (a mesma do histórico da 12K-C)
 *   GET /api/relatorios/estoque
 *   GET /api/relatorios/proximo-vencimento
 *   GET /api/relatorios/vencidos
 *   GET /api/relatorios/epis-entregues
 *   GET /api/relatorios/auditoria/{indicadores,solicitacoes-nao-atendidas,solicitacoes-reprovadas,ca-vencidos,log}   (reportsAudit.visualizar)
 *   POST /api/relatorios/fiscalizacao/{previa,pacotes}, GET /api/relatorios/fiscalizacao/pacotes[/:id[/download]]   (reportsFiscal.visualizar)
 */
function criarRelatorioRoutes({ controller, exigirSessao: sessao, pool: poolInjetado }) {
  const router = Router();
  const exigirVisualizarMaterial = criarExigirPermissaoRecurso({ pool: poolInjetado }, 'materials', 'visualizar');
  const exigirVisualizarFicha = criarExigirPermissaoRecurso({ pool: poolInjetado }, 'epiFicha', 'visualizar');

  router.get('/relatorios/estoque', sessao, exigirVisualizarMaterial, validar({ query: schemas.estoque.query }), controller.estoque);
  router.get('/relatorios/proximo-vencimento', sessao, exigirVisualizarFicha, validar({ query: schemas.proximoVencimento.query }), controller.proximoVencimento);
  router.get('/relatorios/vencidos', sessao, exigirVisualizarFicha, validar({ query: schemas.vencidos.query }), controller.vencidos);
  router.get('/relatorios/epis-entregues', sessao, exigirVisualizarFicha, validar({ query: schemas.entregues.query }), controller.entregues);

  // 12K-D5: Relatório — Auditoria, permissão própria (reportsAudit.visualizar), independente de materials e epiFicha.
  const exigirAuditoria = criarExigirPermissaoRecurso({ pool: poolInjetado }, 'reportsAudit', 'visualizar');
  router.get('/relatorios/auditoria/indicadores', sessao, exigirAuditoria, validar({ query: schemasAuditoria.indicadores.query }), controller.auditoriaIndicadores);
  router.get('/relatorios/auditoria/solicitacoes-nao-atendidas', sessao, exigirAuditoria, validar({ query: schemasAuditoria.solicitacoesNaoAtendidas.query }), controller.auditoriaSolicitacoes);
  router.get('/relatorios/auditoria/solicitacoes-reprovadas', sessao, exigirAuditoria, validar({ query: schemasAuditoria.solicitacoesReprovadas.query }), controller.auditoriaReprovadas);
  router.get('/relatorios/auditoria/ca-vencidos', sessao, exigirAuditoria, validar({ query: schemasAuditoria.caVencidos.query }), controller.auditoriaCaVencidos);
  router.get('/relatorios/auditoria/log', sessao, exigirAuditoria, validar({ query: schemasAuditoria.log.query }), controller.auditoriaLog);

  // 12K-D6: Relatório — Fiscalização. Uma permissão própria cobre ver, pré-visualizar, gerar, listar e baixar; o pacote é da empresa da sessão.
  const exigirFiscal = criarExigirPermissaoRecurso({ pool: poolInjetado }, 'reportsFiscal', 'visualizar');
  router.post('/relatorios/fiscalizacao/previa', sessao, exigirFiscal, validar({ body: schemasFiscal.previa.body }), controller.fiscalPrevia);
  router.post('/relatorios/fiscalizacao/pacotes', sessao, exigirFiscal, validar({ body: schemasFiscal.gerar.body }), controller.fiscalGerar);
  router.get('/relatorios/fiscalizacao/pacotes', sessao, exigirFiscal, validar({ query: schemasFiscal.listar.query }), controller.fiscalListar);
  router.get('/relatorios/fiscalizacao/pacotes/:id', sessao, exigirFiscal, validar({ params: schemasFiscal.porId.params }), controller.fiscalObter);
  router.get('/relatorios/fiscalizacao/pacotes/:id/download', sessao, exigirFiscal, validar({ params: schemasFiscal.porId.params }), controller.fiscalDownload);
  return router;
}

const relatorioRoutes = criarRelatorioRoutes({ controller: relatorioController, exigirSessao, pool });

module.exports = { criarRelatorioRoutes, relatorioRoutes };
