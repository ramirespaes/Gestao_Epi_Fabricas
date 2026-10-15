'use strict';

const cookie = require('cookie');
const { authConfig } = require('../config/auth');
const { serializarCookieDispositivo } = require('../security/cookie');
const { ipDaRequisicao } = require('../utils/ip');
const tabletService = require('../services/token-tablet.service');

/**
 * Autenticação do TABLET (Atendimento Token, Etapa C). Lê SOMENTE o cookie do tablet (authConfig.dispositivo.cookieNome): nunca
 * o de sessão administrativa, nunca Authorization, cabeçalhos X-* nem query. Cookie ausente ou duplicado equivale a ausente.
 * A decisão (credencial, tablet, empresa, rede, rotação) é do serviço, no PostgreSQL; este middleware não conhece body, params
 * nem query, e a origem de rede é o req.ip que o servidor resolveu (TRUST_PROXY_HOPS).
 *
 * Em sucesso popula req.dispositivo (id, empresaId e os dados de localização) — NUNCA req.usuario, req.empresa ou req.sessao:
 * a credencial do tablet não concede nenhum privilégio administrativo. Se esta requisição rotacionou a credencial, a nova vai
 * em Set-Cookie (o valor em claro só existe nesse cabeçalho). Qualquer falha é encaminhada ao errorHandler.
 */

function ocorrenciasDoCookie(cabecalho, nome) {
  if (typeof cabecalho !== 'string' || cabecalho.length === 0) return 0;
  const prefixo = `${nome}=`;
  return cabecalho.split(';').map((parte) => parte.trim()).filter((parte) => parte.startsWith(prefixo)).length;
}

function credencialDaRequisicao(req) {
  const nome = authConfig.dispositivo.cookieNome;
  const cabecalho = req.headers.cookie;
  if (ocorrenciasDoCookie(cabecalho, nome) !== 1) return null;
  const valor = cookie.parse(cabecalho)[nome];
  return typeof valor === 'string' ? valor : null;
}

function criarExigirDispositivo({ pool }) {
  return async function exigirDispositivo(req, res, next) {
    try {
      const { dispositivo, novaCredencial } = await tabletService.autenticar(pool, { credencial: credencialDaRequisicao(req), ip: ipDaRequisicao(req) });
      if (novaCredencial !== null) res.append('Set-Cookie', serializarCookieDispositivo(novaCredencial));
      req.dispositivo = dispositivo;
      next();
    } catch (erro) {
      next(erro);
    }
  };
}

module.exports = { criarExigirDispositivo, credencialDaRequisicao };
