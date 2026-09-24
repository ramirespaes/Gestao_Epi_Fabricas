'use strict';

const loginPlataformaService = require('../services/login-plataforma.service');
const sessaoPlataformaRepo = require('../repositories/sessao-plataforma.repository');
const autenticacaoPlataformaMiddleware = require('../middleware/autenticacao-plataforma');
const { serializarCookieSessaoPlataforma, serializarRemocaoCookieSessaoPlataforma } = require('../security/cookie');
const { pool } = require('../config/database');

/**
 * Controller de autenticação do Painel Privado da plataforma (Autenticação
 * Global — Pacote 2). Espelha `auth.controller.js` ponto a ponto, com as
 * mesmas garantias:
 *
 * - traduz o resultado do service em resposta HTTP, sem decidir regra de
 *   negócio nenhuma;
 * - sem try/catch: Express 5 encaminha a Promise rejeitada ao errorHandler;
 * - `loginPlataformaService`/`sessaoPlataformaRepo` chamados por namespace,
 *   nunca desestruturados, para permitir mock.method nos testes;
 * - o token em claro só existe no Set-Cookie (HttpOnly) — nunca no corpo
 *   JSON.
 *
 * DIFERENÇAS DELIBERADAS: usa os serializadores de cookie da PLATAFORMA
 * (`serializarCookieSessaoPlataforma`/`serializarRemocaoCookieSessaoPlataforma`,
 * nome de cookie diferente do empresarial) e popula/lê
 * `req.administradorPlataforma` (nunca `req.usuario`/`req.empresa`). O
 * corpo de sucesso do login não tem `empresa`: um administrador de
 * plataforma não pertence a nenhuma.
 */

function criarAuthPlataformaController({ pool: poolInjetado }) {
  return {
    /**
     * Devolve o administrador autenticado. Usa exclusivamente
     * req.administradorPlataforma, já populado pelo middleware
     * exigirSessaoPlataforma — nenhuma nova consulta é feita aqui.
     */
    async me(req, res) {
      res.status(200).json({
        status: 'ok',
        administrador: req.administradorPlataforma,
      });
    },

    async login(req, res) {
      const { email, senha } = req.validado.body;

      const resultado = await loginPlataformaService.autenticar(poolInjetado, {
        email,
        senha,
        ip: req.ip,
        dispositivo: req.headers['user-agent'],
      });

      res.append('Set-Cookie', serializarCookieSessaoPlataforma(resultado.token));
      res.status(200).json({
        status: 'ok',
        administrador: resultado.administrador,
      });
    },

    /**
     * Encerra a sessão de plataforma atual. Idempotente, mesma disciplina de
     * auth.controller.logout: cookie ausente/duplicado/malformado ou sessão
     * já inexistente/expirada/revogada não são erro. Usa
     * buscarContextoSessaoPlataforma diretamente, não o middleware estrito
     * (que produziria 401 exatamente nesses casos).
     */
    async logout(req, res) {
      const contexto = await autenticacaoPlataformaMiddleware.buscarContextoSessaoPlataforma(poolInjetado, req);

      if (contexto !== null) {
        await sessaoPlataformaRepo.revogar(poolInjetado, contexto.sessao.id, 'LOGOUT');
      }

      res.append('Set-Cookie', serializarRemocaoCookieSessaoPlataforma());
      res.status(200).json({ status: 'ok' });
    },
  };
}

const authPlataformaController = criarAuthPlataformaController({ pool });

module.exports = { criarAuthPlataformaController, authPlataformaController };
