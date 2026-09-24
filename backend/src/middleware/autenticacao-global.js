'use strict';

const cookie = require('cookie');
const { HttpError } = require('../errors/HttpError');
const { authConfig } = require('../config/auth');
const { tokenSessaoTemFormatoValido, hashTokenSessao } = require('../security/token');
const sessaoGlobalRepo = require('../repositories/sessao-global.repository');
const { pool } = require('../config/database');

/**
 * Middleware de autenticação da sessão GLOBAL da identidade (Autenticação
 * Global — Pacote 4; sessoes_globais, migration 035). Espelha
 * `middleware/autenticacao.js` e `middleware/autenticacao-plataforma.js`
 * ponto a ponto, com as duas diferenças deliberadas de sempre:
 *
 *   1. Lê o cookie PRÓPRIO (`authConfig.sessao.cookieNomeGlobal`), nunca o
 *      empresarial nem o administrativo — mesmo que os três cheguem juntos
 *      numa requisição, cada middleware só reconhece o seu nome;
 *   2. Popula `req.sessaoGlobal` e `req.identidade` (nunca `req.usuario`/
 *      `req.empresa`, nunca `req.administradorPlataforma`): uma rota que
 *      confundisse os contextos falha alto, nunca concede acesso.
 *
 * O QUE ESTA SESSÃO NÃO É: acesso operacional. Nenhuma rota de negócio
 * (RBAC, recursos, ações) fica atrás deste middleware — só as rotas de
 * listar/selecionar empresa e de encerramento. O acesso operacional
 * continua exigindo `exigirSessao` (cookie empresarial, tabela sessoes),
 * que só nasce depois de uma seleção de empresa validada no servidor.
 *
 * CONTRATO DE ERRO: idêntico aos outros dois — toda causa de sessão
 * inválida produz o MESMO HttpError.unauthorized('SESSAO_INVALIDA', ...).
 * Falha real do PostgreSQL propaga sem tratamento (500).
 */

const MENSAGEM_SESSAO_INVALIDA = 'Sessão inválida ou expirada';

function contarOcorrenciasDoCookie(cabecalho, nome) {
  if (typeof cabecalho !== 'string' || cabecalho.length === 0) {
    return 0;
  }
  const prefixo = `${nome}=`;
  return cabecalho
    .split(';')
    .map((parte) => parte.trim())
    .filter((parte) => parte.startsWith(prefixo))
    .length;
}

function extrairTokenDoCookie(req) {
  const cabecalho = req.headers.cookie;
  const nome = authConfig.sessao.cookieNomeGlobal;
  const ocorrencias = contarOcorrenciasDoCookie(cabecalho, nome);

  if (ocorrencias === 0) {
    return { presente: false };
  }
  if (ocorrencias > 1) {
    return { presente: true, ambiguo: true };
  }

  const valores = cookie.parse(cabecalho);
  return { presente: true, ambiguo: false, valor: valores[nome] };
}

/**
 * Resolve o cookie GLOBAL da requisição para o contexto validado no
 * PostgreSQL, ou `null` para qualquer causa de invalidade conhecida.
 * Exportada para o controller de logout (idempotente, sem o middleware
 * estrito) — mesmo padrão dos outros dois contextos.
 *
 * @param {{query: Function}} pool
 * @param {import('express').Request} req
 * @returns {Promise<{sessao: object, identidade: {id:number, email:string}}|null>}
 */
async function buscarContextoSessaoGlobal(pool, req) {
  const extraido = extrairTokenDoCookie(req);
  if (!extraido.presente || extraido.ambiguo) {
    return null;
  }
  if (!tokenSessaoTemFormatoValido(extraido.valor)) {
    return null;
  }

  const tokenHash = hashTokenSessao(extraido.valor);
  return sessaoGlobalRepo.buscarValidaPorHash(pool, tokenHash, authConfig.sessao.inatividadeMinutos);
}

function criarExigirSessaoGlobal({ pool }) {
  return async function exigirSessaoGlobal(req, res, next) {
    const contexto = await buscarContextoSessaoGlobal(pool, req);
    if (contexto === null) {
      next(HttpError.unauthorized('SESSAO_INVALIDA', MENSAGEM_SESSAO_INVALIDA));
      return;
    }

    const atualizou = await sessaoGlobalRepo.registrarUso(pool, contexto.sessao.id, authConfig.sessao.inatividadeMinutos);
    if (!atualizou) {
      next(HttpError.unauthorized('SESSAO_INVALIDA', MENSAGEM_SESSAO_INVALIDA));
      return;
    }

    req.sessaoGlobal = contexto.sessao;
    req.identidade = contexto.identidade;
    next();
  };
}

const exigirSessaoGlobal = criarExigirSessaoGlobal({ pool });

module.exports = {
  criarExigirSessaoGlobal,
  exigirSessaoGlobal,
  buscarContextoSessaoGlobal,
  extrairTokenDoCookie,
};
