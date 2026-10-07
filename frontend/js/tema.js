(function (global) {
  'use strict';

  /**
   * EpiTema — aparência das páginas integradas, POR IDENTIDADE (Configurações).
   *
   * A preferência real mora no servidor (identidades.tema e modo_visual,
   * migration 072) e chega com /auth/me (sessao-empresarial.js chama
   * aplicarPreferencias). Este módulo liga no <html> os atributos que
   * css/main.css já conhece: `data-theme` ("dark"/"light"), `data-display`
   * ("contrast") e `data-a11y` (deuteranopia, protanopia, tritanopia,
   * lowvision, monochrome). O tema "sistema" segue prefers-color-scheme e
   * acompanha a troca feita no sistema durante a sessão.
   *
   * O localStorage é SÓ cache da primeira pintura (para não piscar no tema
   * errado antes de /auth/me responder): guarda apenas tema e modo visual,
   * é reescrito a cada resposta do servidor, que sempre vence, e é apagado
   * ao sair. Nunca decide autorização nem guarda dado sensível.
   *
   * Carregado no <head>, antes de pintar.
   */

  var CONSULTA = '(prefers-color-scheme: dark)';
  var CHAVE_CACHE = 'safework-aparencia';
  var TEMAS = ['sistema', 'claro', 'escuro'];
  var MODOS_VISUAIS = ['padrao', 'alto_contraste', 'deuteranopia', 'protanopia', 'tritanopia', 'baixa_visao', 'monocromatico'];
  // Nome do atributo CSS por modo visual: o valor de negócio nunca vira atributo direto.
  var ATRIBUTO_DO_MODO = {
    padrao: null,
    alto_contraste: { atributo: 'data-display', valor: 'contrast' },
    deuteranopia: { atributo: 'data-a11y', valor: 'deuteranopia' },
    protanopia: { atributo: 'data-a11y', valor: 'protanopia' },
    tritanopia: { atributo: 'data-a11y', valor: 'tritanopia' },
    baixa_visao: { atributo: 'data-a11y', valor: 'lowvision' },
    monocromatico: { atributo: 'data-a11y', valor: 'monochrome' },
  };

  var atual = { tema: 'sistema', modoVisual: 'padrao' };
  var consultaAtiva = null;

  function normalizar(prefs) {
    var p = prefs && typeof prefs === 'object' ? prefs : {};
    return {
      tema: TEMAS.indexOf(p.tema) !== -1 ? p.tema : 'sistema',
      modoVisual: MODOS_VISUAIS.indexOf(p.modoVisual) !== -1 ? p.modoVisual : 'padrao',
    };
  }

  function armazenamento(w) {
    try { return (w && w.localStorage) || null; } catch (e) { return null; }
  }

  function lerCache(w) {
    var s = armazenamento(w);
    if (!s) return null;
    try {
      var bruto = s.getItem(CHAVE_CACHE);
      return bruto ? normalizar(JSON.parse(bruto)) : null;
    } catch (e) {
      return null;
    }
  }

  function gravarCache(w, prefs) {
    var s = armazenamento(w);
    if (!s) return;
    try { s.setItem(CHAVE_CACHE, JSON.stringify({ tema: prefs.tema, modoVisual: prefs.modoVisual })); } catch (e) { /* cache é opcional */ }
  }

  function limparCache(janela) {
    var s = armazenamento(janela || global);
    if (!s) return;
    try { s.removeItem(CHAVE_CACHE); } catch (e) { /* cache é opcional */ }
  }

  function pintar(w) {
    var raiz = w.document.documentElement;
    var escuro = atual.tema === 'escuro' || (atual.tema === 'sistema' && !!(consultaAtiva && consultaAtiva.matches));
    raiz.setAttribute('data-theme', escuro ? 'dark' : 'light');
    if (raiz.style) raiz.style.colorScheme = escuro ? 'dark' : 'light';
    if (typeof raiz.removeAttribute === 'function') {
      raiz.removeAttribute('data-display');
      raiz.removeAttribute('data-a11y');
    }
    var modo = ATRIBUTO_DO_MODO[atual.modoVisual];
    if (modo) raiz.setAttribute(modo.atributo, modo.valor);
  }

  function garantirConsulta(w) {
    if (consultaAtiva !== null) return;
    var consulta = typeof w.matchMedia === 'function' ? w.matchMedia(CONSULTA) : null;
    consultaAtiva = consulta || { matches: false };
    if (!consulta) return;
    var ouvinte = function () { if (atual.tema === 'sistema') pintar(w); };
    if (typeof consulta.addEventListener === 'function') consulta.addEventListener('change', ouvinte);
    else if (typeof consulta.addListener === 'function') consulta.addListener(ouvinte);
  }

  function aplicar(prefs, janela, gravar) {
    var w = janela || global;
    if (!w || !w.document || !w.document.documentElement) return null;
    if (janela) consultaAtiva = null;
    atual = normalizar(prefs);
    garantirConsulta(w);
    pintar(w);
    if (gravar) gravarCache(w, atual);
    return { tema: atual.tema, modoVisual: atual.modoVisual };
  }

  /** Aplica a preferência vinda do servidor (ou de quem a persiste) e atualiza o cache. */
  function aplicarPreferencias(prefs, janela) {
    return aplicar(prefs, janela, true);
  }

  function preferenciasAtuais() {
    return { tema: atual.tema, modoVisual: atual.modoVisual };
  }

  /** Primeira pintura: cache (se houver) ou os padrões, sem escrever nada; o servidor corrige em seguida. */
  function iniciar(janela) {
    return aplicar(lerCache(janela || global) || { tema: 'sistema', modoVisual: 'padrao' }, janela, false);
  }

  var api = {
    CONSULTA: CONSULTA,
    CHAVE_CACHE: CHAVE_CACHE,
    TEMAS: TEMAS.slice(),
    MODOS_VISUAIS: MODOS_VISUAIS.slice(),
    normalizar: normalizar,
    aplicarPreferencias: aplicarPreferencias,
    preferenciasAtuais: preferenciasAtuais,
    limparCache: limparCache,
    iniciar: iniciar,
  };
  global.EpiTema = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    iniciar(global);
  }
})(typeof window !== 'undefined' ? window : globalThis);
