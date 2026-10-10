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

function criarLimitador({ limite, janelaSegundos, chave }) {
  return rateLimit({
    windowMs: janelaSegundos * 1000,
    limit: limite,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    // `chave` (opcional) substitui o IP como identidade do contador; sem ela, o comportamento é o de sempre.
    ...(typeof chave === 'function' ? { keyGenerator: chave } : {}),
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
// Parte F — rotas PÚBLICAS de aceite de convite de usuário, no namespace do
// cliente: instância própria, mesmos parâmetros do limite de autenticação.
// Complementa o cooldown persistente por token (convite-usuario.service.js).
const limitadorConviteUsuario = criarLimitador(httpConfig.rateLimit.autenticacao);
// Envio de convites (criar e reenviar), um contador por portal e compartilhado
// pelas duas operações, para cancelar e criar de novo não escapar do limite.
// Complementa o teto persistente por (empresa, e-mail) dos services.
const limitadorEnvioConviteUsuario = criarLimitador(httpConfig.rateLimit.autenticacao);
const limitadorPlataformaEnvioConvite = criarLimitador(httpConfig.rateLimit.autenticacao);
// POST das rotas de MFA do Painel Privado: instância própria, mesmos
// parâmetros do limite de autenticação. Complementa o limite de falhas por
// desafio e o cooldown persistente de MFA por administrador.
const limitadorPlataformaMfa = criarLimitador(httpConfig.rateLimit.autenticacao);
// Recuperação de senha: um contador por operação e por portal, para que
// esgotar uma não bloqueie a outra nem o login. Complementa o limite
// persistente por e-mail do service.
const limitadorRecuperacaoSenhaSolicitar = criarLimitador(httpConfig.rateLimit.autenticacao);
const limitadorRecuperacaoSenhaRedefinir = criarLimitador(httpConfig.rateLimit.autenticacao);
const limitadorPlataformaRecuperacaoSenhaSolicitar = criarLimitador(httpConfig.rateLimit.autenticacao);
const limitadorPlataformaRecuperacaoSenhaRedefinir = criarLimitador(httpConfig.rateLimit.autenticacao);
// Troca de senha autenticada: um contador por portal, independente do login e
// da recuperação. Complementa o cooldown persistente do service.
const limitadorTrocaSenha = criarLimitador(httpConfig.rateLimit.autenticacao);
// Configurações: a troca do e-mail de acesso confere a senha atual — mesmo orçamento da autenticação.
const limitadorTrocaEmail = criarLimitador(httpConfig.rateLimit.autenticacao);
const limitadorPlataformaTrocaSenha = criarLimitador(httpConfig.rateLimit.autenticacao);

// Revelação do CPF na edição de funcionários: 10 por minuto por USUÁRIO + EMPRESA da sessão (nunca só por IP: a empresa
// inteira pode estar atrás do mesmo NAT). Roda depois da sessão e da autorização, então só conta quem já pode revelar.
// Cada app/rota que precisar de contador próprio cria a sua instância; as rotas reais compartilham `limitadorRevelacaoCpf`.
const LIMITE_REVELACAO_CPF = Object.freeze({ limite: 10, janelaSegundos: 60 });
const chaveRevelacaoCpf = (req) => `${req.empresa?.id}:${req.usuario?.id}`;
const criarLimitadorRevelacaoCpf = () => criarLimitador({ ...LIMITE_REVELACAO_CPF, chave: chaveRevelacaoCpf });
const limitadorRevelacaoCpf = criarLimitadorRevelacaoCpf();

module.exports = {
  criarLimitador,
  limitadorGeral,
  limitadorAutenticacao,
  limitadorPlataformaGeral,
  limitadorPlataformaAutenticacao,
  limitadorPlataformaConvite,
  limitadorConviteUsuario,
  limitadorEnvioConviteUsuario,
  limitadorPlataformaEnvioConvite,
  limitadorPlataformaMfa,
  limitadorRecuperacaoSenhaSolicitar,
  limitadorRecuperacaoSenhaRedefinir,
  limitadorPlataformaRecuperacaoSenhaSolicitar,
  limitadorPlataformaRecuperacaoSenhaRedefinir,
  limitadorTrocaSenha,
  limitadorTrocaEmail,
  limitadorPlataformaTrocaSenha,
  LIMITE_REVELACAO_CPF,
  criarLimitadorRevelacaoCpf,
  limitadorRevelacaoCpf,
};
