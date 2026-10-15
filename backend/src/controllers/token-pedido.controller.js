'use strict';

const tokenPedidoService = require('../services/token-pedido.service');
const { authConfig } = require('../config/auth');
const { hashTokenSessao, tokenSessaoTemFormatoValido } = require('../security/token');
const { serializarRemocaoCookieAtendimento } = require('../security/cookie');
const { credencialDaRequisicao } = require('../middleware/autenticacao-dispositivo');
const { tokenDoAtendimento } = require('./token-atendimento.controller');
const { ipDaRequisicao } = require('../utils/ip');
const { pool } = require('../config/database');

/**
 * Pedido do Atendimento Token (Etapa F). O tablet vem de req.dispositivo (credencial da Etapa C); o atendimento, do cookie `gepi_atendimento`
 * (lido só dele, uma única ocorrência); empresa, funcionário e GHE nunca vêm do cliente. A resposta traz o mínimo (número, status e itens do
 * pedido; nunca id interno, chave, estoque ou dado do funcionário). O cookie do atendimento é removido quando o pedido é registrado ou
 * repetido e quando o atendimento é inválido; a consulta de resultado nunca emite nem renova cookie.
 */

const credencial = (req) => {
  const valor = credencialDaRequisicao(req);
  return valor !== null && tokenSessaoTemFormatoValido(valor) ? hashTokenSessao(valor) : null;
};

function removerCookieSeInvalido(req, res, erro) {
  const temCookie = typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`${authConfig.atendimento.cookieNome}=`);
  if (erro?.codigo === 'ATENDIMENTO_INVALIDO' && temCookie) res.append('Set-Cookie', serializarRemocaoCookieAtendimento());
}

function criarTokenPedidoController({ pool: poolInjetado }) {
  return {
    async finalizar(req, res) {
      try {
        const { repetida, pedido } = await tokenPedidoService.finalizar(poolInjetado, {
          dispositivo: req.dispositivo,
          credencialHash: credencial(req),
          token: tokenDoAtendimento(req),
          corpo: req.validado.body,
          ip: ipDaRequisicao(req),
          agente: req.headers['user-agent'] ?? null,
        });
        res.append('Set-Cookie', serializarRemocaoCookieAtendimento());
        res.status(repetida ? 200 : 201).json({ status: 'ok', repetida, pedido });
      } catch (erro) {
        removerCookieSeInvalido(req, res, erro);
        throw erro;
      }
    },

    async resultado(req, res) {
      try {
        const { http, pedido } = await tokenPedidoService.resultado(poolInjetado, {
          dispositivo: req.dispositivo, token: tokenDoAtendimento(req), chave: req.validado.params.chave,
        });
        res.status(http).json({ status: 'ok', pedido });
      } catch (erro) {
        removerCookieSeInvalido(req, res, erro);
        throw erro;
      }
    },
  };
}

const tokenPedidoController = criarTokenPedidoController({ pool });

module.exports = { criarTokenPedidoController, tokenPedidoController };
