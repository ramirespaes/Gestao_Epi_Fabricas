'use strict';

const cookie = require('cookie');
const tokenAtendimentoService = require('../services/token-atendimento.service');
const { authConfig } = require('../config/auth');
const { hashTokenSessao, tokenSessaoTemFormatoValido } = require('../security/token');
const { serializarCookieAtendimento, serializarRemocaoCookieAtendimento } = require('../security/cookie');
const { credencialDaRequisicao } = require('../middleware/autenticacao-dispositivo');
const { ipDaRequisicao } = require('../utils/ip');
const { pool } = require('../config/database');

/**
 * Rotas do atendimento do funcionário no tablet (Etapa D). O tablet vem de req.dispositivo (credencial da Etapa C, empresa do
 * servidor); o atendimento, do cookie próprio gepi_atendimento: lido SÓ dele, nunca de corpo, query ou cabeçalho, e cookie
 * ausente ou duplicado equivale a ausente. O token só viaja em Set-Cookie (HttpOnly); o corpo traz só o primeiro nome.
 */

function ocorrencias(cabecalho, nome) {
  if (typeof cabecalho !== 'string' || cabecalho.length === 0) return 0;
  return cabecalho.split(';').map((parte) => parte.trim()).filter((parte) => parte.startsWith(`${nome}=`)).length;
}

function tokenDoAtendimento(req) {
  const nome = authConfig.atendimento.cookieNome;
  if (ocorrencias(req.headers.cookie, nome) !== 1) return null;
  const valor = cookie.parse(req.headers.cookie)[nome];
  return typeof valor === 'string' && tokenSessaoTemFormatoValido(valor) ? valor : null;
}

const hashDaCredencial = (req) => {
  const credencial = credencialDaRequisicao(req);
  return credencial !== null && tokenSessaoTemFormatoValido(credencial) ? hashTokenSessao(credencial) : null;
};

const contexto = (req) => ({
  dispositivo: req.dispositivo,
  credencialHash: hashDaCredencial(req),
  token: tokenDoAtendimento(req),
  ip: ipDaRequisicao(req),
  agente: req.headers['user-agent'] ?? null,
});

/** Atendimento inválido com um cookie presente: o navegador descarta o cookie (a resposta em si é sempre a mesma). */
async function removendoCookieSeInvalido(req, res, operacao) {
  try {
    return await operacao();
  } catch (erro) {
    if (erro?.codigo === 'ATENDIMENTO_INVALIDO' && typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`${authConfig.atendimento.cookieNome}=`)) {
      res.append('Set-Cookie', serializarRemocaoCookieAtendimento());
    }
    throw erro;
  }
}

function criarTokenAtendimentoController({ pool: poolInjetado }) {
  return {
    async identificar(req, res) {
      const { token, atendimento } = await tokenAtendimentoService.identificar(poolInjetado, {
        ...contexto(req),
        tipo: req.validado.body.tipo,
        valor: req.validado.body.valor,
      });
      res.append('Set-Cookie', serializarCookieAtendimento(token));
      res.status(201).json({ status: 'ok', atendimento });
    },

    async estado(req, res) {
      const atendimento = await removendoCookieSeInvalido(req, res, () => tokenAtendimentoService.estado(poolInjetado, contexto(req)));
      res.status(200).json({ status: 'ok', atendimento });
    },

    async atividade(req, res) {
      const atendimento = await removendoCookieSeInvalido(req, res, () => tokenAtendimentoService.atividade(poolInjetado, contexto(req)));
      // Interação válida: o cookie acompanha o novo prazo do servidor.
      res.append('Set-Cookie', serializarCookieAtendimento(tokenDoAtendimento(req)));
      res.status(200).json({ status: 'ok', atendimento });
    },

    async encerrar(req, res) {
      await removendoCookieSeInvalido(req, res, () => tokenAtendimentoService.encerrar(poolInjetado, contexto(req)));
      res.append('Set-Cookie', serializarRemocaoCookieAtendimento());
      res.status(200).json({ status: 'ok' });
    },
  };
}

const tokenAtendimentoController = criarTokenAtendimentoController({ pool });

module.exports = { criarTokenAtendimentoController, tokenAtendimentoController, tokenDoAtendimento };
