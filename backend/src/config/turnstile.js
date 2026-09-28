'use strict';

const { z } = require('zod');
const { validarAmbiente, congelarProfundo } = require('./ambiente');
const { httpConfig } = require('./http');

/**
 * Cloudflare Turnstile do login do Portal do Cliente.
 *
 * A site key é pública; a secret só existe no backend. Em production as
 * duas são obrigatórias e nenhuma pode ser chave oficial de teste. Fora de
 * production, sem nenhuma das duas, uso as chaves de teste "sempre passa"
 * da Cloudflare; com elas o Siteverify só aceita o token fictício, então
 * esse modo nunca protege nada e existe só para o desenvolvimento local.
 *
 * Os hostnames aceitos saem das origens do cliente (CORS_ORIGIN), já
 * validadas em config/http.js: é nelas que a página de login é servida.
 */

const ACAO_PORTAL_LOGIN = 'portal_login';
const TIMEOUT_SITEVERIFY_MS = 5000;

// Chaves públicas de teste da documentação da Cloudflare.
const SITE_KEY_TESTE_SUCESSO = '1x00000000000000000000AA';
const SECRET_KEY_TESTE_SUCESSO = '1x0000000000000000000000000000000AA';
const FORMATO_CHAVE_TESTE = /^[0-9]x0{20,}[A-Z]{2}$/;
const FORMATO_CHAVE = /^[A-Za-z0-9_-]{8,255}$/;

const MENSAGENS = Object.freeze({
  OBRIGATORIA_PRODUCAO: 'obrigatória em production',
  CHAVE_TESTE_PRODUCAO: 'chave oficial de teste não é aceita em production',
  FORMATO: 'formato inválido',
  PAR_INCOMPLETO: 'defina as duas chaves do Turnstile, ou nenhuma fora de production',
  PAR_MISTO: 'as duas chaves precisam ser de teste, ou as duas reais',
});

const ehChaveDeTeste = (valor) => FORMATO_CHAVE_TESTE.test(valor);

function criarEsquema(producao) {
  const chave = z.string().refine((v) => FORMATO_CHAVE.test(v), MENSAGENS.FORMATO)
    .refine((v) => !(producao && ehChaveDeTeste(v)), MENSAGENS.CHAVE_TESTE_PRODUCAO);
  return z.object({
    TURNSTILE_PORTAL_SITE_KEY: chave.optional(),
    TURNSTILE_PORTAL_SECRET_KEY: chave.optional(),
  }).superRefine((e, ctx) => {
    const site = e.TURNSTILE_PORTAL_SITE_KEY;
    const secret = e.TURNSTILE_PORTAL_SECRET_KEY;
    const problema = (variavel, message) => ctx.addIssue({ code: 'custom', path: [variavel], message });
    if (producao) {
      if (site === undefined) problema('TURNSTILE_PORTAL_SITE_KEY', MENSAGENS.OBRIGATORIA_PRODUCAO);
      if (secret === undefined) problema('TURNSTILE_PORTAL_SECRET_KEY', MENSAGENS.OBRIGATORIA_PRODUCAO);
      return;
    }
    if (site === undefined && secret !== undefined) problema('TURNSTILE_PORTAL_SITE_KEY', MENSAGENS.PAR_INCOMPLETO);
    if (secret === undefined && site !== undefined) problema('TURNSTILE_PORTAL_SECRET_KEY', MENSAGENS.PAR_INCOMPLETO);
    if (site !== undefined && secret !== undefined && ehChaveDeTeste(site) !== ehChaveDeTeste(secret)) {
      problema('TURNSTILE_PORTAL_SECRET_KEY', MENSAGENS.PAR_MISTO);
    }
  });
}

const VARIAVEIS_CONHECIDAS = ['TURNSTILE_PORTAL_SITE_KEY', 'TURNSTILE_PORTAL_SECRET_KEY'];

function hostnamesDasOrigens(origens) {
  return [...new Set(origens.map((origem) => new URL(origem).hostname))];
}

function carregarConfigTurnstile(origem = process.env, { corsOrigens = httpConfig.cors.origens } = {}) {
  const producao = typeof origem.NODE_ENV === 'string' && origem.NODE_ENV.trim() === 'production';
  const e = validarAmbiente({
    esquema: criarEsquema(producao),
    origem,
    titulo: 'Configuração do Turnstile',
    conhecidas: VARIAVEIS_CONHECIDAS,
    mensagensPermitidas: Object.values(MENSAGENS),
  });
  const siteKey = e.TURNSTILE_PORTAL_SITE_KEY ?? SITE_KEY_TESTE_SUCESSO;
  const secretKey = e.TURNSTILE_PORTAL_SECRET_KEY ?? SECRET_KEY_TESTE_SUCESSO;

  const portal = {
    siteKey,
    acao: ACAO_PORTAL_LOGIN,
    hostnamesPermitidos: hostnamesDasOrigens(corsOrigens),
    modoTeste: ehChaveDeTeste(secretKey),
    timeoutMs: TIMEOUT_SITEVERIFY_MS,
  };
  // Não enumerável: a secret não sai em JSON.stringify nem em util.inspect.
  Object.defineProperty(portal, 'secretKey', { value: secretKey, enumerable: false });
  return congelarProfundo({ portal });
}

module.exports = {
  turnstileConfig: carregarConfigTurnstile(),
  carregarConfigTurnstile,
  ACAO_PORTAL_LOGIN,
};
