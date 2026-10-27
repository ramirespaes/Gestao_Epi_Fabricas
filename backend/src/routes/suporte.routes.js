'use strict';

const { Router } = require('express');
const { validar } = require('../middleware/validar');
const { criarLimitador } = require('../middleware/rate-limit');
const schemas = require('../schemas/suporte.schema');
const { suporteController } = require('../controllers/suporte.controller');
const { exigirSessao } = require('../middleware/autenticacao');

/**
 * Suporte (Portal Empresarial). Qualquer usuário com sessão empresarial válida pode abrir chamado, consultar os próprios e
 * contatar o Almoxarifado ou a SST da própria empresa: não há permissão RBAC nova (é ajuda ao usuário, não dado da empresa).
 * O isolamento é por empresa E usuário, decidido no serviço.
 *
 *   GET  /api/suporte/canais              (se o e-mail do Almoxarifado/SST está cadastrado; nunca o endereço)
 *   POST /api/suporte/chamados            (abrir chamado; idempotente pela chave)
 *   GET  /api/suporte/chamados            (meus chamados)
 *   GET  /api/suporte/chamados/:id        (meu chamado, mensagens da conversa e histórico; marca como lido)
 *   GET  /api/suporte/chamados/:id/mensagens?aposId=N  (só as mensagens mais novas; polling com a conversa aberta)
 *   POST /api/suporte/chamados/:id/mensagens           (mensagem do solicitante; idempotente pela chave; ENCERRADO = 409)
 *   POST /api/suporte/contatos/:canal     (almoxarifado | sst; idempotente pela chave)
 *
 * Limites por usuário e por empresa, por minuto, só depois da sessão, em memória do processo.
 */

const chaveDoUsuario = (req) => `${req.empresa?.id}:${req.usuario?.id}`;
const chaveDaEmpresa = (req) => `${req.empresa?.id}`;

const LIMITES_PADRAO = Object.freeze({
  chamadoPorUsuario: 5, chamadoPorEmpresa: 30, contatoPorUsuario: 5, contatoPorEmpresa: 30, mensagemPorUsuario: 20, mensagemPorEmpresa: 120,
});

function criarSuporteRoutes({ controller, exigirSessao: exigirSessaoInjetado, limites = LIMITES_PADRAO }) {
  const router = Router();
  const limitar = (limite, chave) => criarLimitador({ limite, janelaSegundos: 60, chave });
  const chamados = [limitar(limites.chamadoPorUsuario, chaveDoUsuario), limitar(limites.chamadoPorEmpresa, chaveDaEmpresa)];
  const contatos = [limitar(limites.contatoPorUsuario, chaveDoUsuario), limitar(limites.contatoPorEmpresa, chaveDaEmpresa)];
  const mensagens = [limitar(limites.mensagemPorUsuario, chaveDoUsuario), limitar(limites.mensagemPorEmpresa, chaveDaEmpresa)];

  router.get('/suporte/canais', exigirSessaoInjetado, controller.canais);
  router.post('/suporte/chamados', exigirSessaoInjetado, ...chamados, validar({ body: schemas.criarChamado.body }), controller.abrirChamado);
  router.get('/suporte/chamados', exigirSessaoInjetado, validar({ query: schemas.listarMeusChamados.query }), controller.listarChamados);
  router.get('/suporte/chamados/:id', exigirSessaoInjetado, validar({ params: schemas.buscarChamado.params }), controller.detalharChamado);
  // Conversa (093): leitura incremental (polling só com a janela aberta) e mensagem do solicitante, com cota própria.
  router.get('/suporte/chamados/:id/mensagens', exigirSessaoInjetado, validar({ params: schemas.novasMensagens.params, query: schemas.novasMensagens.query }), controller.novasMensagens);
  router.post(
    '/suporte/chamados/:id/mensagens',
    exigirSessaoInjetado,
    ...mensagens,
    validar({ params: schemas.enviarMensagem.params, body: schemas.enviarMensagem.body }),
    controller.enviarMensagem,
  );
  router.post(
    '/suporte/contatos/:canal',
    exigirSessaoInjetado,
    ...contatos,
    validar({ params: schemas.enviarContato.params, body: schemas.enviarContato.body }),
    controller.enviarContato,
  );
  return router;
}

const suporteRoutes = criarSuporteRoutes({ controller: suporteController, exigirSessao });

module.exports = { criarSuporteRoutes, suporteRoutes, LIMITES_PADRAO };
