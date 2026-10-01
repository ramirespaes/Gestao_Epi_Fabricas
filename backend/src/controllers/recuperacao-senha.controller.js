'use strict';

const recuperacaoSenhaService = require('../services/recuperacao-senha.service');
const {
  serializarRemocaoCookieSessao,
  serializarRemocaoCookieSessaoGlobal,
  serializarRemocaoCookieSessaoPlataforma,
  serializarRemocaoCookieDesafioMfa,
} = require('../security/cookie');
const { pool } = require('../config/database');

/**
 * Controller da recuperação de senha. Rotas públicas: sem sessão e sem MFA.
 * O escopo é fixado na criação, nunca lido da requisição. Só traduz HTTP em
 * chamada de service; não cria sessão nem cookie novo.
 */

// As sessões do portal foram revogadas pelo service; os cookies delas ficaram obsoletos.
const REMOCOES_APOS_REDEFINICAO = Object.freeze({
  PORTAL: () => [serializarRemocaoCookieSessaoGlobal(), serializarRemocaoCookieSessao()],
  PLATAFORMA: () => [serializarRemocaoCookieSessaoPlataforma(), serializarRemocaoCookieDesafioMfa()],
});

function criarRecuperacaoSenhaController({ pool: poolInjetado, escopo } = {}) {
  if (!poolInjetado) {
    throw new TypeError('pool é obrigatório na recuperação de senha');
  }
  if (!Object.hasOwn(REMOCOES_APOS_REDEFINICAO, escopo)) {
    throw new TypeError('escopo desconhecido na recuperação de senha');
  }
  const remocoes = REMOCOES_APOS_REDEFINICAO[escopo];

  return {
    async solicitar(req, res) {
      const resposta = await recuperacaoSenhaService.solicitar(poolInjetado, {
        escopo, email: req.validado.body.email, ip: req.ip, dispositivo: req.headers['user-agent'],
      });
      res.status(202).json(resposta);
    },

    async redefinir(req, res) {
      const { token, novaSenha } = req.validado.body;
      const resposta = await recuperacaoSenhaService.redefinir(poolInjetado, {
        escopo, token, novaSenha, ip: req.ip, dispositivo: req.headers['user-agent'],
      });
      for (const remocao of remocoes()) {
        res.append('Set-Cookie', remocao);
      }
      res.status(200).json(resposta);
    },
  };
}

const recuperacaoSenhaPortalController = criarRecuperacaoSenhaController({ pool, escopo: 'PORTAL' });
const recuperacaoSenhaPlataformaController = criarRecuperacaoSenhaController({ pool, escopo: 'PLATAFORMA' });

module.exports = {
  criarRecuperacaoSenhaController,
  recuperacaoSenhaPortalController,
  recuperacaoSenhaPlataformaController,
};
