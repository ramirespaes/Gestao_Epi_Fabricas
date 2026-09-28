'use strict';

const cookie = require('cookie');
const { authConfig } = require('../config/auth');
const { tokenSessaoTemFormatoValido } = require('./token');

/**
 * Política do cookie de sessão. Helper puro: não cria sessão, não gera nem
 * persiste token, não toca em req/res e não loga.
 *
 * Atributos da emissão:
 * - HttpOnly sempre: o token nunca é legível por script;
 * - Secure e SameSite conforme authConfig.sessao, que já resolve Secure por
 *   ambiente e já rejeita SameSite=None sem Secure na subida do processo;
 * - Path=/ e ausência de Domain: cookie host-only da API, com política única;
 * - Max-Age em segundos, derivado de expiracaoMinutos. Sem Expires, porque
 *   Max-Age tem precedência e não depende do relógio do cliente; sem Priority
 *   e sem Partitioned, que não trazem benefício para esta API.
 *
 * A remoção repete exatamente os atributos estruturais (nome, Path, Secure,
 * SameSite, HttpOnly e ausência de Domain), porque qualquer divergência faria
 * o navegador criar um segundo cookie em vez de substituir o existente. Ali o
 * Expires no passado acompanha o Max-Age=0 como redundância de compatibilidade.
 *
 * A validade do token é decidida por tokenSessaoTemFormatoValido (token.js),
 * única fonte do formato canônico. Erros são TypeError de mensagem fixa e
 * nunca incluem o valor recebido.
 */

const SEGUNDOS_POR_MINUTO = 60;
const EXPIRACAO_NO_PASSADO = new Date(0);
const MENSAGEM_TOKEN_INVALIDO = 'token de sessão inválido';

// path só muda para o cookie do desafio MFA; os cookies de sessão seguem com Path=/.
function criarPoliticaCookie({ nome, secure, sameSite, expiracaoMinutos, path = '/' }) {
  const atributosEstruturais = { httpOnly: true, secure, sameSite, path };

  return {
    serializarSessao(token) {
      if (!tokenSessaoTemFormatoValido(token)) {
        throw new TypeError(MENSAGEM_TOKEN_INVALIDO);
      }
      return cookie.serialize(nome, token, {
        ...atributosEstruturais,
        maxAge: expiracaoMinutos * SEGUNDOS_POR_MINUTO,
      });
    },

    serializarRemocao() {
      return cookie.serialize(nome, '', {
        ...atributosEstruturais,
        maxAge: 0,
        expires: EXPIRACAO_NO_PASSADO,
      });
    },
  };
}

const politicaSessao = criarPoliticaCookie({
  nome: authConfig.sessao.cookieNome,
  secure: authConfig.sessao.cookieSecure,
  sameSite: authConfig.sessao.cookieSameSite,
  expiracaoMinutos: authConfig.sessao.expiracaoMinutos,
});

const serializarCookieSessao = (token) => politicaSessao.serializarSessao(token);
const serializarRemocaoCookieSessao = () => politicaSessao.serializarRemocao();

/**
 * Cookie do Painel Privado da plataforma (Autenticação Global — Pacote 2).
 * Mesma fábrica, mesmos atributos estruturais (HttpOnly, Path=/, sem
 * Domain) e a MESMA política de Secure/SameSite/expiração do cookie
 * empresarial — reaproveitando a arquitetura já aprovada, como o adendo
 * v2.1 orienta. Só o NOME muda (authConfig.sessao.cookieNomeAdmin,
 * validado como distinto de cookieNome na subida do processo,
 * src/config/auth.js) — é essa diferença de nome, por si só, que garante
 * que este cookie nunca é o mesmo que o middleware empresarial procura, e
 * vice-versa.
 */
// Max-Age acompanha a expiração própria da sessão plena do Painel, que só
// nasce depois do segundo fator.
const politicaSessaoPlataforma = criarPoliticaCookie({
  nome: authConfig.sessao.cookieNomeAdmin,
  secure: authConfig.sessao.cookieSecure,
  sameSite: authConfig.sessao.cookieSameSite,
  expiracaoMinutos: authConfig.sessao.expiracaoMinutosAdmin,
});

const serializarCookieSessaoPlataforma = (token) => politicaSessaoPlataforma.serializarSessao(token);
const serializarRemocaoCookieSessaoPlataforma = () => politicaSessaoPlataforma.serializarRemocao();

/**
 * Cookie da sessão GLOBAL da identidade (Autenticação Global — Pacote 4,
 * sessoes_globais/035). Mesma fábrica, mesmos atributos estruturais e a
 * mesma política de Secure/SameSite/expiração; só o NOME muda
 * (authConfig.sessao.cookieNomeGlobal, validado como distinto dos outros
 * dois na subida). Emitido pelo login global do Portal do Cliente; lido
 * exclusivamente por middleware/autenticacao-global.js. Nunca autentica
 * uma rota empresarial (exigirSessao só olha cookieNome) nem uma rota do
 * Painel Privado (exigirSessaoPlataforma só olha cookieNomeAdmin).
 */
const politicaSessaoGlobal = criarPoliticaCookie({
  nome: authConfig.sessao.cookieNomeGlobal,
  secure: authConfig.sessao.cookieSecure,
  sameSite: authConfig.sessao.cookieSameSite,
  expiracaoMinutos: authConfig.sessao.expiracaoMinutos,
});

const serializarCookieSessaoGlobal = (token) => politicaSessaoGlobal.serializarSessao(token);
const serializarRemocaoCookieSessaoGlobal = () => politicaSessaoGlobal.serializarRemocao();

/**
 * Cookie do desafio pré-MFA do Painel Privado. Não é sessão: nome próprio
 * (authConfig.desafioMfa.cookieNome, distinto dos três de sessão),
 * SameSite=Strict fixo e Path restrito às rotas de autenticação, que é onde
 * ficam o estado do MFA e o logout. Secure segue a mesma regra de ambiente
 * dos cookies de sessão (obrigatório em production). Max-Age é o prazo do
 * desafio emitido, que varia por etapa.
 */
const CAMINHO_COOKIE_DESAFIO_MFA = '/api/plataforma/auth';

function politicaDesafioMfa(expiracaoMinutos) {
  return criarPoliticaCookie({
    nome: authConfig.desafioMfa.cookieNome,
    secure: authConfig.sessao.cookieSecure,
    sameSite: 'strict',
    expiracaoMinutos,
    path: CAMINHO_COOKIE_DESAFIO_MFA,
  });
}

function serializarCookieDesafioMfa(token, validadeMinutos) {
  if (!Number.isInteger(validadeMinutos) || validadeMinutos < 1) {
    throw new TypeError('prazo do desafio inválido');
  }
  return politicaDesafioMfa(validadeMinutos).serializarSessao(token);
}

// A remoção não depende do prazo: Max-Age=0 e Expires no passado.
const serializarRemocaoCookieDesafioMfa = () => politicaDesafioMfa(1).serializarRemocao();

module.exports = {
  criarPoliticaCookie,
  serializarCookieSessao,
  serializarRemocaoCookieSessao,
  serializarCookieSessaoPlataforma,
  serializarRemocaoCookieSessaoPlataforma,
  serializarCookieSessaoGlobal,
  serializarRemocaoCookieSessaoGlobal,
  CAMINHO_COOKIE_DESAFIO_MFA,
  serializarCookieDesafioMfa,
  serializarRemocaoCookieDesafioMfa,
};
