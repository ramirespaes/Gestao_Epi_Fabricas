(function (global) {
  'use strict';

  /**
   * EpiAutorizacoes — administração das autorizações individuais e
   * delegações (Bloco 8, Incremento 8, Etapa 5A, Subetapa 3V).
   *
   * Mesma fundação das telas anteriores: EpiHttp e EpiAuth (3R), a
   * consulta de pessoas da 3U, o catálogo de ações da 3T, os contratos
   * da 3P e as regras da 3I. Padrão de três camadas (acoes, mensagens,
   * render) mais um controlador com AS DUAS guardas que este bloco
   * aprendeu a ter — aqui presentes desde o primeiro dia.
   *
   * QUATRO REGRAS DA 3I QUE ESTA TELA PRECISA NÃO DISTORCER, porque o
   * backend não as distorce:
   *
   *   CONCEDER DIRETO É SÓ DO MASTER. Ninguém mais cria autorização do
   *   nada, por mais alto que seja o perfil.
   *
   *   MASTER NÃO DELEGA. Parece contraintuitivo e é deliberado: o
   *   caminho do MASTER é a concessão direta, que não depende de origem
   *   nenhuma. Delegar é para quem RECEBEU uma autorização delegável.
   *
   *   PODER EXECUTAR NÃO É PODER DELEGAR. A delegação exige uma linha
   *   PRÓPRIA do delegador, para aquela ação, com pode_delegar = true —
   *   e ele ainda precisa ter a autorização EFETIVA na hora (a ação
   *   ativa, o vínculo de SST quando exigido, e nenhum bloqueio). Perfil
   *   e grupo nunca dão poder de delegar: nenhuma tabela de perfil ou de
   *   grupo tem pode_delegar.
   *
   *   A AÇÃO DA DELEGAÇÃO VEM DA ORIGEM. Não se escolhe: quem delega
   *   repassa exatamente a ação que recebeu. Por isso o formulário de
   *   delegação não tem seletor de ação — tem seletor de ORIGEM.
   *
   * SOBRE origemId: a tela nunca deixa digitá-lo. As origens oferecidas
   * saem da consulta das autorizações DO PRÓPRIO ator, filtradas por
   * podeDelegar === true. Ainda assim isso é conforto, não segurança: o
   * serviço da 3I revalida a origem inteira (pertence ao chamador? tem
   * pode_delegar? é da mesma empresa e da mesma ação?) antes de confiar
   * nela. Um origemId forjado não fabrica cadeia — é recusado.
   *
   * REVOGAR EM CASCATA NÃO É OPÇÃO. Revogar uma autorização que é origem
   * de outras remove as derivadas, sempre, pela FK da migration 023 — e
   * isso não é um botão nem um parâmetro. A tela avisa antes, mas jamais
   * sugere que a revogação alcança autorizações independentes: as
   * diretas de outras pessoas, e as delegadas de outra cadeia, não são
   * tocadas.
   */

  function http() {
    var cliente = global.EpiHttp;
    if (!cliente) {
      throw new Error('EpiHttp não carregado: inclua js/api-http.js antes de js/autorizacoes-individuais.js');
    }
    return cliente;
  }

  var PERFIL_MASTER = 'MASTER';
  var MODO_NENHUMA = 'NENHUMA';

  // ───────────────────────────────────────────────────────────────────
  // Ações — contratos reais da 3P, da 3T, da 3U e a consulta da 3V
  // ───────────────────────────────────────────────────────────────────

  var acoes = {
    /** GET /api/autorizacoes-individuais?usuarioId= — consulta da 3V. */
    listarDoUsuario: function (usuarioId) {
      return http().requisitar('GET', '/autorizacoes-individuais?usuarioId=' + encodeURIComponent(usuarioId));
    },

    /** GET /api/usuarios — a mesma consulta empresarial aprovada na 3U. */
    listarUsuarios: function (filtro) {
      var opcoes = filtro || {};
      var partes = [];
      if (typeof opcoes.busca === 'string' && opcoes.busca.trim() !== '') {
        partes.push('busca=' + encodeURIComponent(opcoes.busca.trim()));
      }
      if (opcoes.pagina) partes.push('pagina=' + encodeURIComponent(opcoes.pagina));
      if (opcoes.limite) partes.push('limite=' + encodeURIComponent(opcoes.limite));
      return http().requisitar('GET', '/usuarios' + (partes.length ? '?' + partes.join('&') : ''));
    },

    /**
     * GET /api/delegacao/destinatarios — a quem um não-MASTER pode
     * repassar (complemento da 3V). Não é a rota administrativa da 3U:
     * outra autoridade ("pode delegar ao menos uma agora"), outra
     * projeção (só id, nome, e-mail).
     */
    listarDestinatarios: function (filtro) {
      var opcoes = filtro || {};
      var busca = typeof opcoes.busca === 'string' ? opcoes.busca.trim() : '';
      return http().requisitar('GET', '/delegacao/destinatarios' + (busca ? '?busca=' + encodeURIComponent(busca) : ''));
    },

    /** GET /api/catalogo/acoes — o catálogo real da 3T. */
    catalogoDeAcoes: function () {
      return http().requisitar('GET', '/catalogo/acoes');
    },

    /**
     * POST /api/autorizacoes-individuais com tipo DIRETA (3P).
     * Só MASTER passa — quem decide é o serviço da 3I.
     */
    concederDireta: function (dados) {
      var corpo = {
        tipo: 'DIRETA',
        usuarioId: dados.usuarioId,
        acaoCodigo: dados.acaoCodigo,
      };
      if (dados.podeDelegar === true) corpo.podeDelegar = true;
      if (typeof dados.motivo === 'string' && dados.motivo.trim() !== '') corpo.motivo = dados.motivo.trim();
      return http().requisitar('POST', '/autorizacoes-individuais', { corpo: corpo });
    },

    /**
     * POST /api/autorizacoes-individuais com tipo DELEGADA (3P).
     * NÃO leva acaoCodigo: a ação nasce da origem, e o schema da 3P
     * recusa os dois campos juntos com 400 CAMPO_NAO_PERMITIDO.
     */
    delegar: function (dados) {
      var corpo = {
        tipo: 'DELEGADA',
        usuarioId: dados.usuarioId,
        origemId: dados.origemId,
      };
      if (dados.podeDelegar === true) corpo.podeDelegar = true;
      if (typeof dados.motivo === 'string' && dados.motivo.trim() !== '') corpo.motivo = dados.motivo.trim();
      return http().requisitar('POST', '/autorizacoes-individuais', { corpo: corpo });
    },

    /** DELETE /api/autorizacoes-individuais/:id (3P). */
    revogar: function (autorizacaoId, motivo) {
      var corpo = {};
      if (typeof motivo === 'string' && motivo.trim() !== '') corpo.motivo = motivo.trim();
      return http().requisitar('DELETE', '/autorizacoes-individuais/' + encodeURIComponent(autorizacaoId), { corpo: corpo });
    },
  };

  // ───────────────────────────────────────────────────────────────────
  // Mensagens
  // ───────────────────────────────────────────────────────────────────

  var TEXTOS = {
    SESSAO_INVALIDA: 'Sua sessão expirou. Entre novamente para continuar.',
    AUTORIZACAO_CONSULTA_NAO_AUTORIZADA: 'Você não tem autorização para consultar estas autorizações.',
    CONCESSAO_NAO_AUTORIZADA: 'Somente o perfil Master pode conceder uma autorização direta.',
    DELEGACAO_NAO_AUTORIZADA: 'Você não pode delegar esta autorização. '
      + 'Delegar exige uma autorização sua, para esta ação, marcada como repassável — '
      + 'e que ela esteja valendo para você agora.',
    REVOGACAO_NAO_AUTORIZADA: 'Você só pode revogar autorizações que você mesmo concedeu.',
    AUTOCONCESSAO_NAO_PERMITIDA: 'Você não pode conceder nem delegar uma autorização para si mesmo.',
    AUTORIZACAO_JA_EXISTE: 'Esta pessoa já tem essa autorização por este mesmo caminho.',
    AUTORIZACAO_NAO_ENCONTRADA: 'Esta autorização não existe mais. Ela pode já ter sido revogada.',
    CONCESSAO_INVALIDA: 'Não é possível conceder esta ação: ela pode estar desativada, '
      + 'não depender de autorização individual, ou a pessoa não estar ativa.',
    USUARIO_CONSULTA_NAO_AUTORIZADA: 'Você não tem autorização para consultar as pessoas da empresa.',
    CONSULTA_DESTINATARIOS_NAO_AUTORIZADA: 'Você não tem nenhuma autorização repassável valendo agora, '
      + 'então não há a quem repassar. Só é possível repassar uma autorização que você recebeu com essa '
      + 'permissão — e que esteja valendo para você neste momento.',
    CATALOGO_NAO_AUTORIZADO: 'Você não tem autorização para consultar o catálogo de ações.',
    FALHA_DE_REDE: 'Não foi possível falar com o servidor. Verifique sua conexão.',
    RESPOSTA_INVALIDA: 'O servidor respondeu de forma inesperada. Tente novamente.',
  };

  var mensagens = {
    deErro: function (resposta) {
      if (!resposta || resposta.ok) return '';

      if (resposta.status === 400 && Array.isArray(resposta.detalhes) && resposta.detalhes.length > 0) {
        var primeiro = resposta.detalhes[0];
        if (primeiro && primeiro.codigo && TEXTOS[primeiro.codigo]) return TEXTOS[primeiro.codigo];
        if (primeiro && primeiro.mensagem) return primeiro.mensagem;
      }

      if (resposta.codigo && TEXTOS[resposta.codigo]) return TEXTOS[resposta.codigo];
      return resposta.mensagem || 'Não foi possível concluir a operação.';
    },

    exigeNovoLogin: function (resposta) {
      return !!resposta && resposta.ok === false && resposta.status === 401;
    },

    /** O que a pessoa está vendo, já que a lista pode ser parcial. */
    doEscopo: function (escopo, nome) {
      if (escopo === 'TOTAL') return 'Todas as autorizações de ' + nome + '.';
      if (escopo === 'PROPRIAS') return 'Estas são as suas autorizações.';
      return 'Você está vendo apenas as autorizações que você mesmo concedeu a ' + nome + '.';
    },

    deConcessao: function (nome, acaoNome) {
      return nome + ' agora pode “' + acaoNome + '”.';
    },

    deDelegacao: function (nome, acaoNome) {
      return 'Você repassou “' + acaoNome + '” para ' + nome + '.';
    },

    /**
     * O texto da revogação muda conforme existam derivadas. Nunca diz
     * que "todas as autorizações" caem: as independentes não caem.
     */
    deRevogacao: function (nome, acaoNome, derivadas) {
      var base = 'A autorização de “' + acaoNome + '” de ' + nome + ' foi revogada.';
      if (!derivadas) return base;
      return base + ' ' + (derivadas === 1
        ? 'A autorização que tinha sido repassada a partir dela também caiu.'
        : derivadas + ' autorizações repassadas a partir dela também caíram.');
    },

    /** Confirmação de revogação: a cascata explicada, sem exagerar. */
    confirmacaoDeRevogacao: function (autorizacao) {
      var texto = 'Revogar “' + autorizacao.acaoNome + '” de ' + autorizacao.usuarioNome + '.';
      if (autorizacao.podeDelegar === true) {
        texto += ' Atenção: se esta autorização já tiver sido repassada a outras pessoas, '
          + 'essas autorizações repassadas também serão removidas.';
      }
      texto += ' Autorizações concedidas por outro caminho não são afetadas, '
        + 'e ninguém é excluído do sistema.';
      return texto;
    },

    /** Por que não há origem para delegar — a razão importa. */
    semOrigemParaDelegar: function (ehMaster) {
      if (ehMaster) {
        return 'O perfil Master não delega: o caminho dele é a concessão direta, '
          + 'que não depende de repassar uma autorização recebida.';
      }
      return 'Você não tem nenhuma autorização marcada como repassável. '
        + 'Só é possível repassar uma autorização que você recebeu com essa permissão.';
    },
  };

  // ───────────────────────────────────────────────────────────────────
  // Render — HTML sempre escapado
  // ───────────────────────────────────────────────────────────────────

  function escaparHtml(valor) {
    if (valor === null || valor === undefined) return '';
    return String(valor)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** DIRETA ou DELEGADA — decidido por origemId, como no banco. */
  function ehDelegada(autorizacao) {
    return autorizacao.origemId !== null && autorizacao.origemId !== undefined;
  }

  var render = {
    escaparHtml: escaparHtml,
    ehDelegada: ehDelegada,

    selo: function (autorizacao) {
      return ehDelegada(autorizacao)
        ? '<span class="badge">Repassada</span>'
        : '<span class="badge badge-ok">Direta</span>';
    },

    /**
     * Uma linha por autorização. Mostra a ação por nome, a origem quando
     * houver, quem concedeu e se a autorização é repassável.
     */
    /**
     * `opcoes.podeRevogar` vem do controlador, que sabe quem é o ator.
     * Sem o botão, a célula explica por quê — a regra da 3I é "MASTER,
     * ou quem concedeu aquela linha", e mostrar um botão que o backend
     * recusaria com 403 seria convidar a pessoa a um erro (correção
     * pós-auditoria da 3V, item 3). Cortesia, não barreira: quem decide
     * continua sendo o serviço.
     */
    linha: function (autorizacao, opcoes) {
      var podeRevogar = !!(opcoes && opcoes.podeRevogar);
      var origem = ehDelegada(autorizacao)
        ? 'Repassada de ' + escaparHtml(autorizacao.autorizadoPorNome)
        : 'Concedida por ' + escaparHtml(autorizacao.autorizadoPorNome);

      var observacoes = [];
      if (autorizacao.podeDelegar === true) observacoes.push('pode repassar adiante');
      if (autorizacao.acaoExigeSst === true) observacoes.push('exige vínculo com a SST');
      if (autorizacao.acaoAtiva === false) observacoes.push('ação desativada no catálogo');
      if (autorizacao.acaoModo === MODO_NENHUMA) observacoes.push('ação não usa autorização individual');

      return '<tr data-autorizacao="' + escaparHtml(autorizacao.id) + '">'
        + '<td><strong>' + escaparHtml(autorizacao.acaoNome) + '</strong>'
        + '<div style="font-size:11px;color:var(--on-surface-variant)">' + escaparHtml(autorizacao.acaoCodigo) + '</div></td>'
        + '<td>' + render.selo(autorizacao) + '</td>'
        + '<td style="font-size:12px;color:var(--on-surface-variant)">' + origem + '</td>'
        + '<td style="font-size:12px;color:var(--on-surface-variant)">'
        + (observacoes.length ? escaparHtml(observacoes.join(' · ')) : '—') + '</td>'
        + '<td class="inline-actions">'
        + (podeRevogar
          ? '<button class="mini-btn" data-acao="revogar" data-autorizacao="' + escaparHtml(autorizacao.id) + '">Revogar</button>'
          : '<span style="font-size:11px;color:var(--on-surface-variant)">Só quem concedeu pode revogar</span>')
        + '</td></tr>';
    },

    /** `decidir(autorizacao)` devolve se o ator pode revogar aquela linha. */
    tabela: function (autorizacoes, decidir) {
      var podeRevogar = typeof decidir === 'function' ? decidir : function () { return false; };
      var linhas = autorizacoes.map(function (autorizacao) {
        return render.linha(autorizacao, { podeRevogar: podeRevogar(autorizacao) });
      }).join('');
      return '<div class="table-wrap"><table>'
        + '<thead><tr><th>Ação</th><th>Tipo</th><th>Origem</th><th>Observações</th><th></th></tr></thead>'
        + '<tbody>' + linhas + '</tbody></table></div>';
    },

    /**
     * Opções de origem para delegar: apenas as autorizações do PRÓPRIO
     * ator que são repassáveis. A ação aparece junto porque é ela que
     * será repassada — não há escolha de ação na delegação.
     */
    opcoesDeOrigem: function (origens) {
      return '<option value="">Selecione…</option>'
        + origens.map(function (origem) {
          return '<option value="' + escaparHtml(origem.id) + '">'
            + escaparHtml(origem.acaoNome) + '</option>';
        }).join('');
    },

    /** Só ações que o backend aceitaria conceder: ativas e modo ≠ NENHUMA. */
    opcoesDeAcao: function (catalogo) {
      var concediveis = (catalogo || []).filter(function (acao) {
        return acao.ativo === true && acao.modoAutorizacaoIndividual !== MODO_NENHUMA;
      });
      return '<option value="">Selecione…</option>'
        + concediveis.map(function (acao) {
          return '<option value="' + escaparHtml(acao.codigo) + '">'
            + escaparHtml(acao.nome)
            + (acao.exigeSst === true ? ' (exige SST)' : '')
            + '</option>';
        }).join('');
    },

    carregando: function () {
      return '<div class="preview-note" style="text-align:center">Carregando…</div>';
    },

    semUsuario: function () {
      return '<div class="preview-note" style="text-align:center">'
        + 'Selecione uma pessoa para ver as autorizações individuais dela.</div>';
    },

    vazia: function (texto) {
      return '<div class="preview-note" style="text-align:center">' + escaparHtml(texto) + '</div>';
    },

    falha: function (mensagem) {
      return '<div class="notice" style="background:var(--error-container);color:var(--error);border-color:rgba(255,59,48,0.2)">'
        + escaparHtml(mensagem) + '</div>';
    },
  };

  function indexarPor(lista, chave) {
    var mapa = {};
    (lista || []).forEach(function (item) { mapa[item[chave]] = item; });
    return mapa;
  }

  /**
   * As origens que ESTE ator pode usar para delegar: autorizações dele
   * mesmo, repassáveis, de ação ativa que ainda usa autorização
   * individual. Continua sendo conforto — a 3I revalida tudo.
   */
  function origensDelegaveis(minhasAutorizacoes) {
    return (minhasAutorizacoes || []).filter(function (autorizacao) {
      return autorizacao.podeDelegar === true
        && autorizacao.acaoAtiva !== false
        && autorizacao.acaoModo !== MODO_NENHUMA;
    });
  }

  // ───────────────────────────────────────────────────────────────────
  // Controlador — três fluxos, três guardas, uma identidade
  // ───────────────────────────────────────────────────────────────────

  /**
   * Este bloco já encontrou DUAS variedades distintas de corrida na
   * interface, e elas exigem defesas diferentes:
   *
   *   CHEGADA FORA DE ORDEM — resposta antiga voltando depois da nova.
   *   Defesa: geração monotônica, que recusa APLICAR o resultado.
   *
   *   PARTIDA ATRASADA — requisição antiga sendo EMITIDA por um
   *   temporizador esquecido. Defesa: cancelar o agendamento em toda
   *   porta que mude o que se quer consultar.
   *
   * UMA GERAÇÃO POR FLUXO, e é isso que a correção pós-auditoria da 3V
   * trouxe. A primeira versão usava `geracaoDaLista` tanto para a
   * pesquisa lateral de pessoas quanto para as autorizações da pessoa
   * selecionada — e a auditoria reproduziu a consequência: pesquisar
   * "bruno" enquanto as autorizações de Ana ainda estavam em voo
   * DESCARTAVA a resposta legítima de Ana, e a tela ficava em
   * "Carregando…". Os dois fluxos não têm nada a ver um com o outro;
   * partilhar o contador era acoplamento, não proteção.
   *
   *   geracaoDaLista    — as AUTORIZAÇÕES da pessoa selecionada. Muda ao
   *   selecionar pessoa, recarregar, após cada escrita, e na sessão.
   *
   *   geracaoDaPesquisa — a LISTA LATERAL de pessoas. Muda ao digitar,
   *   ao pesquisar direto, e na sessão. Nunca ao selecionar alguém —
   *   escolher uma pessoa não muda o que se digitou no campo.
   *
   *   geracaoDoContexto — o que pode ESCREVER, e sobre quem. Muda apenas
   *   quando a PESSOA SELECIONADA deixa de ser a mesma. Digitar não
   *   invalida uma concessão em voo: não mudou o alvo.
   *
   * A IDENTIDADE É A GUARDA DA SESSÃO. `iniciar()` cria um objeto de
   * identidade novo; `encerrar()` e o 401 o anulam. Cada operação
   * captura a identidade vigente ao começar e, ao voltar do `await`,
   * recusa-se a agir se ela mudou — inclusive para um 401, porque um
   * 401 de uma sessão que já não é a atual não diz nada sobre a atual.
   * Foi o segundo defeito reproduzido pela auditoria: duas
   * inicializações sobrepostas, e as origens delegáveis da identidade
   * ANTIGA sobrescrevendo as da nova. Sem contador extra: a própria
   * identidade, comparada por referência, é a geração.
   *
   * CONFIRMAÇÕES SÃO PEDIDOS CONGELADOS, como na 3U: guardam a pessoa, a
   * autorização, a ação e o contexto de origem. Uma confirmação aberta
   * para o Usuário A jamais executa sobre o Usuário B; e a revogação
   * carrega o ID DA AUTORIZAÇÃO capturado, de modo que uma recarga no
   * meio do caminho não troque o alvo por outro.
   *
   * O 401 continua valendo sempre — DENTRO da mesma identidade.
   */
  function criarControlador(opcoes) {
    var ui = opcoes.ui;
    var chamadas = opcoes.acoes || acoes;
    var atrasoDaBusca = opcoes.atrasoDaBusca === undefined ? 300 : opcoes.atrasoDaBusca;
    var agendar = opcoes.agendar || function (fn, ms) { return setTimeout(fn, ms); };
    var cancelar = opcoes.cancelar || function (id) { return clearTimeout(id); };

    var geracaoDaLista = 0;
    var geracaoDaPesquisa = 0;
    var geracaoDoContexto = 0;

    var identidade = null;          // { id, perfil } — objeto NOVO a cada iniciar()
    var usuarioSelecionado = null;  // { id, nome }
    var autorizacoes = [];
    var minhasOrigens = [];
    var catalogo = [];
    var buscaAtual = '';

    var temporizador = null;
    var resolverDigitacao = null;

    var listaObsoleta = function (minha) { return minha !== geracaoDaLista; };
    var pesquisaObsoleta = function (minha) { return minha !== geracaoDaPesquisa; };
    var contextoMudou = function (meu) { return meu !== geracaoDoContexto; };
    var identidadeMudou = function (minha) { return minha !== identidade; };

    function invalidarLista() { geracaoDaLista += 1; }
    function invalidarPesquisa() { geracaoDaPesquisa += 1; }

    /** Contexto e lista de autorizações: usado quando a PESSOA muda. */
    function invalidarContexto() {
      geracaoDaLista += 1;
      geracaoDoContexto += 1;
      autorizacoes = [];
    }

    /** Tudo: usado quando a SESSÃO muda (iniciar, encerrar, 401). */
    function invalidarSessao() {
      invalidarContexto();
      invalidarPesquisa();
    }

    function descartarDigitacaoPendente(desfecho) {
      if (temporizador !== null) { cancelar(temporizador); temporizador = null; }
      if (resolverDigitacao !== null) {
        var resolver = resolverDigitacao;
        resolverDigitacao = null;
        resolver(desfecho);
      }
    }

    /**
     * 401 só derruba a sessão se a resposta pertence à identidade
     * VIGENTE. Um 401 atrasado de uma sessão já substituída não pode
     * expulsar quem entrou depois.
     */
    function tratouSessao(resposta, minhaIdentidade) {
      if (!mensagens.exigeNovoLogin(resposta)) return false;
      if (identidadeMudou(minhaIdentidade)) return false;
      descartarDigitacaoPendente({ status: 'sessao' });
      invalidarSessao();
      identidade = null;
      usuarioSelecionado = null;
      minhasOrigens = [];
      ui.sessaoExpirada(mensagens.deErro(resposta));
      return true;
    }

    var ehMaster = function () { return !!identidade && identidade.perfil === PERFIL_MASTER; };

    /** A regra da 3I para revogar: MASTER, ou quem concedeu aquela linha. */
    function podeRevogar(autorizacao) {
      if (!identidade) return false;
      return ehMaster() || autorizacao.autorizadoPor === identidade.id;
    }

    function mostrarSemUsuario() {
      ui.renderAutorizacoes(render.semUsuario());
      ui.escopo('');
    }

    /**
     * Guarda a identidade do ator e carrega o que só depende dela: o
     * catálogo (para conceder) e as próprias autorizações (de onde saem
     * as origens delegáveis).
     *
     * As duas consultas podem falhar por falta de autoridade sem que
     * isso impeça o resto da tela — um delegador não-MASTER pode não ter
     * autoridade para ler o catálogo, e ainda assim delega.
     */
    async function iniciar(identidadeDoAtor) {
      descartarDigitacaoPendente({ status: 'substituida' });
      invalidarSessao();
      usuarioSelecionado = null;
      autorizacoes = [];
      minhasOrigens = [];
      catalogo = [];

      identidade = identidadeDoAtor
        ? { id: identidadeDoAtor.id, perfil: identidadeDoAtor.perfil }
        : null;
      var minhaIdentidade = identidade;

      if (minhaIdentidade === null) return { status: 'sem-identidade' };

      var respostas = await Promise.all([
        chamadas.listarDoUsuario(minhaIdentidade.id),
        chamadas.catalogoDeAcoes(),
      ]);

      // A GUARDA DA SESSÃO, antes de qualquer efeito — inclusive do 401.
      if (identidadeMudou(minhaIdentidade)) return { status: 'obsoleta' };

      for (var i = 0; i < respostas.length; i += 1) {
        if (tratouSessao(respostas[i], minhaIdentidade)) return { status: 'sessao' };
      }

      if (respostas[0].ok) {
        minhasOrigens = origensDelegaveis(respostas[0].dados.autorizacoes || []);
      }
      if (respostas[1].ok) {
        catalogo = respostas[1].dados.acoes || [];
      }

      ui.origens(render.opcoesDeOrigem(minhasOrigens), minhasOrigens.length);
      ui.acoesConcediveis(render.opcoesDeAcao(catalogo), catalogo.length > 0);
      ui.podeConcederDireta(ehMaster());
      if (minhasOrigens.length === 0) {
        ui.avisoDelegacao(mensagens.semOrigemParaDelegar(ehMaster()));
      } else {
        ui.avisoDelegacao('');
      }

      mostrarSemUsuario();
      return {
        status: 'ok',
        origens: minhasOrigens.length,
        acoes: catalogo.length,
        podeConceder: ehMaster(),
      };
    }

    async function carregar(minha) {
      var minhaIdentidade = identidade;
      var alvo = usuarioSelecionado;

      var resposta = await chamadas.listarDoUsuario(alvo.id);

      if (tratouSessao(resposta, minhaIdentidade)) return { status: 'sessao' };

      // A GUARDA DA LISTA — só a dela. A pesquisa lateral não entra aqui.
      if (identidadeMudou(minhaIdentidade) || listaObsoleta(minha)) {
        return { status: 'obsoleta', usuario: alvo.id };
      }

      if (!resposta.ok) {
        ui.renderAutorizacoes(render.falha(mensagens.deErro(resposta)));
        ui.escopo('');
        return { status: 'erro', usuario: alvo.id };
      }

      autorizacoes = resposta.dados.autorizacoes || [];

      ui.renderAutorizacoes(autorizacoes.length === 0
        ? render.vazia('Esta pessoa não tem nenhuma autorização individual.')
        : render.tabela(autorizacoes, podeRevogar));
      ui.escopo(mensagens.doEscopo(resposta.dados.escopo, alvo.nome));

      return { status: 'ok', usuario: alvo.id, total: autorizacoes.length, escopo: resposta.dados.escopo };
    }

    /**
     * Troca a pessoa observada: muda o contexto e a lista de
     * autorizações. NÃO toca na pesquisa lateral — nem na em voo, nem na
     * agendada: escolher alguém não muda o que se digitou no campo.
     */
    function selecionar(usuario) {
      invalidarContexto();
      var minha = geracaoDaLista;

      usuarioSelecionado = usuario ? { id: Number(usuario.id), nome: usuario.nome } : null;
      ui.aviso('', null);
      ui.usuarioSelecionado(usuarioSelecionado ? usuarioSelecionado.nome : '');

      if (usuarioSelecionado === null) {
        mostrarSemUsuario();
        return Promise.resolve({ status: 'sem-usuario' });
      }

      ui.renderAutorizacoes(render.carregando());
      return carregar(minha);
    }

    function recarregar() {
      if (usuarioSelecionado === null) {
        mostrarSemUsuario();
        return Promise.resolve({ status: 'sem-usuario' });
      }
      invalidarLista();
      return carregar(geracaoDaLista);
    }

    /** Pesquisa de pessoas — só a lista lateral, com a guarda dela. */
    function buscarPessoas(termo) {
      descartarDigitacaoPendente({ status: 'substituida' });
      buscaAtual = typeof termo === 'string' ? termo : '';

      invalidarPesquisa();
      var minha = geracaoDaPesquisa;
      var minhaIdentidade = identidade;

      ui.renderPessoas(render.carregando());

      // MASTER usa a consulta administrativa da 3U (ele concede direto a
      // qualquer pessoa). Quem não é MASTER só tem uma razão para
      // procurar alguém aqui: repassar — e a consulta de destinatários é
      // a que corresponde a essa autoridade, sem emprestar a de grupos.
      var consulta = ehMaster()
        ? chamadas.listarUsuarios({ busca: buscaAtual })
        : chamadas.listarDestinatarios({ busca: buscaAtual });

      return consulta.then(function (resposta) {
        if (tratouSessao(resposta, minhaIdentidade)) return { status: 'sessao' };
        if (identidadeMudou(minhaIdentidade) || pesquisaObsoleta(minha)) return { status: 'obsoleta' };

        if (!resposta.ok) {
          ui.renderPessoas(render.falha(mensagens.deErro(resposta)));
          return { status: 'erro' };
        }

        var pessoas = resposta.dados.usuarios || resposta.dados.destinatarios || [];
        ui.renderPessoas(pessoas, resposta.dados.total);
        return { status: 'ok', pessoas: pessoas.length, total: resposta.dados.total };
      });
    }

    /** Digitação: invalida na tecla, agenda depois — a lição da 3U. */
    function digitar(termo) {
      invalidarPesquisa();
      descartarDigitacaoPendente({ status: 'substituida' });

      return new Promise(function (resolver) {
        resolverDigitacao = resolver;
        temporizador = agendar(function () {
          temporizador = null;
          resolverDigitacao = null;
          resolver(buscarPessoas(termo));
        }, atrasoDaBusca);
      });
    }

    // ── pedidos congelados ───────────────────────────────────────────

    function prepararConcessao(dados) {
      if (usuarioSelecionado === null) return null;
      return Object.freeze({
        tipo: 'DIRETA',
        usuarioId: usuarioSelecionado.id,
        usuarioNome: usuarioSelecionado.nome,
        acaoCodigo: dados.acaoCodigo,
        acaoNome: dados.acaoNome,
        podeDelegar: dados.podeDelegar === true,
        motivo: dados.motivo || null,
        contexto: geracaoDoContexto,
      });
    }

    function prepararDelegacao(dados) {
      if (usuarioSelecionado === null) return null;
      // A ação vem da ORIGEM, nunca escolhida: é o contrato da 3I.
      var origem = minhasOrigens.filter(function (o) { return o.id === Number(dados.origemId); })[0];
      if (!origem) return null;
      return Object.freeze({
        tipo: 'DELEGADA',
        usuarioId: usuarioSelecionado.id,
        usuarioNome: usuarioSelecionado.nome,
        origemId: origem.id,
        acaoCodigo: origem.acaoCodigo,
        acaoNome: origem.acaoNome,
        podeDelegar: dados.podeDelegar === true,
        motivo: dados.motivo || null,
        contexto: geracaoDoContexto,
      });
    }

    /** Só monta pedido para o que a 3I deixaria revogar — sem botão, sem pedido. */
    function prepararRevogacao(autorizacaoId) {
      if (usuarioSelecionado === null) return null;
      var alvo = autorizacoes.filter(function (a) { return a.id === Number(autorizacaoId); })[0];
      if (!alvo || !podeRevogar(alvo)) return null;
      return Object.freeze({
        tipo: 'REVOGACAO',
        autorizacaoId: alvo.id,
        usuarioId: usuarioSelecionado.id,
        usuarioNome: alvo.usuarioNome,
        acaoNome: alvo.acaoNome,
        podeDelegar: alvo.podeDelegar === true,
        motivo: null,
        contexto: geracaoDoContexto,
      });
    }

    function pedidoValido(pedido) {
      return !!pedido && pedido.contexto === geracaoDoContexto;
    }

    async function executar(pedido) {
      var meuContexto = pedido.contexto;
      var minhaIdentidade = identidade;

      var resposta;
      if (pedido.tipo === 'DIRETA') {
        resposta = await chamadas.concederDireta(pedido);
      } else if (pedido.tipo === 'DELEGADA') {
        resposta = await chamadas.delegar(pedido);
      } else {
        resposta = await chamadas.revogar(pedido.autorizacaoId, pedido.motivo);
      }

      if (tratouSessao(resposta, minhaIdentidade)) return { status: 'sessao' };

      if (identidadeMudou(minhaIdentidade) || contextoMudou(meuContexto)) {
        if (!resposta.ok && !identidadeMudou(minhaIdentidade)) {
          ui.aviso('Não foi possível concluir a operação sobre ' + pedido.usuarioNome
            + ': ' + mensagens.deErro(resposta), 'erro');
        }
        return { status: 'obsoleta', usuario: pedido.usuarioId };
      }

      if (!resposta.ok) {
        ui.aviso(mensagens.deErro(resposta), 'erro');
        return { status: 'erro', usuario: pedido.usuarioId };
      }

      if (pedido.tipo === 'DIRETA') {
        ui.aviso(mensagens.deConcessao(pedido.usuarioNome, pedido.acaoNome), 'ok');
      } else if (pedido.tipo === 'DELEGADA') {
        ui.aviso(mensagens.deDelegacao(pedido.usuarioNome, pedido.acaoNome), 'ok');
      } else {
        ui.aviso(mensagens.deRevogacao(
          pedido.usuarioNome, pedido.acaoNome, resposta.dados.descendentesObservados || 0,
        ), 'ok');
      }

      // A recarga que segue uma escrita é do fluxo da LISTA: uma
      // pesquisa lateral simultânea não a descarta.
      invalidarLista();
      await carregar(geracaoDaLista);
      return { status: 'ok', usuario: pedido.usuarioId, tipo: pedido.tipo };
    }

    /**
     * Executa um pedido, e SÓ se o contexto em que foi montado ainda for
     * o vigente. Se a pessoa selecionada mudou, nada é enviado.
     */
    async function confirmar(pedido) {
      if (!pedido) return { status: 'sem-pedido' };

      if (!pedidoValido(pedido)) {
        ui.aviso(
          'A pessoa selecionada mudou depois que esta confirmação foi aberta. '
          + 'Nada foi alterado — refaça a operação na pessoa desejada.',
          'erro',
        );
        return { status: 'contexto-mudou', usuario: pedido.usuarioId };
      }

      return executar(pedido);
    }

    function encerrar() {
      descartarDigitacaoPendente({ status: 'sessao' });
      invalidarSessao();
      identidade = null;
      usuarioSelecionado = null;
      autorizacoes = [];
      minhasOrigens = [];
      catalogo = [];
      buscaAtual = '';
      ui.aviso('', null);
      ui.escopo('');
      ui.usuarioSelecionado('');
    }

    return {
      iniciar: iniciar,
      selecionar: selecionar,
      recarregar: recarregar,
      buscarPessoas: buscarPessoas,
      digitar: digitar,
      prepararConcessao: prepararConcessao,
      prepararDelegacao: prepararDelegacao,
      prepararRevogacao: prepararRevogacao,
      pedidoValido: pedidoValido,
      podeRevogar: podeRevogar,
      confirmar: confirmar,
      encerrar: encerrar,
      mostrarSemUsuario: mostrarSemUsuario,
      usuarioSelecionado: function () {
        return usuarioSelecionado ? { id: usuarioSelecionado.id, nome: usuarioSelecionado.nome } : null;
      },
      ehMaster: ehMaster,
      origensDelegaveis: function () { return minhasOrigens.map(function (o) { return Object.assign({}, o); }); },
      autorizacoes: function () { return autorizacoes.map(function (a) { return Object.assign({}, a); }); },
      buscaAtual: function () { return buscaAtual; },
    };
  }

  global.EpiAutorizacoes = {
    acoes: acoes,
    mensagens: mensagens,
    render: render,
    criarControlador: criarControlador,
    indexarPor: indexarPor,
    origensDelegaveis: origensDelegaveis,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.EpiAutorizacoes;
  }
})(typeof window !== 'undefined' ? window : globalThis);
