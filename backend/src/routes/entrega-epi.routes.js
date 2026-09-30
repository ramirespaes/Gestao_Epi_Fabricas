'use strict';

const { Router } = require('express');
const { validar } = require('../middleware/validar');
const schemas = require('../schemas/entrega-epi.schema');
const { entregaEpiController } = require('../controllers/entrega-epi.controller');
const { exigirSessao } = require('../middleware/autenticacao');
const { criarExigirPermissaoRecurso, criarExigirPermissaoAcao } = require('../middleware/autorizacao');
const { pool } = require('../config/database');

/**
 * Rotas da entrega de EPI (10E) e da ficha (10F). Duas autoridades
 * distintas, nunca uma pela outra:
 *   - realizar a entrega e o contexto para ela -> AÇÃO `REALIZAR_ENTREGA`
 *     (catálogo 003/017, modo ALTERNATIVA), independente de `materials`;
 *   - consultar a ficha e o histórico -> RECURSO `epiFicha`, visualizar.
 *
 * Caminhos, quando montado por app.js sob /api:
 *   POST /api/entregas-epi
 *   GET  /api/entregas-epi/contexto/funcionarios          (localizar trabalhador por nome/matrícula)
 *   POST /api/entregas-epi/contexto/consulta-cpf          (CPF no corpo, nunca na URL)
 *   GET  /api/entregas-epi/contexto/:funcionarioId
 *   GET  /api/entregas-epi/contexto/:funcionarioId/materiais
 *   GET  /api/entregas-epi/contexto/:funcionarioId/materiais/:materialId/lotes
 *   GET  /api/entregas-epi/:id
 *   GET  /api/fichas-epi
 *   POST /api/fichas-epi/consulta-cpf   (CPF no corpo, nunca na URL)
 *   GET  /api/fichas-epi/:id
 *   GET  /api/fichas-epi/:id/entregas
 */

const ACAO_REALIZAR_ENTREGA = 'REALIZAR_ENTREGA';
const RECURSO_FICHA = 'epiFicha';

function criarEntregaEpiRoutes({ controller, exigirSessao: exigirSessaoInjetado, pool: poolInjetado }) {
  const router = Router();

  const exigirRealizarEntrega = criarExigirPermissaoAcao({ pool: poolInjetado }, ACAO_REALIZAR_ENTREGA);
  const exigirVisualizarFicha = criarExigirPermissaoRecurso({ pool: poolInjetado }, RECURSO_FICHA, 'visualizar');

  router.post(
    '/entregas-epi',
    exigirSessaoInjetado, exigirRealizarEntrega,
    validar({ body: schemas.registrar.body }),
    controller.registrar,
  );
  // As rotas de contexto ficam antes de /entregas-epi/:id, e as estáticas
  // (funcionarios, consulta-cpf) antes de /contexto/:funcionarioId.
  router.get(
    '/entregas-epi/contexto/funcionarios',
    exigirSessaoInjetado, exigirRealizarEntrega,
    validar({ query: schemas.contextoFuncionarios.query }),
    controller.contextoFuncionarios,
  );
  router.post(
    '/entregas-epi/contexto/consulta-cpf',
    exigirSessaoInjetado, exigirRealizarEntrega,
    validar({ body: schemas.contextoConsultaCpf.body }),
    controller.contextoConsultaCpf,
  );
  router.get(
    '/entregas-epi/contexto/:funcionarioId',
    exigirSessaoInjetado, exigirRealizarEntrega,
    validar({ params: schemas.contexto.params }),
    controller.contexto,
  );
  router.get(
    '/entregas-epi/contexto/:funcionarioId/materiais',
    exigirSessaoInjetado, exigirRealizarEntrega,
    validar({ params: schemas.contextoMateriais.params, query: schemas.contextoMateriais.query }),
    controller.contextoMateriais,
  );
  router.get(
    '/entregas-epi/contexto/:funcionarioId/materiais/:materialId/lotes',
    exigirSessaoInjetado, exigirRealizarEntrega,
    validar({ params: schemas.contextoLotes.params }),
    controller.contextoLotes,
  );
  router.get(
    '/entregas-epi/:id',
    exigirSessaoInjetado, exigirVisualizarFicha,
    validar({ params: schemas.porId.params }),
    controller.buscarEntrega,
  );

  router.get(
    '/fichas-epi',
    exigirSessaoInjetado, exigirVisualizarFicha,
    validar({ query: schemas.fichas.query }),
    controller.listarFichas,
  );
  router.post(
    '/fichas-epi/consulta-cpf',
    exigirSessaoInjetado, exigirVisualizarFicha,
    validar({ body: schemas.consultaCpf.body }),
    controller.consultarCpf,
  );
  router.get(
    '/fichas-epi/:id',
    exigirSessaoInjetado, exigirVisualizarFicha,
    validar({ params: schemas.porId.params }),
    controller.detalharFicha,
  );
  router.get(
    '/fichas-epi/:id/entregas',
    exigirSessaoInjetado, exigirVisualizarFicha,
    validar({ params: schemas.fichaEntregas.params, query: schemas.fichaEntregas.query }),
    controller.entregasDaFicha,
  );

  return router;
}

const entregaEpiRoutes = criarEntregaEpiRoutes({ controller: entregaEpiController, exigirSessao, pool });

module.exports = { criarEntregaEpiRoutes, entregaEpiRoutes, ACAO_REALIZAR_ENTREGA, RECURSO_FICHA };
