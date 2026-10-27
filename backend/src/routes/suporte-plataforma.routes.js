'use strict';

const { Router } = require('express');
const { validar } = require('../middleware/validar');
const { criarLimitador } = require('../middleware/rate-limit');
const schemas = require('../schemas/suporte.schema');
const { suportePlataformaController } = require('../controllers/suporte-plataforma.controller');
const { exigirSessaoPlataforma } = require('../middleware/autenticacao-plataforma');

/**
 * Atendimento dos chamados de suporte no Painel Privado. TODAS atrás de exigirSessaoPlataforma (cookie administrativo próprio): a
 * sessão empresarial nunca as alcança. Montadas na cadeia /api/plataforma (CORS, Origin, Host e limite exclusivos). Só GET, POST e
 * PATCH (os métodos do namespace da plataforma); sem exclusão: a trilha do atendimento é imutável.
 *
 *   GET   /suporte/chamados                 (fila; filtros situacao, empresaId, busca; paginada)
 *   GET   /suporte/chamados/:id             (detalhe, mensagens da conversa e histórico; marca como lido pelo suporte)
 *   GET   /suporte/chamados/:id/mensagens   (?aposId=N: só as mais novas; polling com a conversa aberta)
 *   POST  /suporte/chamados/:id/respostas   (mensagem do suporte; leva a RESPONDIDO; chave de idempotência opcional)
 *   PATCH /suporte/chamados/:id/situacao    (ABERTO | EM_ATENDIMENTO | RESPONDIDO | ENCERRADO; de ENCERRADO só para ABERTO = reabertura)
 */
const chaveDoAdministrador = (req) => `${req.administradorPlataforma?.id}`;

function criarSuportePlataformaRoutes({ controller, exigirSessaoPlataforma: exigir, limiteEscritaPorMinuto = 60 }) {
  const router = Router();
  const limiteEscrita = criarLimitador({ limite: limiteEscritaPorMinuto, janelaSegundos: 60, chave: chaveDoAdministrador });

  router.get('/suporte/chamados', exigir, validar({ query: schemas.listarChamadosPlataforma.query }), controller.listar);
  router.get('/suporte/chamados/:id', exigir, validar({ params: schemas.buscarChamadoPlataforma.params }), controller.detalhar);
  router.get('/suporte/chamados/:id/mensagens', exigir, validar({ params: schemas.novasMensagens.params, query: schemas.novasMensagens.query }), controller.novasMensagens);
  router.post(
    '/suporte/chamados/:id/respostas',
    exigir,
    limiteEscrita,
    validar({ params: schemas.responderChamado.params, body: schemas.responderChamado.body }),
    controller.responder,
  );
  router.patch(
    '/suporte/chamados/:id/situacao',
    exigir,
    limiteEscrita,
    validar({ params: schemas.alterarSituacao.params, body: schemas.alterarSituacao.body }),
    controller.alterarSituacao,
  );
  return router;
}

const suportePlataformaRoutes = criarSuportePlataformaRoutes({ controller: suportePlataformaController, exigirSessaoPlataforma });

module.exports = { criarSuportePlataformaRoutes, suportePlataformaRoutes };
