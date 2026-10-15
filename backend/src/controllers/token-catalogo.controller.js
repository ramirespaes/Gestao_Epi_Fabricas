'use strict';

const tokenCatalogoService = require('../services/token-catalogo.service');
const { authConfig } = require('../config/auth');
const { serializarRemocaoCookieAtendimento } = require('../security/cookie');
const { tokenDoAtendimento } = require('./token-atendimento.controller');
const { pool } = require('../config/database');

/**
 * Catálogo do Atendimento Token (Etapa E). O tablet vem de req.dispositivo (credencial da Etapa C); o atendimento, do cookie
 * `gepi_atendimento` (lido SÓ dele, exatamente uma ocorrência). Consulta pura: nunca emite nem renova cookie; só o REMOVE quando o
 * atendimento é inválido (o navegador descarta o cookie morto), como a Etapa D. A resposta nunca traz dado do funcionário.
 */
function criarTokenCatalogoController({ pool: poolInjetado }) {
  return {
    async obter(req, res) {
      try {
        const catalogo = await tokenCatalogoService.obter(poolInjetado, { dispositivo: req.dispositivo, token: tokenDoAtendimento(req) });
        res.status(200).json({ status: 'ok', catalogo });
      } catch (erro) {
        if (erro?.codigo === 'ATENDIMENTO_INVALIDO' && typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`${authConfig.atendimento.cookieNome}=`)) {
          res.append('Set-Cookie', serializarRemocaoCookieAtendimento());
        }
        throw erro;
      }
    },
  };
}

const tokenCatalogoController = criarTokenCatalogoController({ pool });

module.exports = { criarTokenCatalogoController, tokenCatalogoController };
