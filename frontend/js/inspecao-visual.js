(function (global) {
  'use strict';

  /**
   * Liberação visual controlada (05/10/2026, TEMPORÁRIA).
   *
   * Carregado só pelos protótipos ainda "Em integração" (nunca publicado:
   * NUNCA_PUBLICAR em publicacao/empacotar.js). Age apenas quando a página é
   * aberta com ?inspecao=1 — o link que o menu das páginas integradas monta
   * para o MASTER (permissoes-efetivas.js). Esconde a tela de login SIMULADA
   * do protótipo, mostra uma faixa fixa e recusa toda escrita na API
   * simulada (db-api.js), além de qualquer submit de formulário: a tela
   * serve só para inspeção, nada é gravado, nem de mentira. O protótipo
   * nunca chama o backend real; isto não muda nada disso.
   *
   * O marcador também é propagado aos links da barra lateral que levam a
   * outro protótipo: o fileMap inline da página e o appendSessionToNavLinks
   * do main.js reescrevem esses href sem o marcador, e o segundo salto
   * cairia na tela de login simulada. Links de páginas integradas (inclusive
   * Configurações) nunca recebem o marcador.
   */

  var MARCADOR = 'inspecao';
  var PAR = MARCADOR + '=1';
  var TEXTO = 'Em integração — tela aberta só para inspeção visual. Protótipo sem ligação com o sistema: nenhum dado é gravado.';
  var RECUSA = 'Protótipo em inspeção visual: nenhuma ação grava dados.';
  // Mesmos arquivos de INSPECAO_PROTOTIPOS (permissoes-efetivas.js); conferido por teste.
  var PROTOTIPOS = ['emails-gestao.html', 'lgpd.html', 'self-service.html', 'support.html'];
  // MÓDULOS TEMPORARIAMENTE DESATIVADOS / ADIADOS (05/10/2026): Compras / Entradas e
  // Regras Função / Setor saem da inspeção — o link nunca recebe o marcador, o clique
  // é recusado com aviso e a própria página não ativa a inspeção nem com ?inspecao=1
  // (fica no estado legado, não operacional). Arquivos preservados para retomada.
  var DESATIVADOS = ['purchases.html', 'eligibility-rules.html'];
  var DESATIVADO = 'Módulo temporariamente desativado.';
  // Ocultação temporária da navegação (05/10/2026), espelho de NAVEGACAO_OCULTA
  // em permissoes-efetivas.js para a barra lateral LEGADA dos protótipos (data-page,
  // reexibida pelo main.js com display:flex): regra com !important, só em inspeção.
  var NAVEGACAO_OCULTA_LEGADA = ['purchases', 'stockValidity', 'eligibilityRules', 'newUser', 'userAdmin'];

  function arquivoDe(href) {
    if (typeof href !== 'string' || href === '') return '';
    if (/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href)) return '';
    return href.split('#')[0].split('?')[0].split('/').pop();
  }

  function desativado(href) {
    return DESATIVADOS.indexOf(arquivoDe(href)) !== -1;
  }

  function ativo(location) {
    try {
      return new URLSearchParams(location && location.search ? location.search : '').get(MARCADOR) === '1';
    } catch (e) {
      return false;
    }
  }

  function comMarcador(href) {
    if (typeof href !== 'string' || href === '') return href;
    if (/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href)) return href;
    var partes = href.split('#');
    var fragmento = partes.length > 1 ? '#' + partes.slice(1).join('#') : '';
    var semFragmento = partes[0].split('?');
    var caminho = semFragmento[0];
    if (PROTOTIPOS.indexOf(caminho.split('/').pop()) === -1) return href;
    var pares = semFragmento.length > 1 ? semFragmento.slice(1).join('?').split('&') : [];
    if (pares.indexOf(PAR) !== -1) return href;
    pares = pares.filter(function (p) { return p !== '' && p.indexOf(MARCADOR + '=') !== 0; });
    pares.push(PAR);
    return caminho + '?' + pares.join('&') + fragmento;
  }

  function marcarLink(a) {
    if (!a || typeof a.getAttribute !== 'function') return;
    var href = a.getAttribute('href');
    if (desativado(href)) {
      a.setAttribute('aria-disabled', 'true');
      a.setAttribute('title', DESATIVADO);
      return;
    }
    var novo = comMarcador(href);
    if (novo !== href) a.setAttribute('href', novo);
  }

  function marcarLinks(doc) {
    if (typeof doc.querySelectorAll !== 'function') return;
    Array.prototype.forEach.call(doc.querySelectorAll('a[href]'), marcarLink);
  }

  function ancoraDe(alvo) {
    var el = alvo;
    while (el && String(el.tagName).toUpperCase() !== 'A') el = el.parentNode;
    return el || null;
  }

  function faixa(doc) {
    var el = doc.createElement('div');
    el.setAttribute('role', 'status');
    el.setAttribute('data-inspecao-visual', '1');
    el.textContent = TEXTO;
    el.style.cssText = 'position:sticky;top:0;z-index:10001;background:#FF9500;color:#1c1c1e;font:600 13px/1.4 system-ui,sans-serif;padding:8px 16px;text-align:center';
    return el;
  }

  function esconderLogin(doc) {
    var login = doc.getElementById('loginScreen');
    if (login) login.style.display = 'none';
    // Regra com !important: o main.js legado reexibe o login por style.display.
    var alvo = doc.head || doc.documentElement;
    if (!alvo || typeof alvo.appendChild !== 'function') return;
    var estilo = doc.createElement('style');
    estilo.setAttribute('data-inspecao-visual', 'login');
    estilo.textContent = '#loginScreen{display:none !important}';
    alvo.appendChild(estilo);
  }

  function ocultarNavegacaoLegada(doc) {
    var alvo = doc.head || doc.documentElement;
    if (!alvo || typeof alvo.appendChild !== 'function') return;
    var estilo = doc.createElement('style');
    estilo.setAttribute('data-inspecao-visual', 'navegacao');
    estilo.textContent = NAVEGACAO_OCULTA_LEGADA.map(function (pagina) { return '.nav a[data-page="' + pagina + '"]'; }).join(',') + '{display:none !important}';
    alvo.appendChild(estilo);
  }

  function bloquearEscritas(api, avisar) {
    if (!api || typeof api.request !== 'function') return;
    var original = api.request;
    api.request = function (metodo) {
      if (String(metodo).toUpperCase() === 'GET') return original.apply(this, arguments);
      avisar(RECUSA);
      return Promise.resolve({ ok: false, status: 403, data: null, message: RECUSA });
    };
  }

  function ativar(doc, win) {
    var w = win || global;
    if (!doc || !ativo(w.location)) return false;
    if (desativado(w.location && w.location.pathname)) return false;
    esconderLogin(doc);
    ocultarNavegacaoLegada(doc);
    if (doc.body) doc.body.insertBefore(faixa(doc), doc.body.firstChild || null);
    var avisar = function (mensagem) { if (typeof w.showToast === 'function') w.showToast(mensagem, 'warning'); };
    bloquearEscritas(w.EpiAPI, avisar);
    doc.addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (typeof ev.stopImmediatePropagation === 'function') ev.stopImmediatePropagation();
      avisar(RECUSA);
    }, true);
    marcarLinks(doc);
    doc.addEventListener('click', function (ev) {
      var a = ancoraDe(ev && ev.target);
      if (a && typeof a.getAttribute === 'function' && desativado(a.getAttribute('href'))) {
        if (typeof ev.preventDefault === 'function') ev.preventDefault();
        if (typeof ev.stopImmediatePropagation === 'function') ev.stopImmediatePropagation();
        avisar(DESATIVADO);
        return;
      }
      marcarLink(a);
    }, true);
    return true;
  }

  global.EpiInspecaoVisual = {
    MARCADOR: MARCADOR, TEXTO: TEXTO, RECUSA: RECUSA, PROTOTIPOS: PROTOTIPOS.slice(),
    DESATIVADOS: DESATIVADOS.slice(), DESATIVADO: DESATIVADO, desativado: desativado,
    NAVEGACAO_OCULTA_LEGADA: NAVEGACAO_OCULTA_LEGADA.slice(),
    ativo: ativo, comMarcador: comMarcador, marcarLinks: marcarLinks, ativar: ativar,
  };

  if (global.document && typeof global.document.addEventListener === 'function') {
    global.document.addEventListener('DOMContentLoaded', function () { ativar(global.document, global); });
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.EpiInspecaoVisual;
  }
})(typeof window !== 'undefined' ? window : globalThis);
