'use strict';

const loginService = require('../services/login.service');
const { serializarCookieSessao } = require('../security/cookie');
const { pool } = require('../config/database');

/**
 * Controller de autenticação (Bloco 8, Incremento 6).
 *
 * Traduz o resultado de login.service.autenticar em resposta HTTP. Não
 * decide regra de negócio nenhuma: não sabe o que é cooldown, Argon2id,
 * advisory lock ou isolamento multiempresa — isso já está resolvido no
 * serviço. Não usa try/catch: Express 5 encaminha automaticamente a Promise
 * rejeitada de um handler async para o errorHandler, que já trata HttpError
 * e erros genéricos com segurança (sem stack, sem SQL, sem dado sensível).
 *
 * `loginService.autenticar(...)` é chamado por namespace, não desestruturado
 * — mesma razão documentada em login.service.js: permite mock.method nos
 * testes sem alterar o comportamento em produção.
 *
 * O pool chega por parâmetro da fábrica, nunca importado por um repository
 * ou service (decisão arquitetural do Bloco 8): este controller é o ponto
 * da aplicação onde o pool real de config/database.js é lido pela primeira
 * vez e entregue ao serviço a cada requisição.
 *
 * RESPOSTA: o token em claro só existe no Set-Cookie (HttpOnly), nunca no
 * corpo JSON. O corpo de sucesso contém somente { status, usuario, empresa }
 * — nem token, nem sessao.id, nem sessao.expiraEm: o Max-Age do próprio
 * cookie já comunica a validade ao navegador.
 */

function criarAuthController({ pool: poolInjetado }) {
  return {
    async login(req, res) {
      const { cnpj, email, senha } = req.validado.body;

      const resultado = await loginService.autenticar(poolInjetado, {
        cnpj,
        email,
        senha,
        ip: req.ip,
        dispositivo: req.headers['user-agent'],
      });

      res.append('Set-Cookie', serializarCookieSessao(resultado.token));
      res.status(200).json({
        status: 'ok',
        usuario: resultado.usuario,
        empresa: resultado.empresa,
      });
    },
  };
}

const authController = criarAuthController({ pool });

module.exports = { criarAuthController, authController };
