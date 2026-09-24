(function (global) {
  'use strict';

  /**
   * EpiSessaoEmpresarial — sessão empresarial REAL para as páginas de
   * frontend/pages/ (Bloco 9, Etapa C, Parte C0).
   *
   * Camada comum que substitui, nas páginas integradas, qualquer login
   * próprio (o formulário antigo por CNPJ das telas do Incremento 8 e o
   * login simulado de js/main.js). A única fonte de "quem está usando e em
   * qual empresa" passa a ser o servidor:
   *
   *   GET  /api/auth/me          sessão empresarial (cookie HttpOnly gepi_sessao)
   *                              -> { usuario, empresa } | 401
   *   GET  /api/auth/global/me   só para saber se há mais de uma empresa
   *                              (exibir "Trocar de empresa"); não autoriza nada
   *   POST /api/auth/global/logout  "Sair" (encerra sessão global e empresarial)
   *
   * Sem sessão válida (401, ou resposta sem o formato esperado) a página é
   * levada ao Portal do Cliente (frontend/portal/), que faz o login global
   * e a seleção de empresa. "Trocar de empresa" também é do Portal: ele
   * revalida o vínculo no servidor e revoga a sessão anterior.
   *
   * O QUE ESTE MÓDULO NUNCA FAZ:
   *   - não lê nem grava token, sessão ou identidade em localStorage,
   *     sessionStorage, cookie legível ou URL (a sessão vive só no cookie
   *     HttpOnly, invisível a este código);
   *   - não usa js/db-api.js (banco simulado epi_db_v2) nem js/main.js
   *     (login simulado) — as páginas integradas não carregam esses
   *     arquivos;
   *   - não decide autorização: o contexto em memória serve para EXIBIR
   *     nome, empresa e perfil. Cada operação continua sendo autorizada
   *     pelo backend (RBAC), que responde 401/403 quando for o caso.
   *
   * O QUE ELE LIMPA, POR DEFESA: rastros do protótipo que poderiam ser
   * confundidos com uma sessão — a chave 'epi-session-user' que js/main.js
   * grava em localStorage, sessionStorage e cookie legível, e o parâmetro
   * ?_s=<base64> que js/main.js acrescenta aos links do menu. Isso impede
   * que uma página do protótipo, aberta depois no mesmo navegador, se
   * apresente como "logada" com o usuário de exemplo enquanto há uma
   * empresa real autenticada. O banco simulado (epi_db_v2) NÃO é apagado:
   * pertence às páginas ainda não integradas e não é lido aqui.
   *
   * A `janela` (location, history, storages, document) é injetável para
   * teste sem navegador, como o `fetch` em js/api-http.js.
   */

  var PORTAL = {
    login: '../portal/index.html',
    empresas: '../portal/empresas.html',
    inicio: '../portal/inicio.html',
  };

  // Rastros do protótipo (js/main.js): SESSION_KEY e o parâmetro de URL.
  var CHAVE_SESSAO_LEGADA = 'epi-session-user';
  var PARAMETRO_SESSAO_LEGADA = '_s';

  var PERFIS = ['MASTER', 'ADMINISTRADOR', 'SUPERVISOR', 'USUARIO'];
  var ROTULOS_PERFIL = { MASTER: 'Master', ADMINISTRADOR: 'Administrador', SUPERVISOR: 'Supervisor', USUARIO: 'Usuário' };

  var MENSAGENS = {
    VERIFICANDO: 'Verificando sua sessão…',
    FALHA: 'Não foi possível confirmar sua sessão agora. Verifique a conexão e tente novamente pelo Portal do Cliente.',
    FALHA_SAIDA: 'Não foi possível confirmar a saída com o servidor. Sua sessão pode continuar ativa. Verifique a conexão e clique em Sair novamente.',
  };

  var janelaInjetada = null;
  var contextoAtual = null;

  function janela() { return janelaInjetada || global; }

  function http() {
    var cliente = global.EpiHttp;
    if (!cliente) {
      throw new Error('EpiHttp não carregado: inclua js/api-http.js antes de js/sessao-empresarial.js');
    }
    return cliente;
  }

  function inteiroPositivo(v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v && v > 0; }
  function texto(v) { return typeof v === 'string' && v.length > 0; }

  /**
   * Aceita só o formato que o backend devolve; copia apenas os campos de
   * exibição (lista explícita). Qualquer outra coisa é tratada como
   * ausência de sessão — nunca como sessão parcial.
   */
  function validarContexto(dados) {
    if (!dados || typeof dados !== 'object') return null;
    var u = dados.usuario;
    var e = dados.empresa;
    if (!u || !e) return null;
    if (!inteiroPositivo(u.id) || !texto(u.nome) || PERFIS.indexOf(u.perfil) === -1) return null;
    if (!inteiroPositivo(e.id) || !texto(e.nome)) return null;
    return {
      usuario: { id: u.id, nome: u.nome, email: typeof u.email === 'string' ? u.email : null, perfil: u.perfil },
      empresa: { id: e.id, nome: e.nome, cnpj: typeof e.cnpj === 'string' ? e.cnpj : null },
    };
  }

  function copiar(ctx) {
    return ctx === null ? null : {
      usuario: { id: ctx.usuario.id, nome: ctx.usuario.nome, email: ctx.usuario.email, perfil: ctx.usuario.perfil },
      empresa: { id: ctx.empresa.id, nome: ctx.empresa.nome, cnpj: ctx.empresa.cnpj },
    };
  }

  /** Remove a "sessão" do protótipo das três camadas onde js/main.js a grava. Nunca lança. */
  function removerSessaoLegada(j) {
    try { if (j.localStorage) j.localStorage.removeItem(CHAVE_SESSAO_LEGADA); } catch (e) { /* armazenamento indisponível */ }
    try { if (j.sessionStorage) j.sessionStorage.removeItem(CHAVE_SESSAO_LEGADA); } catch (e) { /* idem */ }
    try { if (j.document) j.document.cookie = CHAVE_SESSAO_LEGADA + '=; path=/; max-age=0'; } catch (e) { /* idem */ }
  }

  /** Tira ?_s= da barra de endereço sem recarregar. Devolve true se havia. */
  function removerParametroDaUrl(j) {
    var loc = j.location;
    if (!loc || typeof loc.search !== 'string' || loc.search.length === 0) return false;
    var parametros = new URLSearchParams(loc.search);
    if (!parametros.has(PARAMETRO_SESSAO_LEGADA)) return false;
    parametros.delete(PARAMETRO_SESSAO_LEGADA);
    var resto = parametros.toString();
    if (j.history && typeof j.history.replaceState === 'function') {
      j.history.replaceState(null, '', loc.pathname + (resto ? '?' + resto : '') + (loc.hash || ''));
    }
    return true;
  }

  function irPara(destino) {
    var j = janela();
    j.location.replace(PORTAL[destino] || PORTAL.login);
  }

  /**
   * Confirma a sessão empresarial no servidor.
   *
   * @returns {Promise<{autenticado: true, contexto: object, podeTrocar: boolean}
   *   | {autenticado: false, motivo: 'SEM_SESSAO'|'RESPOSTA_INVALIDA'|'FALHA'}>}
   *   SEM_SESSAO e RESPOSTA_INVALIDA já redirecionaram ao Portal. FALHA
   *   (rede, 5xx) não redireciona: a página mostra o aviso — mandar ao
   *   login por uma queda de rede apagaria o contexto sem motivo.
   */
  async function iniciar(opcoes) {
    var o = opcoes || {};
    janelaInjetada = o.janela || null;
    var j = janela();
    contextoAtual = null;

    removerParametroDaUrl(j);
    removerSessaoLegada(j);

    var resposta = await http().requisitar('GET', '/auth/me');
    if (!resposta.ok) {
      if (resposta.status === 401) {
        irPara('login');
        return { autenticado: false, motivo: 'SEM_SESSAO' };
      }
      return { autenticado: false, motivo: 'FALHA' };
    }

    var ctx = validarContexto(resposta.dados);
    if (ctx === null) {
      irPara('login');
      return { autenticado: false, motivo: 'RESPOSTA_INVALIDA' };
    }
    contextoAtual = ctx;

    // Só apresentação: "Trocar de empresa" aparece quando a pessoa tem
    // mais de uma empresa autorizada. Falha aqui não derruba a página.
    var podeTrocar = false;
    try {
      var global_ = await http().requisitar('GET', '/auth/global/me');
      podeTrocar = !!(global_.ok && global_.dados && Array.isArray(global_.dados.empresas) && global_.dados.empresas.length > 1);
    } catch (e) {
      podeTrocar = false;
    }

    return { autenticado: true, contexto: copiar(ctx), podeTrocar: podeTrocar };
  }

  /** 401 durante o uso: o servidor encerrou a sessão. Volta ao Portal. */
  function sessaoEncerrada() {
    contextoAtual = null;
    irPara('login');
  }

  /**
   * "Sair": pede ao servidor o encerramento das sessões global e
   * empresarial e SÓ ENTÃO vai ao Portal (correção pós-auditoria da C0).
   *
   * A saída só é tratada como concluída com resposta 2xx do backend: é
   * ele quem revoga as sessões e remove os cookies HttpOnly (que este
   * código não consegue ler nem apagar). Falha de rede ou resposta de erro
   * NÃO confirmam nada. Nesse caso a página continua onde está, com o
   * contexto intacto, e a pessoa pode tentar de novo. Nunca se afirma uma
   * revogação que não aconteceu.
   *
   * @returns {Promise<{ok: true} | {ok: false, motivo: 'REDE'|'HTTP', status: number, mensagem: string}>}
   */
  async function sair() {
    var resposta;
    try {
      resposta = await http().requisitar('POST', '/auth/global/logout');
    } catch (erro) {
      return { ok: false, motivo: 'REDE', status: 0, mensagem: MENSAGENS.FALHA_SAIDA };
    }
    if (!resposta || !resposta.ok) {
      var status = resposta && typeof resposta.status === 'number' ? resposta.status : 0;
      return { ok: false, motivo: status === 0 ? 'REDE' : 'HTTP', status: status, mensagem: MENSAGENS.FALHA_SAIDA };
    }
    contextoAtual = null;
    irPara('login');
    return { ok: true };
  }

  /** "Trocar de empresa": a escolha e a revalidação são do Portal. */
  function trocarEmpresa() {
    irPara('empresas');
  }

  function rotuloIdentificacao(ctx) {
    if (!ctx) return '';
    return ctx.usuario.nome + ' · ' + ctx.empresa.nome + ' · ' + (ROTULOS_PERFIL[ctx.usuario.perfil] || ctx.usuario.perfil);
  }

  /**
   * Liga a sessão aos elementos comuns da página: tela de verificação,
   * identificação, "Sair" e "Trocar de empresa". Devolve o contexto quando
   * a sessão é válida, ou null (a página não carrega dado nenhum).
   *
   * "Sair": o botão fica desabilitado enquanto o servidor responde. Com a
   * saída confirmada, `aoEncerrar` limpa a tela e a página vai ao Portal.
   * Sem confirmação, a tela NÃO é limpa (a sessão pode continuar ativa),
   * `aoFalharSaida(mensagem)` exibe o aviso e o botão volta a ficar
   * disponível para uma nova tentativa.
   *
   * @param {{elementos: {tela, mensagem, linkPortal, identificacao, botaoSair, botaoTrocar},
   *          aoEncerrar?: Function, aoFalharSaida?: Function, janela?: object}} opcoes
   */
  async function montar(opcoes) {
    var o = opcoes || {};
    var el = o.elementos || {};
    var aoEncerrar = typeof o.aoEncerrar === 'function' ? o.aoEncerrar : function () {};
    var aoFalharSaida = typeof o.aoFalharSaida === 'function' ? o.aoFalharSaida : function () {};

    if (el.mensagem) el.mensagem.textContent = MENSAGENS.VERIFICANDO;

    var r;
    try {
      r = await iniciar({ janela: o.janela });
    } catch (erro) {
      r = { autenticado: false, motivo: 'FALHA' };
    }

    if (!r.autenticado) {
      if (r.motivo === 'FALHA') {
        if (el.mensagem) el.mensagem.textContent = MENSAGENS.FALHA;
        if (el.linkPortal) el.linkPortal.style.display = '';
      }
      return null;
    }

    if (el.identificacao) el.identificacao.textContent = rotuloIdentificacao(r.contexto);
    if (el.botaoTrocar) {
      el.botaoTrocar.style.display = r.podeTrocar ? '' : 'none';
      el.botaoTrocar.addEventListener('click', function () { aoEncerrar(); trocarEmpresa(); });
    }
    if (el.botaoSair) {
      el.botaoSair.addEventListener('click', function () {
        if (el.botaoSair.disabled) return;
        el.botaoSair.disabled = true;
        return sair().then(function (resultado) {
          if (resultado.ok) {
            aoEncerrar();
            return resultado;
          }
          el.botaoSair.disabled = false;
          aoFalharSaida(resultado.mensagem);
          return resultado;
        });
      });
    }
    if (el.tela) el.tela.style.display = 'none';
    return r.contexto;
  }

  function contexto() { return copiar(contextoAtual); }

  global.EpiSessaoEmpresarial = {
    iniciar: iniciar,
    montar: montar,
    sessaoEncerrada: sessaoEncerrada,
    sair: sair,
    trocarEmpresa: trocarEmpresa,
    contexto: contexto,
    rotuloIdentificacao: rotuloIdentificacao,
    PORTAL: PORTAL,
    MENSAGENS: MENSAGENS,
    CHAVE_SESSAO_LEGADA: CHAVE_SESSAO_LEGADA,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.EpiSessaoEmpresarial;
  }
})(typeof window !== 'undefined' ? window : globalThis);
