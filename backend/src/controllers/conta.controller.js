'use strict';

const contaService = require('../services/conta.service');
const trocaEmailGlobalService = require('../services/troca-email-global.service');
const { extrairTokenDoCookie: cookieGlobal } = require('../middleware/autenticacao-global');
const { extrairTokenDoCookie: cookieEmpresarial } = require('../middleware/autenticacao');
const { pool } = require('../config/database');

/**
 * Controllers das Configurações (conta da identidade autenticada). Só
 * traduzem HTTP em chamada de service: quem age é a identidade que o
 * middleware de sessão global provou, nunca o corpo; os tokens saem dos
 * cookies da própria requisição. A leitura da conta continua em
 * GET /auth/global/me e GET /auth/me (estendidos).
 */

function tokenDoCookie(extrair, req) {
  const cookie = extrair(req);
  return cookie.presente && !cookie.ambiguo ? cookie.valor : null;
}

function criarContaController({ pool: poolInjetado } = {}) {
  if (!poolInjetado) {
    throw new TypeError('pool é obrigatório nas Configurações');
  }
  return {
    async atualizar(req, res) {
      const corpo = req.validado.body;
      const conta = await contaService.atualizar(poolInjetado, {
        identidadeId: req.identidade.id,
        telefone: corpo.telefone ?? null,
        telefoneInformado: Object.hasOwn(corpo, 'telefone'),
        tema: corpo.tema,
        modoVisual: corpo.modoVisual,
        ip: req.ip,
        dispositivo: req.headers['user-agent'],
      });
      res.status(200).json({ status: 'ok', conta });
    },

    async trocarEmail(req, res) {
      const { senhaAtual, novoEmail } = req.validado.body;
      const resultado = await trocaEmailGlobalService.trocar(poolInjetado, {
        identidadeId: req.identidade.id,
        sessaoGlobalId: req.sessaoGlobal.id,
        tokenSessaoGlobal: tokenDoCookie(cookieGlobal, req),
        tokenSessaoEmpresarial: tokenDoCookie(cookieEmpresarial, req),
        senhaAtual,
        novoEmail,
        ip: req.ip,
        dispositivo: req.headers['user-agent'],
      });
      res.status(200).json(resultado);
    },
  };
}

const contaController = criarContaController({ pool });

module.exports = { criarContaController, contaController };
