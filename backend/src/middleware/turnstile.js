'use strict';

const { HttpError } = require('../errors/HttpError');
const { criarValidadorTurnstile, RESULTADO } = require('../security/turnstile');
const { turnstileConfig } = require('../config/turnstile');

/**
 * Exige um token do Turnstile válido antes do controller. Fica depois do
 * limitador e da validação do corpo: o Siteverify só é chamado para um corpo
 * bem formado, e um desafio inválido nunca chega ao login (cooldown, Argon2,
 * sessão).
 */

const MENSAGEM_INVALIDA = 'Verificação de segurança inválida. Aguarde uma nova verificação e tente novamente';
const MENSAGEM_INDISPONIVEL = 'Verificação de segurança temporariamente indisponível. Tente novamente em instantes';

function criarExigirTurnstile({ validador }) {
  if (!validador || typeof validador.verificar !== 'function') {
    throw new TypeError('validador do Turnstile ausente');
  }
  return async function exigirTurnstile(req, res, next) {
    const token = req.validado && req.validado.body ? req.validado.body.turnstileToken : undefined;
    const { resultado } = await validador.verificar({ token, ip: req.ip });
    if (resultado === RESULTADO.VALIDO) {
      next();
      return;
    }
    if (resultado === RESULTADO.INDISPONIVEL) {
      next(new HttpError(503, 'VERIFICACAO_SEGURANCA_INDISPONIVEL', MENSAGEM_INDISPONIVEL));
      return;
    }
    next(HttpError.forbidden('VERIFICACAO_SEGURANCA_INVALIDA', MENSAGEM_INVALIDA));
  };
}

const exigirTurnstilePortal = criarExigirTurnstile({
  validador: criarValidadorTurnstile({
    secretKey: turnstileConfig.portal.secretKey,
    acao: turnstileConfig.portal.acao,
    hostnamesPermitidos: turnstileConfig.portal.hostnamesPermitidos,
    modoTeste: turnstileConfig.portal.modoTeste,
    timeoutMs: turnstileConfig.portal.timeoutMs,
    fetch: (...args) => globalThis.fetch(...args),
  }),
});

module.exports = { criarExigirTurnstile, exigirTurnstilePortal };
