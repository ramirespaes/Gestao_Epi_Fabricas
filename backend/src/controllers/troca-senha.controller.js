'use strict';

const trocaSenhaGlobalService = require('../services/troca-senha-global.service');
const trocaSenhaPlataformaService = require('../services/troca-senha-plataforma.service');
const { extrairTokenDoCookie: cookieGlobal } = require('../middleware/autenticacao-global');
const { extrairTokenDoCookie: cookieEmpresarial } = require('../middleware/autenticacao');
const { extrairTokenDoCookie: cookiePlataforma } = require('../middleware/autenticacao-plataforma');
const { pool } = require('../config/database');

/**
 * Controllers da troca de senha autenticada. Só traduzem HTTP em chamada de
 * service: quem age vem do que o middleware de sessão já provou, nunca do
 * corpo, e os tokens saem dos cookies da própria requisição. A sessão atual
 * continua como está, então não há cookie na resposta e nenhuma sessão nasce.
 */

const RESPOSTA = Object.freeze({ status: 'SENHA_ALTERADA' });

/** Cookie ausente ou repetido vira null; o valor presente segue como veio, quem decide é o service. */
function tokenDoCookie(extrair, req) {
  const cookie = extrair(req);
  return cookie.presente && !cookie.ambiguo ? cookie.valor : null;
}

function criarTrocaSenhaGlobalController({ pool: poolInjetado } = {}) {
  if (!poolInjetado) {
    throw new TypeError('pool é obrigatório na troca de senha');
  }
  return {
    async trocar(req, res) {
      const { senhaAtual, novaSenha } = req.validado.body;
      await trocaSenhaGlobalService.trocar(poolInjetado, {
        identidadeId: req.identidade.id,
        sessaoGlobalId: req.sessaoGlobal.id,
        tokenSessaoGlobal: tokenDoCookie(cookieGlobal, req),
        tokenSessaoEmpresarial: tokenDoCookie(cookieEmpresarial, req),
        senhaAtual,
        novaSenha,
        ip: req.ip,
        dispositivo: req.headers['user-agent'],
      });
      res.status(200).json(RESPOSTA);
    },
  };
}

function criarTrocaSenhaPlataformaController({ pool: poolInjetado } = {}) {
  if (!poolInjetado) {
    throw new TypeError('pool é obrigatório na troca de senha');
  }
  return {
    async trocar(req, res) {
      const { senhaAtual, novaSenha, codigo } = req.validado.body;
      await trocaSenhaPlataformaService.trocar(poolInjetado, {
        administradorId: req.administradorPlataforma.id,
        sessaoId: req.sessaoPlataforma.id,
        tokenSessao: tokenDoCookie(cookiePlataforma, req),
        senhaAtual,
        novaSenha,
        codigo,
        ip: req.ip,
        dispositivo: req.headers['user-agent'],
      });
      res.status(200).json(RESPOSTA);
    },
  };
}

const trocaSenhaGlobalController = criarTrocaSenhaGlobalController({ pool });
const trocaSenhaPlataformaController = criarTrocaSenhaPlataformaController({ pool });

module.exports = {
  criarTrocaSenhaGlobalController,
  criarTrocaSenhaPlataformaController,
  trocaSenhaGlobalController,
  trocaSenhaPlataformaController,
};
