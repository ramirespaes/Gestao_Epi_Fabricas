'use strict';

const { Router } = require('express');
const { validar } = require('../middleware/validar');
const schemas = require('../schemas/solicitacao-epi.schema');
const { criarSolicitacaoEpiController } = require('../controllers/solicitacao-epi.controller');
const { exigirSessao } = require('../middleware/autenticacao');
const { criarExigirPermissaoRecurso, criarExigirPermissaoAcao, MENSAGEM_PERMISSAO_NEGADA } = require('../middleware/autorizacao');
const { HttpError } = require('../errors/HttpError');
const { pool } = require('../config/database');

/**
 * Solicitação de EPI pela camada HTTP. Cada operação tem a sua autoridade,
 * sempre pela autorização central (criarExigirPermissaoRecurso /
 * criarExigirPermissaoAcao), nunca uma pela outra:
 *   - minhas            -> RECURSO `request`, visualizar (só as do próprio usuário);
 *   - criar             -> RECURSO `request`, criar;
 *   - cancelar          -> RECURSO `request`, editar (e o serviço: só o próprio
 *                          solicitante, só PENDENTE); excluir não é usado, o
 *                          cancelamento não apaga o registro;
 *   - fila              -> AÇÃO `APROVAR_SOLICITACAO`;
 *   - decidir           -> aprovar algum item exige `APROVAR_SOLICITACAO`, reprovar
 *                          algum exige `REPROVAR_SOLICITACAO`, a decisão mista as duas;
 *   - encerrar          -> AÇÃO `ENCERRAR_SOLICITACAO`;
 *   - entregáveis e
 *     entregar          -> AÇÃO `REALIZAR_ENTREGA`;
 *   - contexto da
 *     criação (12G-0)   -> RECURSO `request`, criar (trabalhador e material para
 *                          escolher, sem CPF e sem números de estoque);
 *   - encerráveis (12G-0) -> AÇÃO `ENCERRAR_SOLICITACAO` (lista própria e mínima;
 *                          não abre os entregáveis, que continuam de quem entrega).
 * As ações da SST exigem vínculo SST e autorização individual (catálogo 017 e
 * 068). O detalhe não tem uma permissão única: o serviço decide, com as mesmas
 * avaliações da autorização central, se quem pede trabalha a solicitação ou só
 * pode ver as próprias. Separação de funções (AUTODECISAO_PROIBIDA), estado,
 * cobertura e estoque são do serviço.
 *
 * Caminhos, quando montado por app.js sob /api:
 *   GET  /api/solicitacoes-epi/minhas
 *   GET  /api/solicitacoes-epi/fila
 *   GET  /api/solicitacoes-epi/entregaveis
 *   GET  /api/solicitacoes-epi/encerraveis
 *   GET  /api/solicitacoes-epi/contexto/funcionarios
 *   GET  /api/solicitacoes-epi/contexto/:funcionarioId/materiais
 *   GET  /api/solicitacoes-epi/:id
 *   POST /api/solicitacoes-epi
 *   POST /api/solicitacoes-epi/:id/cancelamento
 *   POST /api/solicitacoes-epi/:id/decisao
 *   POST /api/solicitacoes-epi/:id/encerramento
 *   POST /api/solicitacoes-epi/:id/entregas
 */

const RECURSO_SOLICITACAO = 'request';
const OPERACAO_CRIAR = 'criar';
const OPERACAO_CANCELAR = 'editar';
const ACAO_APROVAR = 'APROVAR_SOLICITACAO';
const ACAO_REPROVAR = 'REPROVAR_SOLICITACAO';
const ACAO_ENCERRAR = 'ENCERRAR_SOLICITACAO';
const ACAO_ENTREGAR = 'REALIZAR_ENTREGA';
const ACAO_FILA = ACAO_APROVAR;
const ACAO_ENTREGAVEIS = ACAO_ENTREGAR;
// 12G-0: o contexto da criação é de quem cria; as encerráveis, de quem encerra (nunca de quem só entrega).
const OPERACAO_CONTEXTO = OPERACAO_CRIAR;
const ACAO_ENCERRAVEIS = ACAO_ENCERRAR;

/** As ações que a decisão exige, pelo que ela faz com os itens. */
function acoesDaDecisao(decisoes) {
  const acoes = [];
  if (decisoes.some((x) => x.decisao === 'APROVADO')) acoes.push(ACAO_APROVAR);
  if (decisoes.some((x) => x.decisao === 'REPROVADO')) acoes.push(ACAO_REPROVAR);
  return acoes;
}

// Roda o middleware da fábrica central e devolve o erro que ele passou ao next (undefined quando permite).
const rodarExigencia = (middleware, req, res) => new Promise((resolve, reject) => {
  Promise.resolve(middleware(req, res, resolve)).catch(reject);
});

/**
 * Autoridade da decisão sobre o corpo já validado: roda, em ordem, as
 * exigências da fábrica central para as ações que a decisão usa, e para na
 * primeira recusa. Sem nenhuma ação a exigir, recusa: nunca segue sem
 * exigência.
 */
