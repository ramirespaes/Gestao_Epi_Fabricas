'use strict';

const loginPlataformaService = require('../services/login-plataforma.service');
const desafioMfaService = require('../services/desafio-mfa-plataforma.service');
const mfaCadastroService = require('../services/mfa-cadastro-plataforma.service');
const sessaoPlataformaRepo = require('../repositories/sessao-plataforma.repository');
const autenticacaoPlataformaMiddleware = require('../middleware/autenticacao-plataforma');
const { tokenDoDesafioNaRequisicao } = require('../middleware/desafio-mfa-plataforma');
const {
  serializarCookieSessaoPlataforma,
  serializarRemocaoCookieSessaoPlataforma,
  serializarCookieDesafioMfa,
  serializarRemocaoCookieDesafioMfa,
} = require('../security/cookie');
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
 * (nome de cookie diferente do empresarial) e lê
 * `req.administradorPlataforma` (nunca `req.usuario`/`req.empresa`).
 *
 * O login por senha não emite sessão: emite só o cookie do desafio pré-MFA
 * e responde a etapa e o prazo, sem administrador, e-mail ou token no corpo.
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

      res.append('Set-Cookie', serializarCookieDesafioMfa(resultado.token, resultado.desafio.validadeMinutos));
      res.status(200).json({
        status: 'ok',
        etapa: resultado.desafio.etapa,
        expiraEm: resultado.desafio.expiraEm,
      });
    },

    /** Só atrás de exigirDesafioMfa: devolve a etapa e o prazo, nada mais. */
    async estadoMfa(req, res) {
      res.status(200).json({
        status: 'ok',
        etapa: req.desafioMfaPlataforma.tipo,
        expiraEm: req.desafioMfaPlataforma.expiraEm,
      });
    },

    /**
     * LIBERACAO -> CADASTRO. O desafio muda de token: o cookie é trocado.
     * URI e chave manual existem só nesta resposta (e no reinício).
     */
    async mfaLiberacao(req, res) {
      const resultado = await mfaCadastroService.confirmarLiberacao(poolInjetado, {
        desafioId: req.desafioMfaPlataforma.id,
        administradorId: req.desafioMfaPlataforma.administradorId,
        codigoLiberacao: req.validado.body.codigoLiberacao,
        ip: req.ip,
        dispositivo: req.headers['user-agent'],
      });

      res.append('Set-Cookie', serializarCookieDesafioMfa(resultado.token, resultado.desafio.validadeMinutos));
      res.status(200).json({
        status: 'ok',
        etapa: resultado.desafio.etapa,
        expiraEm: resultado.desafio.expiraEm,
        cadastro: resultado.cadastro,
      });
    },

    /** Mesmo desafio, secret novo: o cookie não muda. */
    async mfaCadastroReiniciar(req, res) {
      const resultado = await mfaCadastroService.reiniciarCadastro(poolInjetado, {
        desafioId: req.desafioMfaPlataforma.id,
        administradorId: req.desafioMfaPlataforma.administradorId,
        ip: req.ip,
        dispositivo: req.headers['user-agent'],
      });

      res.status(200).json({
        status: 'ok',
        etapa: resultado.desafio.etapa,
        expiraEm: resultado.desafio.expiraEm,
        cadastro: resultado.cadastro,
      });
    },

    /**
     * Primeiro TOTP: a sessão plena nasce aqui, com token novo. Emite o
     * cookie de sessão, remove o do desafio e devolve os recovery codes, que
     * não voltam a ser exibidos.
     */
    async mfaCadastroConfirmar(req, res) {
      const sessaoAnterior = autenticacaoPlataformaMiddleware.extrairTokenDoCookie(req);
      const resultado = await mfaCadastroService.confirmarCadastro(poolInjetado, {
        desafioId: req.desafioMfaPlataforma.id,
        administradorId: req.desafioMfaPlataforma.administradorId,
        codigo: req.validado.body.codigo,
        tokenSessaoAnterior: sessaoAnterior.presente && !sessaoAnterior.ambiguo ? sessaoAnterior.valor : null,
        ip: req.ip,
        dispositivo: req.headers['user-agent'],
      });

      res.append('Set-Cookie', serializarCookieSessaoPlataforma(resultado.token));
      res.append('Set-Cookie', serializarRemocaoCookieDesafioMfa());
      res.status(200).json({ status: 'ok', codigosRecuperacao: resultado.codigosRecuperacao });
    },

    /**
     * Encerra o que houver: a sessão de plataforma (revogada com LOGOUT) e o
     * desafio pré-MFA (encerrado com LOGOUT), cada um pelo próprio cookie e
     * independentemente do outro. Idempotente, mesma disciplina de
     * auth.controller.logout: cookie ausente/duplicado/malformado, sessão ou
     * desafio já inexistente/vencido/encerrado não são erro. Remove sempre
     * os dois cookies.
     */
    async logout(req, res) {
      const contexto = await autenticacaoPlataformaMiddleware.buscarContextoSessaoPlataforma(poolInjetado, req);
      if (contexto !== null) {
        await sessaoPlataformaRepo.revogar(poolInjetado, contexto.sessao.id, 'LOGOUT');
      }

      const tokenDesafio = tokenDoDesafioNaRequisicao(req);
      if (tokenDesafio !== null) {
        await desafioMfaService.encerrarDesafioPorToken(poolInjetado, tokenDesafio);
      }

      res.append('Set-Cookie', serializarRemocaoCookieSessaoPlataforma());
      res.append('Set-Cookie', serializarRemocaoCookieDesafioMfa());
      res.status(200).json({ status: 'ok' });
    },
  };
}

const authPlataformaController = criarAuthPlataformaController({ pool });

module.exports = { criarAuthPlataformaController, authPlataformaController };
