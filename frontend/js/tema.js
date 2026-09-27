(function (global) {
  'use strict';

  /**
   * EpiTema — o tema das páginas integradas segue o do sistema operacional.
   *
   * Liga `data-theme` em "dark" ou "light" no <html>, que os tokens de
   * css/main.css já usam, e acompanha a troca feita no sistema durante a
   * sessão. Não há botão e nada é guardado: o sistema operacional é a única
   * fonte. Carregado no <head>, antes de pintar, para não piscar o claro.
   */

  var CONSULTA = '(prefers-color-scheme: dark)';

  function aplicar(documento, escuro) {
    var raiz = documento.documentElement;
    raiz.setAttribute('data-theme', escuro ? 'dark' : 'light');
    raiz.style.colorScheme = escuro ? 'dark' : 'light';
  }

  function iniciar(janela) {
    var w = janela || global;
    if (!w || !w.document || !w.document.documentElement) return null;
    var consulta = typeof w.matchMedia === 'function' ? w.matchMedia(CONSULTA) : null;
    var atualizar = function () { aplicar(w.document, !!(consulta && consulta.matches)); };
    atualizar();
    if (consulta) {
      if (typeof consulta.addEventListener === 'function') consulta.addEventListener('change', atualizar);
      else if (typeof consulta.addListener === 'function') consulta.addListener(atualizar);
    }
    return consulta;
  }

  var api = { CONSULTA: CONSULTA, iniciar: iniciar };
  global.EpiTema = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    iniciar(global);
  }
})(typeof window !== 'undefined' ? window : globalThis);
