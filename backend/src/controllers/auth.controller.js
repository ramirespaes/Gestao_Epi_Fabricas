'use strict';

const loginService = require('../services/login.service');
const sessaoRepo = require('../repositories/sessao.repository');
const autenticacaoMiddleware = require('../middleware/autenticacao');
const { serializarCookieSessao, serializarRemocaoCookieSessao } = require('../security/cookie');
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
    /**
     * Devolve a identidade autenticada. Usa exclusivamente req.usuario e
     * req.empresa, já populados pelo middleware exigirSessao após validar
     * o cookie no PostgreSQL — nenhuma nova consulta é feita aqui, e nada
     * vindo de body/params/query influencia a resposta. req.sessao existe
     * mas nunca é incluído no corpo: o cliente não precisa do id interno
     * da sessão.
     */
    async me(req, res) {
      // identidadeId (Pacote 4) é contexto interno da sessão; o corpo
      // público de /auth/me permanece exatamente o de antes.
      const { identidadeId, ...usuario } = req.usuario;
      res.status(200).json({
        status: 'ok',
        usuario,
        empresa: req.empresa,
      });
    },

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

    /**
     * Encerra a sessão atual. Idempotente por natureza: cookie ausente,
     * duplicado, malformado, ou sessão já inexistente/expirada/revogada
     * não são erro — o objetivo do cliente (não ter mais um cookie
     * utilizável) é alcançado de qualquer forma. Não fica atrás do
     * middleware exigirSessao (que rejeitaria com 401 exatamente esses
     * casos): usa buscarContextoSessao diretamente, que só devolve null
     * para essas causas já conhecidas.
     *
     * empresaId e sessaoId usados em revogar() vêm exclusivamente do
     * contexto validado no PostgreSQL — nunca de body, query ou headers.
     *
     * Uma falha REAL (buscarContextoSessao ou revogar rejeitam, não
     * devolvem null/false) propaga sem tratamento: nem Set-Cookie nem
     * corpo de sucesso chegam a ser produzidos, e o errorHandler decide
     * o 500 — a resposta nunca afirma uma revogação que não aconteceu.
     * O retorno de revogar() (true/false) não é examinado: mesmo false
     * (a sessão deixou de estar ativa entre a consulta e a revogação) é
     * uma conclusão idempotente, não um erro.
     */
    async logout(req, res) {
      const contexto = await autenticacaoMiddleware.buscarContextoSessao(poolInjetado, req);

      if (contexto !== null) {
        await sessaoRepo.revogar(poolInjetado, contexto.empresa.id, contexto.sessao.id, 'LOGOUT');
      }

      res.append('Set-Cookie', serializarRemocaoCookieSessao());
      res.status(200).json({ status: 'ok' });
    },
  };
}

const authController = criarAuthController({ pool });

module.exports = { criarAuthController, authController };
