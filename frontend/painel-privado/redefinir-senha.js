(function () {
  'use strict';

  /**
   * Redefinição de senha do Painel Privado pelo link. Toda a página mora em
   * EpiSenhaCiclo.iniciarRedefinicao; aqui só ficam a base da API e o POST
   * desta cadeia (/api/plataforma).
   */

  window.EpiHttp.configurar({ baseUrl: window.SAFEWORK_PLATAFORMA_API_BASE_URL });
  window.EpiSenhaCiclo.iniciarRedefinicao({
    janela: window,
    documento: document,
    caminho: '/auth/recuperacao-senha/redefinir',
  });
})();
