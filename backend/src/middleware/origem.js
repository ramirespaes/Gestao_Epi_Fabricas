'use strict';

const { HttpError } = require('../errors/HttpError');
const { httpConfig } = require('../config/http');

/**
 * Verificação de origem para requisições que alteram estado (proteção CSRF).
 *
 * CORS diz ao navegador o que ele pode ler cross-origin; esta camada rejeita
 * de fato requisições inseguras vindas de origem não confiável, necessária
 * porque a sessão usará cookie HttpOnly, que o navegador anexa sozinho.
 *
 * - Métodos seguros: GET, HEAD e OPTIONS. Todo o resto exige origem válida,
 *   inclusive métodos futuros ou não padrão, porque o critério é "não está
 *   na lista de seguros".
 * - Origin tem precedência absoluta: se estiver presente e não for
 *   exatamente uma origem da allowlist, a requisição é rejeitada sem
 *   consultar Referer (um Referer legítimo não neutraliza um Origin suspeito).
 * - Referer só é usado quando não há nenhuma ocorrência de Origin; vale
 *   apenas sua url.origin, e o valor precisa ser URL absoluta http/https sem
 *   credenciais.
 * - Ocorrências são contadas em req.rawHeaders (case-insensitive), porque o
 *   Node une Origin duplicado numa string e descarta Referer duplicado; um
 *   header enviado com valor vazio conta como presente e inválido.
 * - Allowlist: exclusivamente httpConfig.cors.origens, já validada e
 *   canonizada em config/http.js. Sem process.env, sem parser novo, sem
 *   curingas. Comparação por igualdade exata.
 * - As respostas 403 são fixas; Origin e Referer recebidos nunca vão para
 *   resposta, erro ou log.
 */

const METODOS_SEGUROS = new Set(['GET', 'HEAD', 'OPTIONS']);
const PROTOCOLOS_PERMITIDOS = new Set(['http:', 'https:']);

function cabecalhoUnico(req, nome) {
  const { rawHeaders } = req;
  let valor;
  let ocorrencias = 0;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (rawHeaders[i].toLowerCase() === nome) {
      ocorrencias += 1;
      valor = rawHeaders[i + 1];
    }
  }
  return { ocorrencias, valor };
}

function origemDoReferer(referer) {
  let url;
  try {
    url = new URL(referer);
  } catch {
    return null;
  }
  if (!PROTOCOLOS_PERMITIDOS.has(url.protocol) || url.username !== '' || url.password !== '') {
    return null;
  }
  return url.origin;
}

function criarVerificacaoOrigem({ origens }) {
  const permitidas = new Set(origens);

  return function verificarOrigemRequisicao(req, res, next) {
    if (METODOS_SEGUROS.has(req.method)) {
      next();
      return;
    }

    const naoPermitida = () => next(HttpError.forbidden('ORIGEM_NAO_PERMITIDA', 'Origem da requisição não permitida'));

    const origin = cabecalhoUnico(req, 'origin');
    if (origin.ocorrencias > 0) {
      if (origin.ocorrencias === 1 && permitidas.has(origin.valor)) {
        next();
        return;
      }
      naoPermitida();
      return;
    }

    const referer = cabecalhoUnico(req, 'referer');
    if (referer.ocorrencias === 0) {
      next(HttpError.forbidden('ORIGEM_AUSENTE', 'Origem da requisição não informada'));
      return;
    }
    if (referer.ocorrencias === 1 && permitidas.has(origemDoReferer(referer.valor))) {
      next();
      return;
    }
    naoPermitida();
  };
}

const verificarOrigem = criarVerificacaoOrigem({ origens: httpConfig.cors.origens });

// Verificação de origem do namespace /api/plataforma (Autenticação Global —
// Pacote 2): mesma fábrica, allowlist SEPARADA — um Origin válido para o
// cliente nunca é aceito aqui, e vice-versa.
const verificarOrigemPlataforma = criarVerificacaoOrigem({ origens: httpConfig.plataforma.corsOrigens });

module.exports = { criarVerificacaoOrigem, verificarOrigem, verificarOrigemPlataforma };
