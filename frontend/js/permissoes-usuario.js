(function (global) {
  'use strict';

  /**
   * EpiPermissoesUsuario — Gestão de Usuários → Configurar permissões / Copiar permissões.
   *
   * Configurar permissões é BINÁRIO: cada acesso é um ligado/desligado que mostra o resultado EFETIVO atual.
   * A lista vem de GET /administracao/usuarios/:id/acessos (só acessos com enforcement real no servidor); a
   * mudança é PUT .../acessos/:acesso { ligado }. Quem escolhe a camada (perfil, grupo, exceção individual) é o
   * servidor; o navegador não conhece recurso, ação, operação nem perfil e nunca calcula o efeito.
   * Master e quem não pode alterar aparecem com o controle travado. Tudo montado com nós e texto.
   */

  var SOMENTE_LEITURA = Object.freeze({
    SOMENTE_MASTER: 'Somente o Master altera os acessos individuais. Você pode consultar.',
    USUARIO_MASTER: 'O Master tem autoridade própria e máxima: os acessos dele são fixos.',
  });
  var GRUPOS = Object.freeze({
    GERAL: 'Geral',
    COLABORADORES: 'Colaboradores',
    EPIS: 'EPIs',
    ESTOQUE: 'Estoque',
    ATENDIMENTO: 'Atendimento Token',
    ADMINISTRACAO: 'Administração',
  });
  var CAMINHO = '/administracao/usuarios';
  var CAMINHO_GRUPOS = '/grupos-acesso';
  var PERFIL_FIXO = 'MASTER';

  var TEXTOS = Object.freeze({
    FALHA: 'Não foi possível carregar os acessos agora. Tente novamente.',
    SEM_AUTORIDADE: 'Sem autoridade para ver ou alterar os acessos deste usuário.',
    ALTERADO: 'Acesso atualizado.',
    FALHA_ALTERAR: 'Não foi possível alterar o acesso agora. A tela foi atualizada.',
    NAO_ENCONTRADO: 'Usuário não encontrado. A lista foi atualizada.',
    INDISPONIVEL: 'Esta função não está disponível no servidor atual. Verifique se o servidor foi atualizado.',
    MASTER_FIXO: 'O Master tem autoridade própria: os acessos dele não são configuráveis.',
    SOMENTE_MASTER: 'Somente o Master altera os acessos individuais.',
    EXIGE_SST: 'Exige o vínculo com a Segurança do Trabalho (em Alterar usuário).',
    FALTA_SST: 'Falta o vínculo: sem ele a pessoa não acessa a Aprovação.',
    GRUPO_PROPRIO: 'Você não pode alterar as permissões do seu próprio grupo.',
    GRUPO_NAO_ENCONTRADO: 'Grupo não encontrado. A lista foi atualizada.',
    GRUPO_DICA: 'Vale para todos os integrantes do grupo enquanto ele estiver ativo. Ligado: o grupo concede o acesso. Desligado: o grupo não concede (o perfil e as exceções individuais continuam valendo).',
    // Avisos informativos calculados pelo servidor (`avisos: [{ codigo }]`): a tela só traduz o código; nada é revogado.
    PARCIAL: 'Acesso parcial: só uma das duas permissões está ativa.',
    AVISOS: Object.freeze({
      FUNCIONARIOS_SEM_VISUALIZAR: 'Histórico de Funcionários está desligado, mas Cadastrar e/ou Editar Funcionário continuam concedidos: '
        + 'a página Cadastro de Colaboradores pode ficar inacessível pelo menu.',
      EXPORTAR_HISTORICO_SEM_VISUALIZAR: 'Exportar Histórico de Funcionários está ligado, mas Histórico de Funcionários está desligado. '
        + 'A exportação exige as duas permissões: sem a leitura, este acesso não autoriza o download.',
      TOKEN_SEM_CONSULTAR: 'Consultar (Atendimento Token) está desligado, mas outro acesso do Atendimento Token que depende dele continua concedido: '
        + 'as abas e os botões dessas funções podem não aparecer na Central.',
      PREVIA_SEM_HISTORICO_FUNCIONARIOS: 'Prévia do catálogo está ligada, mas Histórico de Funcionários está desligado. '
        + 'A prévia com um funcionário real exige as duas permissões: sem a leitura, a busca de funcionário não fica disponível.',
      ACESSO_PARCIAL_LEGADO: 'Acesso parcial legado: só uma das duas permissões está ativa para este usuário, então o controle aparece desligado mas parte do acesso continua valendo. '
        + 'Ligar concede as duas; desligar remove a que sobra. Nada muda até alguém agir. Acessos: ',
      // Evento (só na resposta do PUT): o servidor lista o que foi reabilitado; a regra de autorização não mudou.
      DEPENDENCIA_REABILITADA: 'Esta alteração também reabilitou um acesso que estava bloqueado para este usuário: ',
    }),
    AVISOS_GRUPO: Object.freeze({
      FUNCIONARIOS_SEM_VISUALIZAR: 'A configuração deste grupo concede Cadastrar e/ou Editar Funcionário, mas não concede o Histórico de '
        + 'Funcionários. Integrantes que não recebam essa leitura pelo perfil ou por exceção individual podem não encontrar o '
        + 'Cadastro de Colaboradores no menu.',
      EXPORTAR_HISTORICO_SEM_VISUALIZAR: 'A configuração deste grupo concede Exportar Histórico de Funcionários, mas não concede o Histórico de '
        + 'Funcionários. A exportação exige as duas permissões; para cada integrante, o resultado também depende do perfil e das '
        + 'exceções individuais.',
      TOKEN_SEM_CONSULTAR: 'A configuração deste grupo concede acessos do Atendimento Token que dependem de Consultar, mas não concede Consultar. '
        + 'Integrantes que não recebam essa leitura pelo perfil ou por exceção individual podem não ver essas funções na Central.',
      PREVIA_SEM_HISTORICO_FUNCIONARIOS: 'A configuração deste grupo concede a Prévia do catálogo, mas não concede o Histórico de Funcionários. '
        + 'A prévia com um funcionário real exige as duas permissões; para cada integrante, o resultado também depende do perfil e das '
        + 'exceções individuais.',
      ACESSO_PARCIAL_LEGADO: 'Acesso parcial legado: este grupo concede só uma das duas permissões, então o controle aparece desligado mas o grupo ainda concede parte do acesso. '
        + 'Ligar faz o grupo conceder as duas; desligar retira a concessão do grupo (o perfil e as exceções individuais dos integrantes continuam valendo). Nada muda até alguém agir. Acessos: ',
      DEPENDENCIA_REABILITADA: 'Esta alteração também reabilitou, na configuração deste grupo, um acesso que estava negado: ',
    }),
    // Copiar permissões
    COPIA_OK: 'Permissões copiadas.',
    COPIA_FALHA: 'Não foi possível copiar as permissões agora. Nada foi alterado.',
    COPIA_MESMO: 'Escolha um usuário de destino diferente da origem.',
    COPIA_SEM_USUARIOS: 'Não há outro usuário na empresa para receber a cópia.',
    COPIA_NAO_APLICA: 'O Master tem autoridade própria: não recebe grupo nem permissões individuais.',
  });

  function http() {
    if (!global.EpiHttp) throw new Error('EpiHttp não carregado: inclua js/api-http.js antes de js/permissoes-usuario.js');
    return global.EpiHttp;
  }
  function exigirId(id) {
    if (typeof id !== 'number' || !isFinite(id) || Math.floor(id) !== id || id <= 0) throw new TypeError('identificador de usuário inválido');
    return id;
  }
  // 404 só é "usuário não encontrado" quando o servidor diz isso; rota inexistente nunca é apresentada assim.
  function naoEncontrado(r, padrao) {
    if (r.codigo === 'USUARIO_NAO_ENCONTRADO' || r.codigo === 'USUARIO_ORIGEM_NAO_ENCONTRADO') return TEXTOS.NAO_ENCONTRADO;
    if (r.codigo === 'ROTA_NAO_ENCONTRADA') return TEXTOS.INDISPONIVEL;
    return padrao;
  }

  /**
   * Depois de um PUT bem-sucedido, redesenha as linhas dos OUTROS acessos que o servidor alterou (`alterados`), por
   * dependência. A linha clicada continua sendo redesenhada pela própria página (ela usa `dados.acesso`). Resposta sem
   * `alterados` (servidor anterior) não muda nada. Devolve sempre a resposta recebida.
   */
  function sincronizarResposta(tipo, id, acesso, r) {
    if (r && r.ok && r.dados && Array.isArray(r.dados.alterados) && global.document) {
      render.sincronizar(global.document, tipo, id, r.dados.alterados, acesso);
    }
    return r;
  }

  // ─── API ──────────────────────────────────────────────────────────
  var acoes = {
    /** Visão das permissões em camadas: só o resumo da cópia usa; Configurar usa `acessos`. */
    detalhar: function (id) { return http().requisitar('GET', CAMINHO + '/' + exigirId(id) + '/permissoes'); },
    acessos: function (id) { return http().requisitar('GET', CAMINHO + '/' + exigirId(id) + '/acessos'); },
    definirAcesso: function (id, acesso, ligado) {
      if (typeof acesso !== 'string' || !/^[a-zA-Z][a-zA-Z0-9]{0,39}$/.test(acesso)) throw new TypeError('acesso inválido');
      if (typeof ligado !== 'boolean') throw new TypeError('valor inválido');
      return Promise.resolve(http().requisitar('PUT', CAMINHO + '/' + exigirId(id) + '/acessos/' + acesso, { corpo: { ligado: ligado } }))
        .then(function (r) { return sincronizarResposta('usuario', id, acesso, r); });
    },
    /** Permissões do GRUPO como acessos ON/OFF (mesmas permissões de grupo existentes, visão binária). */
    acessosDoGrupo: function (grupoId) { return http().requisitar('GET', CAMINHO_GRUPOS + '/' + exigirId(grupoId) + '/acessos'); },
    definirAcessoDoGrupo: function (grupoId, acesso, ligado) {
      if (typeof acesso !== 'string' || !/^[a-zA-Z][a-zA-Z0-9]{0,39}$/.test(acesso)) throw new TypeError('acesso inválido');
      if (typeof ligado !== 'boolean') throw new TypeError('valor inválido');
      return Promise.resolve(http().requisitar('PUT', CAMINHO_GRUPOS + '/' + exigirId(grupoId) + '/acessos/' + acesso, { corpo: { ligado: ligado } }))
        .then(function (r) { return sincronizarResposta('grupo', grupoId, acesso, r); });
    },
    copiar: function (destinoId, origemId) {
      return http().requisitar('POST', CAMINHO + '/' + exigirId(destinoId) + '/permissoes/copiar', { corpo: { origemId: exigirId(origemId) } });
    },
  };

  // ─── Modelo ───────────────────────────────────────────────────────
  var modelo = {
    erro: function (r) {
      if (r && r.codigo === 'USUARIO_MASTER_PERMISSOES_FIXAS') return TEXTOS.MASTER_FIXO;
      if (r && r.codigo === 'PERMISSOES_INDIVIDUAIS_SOMENTE_MASTER') return TEXTOS.SOMENTE_MASTER;
      if (r && r.codigo === 'GRUPO_PERMISSAO_PROPRIO_GRUPO') return TEXTOS.GRUPO_PROPRIO;
      if (r && r.status === 403) return TEXTOS.SEM_AUTORIDADE;
      if (r && r.codigo === 'GRUPO_NAO_ENCONTRADO') return TEXTOS.GRUPO_NAO_ENCONTRADO;
      if (r && r.status === 404) return naoEncontrado(r, TEXTOS.FALHA_ALTERAR);
      return TEXTOS.FALHA_ALTERAR;
    },
    /** Tipo de conta da LINHA (nunca o de quem age) que não tem grupo nem camada individual: só avisa; o servidor recusa de qualquer forma. */
    perfilFixo: function (perfil) { return perfil === PERFIL_FIXO; },
    /** Texto do resultado da cópia: diz o que foi copiado e o que ficou de fora. */
    mensagemCopia: function (r) {
      var c = r || {};
      var partes = [TEXTOS.COPIA_OK];
      if (c.grupo && c.grupo.motivo === 'GRUPO_INATIVO') partes.push('O grupo da origem está inativo e não foi vinculado.');
      if (c.individual && c.individual.executado === false && c.individual.motivo === 'SOMENTE_MASTER') partes.push('As permissões individuais não foram copiadas: somente o Master as copia.');
      return partes.join(' ');
    },
    erroCopia: function (r) {
      if (r && r.codigo === 'USUARIO_MASTER_PERMISSOES_FIXAS') return TEXTOS.COPIA_NAO_APLICA;
      if (r && r.codigo === 'COPIA_PARA_O_PROPRIO_USUARIO') return TEXTOS.COPIA_MESMO;
      if (r && r.status === 403) return TEXTOS.SEM_AUTORIDADE;
      if (r && r.status === 404) return naoEncontrado(r, TEXTOS.COPIA_FALHA);
      return TEXTOS.COPIA_FALHA;
    },
    validoAcessos: function (d) {
      return !!d && (!!d.usuario || !!d.grupo) && Array.isArray(d.toggles);
    },
    /** Agrupa na ordem dos grupos conhecidos; acesso de grupo desconhecido vai ao fim, nunca some. */
    agrupar: function (toggles) {
      var porGrupo = {};
      var ordem = [];
      toggles.forEach(function (t) {
        if (!Object.prototype.hasOwnProperty.call(porGrupo, t.grupo)) { porGrupo[t.grupo] = []; ordem.push(t.grupo); }
        porGrupo[t.grupo].push(t);
      });
      var conhecidos = Object.keys(GRUPOS).filter(function (g) { return porGrupo[g]; });
      var outros = ordem.filter(function (g) { return !GRUPOS[g]; });
      return conhecidos.concat(outros).map(function (g) { return { grupo: g, rotulo: GRUPOS[g] || g, itens: porGrupo[g] }; });
    },
    resumo: function (d) {
      var r = d.resumoIndividual || { recursos: 0, autorizacoes: 0, bloqueios: 0 };
      return { grupo: d.grupo ? d.grupo.nome : null, recursos: r.recursos, autorizacoes: r.autorizacoes, bloqueios: r.bloqueios };
    },
    valido: function (d) {
      return !!d && !!d.usuario && Array.isArray(d.recursos) && Array.isArray(d.acoes);
    },
  };

  // ─── Render (nós e texto) ─────────────────────────────────────────
  function no(doc, tag, atributos, filhos) {
    var el = doc.createElement(tag);
    Object.keys(atributos || {}).forEach(function (k) {
      var v = atributos[k];
      if (v === null || v === undefined || v === false) return;
      el.setAttribute(k, String(v));
    });
    (filhos || []).forEach(function (f) {
      if (f === null || f === undefined || f === false) return;
      el.appendChild(typeof f === 'string' ? doc.createTextNode(f) : f);
    });
    return el;
  }
  function select(doc, atributos, opcoes, valor) {
    var s = no(doc, 'select', Object.assign({ class: 'in' }, atributos), opcoes.map(function (o) { return no(doc, 'option', { value: o[0] }, [o[1]]); }));
    s.value = valor;
    return s;
  }
  function cabecalho(doc, titulo) {
    return no(doc, 'div', { class: 'mh' }, [
      no(doc, 'h2', {}, [titulo]),
      no(doc, 'button', { class: 'btn icon ghost', type: 'button', 'data-close': '', 'aria-label': 'Fechar' }, ['✕']),
    ]);
  }

  var render = {
    /** "Nome da função  [interruptor]": sem seletores, sem três estados, sem tabela técnica. */
    linhaAcesso: function (doc, t, editavel) {
      var entrada = no(doc, 'input', { type: 'checkbox', role: 'switch', 'data-acesso': t.id, 'aria-label': t.rotulo, disabled: editavel ? null : '' });
      entrada.checked = t.ligado === true;
      if (t.ligado === true) entrada.setAttribute('checked', '');
      return no(doc, 'div', { class: 'prow', 'data-linha-acesso': t.id }, [
        no(doc, 'span', { class: 'lbl' }, [t.rotulo, t.exigeVinculoSst === true ? no(doc, 'small', { 'data-aviso-sst': '' }, [
          TEXTOS.EXIGE_SST + (t.ligado === true && t.vinculoSst !== true ? ' ' + TEXTOS.FALTA_SST : '')]) : null,
        t.parcial === true && t.ligado !== true ? no(doc, 'small', { 'data-parcial': '' }, [TEXTOS.PARCIAL]) : null]),
        no(doc, 'label', { class: 'switch' }, [entrada, no(doc, 'span', { class: 't' })]),
      ]);
    },
    /**
     * Redesenha as linhas dos acessos alterados por dependência, SÓ se o modal aberto é do mesmo alvo (tipo e id) — uma
     * resposta que chega depois de o modal ser trocado nunca toca em outro usuário ou grupo. Ignora o acesso clicado
     * (a página o redesenha), entradas malformadas e acessos que não estão na janela. Mantém o estado editável da linha.
     */
    sincronizar: function (doc, tipo, id, alterados, clicado) {
      var raiz = doc.querySelector('[data-alvo-acessos]');
      if (!raiz || raiz.getAttribute('data-alvo-acessos') !== tipo + ':' + id) return 0;
      var feitos = 0;
      (Array.isArray(alterados) ? alterados : []).forEach(function (t) {
        if (!t || typeof t !== 'object' || typeof t.id !== 'string' || typeof t.rotulo !== 'string' || typeof t.ligado !== 'boolean' || t.id === clicado) return;
        var linhas = raiz.querySelectorAll('[data-linha-acesso]');
        var atual = null;
        for (var i = 0; i < linhas.length; i += 1) {
          if (linhas[i].getAttribute('data-linha-acesso') === t.id) atual = linhas[i];
        }
        if (!atual || !atual.parentNode) return;
        var entrada = atual.querySelector('input[data-acesso]');
        var nova = render.linhaAcesso(doc, t, !!entrada && !entrada.disabled);
        atual.parentNode.insertBefore(nova, atual);
        atual.parentNode.removeChild(atual);
        feitos += 1;
      });
      return feitos;
    },
    /** Preenche a área de avisos com os códigos conhecidos (texto do usuário ou do grupo); sem nenhum, a área some. */
    avisos: function (doc, area, avisos, ehGrupo) {
      var textos = ehGrupo ? TEXTOS.AVISOS_GRUPO : TEXTOS.AVISOS;
      var itens = (Array.isArray(avisos) ? avisos : []).filter(function (a) {
        return a && typeof a.codigo === 'string' && Object.prototype.hasOwnProperty.call(textos, a.codigo);
      }).map(function (a) {
        // Aviso de evento: o servidor lista os acessos afetados (só texto, nunca HTML); sem lista válida, o texto-base basta.
        var nomes = Array.isArray(a.acessos) ? a.acessos.filter(function (n) { return typeof n === 'string' && n.length > 0 && n.length <= 120; }).slice(0, 10) : [];
        return no(doc, 'p', { 'data-aviso': a.codigo, style: 'margin:0' }, [textos[a.codigo] + (nomes.length ? nomes.join(', ') + '.' : '')]);
      });
      area.replaceChildren.apply(area, itens);
      area.style.display = itens.length ? '' : 'none';
      return area;
    },
    /** O modal inteiro; a lista é exatamente a que `d` traz. */
    modalAcessos: function (doc, d) {
      var ehGrupo = !d.usuario && !!d.grupo;
      var u = ehGrupo ? d.grupo : d.usuario;
      // No grupo, quem decide é o servidor (autoridade e grupo próprio); a tela não esconde nada por conta própria.
      var editavel = (ehGrupo || d.podeAlterar === true) && !d.toggles.some(function (t) { return t.fixo === true; });
      var aviso = editavel ? null : no(doc, 'p', { class: 'dim', id: 'avisoSomenteLeitura', style: 'margin:0 0 12px;font-size:.85rem' }, [SOMENTE_LEITURA[d.motivoSomenteLeitura] || '']);
      var dicaGrupo = ehGrupo ? no(doc, 'p', { class: 'dim', id: 'dicaGrupo', style: 'margin:0 0 12px;font-size:.85rem' }, [TEXTOS.GRUPO_DICA]) : null;
      var avisos = render.avisos(doc, no(doc, 'div', { id: 'avisoDependencias', role: 'status', style: 'margin:0 0 12px;font-size:.85rem;color:#C07000' }), d.avisos, ehGrupo);
      var secoes = modelo.agrupar(d.toggles).map(function (g) {
        return no(doc, 'div', { 'data-grupo-acesso': g.grupo }, [no(doc, 'h3', {}, [g.rotulo])].concat(g.itens.map(function (t) { return render.linhaAcesso(doc, t, editavel); })));
      });
      return [
        cabecalho(doc, (ehGrupo ? 'Permissões do grupo ' : 'Permissões de ') + u.nome),
        no(doc, 'div', { class: 'mb', 'data-alvo-acessos': (ehGrupo ? 'grupo:' : 'usuario:') + u.id }, [dicaGrupo, aviso, avisos].concat(secoes, [no(doc, 'div', { class: 'hint', id: 'hintPermissoes', role: 'status', 'aria-live': 'polite' })])),
        no(doc, 'div', { class: 'mf' }, [no(doc, 'span'), no(doc, 'button', { class: 'btn primary', type: 'button', 'data-close': '' }, ['Fechar'])]),
      ];
    },
    modalCopiar: function (doc, origem, destinos) {
      var opcoes = [['', 'Selecione um usuário']].concat(destinos.map(function (u) { return [String(u.id), u.nome + (u.ativo ? '' : ' (desabilitado)')]; }));
      return [
        cabecalho(doc, 'Copiar permissões'),
        no(doc, 'div', { class: 'mb' }, [
          no(doc, 'p', { style: 'margin-top:0' }, ['Usuário de origem: ', no(doc, 'b', {}, [origem.nome])]),
          no(doc, 'label', { class: 'f' }, [no(doc, 'span', {}, ['Selecionar usuário de destino']), select(doc, { id: 'cp-destino', name: 'destino' }, opcoes, '')]),
          no(doc, 'div', { id: 'cp-resumo', style: 'margin-top:14px;line-height:1.6' }),
          no(doc, 'div', { class: 'hint', id: 'hintCopia', role: 'alert', 'aria-live': 'polite' }),
        ]),
        no(doc, 'div', { class: 'mf' }, [
          no(doc, 'button', { class: 'btn link', type: 'button', 'data-close': '' }, ['Cancelar']),
          no(doc, 'button', { class: 'btn primary', type: 'button', id: 'btnCopiar', disabled: '' }, ['Copiar permissões']),
        ]),
      ];
    },
    resumoCopia: function (doc, origem, destino, resumoOrigem) {
      return [
        no(doc, 'p', { style: 'margin:0', id: 'cp-pergunta' }, ['Copiar permissões de ' + origem.nome + ' para ' + destino.nome + '?']),
        no(doc, 'p', { class: 'dim', style: 'margin:6px 0 0;font-size:.85rem' }, ['O perfil e os dados pessoais de ' + destino.nome + ' não serão alterados.']),
        no(doc, 'p', { class: 'dim', style: 'margin:6px 0 0;font-size:.85rem', id: 'cp-conteudo' }, [
          'Grupo: ' + (resumoOrigem.grupo || 'sem grupo') + ' · exceções de página: ' + resumoOrigem.recursos + ' · funções concedidas: ' + resumoOrigem.autorizacoes + ' · bloqueios: ' + resumoOrigem.bloqueios + '.',
        ]),
      ];
    },
  };

  global.EpiPermissoesUsuario = {
    acoes: acoes, modelo: modelo, render: render, TEXTOS: TEXTOS, GRUPOS: GRUPOS, SOMENTE_LEITURA: SOMENTE_LEITURA,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.EpiPermissoesUsuario;
  }
})(typeof window !== 'undefined' ? window : globalThis);
