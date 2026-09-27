(function (global) {
  'use strict';

  /**
   * EpiPortal — Portal do Cliente (Autenticação Global — Pacote 4).
   *
   * Domínio do login global e da seleção de empresa, sobre EpiHttp
   * (js/api-http.js, carregado antes). Consome exatamente os contratos do
   * backend:
   *
   *   POST /api/auth/global/login                   { email, senha, turnstileToken } -> { identidade, empresas, contexto }
   *   GET  /api/auth/global/turnstile               -> { siteKey, action } do widget de verificação
   *   GET  /api/auth/global/me                      -> { identidade, empresas, contexto } | 401
   *   POST /api/auth/global/empresas/:id/selecionar (sem corpo) -> { usuario, empresa }
   *   POST /api/auth/logout                         "sair da empresa" (mantém o login global)
   *   POST /api/auth/global/logout                  "sair completamente"
   *
   * SEM CNPJ: o Portal pede só e-mail e senha.
   *
   * NADA DE TOKEN NO JAVASCRIPT: as duas sessões (global e empresarial)
   * vivem em cookies HttpOnly emitidos pelo backend — inacessíveis a este
   * código. Nada é gravado em localStorage, sessionStorage, cookie legível
   * ou URL; a identidade e a lista de empresas ficam só na memória da
   * página, para desenhar a tela. Quem decide o que a pessoa pode fazer é
   * sempre o servidor, a cada requisição.
   *
   * A EMPRESA ESCOLHIDA VAI NO CAMINHO, NUNCA NO CORPO: é uma escolha entre
   * opções que o próprio servidor listou e que ele REVALIDA (vínculo ativo,
   * empresa ativa, identidade ativa). EpiHttp, por construção, nem deixa
   * sair um corpo com `empresaId`.
   *
   * Três camadas, como nas demais telas HTTP do projeto (testáveis sem
   * navegador): `acoes` (fala com a API), `decisao` (para onde ir, funções
   * puras) e `render` (HTML escapado, funções puras).
   */

  var CAMINHOS = {
    login: '/auth/global/login',
    verificacao: '/auth/global/turnstile',
    me: '/auth/global/me',
    sairEmpresa: '/auth/logout',
    sairTudo: '/auth/global/logout',
  };

  var PAGINAS = {
    login: 'index.html',
    selecionar: 'empresas.html',
    semEmpresa: 'empresas.html',
    inicio: 'inicio.html',
    // Parte C7: com empresa selecionada, o Portal leva ao dashboard.
    painel: '../pages/dashboard.html',
  };

  var ROTULOS_PERFIL = {
    MASTER: 'Master',
    ADMINISTRADOR: 'Administrador',
    SUPERVISOR: 'Supervisor',
    USUARIO: 'Usuário',
  };

  function http() {
    var cliente = global.EpiHttp;
    if (!cliente) {
      throw new Error('EpiHttp não carregado: inclua js/api-http.js antes de js/portal-cliente.js');
    }
    return cliente;
  }

  function exigirIdEmpresa(id) {
    if (typeof id !== 'number' || !isFinite(id) || Math.floor(id) !== id || id <= 0) {
      throw new TypeError('identificador de empresa inválido');
    }
  }

  var acoes = {
    /** Senha e token da verificação só existem nesta chamada; nunca são guardados nem registrados. */
    entrar: function (credenciais) {
      var c = credenciais || {};
      if (typeof c.email !== 'string' || typeof c.senha !== 'string') {
        return Promise.reject(new TypeError('email e senha são obrigatórios'));
      }
      if (typeof c.turnstileToken !== 'string' || c.turnstileToken.length === 0) {
        return Promise.reject(new TypeError('verificação de segurança obrigatória'));
      }
      return http().requisitar('POST', CAMINHOS.login, {
        corpo: { email: c.email, senha: c.senha, turnstileToken: c.turnstileToken },
      });
    },

    configuracaoVerificacao: function () {
      return http().requisitar('GET', CAMINHOS.verificacao);
    },

    sessao: function () {
      return http().requisitar('GET', CAMINHOS.me);
    },

    selecionar: function (empresaId) {
      try {
        exigirIdEmpresa(empresaId);
      } catch (erro) {
        return Promise.reject(erro);
      }
      return http().requisitar('POST', '/auth/global/empresas/' + empresaId + '/selecionar');
    },

    sairDaEmpresa: function () {
      return http().requisitar('POST', CAMINHOS.sairEmpresa);
    },

    sairCompletamente: function () {
      return http().requisitar('POST', CAMINHOS.sairTudo);
    },
  };

  var decisao = {
    /**
     * Para onde ir com um corpo { empresas, contexto } (login ou /me):
     *   contexto presente     -> 'inicio'      (cenário A, ou empresa já selecionada)
     *   nenhuma empresa       -> 'semEmpresa'  (cenário C)
     *   uma ou mais, sem ctx  -> 'selecionar'  (cenário B, ou após "sair da empresa")
     */
    destino: function (dados) {
      if (!dados) return 'login';
      if (dados.contexto) return 'inicio';
      if (!Array.isArray(dados.empresas) || dados.empresas.length === 0) return 'semEmpresa';
      return 'selecionar';
    },

    /** Resposta de /me: 401 (ou qualquer falha de sessão) leva ao login. */
    destinoDaSessao: function (resposta) {
      if (!resposta || !resposta.ok) return 'login';
      return decisao.destino(resposta.dados);
    },

    /**
     * Parte C7 — para onde levar ao ENTRAR (login, sessão já existente ou
     * seleção de empresa): com empresa selecionada, o painel
     * (pages/dashboard.html); nos demais casos, o mesmo destino de antes.
     * `destino` continua sendo a validação do início do Portal (inicio.js),
     * que por isso nunca redireciona sozinho para o dashboard — sem laço.
     */
    entrada: function (dados) {
      var d = decisao.destino(dados);
      return d === 'inicio' ? 'painel' : d;
    },

    entradaDaSessao: function (resposta) {
      if (!resposta || !resposta.ok) return 'login';
      return decisao.entrada(resposta.dados);
    },

    pagina: function (destino) {
      return PAGINAS[destino] || PAGINAS.login;
    },

    /** "Trocar de empresa" só faz sentido com mais de uma empresa autorizada. */
    podeTrocar: function (dados) {
      return !!(dados && Array.isArray(dados.empresas) && dados.empresas.length > 1);
    },
  };

  function escaparHtml(texto) {
    return String(texto === null || texto === undefined ? '' : texto).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function formatarCnpj(cnpj) {
    var s = String(cnpj || '');
    if (s.length !== 14) return s;
    return s.slice(0, 2) + '.' + s.slice(2, 5) + '.' + s.slice(5, 8) + '/' + s.slice(8, 12) + '-' + s.slice(12);
  }

  var render = {
    escaparHtml: escaparHtml,
    formatarCnpj: formatarCnpj,
    rotuloPerfil: function (perfil) { return ROTULOS_PERFIL[perfil] || escaparHtml(perfil); },

    /** Um botão por empresa autorizada; a atual (se houver) vem marcada. */
    listaEmpresas: function (empresas, empresaAtualId) {
      return (empresas || []).map(function (e) {
        var atual = e.id === empresaAtualId;
        return '<li><button type="button" class="empresa' + (atual ? ' atual' : '') + '" data-empresa-id="' + Number(e.id) + '">'
          + '<span class="empresa-nome">' + escaparHtml(e.nome) + '</span>'
          + '<span class="empresa-detalhe">CNPJ ' + escaparHtml(formatarCnpj(e.cnpj)) + ' · ' + escaparHtml(render.rotuloPerfil(e.perfil)) + (atual ? ' · empresa atual' : '') + '</span>'
          + '</button></li>';
      }).join('');
    },
  };

  var mensagens = {
    CREDENCIAIS: 'E-mail ou senha inválidos.',
    SEM_EMPRESA: 'Seu acesso foi confirmado, mas não há nenhuma empresa ativa vinculada a ele. Procure o responsável pelo cadastro da sua empresa.',
    VERIFICACAO_PENDENTE: 'Aguarde a verificação de segurança para entrar.',
    VERIFICACAO_EXPIRADA: 'A verificação de segurança expirou. Aguarde uma nova verificação.',
    VERIFICACAO_ERRO: 'Não foi possível concluir a verificação de segurança. Recarregue a página e tente novamente.',
    deErro: function (resposta) {
      if (!resposta) return 'Não foi possível concluir a operação.';
      if (resposta.status === 403 && resposta.codigo === 'EMPRESA_NAO_AUTORIZADA') {
        return 'Esta empresa não está mais disponível para o seu acesso. A lista foi atualizada.';
      }
      if (resposta.codigo === 'VERIFICACAO_SEGURANCA_INVALIDA') {
        return 'A verificação de segurança não foi aceita. Aguarde uma nova verificação e tente novamente.';
      }
      if (resposta.codigo === 'VERIFICACAO_SEGURANCA_INDISPONIVEL') {
        return 'A verificação de segurança está temporariamente indisponível. Tente novamente em instantes.';
      }
      return resposta.mensagem || 'Não foi possível concluir a operação.';
    },
  };

  /**
   * Verificação de segurança do login (Cloudflare Turnstile). O token fica
   * só nesta closure: nunca em storage, cookie, URL, DOM ou console.
   * `response-field: false` impede o widget de criar um campo com ele no
   * formulário. Estados: carregando, aguardando, pronto, expirado, erro.
   */
  var OPCOES_WIDGET = { theme: 'auto', language: 'pt-BR', appearance: 'always' };
  // `flexible` tem largura mínima de 300px; abaixo disso uso `compact` (150px).
  var LARGURA_MINIMA_FLEXIVEL = 300;

  function tamanhoDoWidget(largura) {
    return typeof largura === 'number' && isFinite(largura) && largura >= LARGURA_MINIMA_FLEXIVEL ? 'flexible' : 'compact';
  }

  function larguraDe(elemento) {
    return elemento && typeof elemento.getBoundingClientRect === 'function' ? elemento.getBoundingClientRect().width : NaN;
  }

  function criarVerificacao(opcoes) {
    var o = opcoes || {};
    var token = null;
    var widget = null;
    var estado = 'carregando';

    function mudar(novo) {
      estado = novo;
      if (typeof o.aoMudar === 'function') o.aoMudar(novo);
    }
    function descartar(novo) {
      token = null;
      mudar(novo);
    }

    return {
      iniciar: function () {
        var api = o.turnstile;
        if (!api || typeof api.render !== 'function' || typeof api.reset !== 'function'
          || typeof o.siteKey !== 'string' || typeof o.action !== 'string') {
          descartar('erro');
          return false;
        }
        widget = api.render(o.elemento, {
          sitekey: o.siteKey,
          action: o.action,
          theme: OPCOES_WIDGET.theme,
          language: OPCOES_WIDGET.language,
          size: tamanhoDoWidget(larguraDe(o.elemento)),
          appearance: OPCOES_WIDGET.appearance,
          'response-field': false,
          callback: function (novo) {
            if (typeof novo === 'string' && novo.length > 0) {
              token = novo;
              mudar('pronto');
            }
          },
          'expired-callback': function () { descartar('expirado'); },
          'timeout-callback': function () { descartar('expirado'); },
          // true avisa o widget de que tratei o erro; ele segue tentando sozinho.
          'error-callback': function () { descartar('erro'); return true; },
        });
        mudar('aguardando');
        return true;
      },
      temToken: function () { return token !== null; },
      estado: function () { return estado; },
      /** Entrega o token e o esquece: cada token vale para uma única tentativa. */
      consumir: function () {
        var atual = token;
        token = null;
        if (atual !== null) mudar('aguardando');
        return atual;
      },
      reiniciar: function () {
        token = null;
        if (widget !== null) o.turnstile.reset(widget);
        mudar('aguardando');
      },
    };
  }

  var login = {
    /**
     * Envia o login com o token atual, já descartado. Qualquer desfecho que
     * não seja sucesso (4xx, 5xx ou falha de rede depois do envio) reinicia
     * o widget: a próxima tentativa exige um token novo.
     */
    enviar: function (credenciais, verificacao) {
      var token = verificacao.consumir();
      if (token === null) return Promise.resolve({ ok: false, semVerificacao: true });
      var c = credenciais || {};
      return acoes.entrar({ email: c.email, senha: c.senha, turnstileToken: token }).then(function (r) {
        if (!r.ok) verificacao.reiniciar();
        return r;
      }, function (erro) {
        verificacao.reiniciar();
        throw erro;
      });
    },
  };

  global.EpiPortal = {
    acoes: acoes,
    decisao: decisao,
    render: render,
    mensagens: mensagens,
    verificacao: { criar: criarVerificacao, tamanho: tamanhoDoWidget },
    login: login,
    PAGINAS: PAGINAS,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.EpiPortal;
  }
})(typeof window !== 'undefined' ? window : globalThis);
