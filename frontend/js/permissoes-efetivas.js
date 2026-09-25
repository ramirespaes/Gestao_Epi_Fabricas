(function (global) {
  'use strict';

  /**
   * EpiPermissoes — permissões EFETIVAS do usuário na empresa selecionada
   * (Bloco 9, Etapa C, Parte C1), vindas de GET /api/auth/permissoes.
   *
   * SOMENTE APRESENTAÇÃO. O backend calcula (com as mesmas funções que usa
   * para autorizar cada operação) e continua sendo a autoridade final: uma
   * chamada direta a uma API proibida recebe 403 independentemente do que
   * esta camada mostrar ou esconder.
   *
   * FALHA FECHADA. Consulta que falha (rede, 5xx), resposta fora do formato,
   * ou resposta de OUTRA empresa, OUTRO usuário ou OUTRO perfil que não os
   * exibidos pela página (troca em outra aba, perfil alterado) produzem
   * "nenhuma permissão": links administrativos escondidos, páginas sem
   * dados, botões de escrita ausentes. Nunca há valor padrão "liberado":
   * cada decisão exige `true` explícito vindo do servidor.
   *
   * SEM CACHE NO NAVEGADOR. Nada vai para localStorage, sessionStorage,
   * cookie ou URL; a resposta vive só na memória da página, e cada página
   * consulta de novo ao carregar (a API responde com Cache-Control:
   * no-store). Assim uma alteração de grupo, perfil ou exceção individual,
   * ou uma troca de empresa, vale no próximo carregamento — e, antes dele,
   * o próprio backend já recusa o que deixou de ser permitido.
   *
   * AS PÁGINAS ADMINISTRATIVAS têm autoridade própria (não são permissões
   * de recurso comuns) — ver backend/src/services/autoridade-administrativa.js
   * e permissoes-efetivas.service.js. O mapa PAGINAS abaixo diz, para cada
   * página, quais áreas administrativas ela exige para abrir e para
   * alterar. As páginas de permissões e de integrantes listam os grupos
   * pela rota de grupos (que exige a autoridade de grupos), por isso exigem
   * também gruposAcesso.consultar para abrir: sem ela, a página não
   * conseguiria funcionar e o link não é oferecido.
   */

  var PAGINAS = {
    'grupos-acesso': {
      abrir: [['gruposAcesso', 'consultar']],
      alterar: [['gruposAcesso', 'alterar']],
    },
    'grupo-permissoes': {
      abrir: [['permissoesGrupo', 'consultar'], ['gruposAcesso', 'consultar']],
      alterar: [['permissoesGrupo', 'alterar']],
    },
    'grupo-usuarios': {
      abrir: [['vinculosGrupo', 'consultar'], ['gruposAcesso', 'consultar']],
      alterar: [['vinculosGrupo', 'alterar']],
    },
    'autorizacoes-individuais': {
      abrir: [['autorizacoesIndividuais', 'consultar']],
      // Escrita nesta página é por operação (conceder direto / delegar /
      // revogar a própria concessão), decidida item a item.
      alterar: [],
    },
    // Parte C2: primeira página por RECURSO (não por área administrativa).
    // Abrir = materials.visualizar; salvar = materials.criar. A entrada
    // inicial de estoque é a ação MOVIMENTAR_ESTOQUE, consultada à parte
    // pela página (acao()), independente de criar.
    materials: {
      abrir: [{ recurso: 'materials', operacao: 'visualizar' }],
      alterar: [{ recurso: 'materials', operacao: 'criar' }],
    },
  };

  var MENSAGENS = {
    FALHA: 'Não foi possível carregar suas permissões nesta empresa. Nenhuma operação foi liberada. Recarregue a página para tentar novamente.',
    SEM_ACESSO: 'Seu perfil nesta empresa não tem acesso a este módulo.',
    CONTEXTO_DIVERGENTE: 'Sua sessão mudou (outra empresa, outro usuário ou outro perfil), provavelmente em outra aba. Nenhuma operação foi liberada. Recarregue a página.',
  };

  var AREAS = ['gruposAcesso', 'permissoesGrupo', 'vinculosGrupo'];
  var OPERACOES_RECURSO = ['visualizar', 'criar', 'editar', 'excluir'];

  function http() {
    var cliente = global.EpiHttp;
    if (!cliente) {
      throw new Error('EpiHttp não carregado: inclua js/api-http.js antes de js/permissoes-efetivas.js');
    }
    return cliente;
  }

  function ehObjeto(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function soBooleanos(obj, chaves) {
    if (!ehObjeto(obj)) return false;
    for (var i = 0; i < chaves.length; i += 1) {
      if (typeof obj[chaves[i]] !== 'boolean') return false;
    }
    return true;
  }
  function inteiroPositivo(v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v && v > 0; }

  /**
   * Aceita só o formato exato do backend; qualquer desvio é "sem
   * permissões" (falha fechada). Copia o que valida — nada além.
   */
  function validar(dados) {
    if (!ehObjeto(dados) || !inteiroPositivo(dados.empresaId) || !inteiroPositivo(dados.usuarioId)) return null;
    if (typeof dados.perfil !== 'string' || !ehObjeto(dados.recursos) || !ehObjeto(dados.acoes) || !ehObjeto(dados.administracao)) return null;

    var recursos = {};
    var nomes = Object.keys(dados.recursos);
    for (var i = 0; i < nomes.length; i += 1) {
      if (!soBooleanos(dados.recursos[nomes[i]], OPERACOES_RECURSO)) return null;
      recursos[nomes[i]] = {
        visualizar: dados.recursos[nomes[i]].visualizar,
        criar: dados.recursos[nomes[i]].criar,
        editar: dados.recursos[nomes[i]].editar,
        excluir: dados.recursos[nomes[i]].excluir,
      };
    }

    var acoes = {};
    var codigos = Object.keys(dados.acoes);
    for (var j = 0; j < codigos.length; j += 1) {
      if (typeof dados.acoes[codigos[j]] !== 'boolean') return null;
      acoes[codigos[j]] = dados.acoes[codigos[j]];
    }

    var adm = dados.administracao;
    var administracao = {};
    for (var k = 0; k < AREAS.length; k += 1) {
      if (!soBooleanos(adm[AREAS[k]], ['consultar', 'alterar'])) return null;
      administracao[AREAS[k]] = { consultar: adm[AREAS[k]].consultar, alterar: adm[AREAS[k]].alterar };
    }
    if (!soBooleanos(adm.autorizacoesIndividuais, ['consultar', 'concederDireta', 'delegar'])) return null;
    administracao.autorizacoesIndividuais = {
      consultar: adm.autorizacoesIndividuais.consultar,
      concederDireta: adm.autorizacoesIndividuais.concederDireta,
      delegar: adm.autorizacoesIndividuais.delegar,
    };

    return {
      empresaId: dados.empresaId,
      usuarioId: dados.usuarioId,
      perfil: dados.perfil,
      recursos: recursos,
      acoes: acoes,
      administracao: administracao,
    };
  }

  /**
   * O contexto esperado precisa estar COMPLETO: empresa, usuário e perfil
   * da sessão que esta página exibe (EpiSessaoEmpresarial / Portal).
   */
  function contextoEsperadoValido(e) {
    return !!(e && inteiroPositivo(e.empresaId) && inteiroPositivo(e.usuarioId) && typeof e.perfil === 'string' && e.perfil.length > 0);
  }

  /**
   * Consulta as permissões no servidor.
   *
   * CORRESPONDÊNCIA COM A PÁGINA (correção pós-auditoria da C1): a resposta
   * só vale se for da MESMA empresa, do MESMO usuário e com o MESMO perfil
   * que a página identificou ao abrir. Outra aba pode ter trocado de
   * empresa, entrado com outra pessoa ou o perfil pode ter mudado no
   * servidor; nesses casos a página estaria mostrando uma identidade e
   * aplicando permissões de outra. Qualquer divergência — ou contexto
   * esperado incompleto — falha fechada: nada é liberado.
   *
   * @param {{empresaId: number, usuarioId: number, perfil: string}} esperado
   * @returns {Promise<{ok: true, permissoes: object}
   *   | {ok: false, motivo: 'SEM_SESSAO'|'FALHA'|'RESPOSTA_INVALIDA'|'CONTEXTO_DIVERGENTE'}>}
   */
  async function carregar(esperado) {
    var e = esperado || {};
    if (!contextoEsperadoValido(e)) {
      // Sem saber quem a página exibe, não há como conferir a resposta:
      // nem consulta o servidor.
      return { ok: false, motivo: 'CONTEXTO_DIVERGENTE' };
    }
    var resposta;
    try {
      resposta = await http().requisitar('GET', '/auth/permissoes');
    } catch (erro) {
      return { ok: false, motivo: 'FALHA' };
    }
    if (!resposta.ok) {
      return { ok: false, motivo: resposta.status === 401 ? 'SEM_SESSAO' : 'FALHA' };
    }
    var permissoes = validar(resposta.dados);
    if (permissoes === null) return { ok: false, motivo: 'RESPOSTA_INVALIDA' };
    if (permissoes.empresaId !== e.empresaId || permissoes.usuarioId !== e.usuarioId || permissoes.perfil !== e.perfil) {
      return { ok: false, motivo: 'CONTEXTO_DIVERGENTE' };
    }
    return { ok: true, permissoes: permissoes };
  }

  function administra(permissoes, area, operacao) {
    return !!(permissoes && permissoes.administracao && permissoes.administracao[area]
      && permissoes.administracao[area][operacao] === true);
  }

  function recurso(permissoes, nome, operacao) {
    return !!(permissoes && permissoes.recursos && Object.prototype.hasOwnProperty.call(permissoes.recursos, nome)
      && permissoes.recursos[nome][operacao] === true);
  }

  function acao(permissoes, codigo) {
    return !!(permissoes && permissoes.acoes && Object.prototype.hasOwnProperty.call(permissoes.acoes, codigo)
      && permissoes.acoes[codigo] === true);
  }

  /** Exigência: [area, operacao] (administrativa) ou {recurso, operacao} (recurso). */
  function todas(permissoes, exigencias) {
    for (var i = 0; i < exigencias.length; i += 1) {
      var e = exigencias[i];
      var ok = Array.isArray(e) ? administra(permissoes, e[0], e[1]) : recurso(permissoes, e.recurso, e.operacao);
      if (!ok) return false;
    }
    return true;
  }

  function podeAbrir(permissoes, pagina) {
    var p = Object.prototype.hasOwnProperty.call(PAGINAS, pagina) ? PAGINAS[pagina] : null;
    return !!(p && permissoes && todas(permissoes, p.abrir));
  }

  function podeAlterar(permissoes, pagina) {
    var p = Object.prototype.hasOwnProperty.call(PAGINAS, pagina) ? PAGINAS[pagina] : null;
    return !!(p && podeAbrir(permissoes, pagina) && p.alterar.length > 0 && todas(permissoes, p.alterar));
  }

  /**
   * Mostra só os links de páginas que o usuário pode abrir. Links com
   * `data-pagina` nascem ocultos no HTML (falha fechada até a resposta);
   * com permissoes null, todos continuam ocultos.
   */
  function aplicarMenu(permissoes, links) {
    var lista = links ? Array.prototype.slice.call(links) : [];
    lista.forEach(function (a) {
      var pagina = a.getAttribute('data-pagina');
      a.style.display = podeAbrir(permissoes, pagina) ? '' : 'none';
    });
  }

  /**
   * Empresa, usuário e perfil a partir do contexto que a página exibe
   * ({usuario, empresa} de EpiSessaoEmpresarial ou do Portal). Campos
   * ausentes ficam null — e carregar() falha fechada.
   */
  function esperadoDoContexto(contexto) {
    var c = contexto || {};
    return {
      empresaId: c.empresa ? c.empresa.id : null,
      usuarioId: c.usuario ? c.usuario.id : null,
      perfil: c.usuario ? c.usuario.perfil : null,
    };
  }

  /**
   * Fluxo comum das páginas: consulta, aplica o menu e decide se a página
   * pode abrir. Devolve {permissoes, podeAlterar} ou null (nada deve ser
   * carregado). 401 devolve ao Portal (sessão encerrada no servidor).
   *
   * @param {{pagina: string, contexto: object, links: NodeList|Array, aviso: Function}} opcoes
   */
  async function prepararPagina(opcoes) {
    var o = opcoes || {};
    var aviso = typeof o.aviso === 'function' ? o.aviso : function () {};
    var r = await carregar(esperadoDoContexto(o.contexto));
    if (!r.ok) {
      aplicarMenu(null, o.links);
      if (r.motivo === 'SEM_SESSAO' && global.EpiSessaoEmpresarial) {
        global.EpiSessaoEmpresarial.sessaoEncerrada();
        return null;
      }
      aviso(r.motivo === 'CONTEXTO_DIVERGENTE' ? MENSAGENS.CONTEXTO_DIVERGENTE : MENSAGENS.FALHA);
      return null;
    }

    aplicarMenu(r.permissoes, o.links);
    if (!podeAbrir(r.permissoes, o.pagina)) {
      aviso(MENSAGENS.SEM_ACESSO);
      return null;
    }
    return { permissoes: r.permissoes, podeAlterar: podeAlterar(r.permissoes, o.pagina) };
  }

  /**
   * Torna um trecho renderizado somente leitura: retira os botões de
   * operação (qualquer elemento com data-acao) e desabilita os campos. Usado
   * quando o usuário pode abrir a página mas não alterar — visualizar nunca
   * implica escrita. Apresentação apenas: a API continua recusando.
   */
  function somenteLeitura(raiz) {
    if (!raiz || typeof raiz.querySelectorAll !== 'function') return;
    Array.prototype.forEach.call(raiz.querySelectorAll('[data-acao]'), function (el) {
      if (el.parentNode) el.parentNode.removeChild(el);
    });
    Array.prototype.forEach.call(raiz.querySelectorAll('select, input, textarea'), function (campo) {
      campo.disabled = true;
    });
  }

  global.EpiPermissoes = {
    carregar: carregar,
    esperadoDoContexto: esperadoDoContexto,
    prepararPagina: prepararPagina,
    somenteLeitura: somenteLeitura,
    aplicarMenu: aplicarMenu,
    podeAbrir: podeAbrir,
    podeAlterar: podeAlterar,
    administra: administra,
    recurso: recurso,
    acao: acao,
    PAGINAS: PAGINAS,
    MENSAGENS: MENSAGENS,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.EpiPermissoes;
  }
})(typeof window !== 'undefined' ? window : globalThis);
