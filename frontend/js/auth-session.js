(function (global) {
  'use strict';

  /**
   * EpiAuth — autenticação e sessão reais (Bloco 8, Incremento 8, Etapa
   * 5A, Subetapa 3R).
   *
   * Domínio de autenticação sobre EpiHttp (js/api-http.js, que precisa
   * ser carregado antes). Consome exatamente os três contratos já
   * aprovados no backend (Incremento 6):
   *
   *   POST /api/auth/login   { cnpj, email, senha } -> 200 { usuario, empresa } + Set-Cookie
   *   GET  /api/auth/me                             -> 200 { usuario, empresa } | 401
   *   POST /api/auth/logout                         -> 200 (idempotente)
   *
   * COMO ISTO DIFERE DO LOGIN LEGADO (js/main.js): lá, doLogin() compara
   * a senha em texto puro contra o seed de localStorage, define
   * CURRENT_USER no navegador e propaga a "sessão" em localStorage,
   * sessionStorage, cookie legível e querystring (?_s=<base64>) entre as
   * páginas. Aqui nada disso acontece:
   *
   *   - a senha vai UMA vez para o servidor e não é guardada em lugar
   *     nenhum, nem em variável de módulo;
   *   - a sessão vive exclusivamente no cookie HttpOnly emitido pelo
   *     backend, invisível ao JavaScript e não forjável pelo cliente;
   *   - identidade (usuário/empresa) fica só EM MEMÓRIA, para a tela
   *     renderizar nome e perfil. Nunca em localStorage, sessionStorage,
   *     cookie legível ou URL — quem decide quem você é continua sendo o
   *     servidor, a cada requisição;
   *   - o perfil devolvido em `identidade()` serve para EXIBIR (por
   *     exemplo, esconder um botão), jamais para autorizar. A autoridade
   *     real é decidida no backend (Subetapas 3J a 3Q, com
   *     autoridade-administrativa.js relendo perfil e autorizações
   *     individuais do banco a cada operação), e uma interface que mostre
   *     um botão a mais continua recebendo 403 ao tentar usá-lo.
   *
   * Este módulo NÃO altera o login legado nem as telas existentes: ele é
   * a fundação que a próxima subetapa usará. As duas coisas convivem sem
   * interferência porque não compartilham estado algum.
   */

  var MENSAGEM_CREDENCIAIS = 'CNPJ, e-mail ou senha incorretos.';

  // Identidade da sessão corrente, só para renderização. Zerada no
  // logout, em qualquer 401 e quando a sessão não é confirmada.
  var identidadeEmMemoria = null;

  function http() {
    var cliente = global.EpiHttp;
    if (!cliente) {
      throw new Error('EpiHttp não carregado: inclua js/api-http.js antes de js/auth-session.js');
    }
    return cliente;
  }

  function guardarIdentidade(dados) {
    identidadeEmMemoria = (dados && dados.usuario)
      ? { usuario: dados.usuario, empresa: dados.empresa }
      : null;
    return identidadeEmMemoria;
  }

  function esquecerIdentidade() {
    identidadeEmMemoria = null;
  }

  /**
   * Autentica contra o backend. A senha é usada apenas na montagem desta
   * requisição e sai de escopo em seguida — não é guardada, não é
   * registrada em log e não volta no corpo da resposta.
   *
   * Recusa de credencial é deliberadamente genérica no backend (proteção
   * contra enumeração de empresa/usuário); a interface repete essa mesma
   * mensagem genérica, sem tentar descobrir o que falhou.
   *
   * @returns {Promise<{ok: boolean, identidade: ?object, resposta: object}>}
   */
  async function entrar(credenciais) {
    var c = credenciais || {};
    if (typeof c.cnpj !== 'string' || typeof c.email !== 'string' || typeof c.senha !== 'string') {
      throw new TypeError('cnpj, email e senha são obrigatórios');
    }

    var resposta = await http().requisitar('POST', '/auth/login', {
      corpo: { cnpj: c.cnpj, email: c.email, senha: c.senha },
    });

    if (!resposta.ok) {
      esquecerIdentidade();
      return { ok: false, identidade: null, resposta: resposta };
    }

    return { ok: true, identidade: guardarIdentidade(resposta.dados), resposta: resposta };
  }

  /**
   * Confirma com o servidor se há sessão válida e atualiza a identidade
   * em memória. É a única forma legítima de saber se o usuário está
   * autenticado: a ausência de identidade em memória (um F5, por
   * exemplo) não significa ausência de sessão, porque o cookie sobrevive
   * ao recarregamento e o JavaScript não consegue lê-lo.
   *
   * @returns {Promise<{autenticado: boolean, identidade: ?object, resposta: object}>}
   */
  async function sessaoAtual() {
    var resposta = await http().requisitar('GET', '/auth/me');

    if (!resposta.ok) {
      esquecerIdentidade();
      return { autenticado: false, identidade: null, resposta: resposta };
    }

    return { autenticado: true, identidade: guardarIdentidade(resposta.dados), resposta: resposta };
  }

  /**
   * Encerra a sessão. O backend é idempotente (cookie ausente, expirado
   * ou já revogado também respondem 200), então a única situação que não
   * é sucesso é falha de rede — e mesmo nela a identidade local é
   * descartada: manter na tela um usuário que se pediu para sair seria
   * pior do que mostrar a tela de login.
   */
  async function sair() {
    var resposta = await http().requisitar('POST', '/auth/logout');
    esquecerIdentidade();
    return { ok: resposta.ok, resposta: resposta };
  }

  /**
   * Identidade conhecida nesta aba, ou null. NÃO é prova de
   * autenticação — é cache de renderização. Para decidir qualquer coisa
   * que importe, use sessaoAtual() (que pergunta ao servidor) ou
   * simplesmente faça a operação e trate o 401/403 da resposta.
   */
  function identidade() {
    if (identidadeEmMemoria === null) return null;
    return {
      usuario: identidadeEmMemoria.usuario,
      empresa: identidadeEmMemoria.empresa,
    };
  }

  global.EpiAuth = {
    entrar: entrar,
    sessaoAtual: sessaoAtual,
    sair: sair,
    identidade: identidade,
    MENSAGEM_CREDENCIAIS: MENSAGEM_CREDENCIAIS,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.EpiAuth;
  }
})(typeof window !== 'undefined' ? window : globalThis);
