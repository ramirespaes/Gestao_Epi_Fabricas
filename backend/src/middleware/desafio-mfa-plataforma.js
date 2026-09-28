'use strict';

const cookie = require('cookie');
const { HttpError } = require('../errors/HttpError');
const { authConfig } = require('../config/auth');
const { tokenSessaoTemFormatoValido, hashTokenSessao } = require('../security/token');
const { serializarRemocaoCookieDesafioMfa } = require('../security/cookie');
const desafioRepo = require('../repositories/desafio-mfa-plataforma.repository');

/**
 * Middleware do desafio pré-MFA do Painel Privado. É deny-by-default: só
 * autentica as rotas que o montarem explicitamente, e cada rota declara os
 * tipos de desafio que aceita. Lê SÓ o cookie do desafio
 * (authConfig.desafioMfa.cookieNome); exigirSessaoPlataforma, por sua vez,
 * só lê o cookie de sessão. Um nunca vale no lugar do outro.
 *
 * Em sucesso preenche req.desafioMfaPlataforma e nada mais: nunca
 * req.administradorPlataforma nem req.sessaoPlataforma, para que nenhuma
 * rota administrativa possa tratar o desafio como sessão.
 *
 * Toda recusa é o mesmo 401 DESAFIO_INVALIDO. Se o cookie veio e não vale
 * (malformado, duplicado, inexistente, vencido, encerrado ou de
 * administrador inativo), a resposta também o remove. Tipo que a rota não
 * aceita não remove: o desafio continua válido para a etapa dele.
 */

const TIPOS_DESAFIO_MFA = Object.freeze(['LIBERACAO', 'CADASTRO', 'VERIFICACAO', 'RECUPERACAO', 'SUBSTITUICAO']);
const MENSAGEM_DESAFIO_INVALIDO = 'Etapa de verificação inválida ou expirada';

function contarOcorrenciasDoCookie(cabecalho, nome) {
  if (typeof cabecalho !== 'string' || cabecalho.length === 0) {
    return 0;
  }
  const prefixo = `${nome}=`;
  return cabecalho.split(';').map((parte) => parte.trim()).filter((parte) => parte.startsWith(prefixo)).length;
}

/** { presente, token }: token só quando há exatamente um cookie do desafio, em formato canônico. */
function lerCookieDoDesafio(req) {
  const cabecalho = req.headers.cookie;
  const nome = authConfig.desafioMfa.cookieNome;
  const ocorrencias = contarOcorrenciasDoCookie(cabecalho, nome);
  if (ocorrencias === 0) {
    return { presente: false, token: null };
  }
  if (ocorrencias > 1) {
    return { presente: true, token: null };
  }
  const valor = cookie.parse(cabecalho)[nome];
  return { presente: true, token: tokenSessaoTemFormatoValido(valor) ? valor : null };
}

/** Token do desafio da requisição, ou null. Usado pelo logout. */
function tokenDoDesafioNaRequisicao(req) {
  return lerCookieDoDesafio(req).token;
}

function criarExigirDesafioMfa({ pool, tipos }) {
  if (!Array.isArray(tipos) || tipos.length === 0 || !tipos.every((t) => TIPOS_DESAFIO_MFA.includes(t))) {
    throw new TypeError('a rota precisa declarar os tipos de desafio aceitos');
  }
  const aceitos = new Set(tipos);

  return async function exigirDesafioMfa(req, res, next) {
    const lido = lerCookieDoDesafio(req);
    const desafio = lido.token === null ? null : await desafioRepo.buscarValidoPorHash(pool, hashTokenSessao(lido.token));

    if (desafio === null) {
      if (lido.presente) {
        res.append('Set-Cookie', serializarRemocaoCookieDesafioMfa());
      }
      next(HttpError.unauthorized('DESAFIO_INVALIDO', MENSAGEM_DESAFIO_INVALIDO));
      return;
    }
    if (!aceitos.has(desafio.tipo)) {
      next(HttpError.unauthorized('DESAFIO_INVALIDO', MENSAGEM_DESAFIO_INVALIDO));
      return;
    }

    req.desafioMfaPlataforma = {
      id: desafio.id,
      administradorId: desafio.administradorId,
      tipo: desafio.tipo,
      expiraEm: desafio.expiraEm,
    };
    next();
  };
}

module.exports = { criarExigirDesafioMfa, tokenDoDesafioNaRequisicao, TIPOS_DESAFIO_MFA };
