(function (global) {
  'use strict';

  /**
   * EpiSuporteNotificacoes — alertas de novas respostas do Suporte no Painel do Cliente.
   *
   * Uma bolinha sobre o botão do menu sanduíche e um contador no item "Suporte" do menu lateral, com a QUANTIDADE DE CHAMADOS
   * que têm resposta da SafeWork ainda não lida (GET /suporte/notificacoes: só o número, nunca texto). O servidor é a única
   * fonte: a conversa só deixa de contar quando ele a marca como lida (abrir o chamado); abrir o menu não muda nada.
   *
   * Ciclo: acionado por permissoes-efetivas.js (ajustarMenuSuporte) com as permissões confirmadas — nunca antes da sessão —
   * e desligado sem elas. Consulta a cada 30 s só com a página visível; ao voltar à aba, na revalidação e depois da leitura
   * de uma conversa, consulta na hora. Uma consulta em voo por vez; resposta de uma identidade (empresa:usuário) ou de um
   * ciclo anterior é descartada; 401/403 param e limpam; falha de rede ou resposta inválida não mudam o que está na tela.
   * Nada vai para localStorage, sessionStorage ou cookie. Sem som, sem notificação do sistema.
   */

  var CAMINHO = '/suporte/notificacoes';
  var INTERVALO_MS = 30000;
  var ROTULO_PADRAO_BOTAO = 'Abrir menu';

  var TEXTOS = {
    descricao: function (n) {
      return n === 1 ? '1 chamado de suporte com resposta não lida' : n + ' chamados de suporte com respostas não lidas';
    },
  };

  var modelo = {
    /** Só a contagem inteira e não negativa do servidor; qualquer outra coisa é null (nunca inventar). */
    contagem: function (resposta) {
      if (!resposta || typeof resposta !== 'object') return null;
      var n = resposta.chamadosNaoLidos;
      if (typeof n !== 'number' || !isFinite(n) || Math.floor(n) !== n || n < 0) return null;
      return n;
    },
  };

  var estado = { identidade: null, contagem: null, geracao: 0, timer: null, emVoo: false, doc: null, ouvindo: null };

  function http() {
    if (!global.EpiHttp || typeof global.EpiHttp.requisitar !== 'function') throw new TypeError('EpiHttp indisponível');
    return global.EpiHttp;
  }
  function visivel(doc) {
    return !(doc && doc.visibilityState === 'hidden');
  }
  function identidadeDe(permissoes) {
    if (!permissoes || typeof permissoes !== 'object') return null;
    if (permissoes.empresaId === undefined || permissoes.usuarioId === undefined) return null;
    return String(permissoes.empresaId) + ':' + String(permissoes.usuarioId);
  }

  // ── apresentação (nós e texto; nada de innerHTML)
  function botaoDoMenu(doc) { return doc && typeof doc.querySelector === 'function' ? doc.querySelector('.mobile-global-menu') : null; }
  function itemSuporte(doc) {
    if (!doc || typeof doc.querySelectorAll !== 'function') return null;
    var links = doc.querySelectorAll('.nav a');
    for (var i = 0; i < links.length; i += 1) {
      var a = links[i];
      if (a.getAttribute('data-pagina') === 'support' || a.getAttribute('data-suporte') === 'true') return a;
    }
    return null;
  }
  function bolinha(doc) {
    var botao = botaoDoMenu(doc);
    if (!botao) return null;
    var el = botao.querySelector('.menu-alerta');
    if (!el) {
      el = doc.createElement('span');
      el.className = 'menu-alerta';
      el.setAttribute('aria-hidden', 'true');
      el.style.display = 'none';
      botao.appendChild(el);
      if (!botao.getAttribute('data-rotulo-base')) botao.setAttribute('data-rotulo-base', botao.getAttribute('aria-label') || ROTULO_PADRAO_BOTAO);
    }
    return el;
  }
  function contador(doc) {
    var a = itemSuporte(doc);
    if (!a) return null;
    var el = a.querySelector('.nav-contador');
    if (!el) {
      el = doc.createElement('span');
      el.className = 'nav-contador';
      el.setAttribute('aria-hidden', 'true');
      el.style.display = 'none';
      a.appendChild(el);
      var sr = doc.createElement('span');
      sr.className = 'nav-contador-sr';
      sr.style.display = 'none';
      a.appendChild(sr);
    }
    return el;
  }
  function pintar(doc, n) {
    var ponto = bolinha(doc);
    var botao = botaoDoMenu(doc);
    var ativo = typeof n === 'number' && n > 0;
    if (ponto) ponto.style.display = ativo ? '' : 'none';
    if (botao) {
      var base = botao.getAttribute('data-rotulo-base') || ROTULO_PADRAO_BOTAO;
      botao.setAttribute('aria-label', ativo ? base + '. ' + TEXTOS.descricao(n) : base);
    }
    var cont = contador(doc);
    if (cont) {
      var sr = itemSuporte(doc).querySelector('.nav-contador-sr');
      cont.textContent = ativo ? String(n) : '';
      cont.style.display = ativo ? '' : 'none';
      if (sr) {
        sr.textContent = ativo ? TEXTOS.descricao(n) : '';
        sr.style.display = ativo ? '' : 'none';
      }
    }
  }

  // ── ciclo
  function cancelarTimer() {
    if (estado.timer !== null) { global.clearTimeout(estado.timer); estado.timer = null; }
  }
  function agendar() {
    cancelarTimer();
    if (estado.identidade === null || !visivel(estado.doc)) return;
    // Função nomeada: o harness de testes identifica este temporizador de fundo pelo nome (dom-pagina: `nome`).
    estado.timer = global.setTimeout(function sondagemNotificacoesSuporte() { estado.timer = null; consultar(); }, INTERVALO_MS);
  }
  function limpar(doc) {
    estado.contagem = null;
    pintar(doc || estado.doc, null);
  }
  function parar() {
    cancelarTimer();
    estado.identidade = null;
    estado.geracao += 1;
  }
  async function consultar() {
    if (estado.identidade === null || estado.emVoo || !visivel(estado.doc)) return;
    var geracao = estado.geracao;
    estado.emVoo = true;
    var r = null;
    try {
      r = await http().requisitar('GET', CAMINHO);
    } catch (e) {
      r = null;
    }
    estado.emVoo = false;
    if (geracao !== estado.geracao) { // identidade ou ciclo mudou enquanto a consulta voava: resposta descartada
      if (estado.identidade !== null) consultar(); // a identidade atual ainda não foi consultada
      return;
    }
    if (r && (r.status === 401 || r.status === 403)) { parar(); limpar(); return; }
    if (r && r.ok) {
      var n = modelo.contagem(r.dados);
      if (n !== null) { estado.contagem = n; pintar(estado.doc, n); }
    }
    agendar();
  }
  function ouvirVisibilidade(doc) {
    if (!doc || typeof doc.addEventListener !== 'function' || estado.ouvindo === doc) return;
    estado.ouvindo = doc;
    doc.addEventListener('visibilitychange', function () {
      if (estado.identidade === null) return;
      if (visivel(doc)) consultar(); else cancelarTimer();
    });
  }

  /**
   * Ponto de entrada do menu (permissoes-efetivas.js): com permissões válidas liga (ou religa) o ciclo para a identidade da
   * sessão; com null desliga e limpa. Identidade diferente da atual (troca de empresa ou de usuário) limpa antes de consultar.
   */
  function sincronizar(permissoes, doc) {
    var d = doc || estado.doc || global.document;
    estado.doc = d;
    var identidade = identidadeDe(permissoes);
    if (identidade === null) { parar(); limpar(d); return; }
    if (identidade !== estado.identidade) { parar(); limpar(d); estado.identidade = identidade; }
    ouvirVisibilidade(d);
    cancelarTimer();
    consultar();
  }
  function atualizarAgora() {
    if (estado.identidade === null) return;
    cancelarTimer();
    consultar();
  }

  global.EpiSuporteNotificacoes = {
    CAMINHO: CAMINHO,
    INTERVALO_MS: INTERVALO_MS,
    TEXTOS: TEXTOS,
    modelo: modelo,
    sincronizar: sincronizar,
    atualizarAgora: atualizarAgora,
    parar: function () { parar(); limpar(); },
    estado: function () { return { identidade: estado.identidade, contagem: estado.contagem, emVoo: estado.emVoo, agendada: estado.timer !== null }; },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.EpiSuporteNotificacoes;
})(typeof window !== 'undefined' ? window : globalThis);
