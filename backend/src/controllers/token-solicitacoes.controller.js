'use strict';

const tokenSolicitacoesService = require('../services/token-solicitacoes.service');
const { authConfig } = require('../config/auth');
const { serializarRemocaoCookieAtendimento } = require('../security/cookie');
const { tokenDoAtendimento } = require('./token-atendimento.controller');
const { pool } = require('../config/database');

/**
 * Consulta das solicitações existentes do Atendimento Token (Etapa G). O tablet vem de req.dispositivo (credencial da Etapa C); o atendimento,
 * do cookie `gepi_atendimento` (lido SÓ dele, exatamente uma ocorrência). Consulta pura: nunca emite nem renova cookie; só o REMOVE quando o
 * atendimento é inválido, como as Etapas D, E e F. A resposta é a projeção mínima do funcionário atual.
 */
function criarTokenSolicitacoesController({ pool: poolInjetado }) {
  return {
    async obter(req, res) {
      try {
        const { temDisponiveis, itens } = await tokenSolicitacoesService.obter(poolInjetado, { dispositivo: req.dispositivo, token: tokenDoAtendimento(req) });
        res.status(200).json({ status: 'ok', temDisponiveis, itens });
      } catch (erro) {
        if (erro?.codigo === 'ATENDIMENTO_INVALIDO' && typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`${authConfig.atendimento.cookieNome}=`)) {
          res.append('Set-Cookie', serializarRemocaoCookieAtendimento());
        }
        throw erro;
      }
    },
  };
}

const tokenSolicitacoesController = criarTokenSolicitacoesController({ pool });

module.exports = { criarTokenSolicitacoesController, tokenSolicitacoesController };
