'use strict';

const { rateLimit } = require('express-rate-limit');
const { HttpError } = require('../errors/HttpError');
const { httpConfig } = require('../config/http');

/**
 * Limite de requisições por IP.
 *
 * - Chave: padrão da biblioteca, que usa req.ip com ipKeyGenerator e agrupa
 *   IPv6 em /56, evitando que um prefixo amplo contorne o limite. Como req.ip
 *   depende de "trust proxy", a configuração de proxy do app decide o que é
 *   contado (ver app.js).
 * - Cabeçalhos: draft-8 (RateLimit e RateLimit-Policy), sem os legados
 *   X-RateLimit-*. O Retry-After do 429 é produzido pela própria biblioteca e
 *   reflete o tempo restante da janela, por isso o handler não o recalcula.
 * - O handler encaminha um HttpError ao errorHandler, para que a resposta
 *   siga o formato JSON da API em vez do texto padrão da biblioteca; 429 é
 *   provocável pelo cliente e não gera log.
 * - Nada é ignorado: GET, HEAD e demais métodos que chegam aqui contam, e não
 *   há skip por sucesso ou falha, porque o objetivo é limitar volume por IP.
 *
 * ESTE LIMITE É COMPLEMENTAR, não substituto, do cooldown persistente por
 * identidade previsto para o login (migration 015).
 *
 * MemoryStore: o contador vive na memória do processo, adequado para uma
 * única instância. Com múltiplas instâncias ou processos, cada um terá seu
 * contador e o limite efetivo será multiplicado; nesse cenário será preciso
 * um store compartilhado.
 */

function criarLimitador({ limite, janelaSegundos }) {
  return rateLimit({
    windowMs: janelaSegundos * 1000,
    limit: limite,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (req, res, next) => {
      next(HttpError.tooManyRequests('LIMITE_REQUISICOES_EXCEDIDO', 'Muitas requisições. Tente novamente mais tarde'));
    },
  });
}

const limitadorGeral = criarLimitador(httpConfig.rateLimit.geral);

// Exportado para o bloco de autenticação montar em /api/auth junto das rotas
// reais de login; não é montado enquanto essas rotas não existirem.
const limitadorAutenticacao = criarLimitador(httpConfig.rateLimit.autenticacao);

// Limitadores do namespace /api/plataforma (Autenticação Global — Pacote 2):
// instâncias PRÓPRIAS (contador em memória separado do cliente), reaproveitando
// os mesmos parâmetros de httpConfig.rateLimit — não há configuração dedicada
// para a plataforma nesta rodada (decisão de escopo registrada em
// login-plataforma.service.js); um cliente da API empresarial nunca consome a
// cota do Painel Privado, e vice-versa.
const limitadorPlataformaGeral = criarLimitador(httpConfig.rateLimit.geral);
const limitadorPlataformaAutenticacao = criarLimitador(httpConfig.rateLimit.autenticacao);
// Pacote 3 — rotas PÚBLICAS de aceite de convite do MASTER (sem sessão):
// instância própria, mesmos parâmetros do limite de autenticação. Camada
// complementar ao cooldown persistente por token (convite-master.service.js).
const limitadorPlataformaConvite = criarLimitador(httpConfig.rateLimit.autenticacao);

module.exports = {
  criarLimitador,
  limitadorGeral,
  limitadorAutenticacao,
  limitadorPlataformaGeral,
  limitadorPlataformaAutenticacao,
  limitadorPlataformaConvite,
};
