(function (global) {
  'use strict';

  /**
   * Resolução do endereço da API do Painel Privado (correção final do
   * Pacote 2 — Autenticação Global, item 5 da auditoria independente:
   * "remover a dependência fixa de localhost como endereço da API em
   * produção").
   *
   * DESENVOLVIMENTO: preservado exatamente como estava —
   * http://localhost:3000/api/plataforma, quando esta página é aberta a
   * partir de localhost/127.0.0.1/[::1].
   *
   * PRODUÇÃO: em vez de um domínio hardcoded (que ainda não existe — ver
   * adendo v2.1, "admin.<domínio>" é decisão futura), assume que a API
   * responde na MESMA origem que serve esta própria página, sob
   * /api/plataforma. É o padrão mais comum de publicação (frontend e
   * backend atrás do mesmo domínio/reverse proxy) e não exige nenhuma
   * mudança de código quando o domínio real for definido: basta publicar
   * esta pasta e a API sob o mesmo host.
   *
   * SEPARAÇÃO DE ORIGENS PRESERVADA: este arquivo é exclusivo de
   * frontend/painel-privado/ — não altera nem é lido por
   * frontend/js/api-http.js nem por nenhuma página do cliente
   * (frontend/pages/*.html), que continuam com sua própria configuração.
   * O Painel Privado sempre fala com a origem QUE O SERVE, nunca com a do
   * cliente, e vice-versa — mesma disciplina de CORS/Origin já aplicada no
   * backend (httpConfig.plataforma.corsOrigens, allowlist separada).
   *
   * `resolverApiBaseUrl` recebe `location` por parâmetro (em vez de ler
   * `window.location` diretamente) para ser testável em Node, sem
   * navegador — mesmo padrão de injeção de dependência de
   * js/api-http.js (`fetch` injetável).
   */

  var DESENVOLVIMENTO_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
  var API_BASE_DESENVOLVIMENTO = 'http://localhost:3000/api/plataforma';
  var PREFIXO_API_PLATAFORMA = '/api/plataforma';

  function resolverApiBaseUrl(location) {
    if (!location || typeof location.hostname !== 'string' || typeof location.origin !== 'string') {
      throw new TypeError('location inválido');
    }
    if (DESENVOLVIMENTO_HOSTS.indexOf(location.hostname) !== -1) {
      return API_BASE_DESENVOLVIMENTO;
    }
    return location.origin + PREFIXO_API_PLATAFORMA;
  }

  global.SafeworkPlataformaConfig = {
    resolverApiBaseUrl: resolverApiBaseUrl,
    DESENVOLVIMENTO_HOSTS: DESENVOLVIMENTO_HOSTS.slice(),
    API_BASE_DESENVOLVIMENTO: API_BASE_DESENVOLVIMENTO,
  };

  // No navegador, calcula já a partir de window.location e publica em
  // SAFEWORK_PLATAFORMA_API_BASE_URL — login.js/painel.js só LEEM essa
  // variável, nunca decidem o endereço por conta própria. Em Node (testes),
  // `global.location` não existe, então este bloco não roda.
  if (typeof global.location !== 'undefined') {
    global.SAFEWORK_PLATAFORMA_API_BASE_URL = resolverApiBaseUrl(global.location);
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.SafeworkPlataformaConfig;
  }
})(typeof window !== 'undefined' ? window : globalThis);
