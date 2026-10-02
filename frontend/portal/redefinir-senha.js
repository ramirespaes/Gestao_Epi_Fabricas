(function () {
  'use strict';

  /**
   * Redefinição de senha do Portal pelo link. Toda a página mora em
   * EpiSenhaCiclo.iniciarRedefinicao; aqui só ficam a base da API e o POST
   * desta cadeia (/api).
   */

  window.EpiHttp.configurar({ baseUrl: window.SAFEWORK_PORTAL_API_BASE_URL });
  window.EpiSenhaCiclo.iniciarRedefinicao({
    janela: window,
    documento: document,
    caminho: '/auth/global/recuperacao-senha/redefinir',
  });
})();
