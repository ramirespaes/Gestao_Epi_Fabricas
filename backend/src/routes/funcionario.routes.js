'use strict';

const { Router } = require('express');
const { validar } = require('../middleware/validar');
const funcionarioSchemas = require('../schemas/funcionario.schema');
const { funcionarioController } = require('../controllers/funcionario.controller');
const { exigirSessao } = require('../middleware/autenticacao');
const { criarExigirPermissaoRecurso, criarExigirPermissaoAcao } = require('../middleware/autorizacao');
const { pool } = require('../config/database');
const { limitadorRevelacaoCpf } = require('../middleware/rate-limit');

/**
 * Rotas de funcionários (Bloco 9, Etapa B). Mesmo desenho de
 * material.routes.js: exigirSessao -> criarExigirPermissaoRecurso ->
 * validar -> controller.
 *
 * Recurso `'employeeHistory'` — o identificador que a página legada de
 * funcionários já usa (js/main.js, convenção da migration 009). Nenhuma
 * destas rotas alcança `usuarios`: funcionário (quem recebe EPI) e usuário
 * (conta de acesso) são cadastros separados, cada um com seu recurso RBAC.
 *
 * Sem rota de exclusão: funcionário é inativado; matrícula e CPF
 * continuam reservados (migration 006).
 *
 * Caminhos, sob /api:
 *   POST  /api/funcionarios
 *   GET   /api/funcionarios
 *   GET   /api/funcionarios/importacao/ghes  (IMPORTAR_FUNCIONARIOS; GHEs ativos, só id e nome)
 *   GET   /api/funcionarios/ghes   (S3: seletor do formulário; employeeHistory.visualizar; id, código e descrição)
 *   POST  /api/funcionarios/consulta-cpf   (SEC-008: CPF no corpo, nunca na URL)
 *   GET   /api/funcionarios/:id
 *   PATCH /api/funcionarios/:id
 *   POST  /api/funcionarios/:id/inativar
 *   POST  /api/funcionarios/:id/reativar
 *   POST  /api/funcionarios/:id/situacao   (S2: ATIVO | AFASTADO | INATIVO; employeeHistory.editar)
 *   POST  /api/funcionarios/:id/cpf/revelar   (CPF completo só aqui; employeeHistory.editar; 10/min por usuário + empresa; auditado)
 */

const RECURSO = 'employeeHistory';

function criarFuncionarioRoutes({
  controller, exigirSessao: exigirSessaoInjetado, pool: poolInjetado, limitadorRevelacaoCpf: limitadorRevelacaoInjetado = limitadorRevelacaoCpf,
}) {
  const router = Router();

  const exigirVisualizar = criarExigirPermissaoRecurso({ pool: poolInjetado }, RECURSO, 'visualizar');
  const exigirCriar = criarExigirPermissaoRecurso({ pool: poolInjetado }, RECURSO, 'criar');
  const exigirEditar = criarExigirPermissaoRecurso({ pool: poolInjetado }, RECURSO, 'editar');

  const exigirImportar = criarExigirPermissaoAcao({ pool: poolInjetado }, 'IMPORTAR_FUNCIONARIOS');

  router.post('/funcionarios', exigirSessaoInjetado, exigirCriar, validar({ body: funcionarioSchemas.criar.body }), controller.criar);
  // Importação em lote: permissão PRÓPRIA (ação IMPORTAR_FUNCIONARIOS), independente de employeeHistory.criar.
  router.post('/funcionarios/importacao', exigirSessaoInjetado, exigirImportar, validar({ body: funcionarioSchemas.importacao.body }), controller.importar);
  // Opções do seletor de GHE da prévia: mesma autoridade da importação (nada de employeeGroups.visualizar); só leitura.
  router.get('/funcionarios/importacao/ghes', exigirSessaoInjetado, exigirImportar, validar({ query: funcionarioSchemas.importacaoGhes.query }), controller.listarGhesImportacao);
  router.get('/funcionarios', exigirSessaoInjetado, exigirVisualizar, validar({ query: funcionarioSchemas.listar.query }), controller.listar);
  // Estática ANTES de /funcionarios/:id, que a capturaria como id inválido. Sem Gestão de GHE nem importação: quem trabalha com funcionários carrega os GHEs.
  router.get('/funcionarios/ghes', exigirSessaoInjetado, exigirVisualizar, validar({ query: funcionarioSchemas.ghesFormulario.query }), controller.listarGhes);
  // SEC-008: consulta por CPF completo, só leitura, com o CPF no corpo.
  router.post('/funcionarios/consulta-cpf', exigirSessaoInjetado, exigirVisualizar, validar({ body: funcionarioSchemas.consultaCpf.body }), controller.consultarCpf);
  router.get('/funcionarios/:id', exigirSessaoInjetado, exigirVisualizar, validar({ params: funcionarioSchemas.buscar.params }), controller.buscar);
  router.patch('/funcionarios/:id', exigirSessaoInjetado, exigirEditar, validar({ params: funcionarioSchemas.alterar.params, body: funcionarioSchemas.alterar.body }), controller.alterar);
  router.post('/funcionarios/:id/inativar', exigirSessaoInjetado, exigirEditar, validar({ params: funcionarioSchemas.inativar.params, body: funcionarioSchemas.inativar.body }), controller.inativar);
  router.post('/funcionarios/:id/reativar', exigirSessaoInjetado, exigirEditar, validar({ params: funcionarioSchemas.reativar.params, body: funcionarioSchemas.reativar.body }), controller.reativar);
  router.post('/funcionarios/:id/situacao', exigirSessaoInjetado, exigirEditar, validar({ params: funcionarioSchemas.situacao.params, body: funcionarioSchemas.situacao.body }), controller.alterarSituacao);
  // O limite vem DEPOIS da autorização (só conta quem pode revelar) e ANTES da validação (corpo inválido também gasta o orçamento).
  router.post('/funcionarios/:id/cpf/revelar', exigirSessaoInjetado, exigirEditar, limitadorRevelacaoInjetado,
    validar({ params: funcionarioSchemas.revelarCpf.params, query: funcionarioSchemas.revelarCpf.query, body: funcionarioSchemas.revelarCpf.body }), controller.revelarCpf);

  return router;
}

const funcionarioRoutes = criarFuncionarioRoutes({ controller: funcionarioController, exigirSessao, pool });

module.exports = { criarFuncionarioRoutes, funcionarioRoutes, RECURSO };