function criarExigirAutoridadeDaDecisao(porAcao) {
  for (const acao of [ACAO_APROVAR, ACAO_REPROVAR]) {
    if (typeof porAcao?.[acao] !== 'function') throw new TypeError(`exigência da decisão ausente: ${acao}`);
  }
  return async function exigirAutoridadeDaDecisao(req, res, next) {
    const acoes = acoesDaDecisao(req.validado.body.decisoes);
    if (acoes.length === 0) {
      next(HttpError.forbidden('PERMISSAO_NEGADA', MENSAGEM_PERMISSAO_NEGADA));
      return;
    }
    for (const acao of acoes) {
      const erro = await rodarExigencia(porAcao[acao], req, res);
      if (erro !== undefined) {
        next(erro);
        return;
      }
    }
    next();
  };
}

function criarSolicitacaoEpiRoutes({ controller, exigirSessao: exigirSessaoInjetado, pool: poolInjetado }) {
  const router = Router();
  const dependencias = { pool: poolInjetado };
  const exigirVerSolicitacoes = criarExigirPermissaoRecurso(dependencias, RECURSO_SOLICITACAO, 'visualizar');
  const exigirCriar = criarExigirPermissaoRecurso(dependencias, RECURSO_SOLICITACAO, OPERACAO_CRIAR);
  const exigirContexto = criarExigirPermissaoRecurso(dependencias, RECURSO_SOLICITACAO, OPERACAO_CONTEXTO);
  const exigirCancelar = criarExigirPermissaoRecurso(dependencias, RECURSO_SOLICITACAO, OPERACAO_CANCELAR);
  const exigirAprovar = criarExigirPermissaoAcao(dependencias, ACAO_APROVAR);
  const exigirReprovar = criarExigirPermissaoAcao(dependencias, ACAO_REPROVAR);
  const exigirEncerrar = criarExigirPermissaoAcao(dependencias, ACAO_ENCERRAR);
  const exigirEntregar = criarExigirPermissaoAcao(dependencias, ACAO_ENTREGAR);
  const exigirAutoridadeDaDecisao = criarExigirAutoridadeDaDecisao({ [ACAO_APROVAR]: exigirAprovar, [ACAO_REPROVAR]: exigirReprovar });

  // As estáticas antes de /:id.
  router.get(
    '/solicitacoes-epi/minhas',
    exigirSessaoInjetado, exigirVerSolicitacoes,
    validar({ query: schemas.minhas.query }),
    controller.minhas,
  );
  router.get(
    '/solicitacoes-epi/fila',
    exigirSessaoInjetado, exigirAprovar,
    validar({ query: schemas.fila.query }),
    controller.fila,
  );
  router.get(
    '/solicitacoes-epi/entregaveis',
    exigirSessaoInjetado, exigirEntregar,
    validar({ query: schemas.entregaveis.query }),
    controller.entregaveis,
  );
  router.get(
    '/solicitacoes-epi/encerraveis',
    exigirSessaoInjetado, exigirEncerrar,
    validar({ query: schemas.encerraveis.query }),
    controller.encerraveis,
  );
  router.get(
    '/solicitacoes-epi/contexto/funcionarios',
    exigirSessaoInjetado, exigirContexto,
    validar({ query: schemas.contextoFuncionarios.query }),
    controller.contextoFuncionarios,
  );
  router.get(
    '/solicitacoes-epi/contexto/:funcionarioId/materiais',
    exigirSessaoInjetado, exigirContexto,
    validar({ params: schemas.contextoMateriais.params, query: schemas.contextoMateriais.query }),
    controller.contextoMateriais,
  );
  router.get(
    '/solicitacoes-epi/:id',
    exigirSessaoInjetado,
    validar({ params: schemas.detalhe.params, query: schemas.detalhe.query }),
    controller.detalhe,
  );

  router.post(
    '/solicitacoes-epi',
    exigirSessaoInjetado, exigirCriar,
    validar({ body: schemas.criar.body }),
    controller.criar,
  );
  router.post(
    '/solicitacoes-epi/:id/cancelamento',
    exigirSessaoInjetado, exigirCancelar,
    validar({ params: schemas.cancelar.params, body: schemas.cancelar.body }),
    controller.cancelar,
  );
  // A ação exigida depende do que a decisão faz: valida o corpo antes de autorizar.
  router.post(
    '/solicitacoes-epi/:id/decisao',
    exigirSessaoInjetado,
    validar({ params: schemas.decidir.params, body: schemas.decidir.body }),
    exigirAutoridadeDaDecisao,
    controller.decidir,
  );
  router.post(
    '/solicitacoes-epi/:id/encerramento',
    exigirSessaoInjetado, exigirEncerrar,
    validar({ params: schemas.encerrar.params, body: schemas.encerrar.body }),
    controller.encerrar,
  );
  router.post(
    '/solicitacoes-epi/:id/entregas',
    exigirSessaoInjetado, exigirEntregar,
    validar({ params: schemas.entregar.params, body: schemas.entregar.body }),
    controller.entregar,
  );
  return router;
}

const solicitacaoEpiRoutes = criarSolicitacaoEpiRoutes({ controller: criarSolicitacaoEpiController({ pool }), exigirSessao, pool });

module.exports = {
  criarSolicitacaoEpiRoutes,
  solicitacaoEpiRoutes,
  criarExigirAutoridadeDaDecisao,
  acoesDaDecisao,
  RECURSO_SOLICITACAO,
  OPERACAO_CRIAR,
  OPERACAO_CANCELAR,
  ACAO_APROVAR,
  ACAO_REPROVAR,
  ACAO_ENCERRAR,
  ACAO_ENTREGAR,
  ACAO_FILA,
  ACAO_ENTREGAVEIS,
  OPERACAO_CONTEXTO,
  ACAO_ENCERRAVEIS,
};
