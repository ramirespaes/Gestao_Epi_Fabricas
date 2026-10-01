'use strict';

const { turnstileConfig } = require('../config/turnstile');

/**
 * Configuração pública do widget do Turnstile no login do Portal: só a site
 * key e a action. Sem sessão e sem banco; a secret nunca passa por aqui.
 */

function criarTurnstileController({ siteKey, acao }) {
  if (typeof siteKey !== 'string' || siteKey.length === 0 || typeof acao !== 'string' || acao.length === 0) {
    throw new TypeError('configuração pública do Turnstile inválida');
  }
  const corpo = Object.freeze({ status: 'ok', siteKey, action: acao });
  return {
    configuracao(req, res) {
      res.status(200).json(corpo);
    },
  };
}

const turnstileController = criarTurnstileController({
  siteKey: turnstileConfig.portal.siteKey,
  acao: turnstileConfig.portal.acao,
});

const turnstileRecuperacaoSenhaController = criarTurnstileController({
  siteKey: turnstileConfig.portal.siteKey,
  acao: turnstileConfig.portal.acaoRecuperacaoSenha,
});

module.exports = { criarTurnstileController, turnstileController, turnstileRecuperacaoSenhaController };
