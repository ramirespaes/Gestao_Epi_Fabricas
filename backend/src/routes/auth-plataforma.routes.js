'use strict';

const { Router } = require('express');
const { validar } = require('../middleware/validar');
const authPlataformaSchemas = require('../schemas/auth-plataforma.schema');
const { limitadorPlataformaAutenticacao, limitadorPlataformaMfa } = require('../middleware/rate-limit');
const { authPlataformaController } = require('../controllers/auth-plataforma.controller');
const { exigirSessaoPlataforma } = require('../middleware/autenticacao-plataforma');
const { criarExigirDesafioMfa, TIPOS_DESAFIO_MFA } = require('../middleware/desafio-mfa-plataforma');
const { pool } = require('../config/database');

/**
 * Rotas de autenticação do Painel Privado da plataforma (Autenticação
 * Global — Pacote 2). Espelha auth.routes.js: só conecta caminho +
 * middlewares + controller, sem saber como cada um foi construído — permite
 * montar com dependências de teste (pool/limitador exclusivos) sem duplicar
 * a definição de rota.
 *
 * /auth/login: limitadorPlataformaAutenticacao (instância PRÓPRIA, contador
 * separado do limitadorAutenticacao do cliente) -> validar -> controller.
 * /auth/me: atrás de exigirSessaoPlataforma.
 * /auth/logout: sem exigirSessaoPlataforma, de propósito — idempotente,
 * mesma razão de auth.routes.js. A verificação de origem do namespace
 * /api/plataforma (montada em app.js) já protege POST.
 *
 * Rotas do MFA: as ÚNICAS que aceitam o desafio pré-MFA, cada uma
 * declarando os tipos de desafio que aceita (deny-by-default). As POST
 * passam antes pelo limitador próprio do MFA; o desafio é conferido antes
 * do corpo, então sem desafio a resposta é 401 sem ler nada.
 *   estado: qualquer tipo;
 *   liberacao: só LIBERACAO;
 *   cadastro/reiniciar e cadastro/confirmar: CADASTRO ou RECUPERACAO;
 *   verificar e recuperacao: só VERIFICACAO;
 *   substituicao/iniciar e recuperacao/regenerar: sessão plena, sem desafio;
 *   substituicao/confirmar: sessão plena e desafio SUBSTITUICAO.
 *
 * `desafioMfa(tipos)` e `limitadorMfa` são obrigatórios, sem padrão: um
 * middleware com o pool global, esquecido numa montagem de teste,
 * consultaria outro banco.
 *
 * Caminhos finais, quando montado por app.js sob /api/plataforma:
 *   POST /api/plataforma/auth/login
 *   GET  /api/plataforma/auth/me
 *   POST /api/plataforma/auth/logout
 *   GET  /api/plataforma/auth/mfa/estado
 *   POST /api/plataforma/auth/mfa/liberacao
 *   POST /api/plataforma/auth/mfa/cadastro/reiniciar
 *   POST /api/plataforma/auth/mfa/cadastro/confirmar
 *   POST /api/plataforma/auth/mfa/verificar
 *   POST /api/plataforma/auth/mfa/recuperacao
 *   POST /api/plataforma/auth/mfa/substituicao/iniciar
 *   POST /api/plataforma/auth/mfa/substituicao/confirmar
 *   POST /api/plataforma/auth/mfa/recuperacao/regenerar
 */

function criarAuthPlataformaRoutes({
  controller, limitador, limitadorMfa, exigirSessaoPlataforma: exigirSessaoInjetado, desafioMfa,
}) {
  if (typeof desafioMfa !== 'function') {
    throw new TypeError('desafioMfa é obrigatório');
  }
  if (typeof limitadorMfa !== 'function') {
    throw new TypeError('limitadorMfa é obrigatório');
  }
  const router = Router();

  router.post('/auth/login', limitador, validar({ body: authPlataformaSchemas.login.body }), controller.login);
  router.get('/auth/me', exigirSessaoInjetado, controller.me);
  router.post('/auth/logout', controller.logout);

  router.get('/auth/mfa/estado', desafioMfa(TIPOS_DESAFIO_MFA), controller.estadoMfa);
  router.post(
    '/auth/mfa/liberacao',
    limitadorMfa, desafioMfa(['LIBERACAO']), validar({ body: authPlataformaSchemas.mfaLiberacao.body }), controller.mfaLiberacao,
  );
  router.post(
    '/auth/mfa/cadastro/reiniciar',
    limitadorMfa, desafioMfa(['CADASTRO', 'RECUPERACAO']), validar({ body: authPlataformaSchemas.mfaCadastroReiniciar.body }), controller.mfaCadastroReiniciar,
  );
  router.post(
    '/auth/mfa/cadastro/confirmar',
    limitadorMfa, desafioMfa(['CADASTRO', 'RECUPERACAO']), validar({ body: authPlataformaSchemas.mfaCadastroConfirmar.body }), controller.mfaCadastroConfirmar,
  );
  router.post(
    '/auth/mfa/verificar',
    limitadorMfa, desafioMfa(['VERIFICACAO']), validar({ body: authPlataformaSchemas.mfaVerificar.body }), controller.mfaVerificar,
  );
  router.post(
    '/auth/mfa/recuperacao',
    limitadorMfa, desafioMfa(['VERIFICACAO']), validar({ body: authPlataformaSchemas.mfaRecuperacao.body }), controller.mfaRecuperacao,
  );
  router.post(
    '/auth/mfa/substituicao/iniciar',
    limitadorMfa, exigirSessaoInjetado, validar({ body: authPlataformaSchemas.mfaReautenticacao.body }), controller.mfaSubstituicaoIniciar,
  );
  router.post(
    '/auth/mfa/substituicao/confirmar',
    limitadorMfa, exigirSessaoInjetado, desafioMfa(['SUBSTITUICAO']), validar({ body: authPlataformaSchemas.mfaSubstituicaoConfirmar.body }),
    controller.mfaSubstituicaoConfirmar,
  );
  router.post(
    '/auth/mfa/recuperacao/regenerar',
    limitadorMfa, exigirSessaoInjetado, validar({ body: authPlataformaSchemas.mfaReautenticacao.body }), controller.mfaRecuperacaoRegenerar,
  );

  return router;
}

const authPlataformaRoutes = criarAuthPlataformaRoutes({
  controller: authPlataformaController,
  limitador: limitadorPlataformaAutenticacao,
  limitadorMfa: limitadorPlataformaMfa,
  exigirSessaoPlataforma,
  desafioMfa: (tipos) => criarExigirDesafioMfa({ pool, tipos }),
});

module.exports = { criarAuthPlataformaRoutes, authPlataformaRoutes };
