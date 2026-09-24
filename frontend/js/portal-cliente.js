(function (global) {
  'use strict';

  /**
   * EpiPortal — Portal do Cliente (Autenticação Global — Pacote 4).
   *
   * Domínio do login global e da seleção de empresa, sobre EpiHttp
   * (js/api-http.js, carregado antes). Consome exatamente os contratos do
   * backend:
   *
   *   POST /api/auth/global/login                   { email, senha } -> { identidade, empresas, contexto }
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
    me: '/auth/global/me',
    sairEmpresa: '/auth/logout',
    sairTudo: '/auth/global/logout',
  };

  var PAGINAS = {
    login: 'index.html',
    selecionar: 'empresas.html',
    semEmpresa: 'empresas.html',
    inicio: 'inicio.html',
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
    /** A senha só existe nesta chamada; nunca é guardada nem registrada. */
    entrar: function (credenciais) {
      var c = credenciais || {};
      if (typeof c.email !== 'string' || typeof c.senha !== 'string') {
        return Promise.reject(new TypeError('email e senha são obrigatórios'));
      }
      return http().requisitar('POST', CAMINHOS.login, { corpo: { email: c.email, senha: c.senha } });
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
    deErro: function (resposta) {
      if (!resposta) return 'Não foi possível concluir a operação.';
      if (resposta.status === 403 && resposta.codigo === 'EMPRESA_NAO_AUTORIZADA') {
        return 'Esta empresa não está mais disponível para o seu acesso. A lista foi atualizada.';
      }
      return resposta.mensagem || 'Não foi possível concluir a operação.';
    },
  };

  global.EpiPortal = {
    acoes: acoes,
    decisao: decisao,
    render: render,
    mensagens: mensagens,
    PAGINAS: PAGINAS,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.EpiPortal;
  }
})(typeof window !== 'undefined' ? window : globalThis);
