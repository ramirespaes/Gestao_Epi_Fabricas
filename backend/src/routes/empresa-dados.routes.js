'use strict';

const { Router } = require('express');
const { validar } = require('../middleware/validar');
const { criarLimitador } = require('../middleware/rate-limit');
const schemas = require('../schemas/empresa-dados.schema');
const { empresaDadosController } = require('../controllers/empresa-dados.controller');
const { exigirSessao } = require('../middleware/autenticacao');
const { criarExigirPermissaoRecurso } = require('../middleware/autorizacao');
const { pool } = require('../config/database');

/**
 * Dados da Empresa (Portal). Recurso RBAC `companyData`:
 *
 *   GET   /api/empresa/dados   (companyData.visualizar)
 *   PATCH /api/empresa/dados   (companyData.visualizar E companyData.editar)
 *
 * Editar sozinho NÃO basta: o PATCH passa pelas DUAS verificações, nesta ordem (sessão -> visualizar -> editar -> limites ->
 * validação -> controller), então "Visualizar desligado + Editar ligado" é 403 também na API, não só na tela. Razão social e CNPJ
 * não são editáveis por aqui, mesmo com todas as permissões (ver empresa-dados.service). Sem rota de criação, de exclusão ou de
 * troca de `ativo`: o ciclo de vida da empresa é do Painel Privado.
 *
 * Os limites do PATCH (por usuário e por empresa, por minuto) ficam na memória do processo e só contam quem já foi autorizado.
 */

const RECURSO = 'companyData';

const chaveDoUsuario = (req) => `${req.empresa?.id}:${req.usuario?.id}`;
const chaveDaEmpresa = (req) => `${req.empresa?.id}`;

const LIMITES_PADRAO = Object.freeze({ porUsuario: 20, porEmpresa: 60 });

function criarEmpresaDadosRoutes({
  controller, exigirSessao: exigirSessaoInjetado, pool: poolInjetado, limites = LIMITES_PADRAO,
}) {
  const router = Router();
  const exigirVisualizar = criarExigirPermissaoRecurso({ pool: poolInjetado }, RECURSO, 'visualizar');
  const exigirEditar = criarExigirPermissaoRecurso({ pool: poolInjetado }, RECURSO, 'editar');
  const limitePorUsuario = criarLimitador({ limite: limites.porUsuario, janelaSegundos: 60, chave: chaveDoUsuario });
  const limitePorEmpresa = criarLimitador({ limite: limites.porEmpresa, janelaSegundos: 60, chave: chaveDaEmpresa });

  router.get('/empresa/dados', exigirSessaoInjetado, exigirVisualizar, controller.consultar);
  router.patch(
    '/empresa/dados',
    exigirSessaoInjetado,
    exigirVisualizar,
    exigirEditar,
    limitePorUsuario,
    limitePorEmpresa,
    validar({ body: schemas.alterar.body }),
    controller.alterar,
  );
  return router;
}

const empresaDadosRoutes = criarEmpresaDadosRoutes({ controller: empresaDadosController, exigirSessao, pool });

module.exports = { criarEmpresaDadosRoutes, empresaDadosRoutes, RECURSO, LIMITES_PADRAO };
