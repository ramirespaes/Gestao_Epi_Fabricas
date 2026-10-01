'use strict';

const net = require('node:net');

/**
 * Verificação server-side do token do Cloudflare Turnstile (Siteverify).
 *
 * Resultado interno mínimo:
 *   VALIDO       success true, action esperada e hostname permitido (no modo
 *                das chaves oficiais de teste, só success true);
 *   INVALIDO     o desafio não vale (token recusado, reusado, expirado,
 *                action ou hostname diferentes);
 *   INDISPONIVEL não deu para saber (timeout, rede, HTTP não-2xx, resposta
 *                fora do contrato, erro de configuração ou interno da
 *                Cloudflare).
 * Os dois últimos bloqueiam o login do mesmo jeito: falho fechado.
 *
 * O endereço é constante e o redirecionamento é recusado, para que nada
 * vindo de fora escolha para onde a secret é enviada.
 */

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TOKEN_TAMANHO_MAXIMO = 2048;
const RESPOSTA_TAMANHO_MAXIMO = 16 * 1024;
const TIMEOUT_MAXIMO_MS = 30000;
// Erros que indicam problema de configuração ou da Cloudflare, não do
// desafio. bad-request fica fora: um token estranho pode provocá-lo, e o que
// o cliente provoca não gera log.
const CODIGOS_INDISPONIBILIDADE = new Set(['missing-input-secret', 'invalid-input-secret', 'internal-error']);

const RESULTADO = Object.freeze({ VALIDO: 'VALIDO', INVALIDO: 'INVALIDO', INDISPONIVEL: 'INDISPONIVEL' });

const resultado = (valor) => ({ resultado: valor });

function registrarIndisponibilidade(motivo, extra) {
  console.warn('[turnstile] verificação indisponível', { motivo, ...extra });
}

async function lerJson(resposta) {
  const texto = await resposta.text();
  if (texto.length > RESPOSTA_TAMANHO_MAXIMO) return undefined;
  try {
    return JSON.parse(texto);
  } catch {
    return undefined;
  }
}

function criarValidadorTurnstile({ secretKey, acao, hostnamesPermitidos, modoTeste, timeoutMs, fetch }) {
  if (typeof secretKey !== 'string' || secretKey.length === 0) throw new TypeError('secret do Turnstile ausente');
  if (typeof acao !== 'string' || acao.length === 0) throw new TypeError('action do Turnstile ausente');
  if (typeof fetch !== 'function') throw new TypeError('fetch ausente');
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > TIMEOUT_MAXIMO_MS) throw new TypeError('timeout do Turnstile inválido');
  if (!Array.isArray(hostnamesPermitidos) || (!modoTeste && hostnamesPermitidos.length === 0)) {
    throw new TypeError('hostnames do Turnstile ausentes');
  }
  const hostnames = new Set(hostnamesPermitidos);

  async function chamarSiteverify(token, ip) {
    const corpo = new URLSearchParams({ secret: secretKey, response: token });
    if (typeof ip === 'string' && net.isIP(ip) !== 0) corpo.set('remoteip', ip);

    const controle = new AbortController();
    const relogio = setTimeout(() => controle.abort(), timeoutMs);
    try {
      const resposta = await fetch(SITEVERIFY_URL, {
        method: 'POST', body: corpo, redirect: 'error', signal: controle.signal,
      });
      if (!resposta.ok) return { falha: 'HTTP', status: resposta.status };
      return { dados: await lerJson(resposta) };
    } catch {
      return { falha: controle.signal.aborted ? 'TIMEOUT' : 'REDE' };
    } finally {
      clearTimeout(relogio);
    }
  }

  return {
    async verificar({ token, ip } = {}) {
      if (typeof token !== 'string' || token.length === 0 || token.length > TOKEN_TAMANHO_MAXIMO) {
        return resultado(RESULTADO.INVALIDO);
      }

      const { falha, status, dados } = await chamarSiteverify(token, ip);
      if (falha) {
        registrarIndisponibilidade(falha, status === undefined ? {} : { status });
        return resultado(RESULTADO.INDISPONIVEL);
      }
      if (dados === null || typeof dados !== 'object' || Array.isArray(dados) || typeof dados.success !== 'boolean') {
        registrarIndisponibilidade('RESPOSTA_MALFORMADA');
        return resultado(RESULTADO.INDISPONIVEL);
      }

      if (dados.success !== true) {
        const codigos = Array.isArray(dados['error-codes']) ? dados['error-codes'] : [];
        if (codigos.some((codigo) => CODIGOS_INDISPONIBILIDADE.has(codigo))) {
          registrarIndisponibilidade('CODIGO_DA_CLOUDFLARE');
          return resultado(RESULTADO.INDISPONIVEL);
        }
        return resultado(RESULTADO.INVALIDO);
      }

      // Chaves oficiais de teste: o Siteverify responde sem action e com
      // hostname fictício, então success basta. O modo vem só da configuração
      // (config/turnstile.js recusa chave de teste em production).
      if (modoTeste) return resultado(RESULTADO.VALIDO);

      if (typeof dados.action !== 'string' || typeof dados.hostname !== 'string') {
        registrarIndisponibilidade('RESPOSTA_MALFORMADA');
        return resultado(RESULTADO.INDISPONIVEL);
      }
      if (dados.action !== acao) return resultado(RESULTADO.INVALIDO);
      if (!hostnames.has(dados.hostname)) return resultado(RESULTADO.INVALIDO);
      return resultado(RESULTADO.VALIDO);
    },
  };
}

module.exports = { criarValidadorTurnstile, SITEVERIFY_URL, RESULTADO, TOKEN_TAMANHO_MAXIMO };
