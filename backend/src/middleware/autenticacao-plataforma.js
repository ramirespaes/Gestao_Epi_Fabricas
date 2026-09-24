'use strict';

const cookie = require('cookie');
const { HttpError } = require('../errors/HttpError');
const { authConfig } = require('../config/auth');
const { tokenSessaoTemFormatoValido, hashTokenSessao } = require('../security/token');
const sessaoRepo = require('../repositories/sessao-plataforma.repository');
const { pool } = require('../config/database');

/**
 * Middleware de autenticação de sessão do Painel Privado da plataforma
 * (Autenticação Global — Pacote 2). Espelha `middleware/autenticacao.js`
 * ponto a ponto, com duas diferenças deliberadas:
 *
 *   1. Lê o cookie PRÓPRIO da plataforma (`authConfig.sessao.cookieNomeAdmin`,
 *      nunca `cookieNome`) — é essa diferença de nome que garante que "o
 *      cookie empresarial não deve autenticar administradores da
 *      plataforma" e "o cookie administrativo não deve autenticar usuários
 *      nos ambientes empresariais" (Pacote 2, item 3): mesmo que os dois
 *      cookies cheguem juntos numa requisição, cada middleware só reconhece
 *      o seu próprio nome.
 *   2. Popula `req.administradorPlataforma` (nunca `req.usuario`/
 *      `req.empresa`) — nomes de propriedade DIFERENTES, de propósito: um
 *      erro de programação que confundisse os dois contextos (por exemplo,
 *      uma rota de plataforma lendo `req.usuario` por engano) falha alto
 *      (undefined, TypeError), nunca concede acesso silenciosamente.
 *
 * A pequena duplicação de `contarOcorrenciasDoCookie`/`extrairTokenDoCookie`
 * em vez de importar de `autenticacao.js` é deliberada: aquele módulo
 * fixa internamente `authConfig.sessao.cookieNome` (o cookie do cliente) e
 * já está aprovado e testado — não é alterado para caber um segundo nome,
 * por menor que fosse o risco. As poucas linhas aqui são as mesmas, só
 * parametrizadas pelo nome do cookie administrativo.
 *
 * CONTRATO DE ERRO: idêntico ao empresarial — toda causa de sessão
 * inválida (cookie ausente, duplicado, malformado, sessão inexistente/
 * revogada/expirada/inativa por inatividade, ou administrador inativo)
 * produz o MESMO HttpError.unauthorized('SESSAO_INVALIDA', ...). Um
 * contexto de autenticação ausente não é tratado aqui (este módulo não
 * decide autorização, só identidade) e uma falha real do PostgreSQL
 * propaga sem tratamento, para o errorHandler genérico (500).
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
  const nome = authConfig.sessao.cookieNomeAdmin;
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
 * Resolve o cookie ADMINISTRATIVO da requisição para o contexto de sessão
 * de plataforma validado no PostgreSQL, ou `null` para qualquer causa de
 * invalidade já conhecida. Exportada para reuso pelo controller de logout,
 * mesmo padrão de `autenticacao.buscarContextoSessao`.
 *
 * @param {{query: Function}} pool
 * @param {import('express').Request} req
 * @returns {Promise<{sessao: object, administrador: object}|null>}
 */
async function buscarContextoSessaoPlataforma(pool, req) {
  const extraido = extrairTokenDoCookie(req);
  if (!extraido.presente || extraido.ambiguo) {
    return null;
  }
  if (!tokenSessaoTemFormatoValido(extraido.valor)) {
    return null;
  }

  const tokenHash = hashTokenSessao(extraido.valor);
  return sessaoRepo.buscarValidaPorHash(pool, tokenHash, authConfig.sessao.inatividadeMinutos);
}

/**
 * Fábrica do middleware. Em sucesso, popula `req.administradorPlataforma`
 * (exatamente o que `buscarValidaPorHash` devolveu) e chama `next()`; em
 * qualquer falha, encaminha `HttpError.unauthorized('SESSAO_INVALIDA', ...)`.
 *
 * `registrarUso` roda em toda requisição autenticada com sucesso — mesma
 * razão do middleware empresarial: sem isso, expiração por inatividade não
 * refletiria uso real.
 */
function criarExigirSessaoPlataforma({ pool }) {
  return async function exigirSessaoPlataforma(req, res, next) {
    const contexto = await buscarContextoSessaoPlataforma(pool, req);
    if (contexto === null) {
      next(HttpError.unauthorized('SESSAO_INVALIDA', MENSAGEM_SESSAO_INVALIDA));
      return;
    }

    const atualizou = await sessaoRepo.registrarUso(pool, contexto.sessao.id, authConfig.sessao.inatividadeMinutos);
    if (!atualizou) {
      next(HttpError.unauthorized('SESSAO_INVALIDA', MENSAGEM_SESSAO_INVALIDA));
      return;
    }

    req.sessaoPlataforma = contexto.sessao;
    req.administradorPlataforma = contexto.administrador;
    next();
  };
}

const exigirSessaoPlataforma = criarExigirSessaoPlataforma({ pool });

module.exports = {
  criarExigirSessaoPlataforma,
  exigirSessaoPlataforma,
  buscarContextoSessaoPlataforma,
  extrairTokenDoCookie,
};
