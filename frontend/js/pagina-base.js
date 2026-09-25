(function (global) {
  'use strict';

  /**
   * EpiPaginaBase — utilitários de página copiados de js/main.js (Bloco 9,
   * Etapa C, Parte C2, item 24 do planejamento): menu lateral no celular e
   * aviso flutuante ("toast"). Nada além disso.
   *
   * Existe para que as páginas integradas ao backend real não carreguem
   * js/main.js (que traz o login simulado, o mock de estoque e as
   * permissões locais do protótipo). main.js e db-api.js seguem intocados
   * servindo as páginas antigas.
   *
   * Sem estado, sem localStorage/sessionStorage, sem cookie. O `document`
   * pode ser injetado (testes sem navegador); o padrão é o da janela.
   */

  var CORES_TOAST = { success: '#34C759', error: '#FF3B30', warning: '#FF9500', info: '#007AFF' };

  function documento(d) {
    return d || global.document;
  }

  function toggleSidebar(d) {
    documento(d).body.classList.toggle('mobile-menu-open');
  }

  function closeMobileMenu(d) {
    documento(d).body.classList.remove('mobile-menu-open');
  }

  /**
   * Mesmo visual do showToast de main.js: pílula fixa no rodapé, 3 s.
   * `agendar(fn)` substitui o setTimeout nos testes.
   */
  function showToast(msg, type, d, agendar) {
    var doc = documento(d);
    var t = doc.createElement('div');
    t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:'
      + (CORES_TOAST[type] || CORES_TOAST.info) + ';color:#fff;padding:10px 20px;border-radius:99px;font-size:13px;'
      + 'font-weight:500;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,0.2);white-space:nowrap';
    t.textContent = msg;
    doc.body.appendChild(t);
    var depois = typeof agendar === 'function' ? agendar : function (fn) { setTimeout(fn, 3000); };
    depois(function () { t.remove(); });
    return t;
  }

  global.EpiPaginaBase = {
    toggleSidebar: toggleSidebar,
    closeMobileMenu: closeMobileMenu,
    showToast: showToast,
  };

  // Os mesmos nomes globais que o HTML original usa em onclick="...":
  // a marcação do protótipo continua válida sem main.js.
  global.toggleSidebar = function () { toggleSidebar(); };
  global.closeMobileMenu = function () { closeMobileMenu(); };
  global.showToast = function (msg, type) { return showToast(msg, type); };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.EpiPaginaBase;
  }
})(typeof window !== 'undefined' ? window : globalThis);
