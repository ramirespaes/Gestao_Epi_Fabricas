'use strict';

const { Router } = require('express');
const { validar } = require('../middleware/validar');
const { parserJsonImportacaoGhe } = require('../middleware/conteudo');
const schemas = require('../schemas/ghe-importacao.schema');
const { gheImportacaoController } = require('../controllers/ghe-importacao.controller');
const { exigirSessao } = require('../middleware/autenticacao');
const { criarExigirPermissaoRecurso } = require('../middleware/autorizacao');
const { pool } = require('../config/database');

/**
 * Rotas da importação GHE/EPI (evolução GHE / importação GHE-EPI, Incremento 5B).
 *
 * ORDEM (crítica): exigirSessao -> permissão de criar -> permissão de editar -> parser JSON de 512 KiB -> validação
 * Zod -> controller. O parser global (32 KiB) isenta exatamente esta rota (middleware/conteudo.js), então o corpo só é
 * lido depois de autenticar e autorizar; sem sessão ou sem permissão a resposta sai antes de qualquer leitura do corpo.
 *
 * RBAC: reutiliza `employeeGroups` (nenhum recurso novo). Importar exige criar E editar (ler a matriz não basta).
 *
 * Caminhos, sob /api:
 *   POST /api/grupos-homogeneos/importacao/preview     (read-only)
 *   POST /api/grupos-homogeneos/importacao/confirmar   (Incremento 5C: revalida no servidor e grava numa transação)
 * As duas são as únicas rotas com corpo de até 512 KiB (isentas, por igualdade exata, no parser global).
 */

const RECURSO = 'employeeGroups';

function criarGheImportacaoRoutes({ controller, exigirSessao: exigirSessaoInjetado, pool: poolInjetado }) {
  const router = Router();

  const exigirCriar = criarExigirPermissaoRecurso({ pool: poolInjetado }, RECURSO, 'criar');
  const exigirEditar = criarExigirPermissaoRecurso({ pool: poolInjetado }, RECURSO, 'editar');

  router.post(
    '/grupos-homogeneos/importacao/preview',
    exigirSessaoInjetado,
    exigirCriar,
    exigirEditar,
    parserJsonImportacaoGhe,
    validar({ body: schemas.previa.body }),
    controller.previa,
  );

  router.post(
    '/grupos-homogeneos/importacao/confirmar',
    exigirSessaoInjetado,
    exigirCriar,
    exigirEditar,
    parserJsonImportacaoGhe,
    validar({ body: schemas.confirmar.body }),
    controller.confirmar,
  );

  return router;
}

const gheImportacaoRoutes = criarGheImportacaoRoutes({ controller: gheImportacaoController, exigirSessao, pool });

module.exports = { criarGheImportacaoRoutes, gheImportacaoRoutes, RECURSO };
