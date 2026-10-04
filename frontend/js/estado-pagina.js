(function (global) {
  'use strict';

  /**
   * EpiEstadoPagina — estados padrão das páginas integradas e a abertura
   * protegida (Bloco 12, 12G-1).
   *
   * ESTADOS: carregando, vazio, erro, acesso negado, sessão inválida,
   * revalidação e "em integração", sempre um por vez dentro de um contêiner,
   * com papel e aviso para leitor de tela (erro, acesso negado e sessão
   * inválida como alerta; o resto como status) e a mensagem como TEXTO: nada
   * passa por innerHTML, então o que vier de fora nunca vira marcação.
   *
   * ABERTURA PROTEGIDA: compõe o que já existe, sem duplicar —
   * EpiSessaoEmpresarial.montar (sessão confirmada no servidor, tela de
   * verificação, restauração pelo histórico) e EpiPermissoes.prepararPagina
   * (permissões reais, menu, falha fechada). O conteúdo protegido nasce oculto
   * no HTML e só aparece depois das duas confirmações; some de novo quando a
   * sessão termina ou muda (restauração pelo histórico com outra sessão). O
   * backend continua sendo a autoridade: esconder é só apresentação.
   *
   * Sem armazenamento do navegador, sem cookie, sem estado global além do
   * próprio objeto.
   */

  var TIPOS = Object.freeze({
    CARREGANDO: 'carregando',
    VAZIO: 'vazio',
    ERRO: 'erro',
    ACESSO_NEGADO: 'acesso-negado',
    SESSAO_INVALIDA: 'sessao-invalida',
    REVALIDANDO: 'revalidando',
    EM_INTEGRACAO: 'em-integracao',
  });

  var MENSAGENS = Object.freeze({
    carregando: 'Carregando…',
    vazio: 'Nada para mostrar.',
    erro: 'Não foi possível carregar as informações. Recarregue a página para tentar novamente.',
    'acesso-negado': 'Você não tem permissão para acessar este módulo nesta empresa.',
    'sessao-invalida': 'Sua sessão terminou. Você será levado ao Portal do Cliente para entrar novamente.',
    revalidando: 'Verificando sua sessão…',
    'em-integracao': 'Em integração: esta área será ligada ao servidor nas próximas etapas.',
    verificandoPermissoes: 'Verificando suas permissões…',
  });

  var ICONES = {
    carregando: 'hourglass_top',
    vazio: 'inbox',
    erro: 'error',
    'acesso-negado': 'lock',
    'sessao-invalida': 'logout',
    revalidando: 'hourglass_top',
    'em-integracao': 'construction',
  };
  var ALERTA = { erro: true, 'acesso-negado': true, 'sessao-invalida': true };
  var OCUPADO = { carregando: true, revalidando: true };

  function tipoValido(tipo) {
    var chaves = Object.keys(TIPOS);
    for (var i = 0; i < chaves.length; i += 1) {
      if (TIPOS[chaves[i]] === tipo) return true;
    }
    return false;
  }

  function exibir(el) { if (el) el.style.display = ''; }
  function ocultar(el) { if (el) el.style.display = 'none'; }

  /**
   * Mostra um estado no contêiner, no lugar do que houver nele.
   * @returns {Element} o elemento do estado
   */
  function mostrar(container, tipo, mensagem) {
    if (!tipoValido(tipo)) throw new TypeError('estado desconhecido: ' + String(tipo));
    if (!container || typeof container.appendChild !== 'function') throw new TypeError('contêiner do estado ausente');
    var doc = container.ownerDocument || global.document;
    var caixa = doc.createElement('div');
    caixa.className = 'estado-pagina estado-' + tipo;
    caixa.setAttribute('data-estado', tipo);
    caixa.setAttribute('role', ALERTA[tipo] ? 'alert' : 'status');
    caixa.setAttribute('aria-live', ALERTA[tipo] ? 'assertive' : 'polite');
    if (OCUPADO[tipo]) caixa.setAttribute('aria-busy', 'true');

    var icone = doc.createElement('span');
    icone.className = 'material-symbols-outlined';
    icone.setAttribute('aria-hidden', 'true');
    icone.textContent = ICONES[tipo];
    var texto = doc.createElement('p');
    texto.textContent = typeof mensagem === 'string' && mensagem.length > 0 ? mensagem : MENSAGENS[tipo];

    caixa.appendChild(icone);
    caixa.appendChild(texto);
    container.textContent = '';
    container.appendChild(caixa);
    exibir(container);
    return caixa;
  }

  function limpar(container) {
    if (!container) return;
    container.textContent = '';
    ocultar(container);
  }

  function sessao() {
    if (!global.EpiSessaoEmpresarial) throw new Error('EpiSessaoEmpresarial não carregado: inclua js/sessao-empresarial.js antes de js/estado-pagina.js');
    return global.EpiSessaoEmpresarial;
  }

  function permissoes() {
    if (!global.EpiPermissoes) throw new Error('EpiPermissoes não carregado: inclua js/permissoes-efetivas.js antes de js/estado-pagina.js');
    return global.EpiPermissoes;
  }

  /**
   * Abre a página só depois da sessão e das permissões confirmadas.
   *
   * @param {{pagina: string,
   *          elementos: {tela, mensagem, linkPortal, conteudo, estado, links},
   *          aoEncerrar?: Function, janela?: object}} opcoes
   * @returns {Promise<{contexto: object, permissoes: object, podeAlterar: boolean} | null>}
   *   null: nada foi liberado (sem sessão, sem acesso, falha ou outro contexto).
   */
  async function montarPaginaProtegida(opcoes) {
    var o = opcoes || {};
    var el = o.elementos || {};
    var aoEncerrarPagina = typeof o.aoEncerrar === 'function' ? o.aoEncerrar : function () {};
    ocultar(el.conteudo);

    function encerrar() {
      ocultar(el.conteudo);
      limpar(el.estado);
      aoEncerrarPagina();
    }

    var contexto = await sessao().montar({
      elementos: {
        tela: el.tela, mensagem: el.mensagem, linkPortal: el.linkPortal, conteudo: el.conteudo,
      },
      aoEncerrar: encerrar,
      janela: o.janela,
    });
    if (!contexto) return null;

    mostrar(el.estado, TIPOS.CARREGANDO, MENSAGENS.verificandoPermissoes);
    var avisado = false;
    var acesso = await permissoes().prepararPagina({
      pagina: o.pagina,
      contexto: contexto,
      links: el.links,
      aviso: function (texto) {
        avisado = true;
        mostrar(el.estado, texto === permissoes().MENSAGENS.SEM_ACESSO ? TIPOS.ACESSO_NEGADO : TIPOS.ERRO, texto);
      },
    });
    if (!acesso) {
      // Sem aviso, o único caminho é o 401: prepararPagina já mandou ao Portal.
      if (!avisado) mostrar(el.estado, TIPOS.SESSAO_INVALIDA);
      return null;
    }

    limpar(el.estado);
    exibir(el.conteudo);
    return { contexto: contexto, permissoes: acesso.permissoes, podeAlterar: acesso.podeAlterar };
  }

  /** 401 durante o uso: nada protegido fica na tela, e a pessoa vai ao Portal. */
  function sessaoEncerrada(elementos) {
    var el = elementos || {};
    ocultar(el.conteudo);
    if (el.estado) mostrar(el.estado, TIPOS.SESSAO_INVALIDA);
    sessao().sessaoEncerrada();
  }

  global.EpiEstadoPagina = {
    TIPOS: TIPOS,
    MENSAGENS: MENSAGENS,
    mostrar: mostrar,
    limpar: limpar,
    montarPaginaProtegida: montarPaginaProtegida,
    sessaoEncerrada: sessaoEncerrada,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.EpiEstadoPagina;
  }
})(typeof window !== 'undefined' ? window : globalThis);
