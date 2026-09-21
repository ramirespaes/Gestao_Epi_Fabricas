'use strict';

const cookie = require('cookie');
const { HttpError } = require('../errors/HttpError');
const { authConfig } = require('../config/auth');
const { tokenSessaoTemFormatoValido, hashTokenSessao } = require('../security/token');
const sessaoRepo = require('../repositories/sessao.repository');
const { pool } = require('../config/database');

/**
 * Middleware de autenticação de sessão (Bloco 8, Incremento 7).
 *
 * A identidade de quem faz a requisição vem exclusivamente da sessão
 * validada no PostgreSQL — nunca de empresaId, usuarioId ou perfil que o
 * navegador possa enviar. Este arquivo não sabe de body, params ou query;
 * a única entrada é o cookie de sessão.
 *
 * `sessaoRepo.funcao(...)` é chamado por namespace, nunca desestruturado —
 * mesma razão já documentada em login.service.js e auth.controller.js:
 * permite mock.method nos testes sem mudar o comportamento em produção.
 *
 * CONTRATO DE ERRO: toda causa de sessão inválida (cookie ausente,
 * duplicado, malformado, sessão inexistente/revogada/expirada/inativa por
 * inatividade, empresa ou usuário inativos, ou a própria atualização de uso
 * recusada) produz o MESMO HttpError.unauthorized('SESSAO_INVALIDA', ...) —
 * nenhuma delas é distinguível pelo cliente, mesma filosofia já usada em
 * login.service.js para não permitir enumeração. Uma falha REAL e inesperada
 * do PostgreSQL (a chamada ao repositório rejeita, não devolve null/false)
 * nunca é convertida nisso: propaga sem tratamento, para o errorHandler
 * genérico decidir (500) — nada aqui usa try/catch de propósito.
 */

const MENSAGEM_SESSAO_INVALIDA = 'Sessão inválida ou expirada';

/**
 * Conta quantas vezes o cookie de nome `nome` aparece no cabeçalho Cookie
 * bruto — mesma técnica de cabecalhoUnico() em middleware/origem.js para
 * Origin/Referer. Não usa cookie.parse() aqui: essa função silenciosamente
 * resolve duplicatas para um único valor (mantendo o primeiro ou o último,
 * dependendo da implementação), o que esconderia justamente a ambiguidade
 * que precisamos detectar e recusar.
 */
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

/**
 * Extrai o token do cookie de sessão da requisição, sem nunca lançar.
 *   { presente: false }                       — nenhuma ocorrência
 *   { presente: true, ambiguo: true }          — mais de uma ocorrência
 *   { presente: true, ambiguo: false, valor }  — exatamente uma ocorrência
 * Só quando há exatamente uma ocorrência o valor é obtido via cookie.parse
 * (seguro nesse ponto, porque a ambiguidade já foi descartada antes).
 */
function extrairTokenDoCookie(req) {
  const cabecalho = req.headers.cookie;
  const nome = authConfig.sessao.cookieNome;
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
 * Resolve o cookie da requisição para o contexto de sessão validado no
 * PostgreSQL, ou null para qualquer causa de invalidade já conhecida
 * (ausência, ambiguidade, formato inválido, ou o próprio repositório não
 * encontrando uma sessão válida). Nunca chama registrarUso: isso fica a
 * cargo de quem usa esta função — o middleware de sessão exige a
 * atualização de uso; um futuro logout não precisa dela.
 *
 * Nunca envia um token de formato inválido ao PostgreSQL: a checagem de
 * formato acontece antes de hashTokenSessao e de qualquer consulta.
 *
 * Exportada para reuso pelo futuro controller de logout — não implementado
 * nesta etapa.
 *
 * @param {{query: Function}} pool
 * @param {import('express').Request} req
 * @returns {Promise<{sessao: object, usuario: object, empresa: object}|null>}
 */
async function buscarContextoSessao(pool, req) {
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
 * Fábrica do middleware de autenticação de sessão. Em sucesso, popula
 * req.sessao/req.usuario/req.empresa (exatamente o que buscarValidaPorHash
 * devolveu) e chama next(); em qualquer falha, encaminha
 * HttpError.unauthorized('SESSAO_INVALIDA', ...).
 *
 * registrarUso roda em TODA requisição autenticada com sucesso — é o que
 * faz a expiração por inatividade refletir uso real: sem isso, um usuário
 * ativo poderia ser desconectado mesmo continuando a usar o sistema. Se
 * registrarUso devolver false (a sessão deixou de ser válida entre a
 * leitura e a tentativa de atualização), a requisição é tratada como
 * sessão inválida, não como sucesso parcial.
 *
 * @param {{pool: import('pg').Pool}} dependencias
 */
function criarExigirSessao({ pool }) {
  return async function exigirSessao(req, res, next) {
    const contexto = await buscarContextoSessao(pool, req);
    if (contexto === null) {
      next(HttpError.unauthorized('SESSAO_INVALIDA', MENSAGEM_SESSAO_INVALIDA));
      return;
    }

    const atualizou = await sessaoRepo.registrarUso(
      pool,
      contexto.sessao.id,
      authConfig.sessao.inatividadeMinutos,
    );
    if (!atualizou) {
      next(HttpError.unauthorized('SESSAO_INVALIDA', MENSAGEM_SESSAO_INVALIDA));
      return;
    }

    req.sessao = contexto.sessao;
    req.usuario = contexto.usuario;
    req.empresa = contexto.empresa;
    next();
  };
}

const exigirSessao = criarExigirSessao({ pool });

module.exports = { criarExigirSessao, exigirSessao, buscarContextoSessao, extrairTokenDoCookie };
