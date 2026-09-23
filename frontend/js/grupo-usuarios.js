(function (global) {
  'use strict';

  /**
   * EpiGrupoUsuarios — administração dos vínculos entre usuários e grupos
   * de acesso (Bloco 8, Incremento 8, Etapa 5A, Subetapa 3U).
   *
   * Mesma fundação das telas anteriores: EpiHttp e EpiAuth (3R), a
   * listagem de grupos da 3S, o padrão de três camadas da 3T (acoes,
   * mensagens, render) e um controlador com guarda de geração — que aqui
   * nasce junto com a tela, em vez de ser acrescentado depois de uma
   * auditoria.
   *
   * O QUE ESTA TELA FAZ, em uma frase: diz quem está em cada grupo, e
   * deixa colocar e tirar pessoas.
   *
   * TRÊS CONCEITOS QUE A TELA PRECISA NÃO CONFUNDIR, porque o backend
   * não os confunde:
   *
   *   VINCULAR é também TRANSFERIR. Cada usuário pertence a NO MÁXIMO um
   *   grupo (`usuarios.grupo_acesso_id`). Colocar num grupo alguém que
   *   já está em outro não cria um segundo vínculo: substitui o
   *   anterior. A tela precisa dizer isso ANTES, não depois.
   *
   *   DESVINCULAR NÃO PERTENCE A UM GRUPO. O contrato da 3O é
   *   `DELETE /usuarios/:usuarioId/grupo-acesso`: remove o vínculo ATUAL
   *   do usuário, seja ele qual for — não existe "remover do grupo X".
   *   Por isso a confirmação fala do usuário, não do grupo.
   *
   *   RETIRAR PODE AUMENTAR ACESSO. Sair de um grupo devolve a pessoa ao
   *   piso do perfil dela. Se o grupo NEGAVA algo que o perfil concede,
   *   tirá-la do grupo libera aquilo. É o contrário da intuição, e a
   *   confirmação precisa avisar.
   *
   * O QUE ESTA TELA NÃO FAZ: não cria, não altera, não inativa e não
   * exclui usuário nenhum; não exclui grupo nenhum. A única escrita é
   * sobre o vínculo.
   */

  function http() {
    var cliente = global.EpiHttp;
    if (!cliente) {
      throw new Error('EpiHttp não carregado: inclua js/api-http.js antes de js/grupo-usuarios.js');
    }
    return cliente;
  }

  var VINCULOS = ['todos', 'sem_grupo', 'com_grupo'];

  // ───────────────────────────────────────────────────────────────────
  // Ações — contratos reais da 3O e a consulta de usuários da 3U
  // ───────────────────────────────────────────────────────────────────

  var acoes = {
    /** GET /api/grupos-acesso/:id/usuarios — quem já está NESTE grupo. */
    listarDoGrupo: function (grupoId) {
      return http().requisitar('GET', '/grupos-acesso/' + encodeURIComponent(grupoId) + '/usuarios');
    },

    /**
     * GET /api/usuarios — quem existe na empresa (Subetapa 3U).
     * Só filtros de apresentação viajam: busca, situação do vínculo e
     * paginação. Empresa e ator saem da sessão, no servidor.
     */
    listarDaEmpresa: function (filtro) {
      var opcoes = filtro || {};
      var partes = [];
      if (typeof opcoes.busca === 'string' && opcoes.busca.trim() !== '') {
        partes.push('busca=' + encodeURIComponent(opcoes.busca.trim()));
      }
      if (VINCULOS.indexOf(opcoes.vinculo) !== -1 && opcoes.vinculo !== 'todos') {
        partes.push('vinculo=' + encodeURIComponent(opcoes.vinculo));
      }
      if (opcoes.pagina) partes.push('pagina=' + encodeURIComponent(opcoes.pagina));
      if (opcoes.limite) partes.push('limite=' + encodeURIComponent(opcoes.limite));

      return http().requisitar('GET', '/usuarios' + (partes.length ? '?' + partes.join('&') : ''));
    },

    /**
     * PUT /api/grupos-acesso/:id/usuarios/:usuarioId — sem corpo.
     * O grupo de destino e o usuário vivem na URL; nada de negócio
     * trafega no corpo (o schema da 3O recusa corpo com qualquer campo).
     */
    vincular: function (grupoId, usuarioId) {
      return http().requisitar(
        'PUT',
        '/grupos-acesso/' + encodeURIComponent(grupoId) + '/usuarios/' + encodeURIComponent(usuarioId),
      );
    },

    /**
     * DELETE /api/usuarios/:usuarioId/grupo-acesso — sem corpo e SEM
     * grupo na URL, de propósito: a operação remove o vínculo atual,
     * qualquer que seja ele (correção pós-auditoria da 3O).
     */
    desvincular: function (usuarioId) {
      return http().requisitar('DELETE', '/usuarios/' + encodeURIComponent(usuarioId) + '/grupo-acesso');
    },
  };

  // ───────────────────────────────────────────────────────────────────
  // Mensagens
  // ───────────────────────────────────────────────────────────────────

  var TEXTOS = {
    SESSAO_INVALIDA: 'Sua sessão expirou. Entre novamente para continuar.',
    GRUPO_VINCULO_NAO_AUTORIZADA: 'Você não tem autorização para administrar os usuários dos grupos.',
    USUARIO_CONSULTA_NAO_AUTORIZADA: 'Você não tem autorização para consultar os usuários da empresa.',
    GRUPO_NAO_AUTORIZADO: 'Você não tem autorização para administrar grupos de acesso.',
    GRUPO_NAO_ENCONTRADO: 'Este grupo não existe mais.',
    USUARIO_NAO_ENCONTRADO: 'Esta pessoa não existe mais no sistema.',
    GRUPO_INATIVO: 'Este grupo está inativo e não aceita novos integrantes. Reative-o antes de incluir alguém.',
    USUARIO_INATIVO: 'Esta pessoa está inativa e não pode ser incluída em um grupo.',
    USUARIO_MASTER_SEM_GRUPO: 'O perfil Master não entra em grupos: ele já tem acesso total.',
    AUTOVINCULO_NAO_PERMITIDO: 'Você não pode alterar o seu próprio grupo. Peça a outra pessoa autorizada.',
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

    /**
     * O resultado de vincular depende de onde a pessoa estava. Quem lê a
     * tela merece saber que houve transferência, e não só "pronto".
     */
    deVinculo: function (nome, vinculo, alterado) {
      if (alterado === false) return nome + ' já estava neste grupo.';
      if (vinculo && vinculo.grupoAnteriorId !== null && vinculo.grupoAnteriorId !== undefined) {
        return nome + ' foi transferido para este grupo e saiu do grupo anterior.';
      }
      return nome + ' agora faz parte deste grupo.';
    },

    deDesvinculo: function (nome, alterado) {
      if (alterado === false) return nome + ' já não estava em nenhum grupo.';
      return nome + ' saiu do grupo e voltou a valer apenas o perfil dele.';
    },

    /** Texto da confirmação — a parte contraintuitiva vem explícita. */
    confirmacaoDeDesvinculo: function (nome, nomeDoGrupo) {
      return nome + ' sai de “' + nomeDoGrupo + '” e passa a valer somente o perfil dele. '
        + 'Atenção: se este grupo NEGAVA algum acesso que o perfil concede, esse acesso volta a ficar liberado. '
        + 'A pessoa não é excluída do sistema.';
    },

    /** Vincular quem já está em outro grupo é transferência: avisar antes. */
    confirmacaoDeTransferencia: function (nome, nomeDoGrupoAtual, nomeDoGrupoDestino) {
      return nome + ' está em “' + nomeDoGrupoAtual + '”. '
        + 'Cada pessoa pertence a um grupo só, então incluir em “' + nomeDoGrupoDestino + '” '
        + 'vai retirá-la do grupo atual.';
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

  /** Nome em destaque, e-mail em segundo plano só para desempatar homônimos. */
  function identificacao(usuario) {
    return '<strong>' + escaparHtml(usuario.nome) + '</strong>'
      + '<div style="font-size:11px;color:var(--on-surface-variant)">' + escaparHtml(usuario.email) + '</div>';
  }

  var render = {
    escaparHtml: escaparHtml,
    identificacao: identificacao,

    selo: function (usuario) {
      return usuario.ativo
        ? '<span class="badge badge-ok">Ativo</span>'
        : '<span class="badge badge-danger">Inativo</span>';
    },

    /** Linha de quem JÁ está no grupo: a única ação é retirar. */
    linhaVinculado: function (usuario) {
      return '<tr data-usuario="' + escaparHtml(usuario.id) + '">'
        + '<td>' + identificacao(usuario) + '</td>'
        + '<td>' + escaparHtml(usuario.perfil) + '</td>'
        + '<td>' + render.selo(usuario) + '</td>'
        + '<td class="inline-actions">'
        + '<button class="mini-btn" data-acao="desvincular" data-usuario="' + escaparHtml(usuario.id) + '">Retirar do grupo</button>'
        + '</td></tr>';
    },

    tabelaVinculados: function (usuarios) {
      var linhas = usuarios.map(render.linhaVinculado).join('');
      return '<div class="table-wrap"><table>'
        + '<thead><tr><th>Pessoa</th><th>Perfil</th><th>Situação</th><th></th></tr></thead>'
        + '<tbody>' + linhas + '</tbody></table></div>';
    },

    /**
     * Linha de quem PODE entrar. O estado do vínculo atual aparece em
     * palavras, e o botão muda de rótulo quando a inclusão for, na
     * verdade, uma transferência.
     *
     * `grupoSelecionado` e `nomesDeGrupo` servem só para descrever a
     * situação — a decisão continua inteiramente no backend.
     */
    linhaDisponivel: function (usuario, grupoSelecionado, nomesDeGrupo) {
      var nomes = nomesDeGrupo || {};
      var jaNesteGrupo = usuario.grupoAcessoId === grupoSelecionado;
      var emOutroGrupo = usuario.grupoAcessoId !== null
        && usuario.grupoAcessoId !== undefined
        && !jaNesteGrupo;

      var situacao;
      if (jaNesteGrupo) situacao = 'Já está neste grupo';
      else if (emOutroGrupo) situacao = 'Em “' + escaparHtml(nomes[usuario.grupoAcessoId] || 'outro grupo') + '”';
      else situacao = 'Sem grupo';

      // MASTER e inativo o backend recusa (409). Desabilitar aqui é
      // cortesia, não barreira: quem decide continua sendo o servidor.
      var impedido = jaNesteGrupo || usuario.ativo !== true || usuario.perfil === 'MASTER';

      // `data-grupo-atual` existe para que a tela NÃO precise interpretar
      // o texto da célula para saber se a inclusão é transferência
      // (correção pós-auditoria da 3U). Texto de interface é para
      // pessoas lerem; decisão de código se toma sobre dado.
      var grupoAtualDoUsuario = (usuario.grupoAcessoId === null || usuario.grupoAcessoId === undefined)
        ? '' : String(usuario.grupoAcessoId);

      return '<tr data-usuario="' + escaparHtml(usuario.id) + '"'
        + ' data-grupo-atual="' + escaparHtml(grupoAtualDoUsuario) + '">'
        + '<td>' + identificacao(usuario) + '</td>'
        + '<td>' + escaparHtml(usuario.perfil) + '</td>'
        + '<td style="font-size:12px;color:var(--on-surface-variant)">' + situacao + '</td>'
        + '<td class="inline-actions">'
        + '<button class="mini-btn" data-acao="vincular" data-usuario="' + escaparHtml(usuario.id) + '"'
        + (impedido ? ' disabled' : '') + '>'
        + (emOutroGrupo ? 'Transferir para cá' : 'Incluir no grupo')
        + '</button></td></tr>';
    },

    tabelaDisponiveis: function (usuarios, grupoSelecionado, nomesDeGrupo) {
      var linhas = usuarios.map(function (usuario) {
        return render.linhaDisponivel(usuario, grupoSelecionado, nomesDeGrupo);
      }).join('');
      return '<div class="table-wrap"><table>'
        + '<thead><tr><th>Pessoa</th><th>Perfil</th><th>Grupo atual</th><th></th></tr></thead>'
        + '<tbody>' + linhas + '</tbody></table></div>';
    },

    /** Quantos de quantos, para que a página não pareça a lista inteira. */
    resumoDaBusca: function (mostrados, total) {
      if (total === 0) return 'Nenhuma pessoa encontrada com esse filtro.';
      if (mostrados >= total) return total === 1 ? '1 pessoa encontrada.' : total + ' pessoas encontradas.';
      // Desde a correção da 3U existem controles de página, então não se
      // pede mais para "refinar a busca": dá para navegar.
      return 'Mostrando ' + mostrados + ' de ' + total + '.';
    },

    /**
     * Controles de página. Some quando não há nada a paginar — botão
     * desabilitado permanente é ruído.
     *
     * Os limites vêm calculados pelo controlador; aqui só se desenha.
     * Desabilitar nas pontas é o que impede navegar além da última
     * página pelo teclado ou pelo clique.
     */
    paginacao: function (estado) {
      if (!estado || estado.total === 0) return '';

      var botao = function (acao, rotulo, habilitado) {
        return '<button class="outlined-btn" data-acao="' + acao + '"'
          + (habilitado ? '' : ' disabled') + '>' + rotulo + '</button>';
      };

      return '<div class="inline-actions" style="justify-content:space-between;align-items:center;margin-top:14px">'
        + '<span style="font-size:12px;color:var(--on-surface-variant)">'
        + 'Página ' + escaparHtml(estado.pagina) + ' de ' + escaparHtml(estado.totalPaginas)
        + ' · ' + escaparHtml(estado.total) + (estado.total === 1 ? ' pessoa' : ' pessoas') + '</span>'
        + '<span class="inline-actions">'
        + botao('pagina-anterior', 'Anterior', estado.temAnterior)
        + botao('pagina-proxima', 'Próxima', estado.temProxima)
        + '</span></div>';
    },

    carregando: function () {
      return '<div class="preview-note" style="text-align:center">Carregando…</div>';
    },

    semGrupo: function () {
      return '<div class="preview-note" style="text-align:center">Selecione um grupo para ver e administrar os integrantes.</div>';
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

  // ───────────────────────────────────────────────────────────────────
  // Controlador — guarda de geração desde o primeiro dia
  // ───────────────────────────────────────────────────────────────────

  // Controlador — duas guardas de geração, e não uma
  // ───────────────────────────────────────────────────────────────────

  /**
   * Requisição HTTP não chega na ordem em que sai. Esta tela tem TRÊS
   * fontes de corrida, e a correção pós-auditoria da 3U mostrou que
   * tratá-las com um contador só era grosseiro demais.
   *
   *   TROCA DE GRUPO — a carga do Grupo A pode voltar depois da do
   *   Grupo B e repintar a tela com os integrantes errados.
   *
   *   BUSCA E PAGINAÇÃO — digitar, filtrar e trocar de página disparam
   *   consultas cujas respostas podem chegar trocadas, deixando na tela
   *   um resultado que não corresponde ao que está escrito no campo nem
   *   à página indicada.
   *
   *   CONFIRMAÇÃO ABERTA — entre abrir o diálogo de transferência e
   *   clicar em "Transferir", a pessoa pode trocar de grupo no seletor.
   *   Executar a operação contra o grupo NOVO seria transferir alguém
   *   para um lugar que ninguém pediu.
   *
   * DUAS GERAÇÕES, PORQUE SÃO DOIS EIXOS DIFERENTES:
   *
   *   geracaoDaLista  — o que pode PINTAR as listas. Muda ao selecionar
   *   grupo, digitar, filtrar, paginar, recarregar, encerrar e no 401.
   *
   *   geracaoDoContexto — o que pode ESCREVER, e contra qual grupo. Muda
   *   apenas quando o grupo selecionado deixa de ser o mesmo: selecionar,
   *   recarregar, encerrar e 401. Digitar uma busca NÃO muda o contexto,
   *   porque não muda o grupo — e seria absurdo uma pessoa perder o aviso
   *   de "fulano incluído" só porque começou a digitar enquanto o
   *   servidor respondia.
   *
   * A VERSÃO ANTERIOR TINHA UM BURACO, apontado pela auditoria: a
   * geração só era incrementada quando a busca COMEÇAVA, depois dos
   * 300 ms de agrupamento. Durante essa espera, a resposta de um termo
   * já abandonado ainda era considerada atual e repintava a lista. Por
   * isso o agrupamento passou a morar aqui dentro: `digitar()` invalida
   * IMEDIATAMENTE, no momento da tecla, e só então agenda a consulta.
   * O agrupamento continua existindo; o que deixou de existir é a janela
   * em que uma resposta velha era aceita.
   *
   * O 401 é a exceção deliberada às duas guardas: sessão não é por
   * grupo, por busca nem por página, então é tratado antes de qualquer
   * verificação de obsolescência.
   *
   * `agendar`/`cancelar` entram por parâmetro para que o teste controle
   * o tempo em vez de esperá-lo.
   */
  function criarControlador(opcoes) {
    var ui = opcoes.ui;
    var chamadas = opcoes.acoes || acoes;
    var atrasoDaBusca = opcoes.atrasoDaBusca === undefined ? 300 : opcoes.atrasoDaBusca;
    var agendar = opcoes.agendar || function (fn, ms) { return setTimeout(fn, ms); };
    var cancelar = opcoes.cancelar || function (id) { return clearTimeout(id); };

    var geracaoDaLista = 0;
    var geracaoDoContexto = 0;

    var grupoAtual = null;
    var nomeDoGrupo = '';
    var opcoesAtuais = {};
    var filtroAtual = { busca: '', vinculo: 'todos' };
    var nomesDeGrupo = {};
    var vinculados = {};

    var pagina = 1;
    var limite = 20;
    var total = 0;

    var temporizador = null;
    var resolverDigitacao = null;

    var listaObsoleta = function (minha) { return minha !== geracaoDaLista; };
    var contextoMudou = function (meu) { return meu !== geracaoDoContexto; };

    /** Só a lista: usado por digitar, filtrar e paginar. */
    function invalidarLista() {
      geracaoDaLista += 1;
    }

    /** Lista e contexto: usado quando o GRUPO deixa de ser o mesmo. */
    function invalidarTudo() {
      geracaoDaLista += 1;
      geracaoDoContexto += 1;
      vinculados = {};
    }

    /** Uma digitação pendente que foi substituída não fica pendurada. */
    function descartarDigitacaoPendente(desfecho) {
      if (temporizador !== null) { cancelar(temporizador); temporizador = null; }
      if (resolverDigitacao !== null) {
        var resolver = resolverDigitacao;
        resolverDigitacao = null;
        resolver(desfecho);
      }
    }

    function tratouSessao(resposta) {
      if (!mensagens.exigeNovoLogin(resposta)) return false;
      descartarDigitacaoPendente({ status: 'sessao' });
      invalidarTudo();
      grupoAtual = null;
      nomeDoGrupo = '';
      ui.sessaoExpirada(mensagens.deErro(resposta));
      return true;
    }

    function mostrarSemGrupo() {
      ui.renderVinculados(render.semGrupo());
      ui.renderDisponiveis(render.semGrupo());
      ui.resumo('');
      ui.paginacao('');
    }

    function definirNomesDeGrupo(grupos) {
      nomesDeGrupo = {};
      (grupos || []).forEach(function (grupo) { nomesDeGrupo[grupo.id] = grupo.nome; });
    }

    /** Última página, nunca menor que 1 (lista vazia ainda é "página 1 de 1"). */
    function totalDePaginas() {
      return Math.max(1, Math.ceil(total / limite));
    }

    function estadoDaPaginacao() {
      var ultima = totalDePaginas();
      return {
        pagina: pagina,
        totalPaginas: ultima,
        total: total,
        limite: limite,
        temAnterior: pagina > 1,
        temProxima: pagina < ultima,
      };
    }

    async function carregar(minha) {
      var grupoOrigem = grupoAtual;
      var filtro = {
        busca: filtroAtual.busca,
        vinculo: filtroAtual.vinculo,
        pagina: pagina,
        limite: limite,
      };

      var respostas = await Promise.all([
        chamadas.listarDoGrupo(grupoOrigem),
        chamadas.listarDaEmpresa(filtro),
      ]);

      for (var i = 0; i < respostas.length; i += 1) {
        if (tratouSessao(respostas[i])) return { status: 'sessao' };
      }

      // A GUARDA DA LISTA. Nada abaixo toca a tela se outra carga, busca
      // ou página já foi pedida.
      if (listaObsoleta(minha)) return { status: 'obsoleta', grupo: grupoOrigem, pagina: filtro.pagina };

      for (var j = 0; j < respostas.length; j += 1) {
        if (respostas[j].ok) continue;
        var texto = mensagens.deErro(respostas[j]);
        ui.renderVinculados(render.falha(texto));
        ui.renderDisponiveis(render.falha(texto));
        ui.resumo('');
        ui.paginacao('');
        return { status: 'erro', grupo: grupoOrigem };
      }

      var doGrupo = respostas[0].dados.usuarios || [];
      var daEmpresa = respostas[1].dados.usuarios || [];
      vinculados = indexarPor(doGrupo, 'id');

      // O servidor é quem manda no total e no limite efetivos.
      total = typeof respostas[1].dados.total === 'number' ? respostas[1].dados.total : daEmpresa.length;
      if (typeof respostas[1].dados.limite === 'number' && respostas[1].dados.limite > 0) {
        limite = respostas[1].dados.limite;
      }

      ui.renderVinculados(doGrupo.length === 0
        ? render.vazia('Ninguém está neste grupo ainda. Use a lista abaixo para incluir.')
        : render.tabelaVinculados(doGrupo));

      ui.renderDisponiveis(daEmpresa.length === 0
        ? render.vazia('Nenhuma pessoa encontrada com esse filtro.')
        : render.tabelaDisponiveis(daEmpresa, grupoOrigem, nomesDeGrupo));

      ui.resumo(render.resumoDaBusca(daEmpresa.length, total));
      ui.paginacao(render.paginacao(estadoDaPaginacao()));

      return {
        status: 'ok',
        grupo: grupoOrigem,
        pagina: pagina,
        vinculados: doGrupo.length,
        disponiveis: daEmpresa.length,
        total: total,
      };
    }

    async function selecionar(grupoId, extras) {
      descartarDigitacaoPendente({ status: 'substituida' });
      invalidarTudo();
      var minha = geracaoDaLista;

      grupoAtual = (grupoId === null || grupoId === undefined || grupoId === '') ? null : Number(grupoId);
      opcoesAtuais = extras || {};
      nomeDoGrupo = opcoesAtuais.nome || (grupoAtual === null ? '' : String(grupoAtual));

      // Trocar de grupo volta para a primeira página: continuar na
      // página 4 de outra lista não significa nada.
      pagina = 1;
      total = 0;

      ui.grupoInativo(grupoAtual !== null && opcoesAtuais.inativo === true);
      ui.aviso('', null);

      if (grupoAtual === null) {
        mostrarSemGrupo();
        return { status: 'sem-grupo' };
      }

      ui.renderVinculados(render.carregando());
      ui.renderDisponiveis(render.carregando());
      return carregar(minha);
    }

    /**
     * Busca ou filtro aplicados JÁ: usado pelo seletor de situação, que
     * não precisa de agrupamento (uma escolha, um evento).
     *
     * DESCARTAR A DIGITAÇÃO AGENDADA É A PRIMEIRA COISA, e é o ajuste
     * final pós-auditoria da 3U. Faltava só esta porta: `selecionar`,
     * `irParaPagina` e `encerrar` já cancelavam o temporizador, `buscar`
     * não. Quem digitasse "ana" e, antes dos 300 ms, trocasse o filtro
     * de situação, veria a busca correta acontecer — e, logo depois, o
     * temporizador esquecido disparar `buscar` de novo com o filtro
     * ABANDONADO, sobrescrevendo `filtroAtual` e a lista.
     *
     * A guarda de geração não pegava esse caso, e não tinha como: a
     * segunda busca era legítima e recente: o problema não era uma
     * resposta velha chegando atrasada, e sim uma REQUISIÇÃO velha sendo
     * emitida tarde. Guarda de geração protege a chegada; cancelar o
     * temporizador protege a partida. São coisas diferentes, e as duas
     * precisam existir.
     *
     * Chamado pelo próprio temporizador, isto é inofensivo: o callback
     * zera `temporizador` e `resolverDigitacao` ANTES de chamar
     * `buscar`, então não há o que descartar nem risco de recursão.
     */
    function buscar(filtro) {
      descartarDigitacaoPendente({ status: 'substituida' });

      filtroAtual = {
        busca: (filtro && filtro.busca) || '',
        vinculo: (filtro && VINCULOS.indexOf(filtro.vinculo) !== -1) ? filtro.vinculo : 'todos',
      };

      // Mudou o filtro, volta para a primeira página: a página 4 do
      // resultado anterior não corresponde a nada no novo.
      pagina = 1;

      if (grupoAtual === null) {
        mostrarSemGrupo();
        return Promise.resolve({ status: 'sem-grupo' });
      }

      invalidarLista();
      ui.renderDisponiveis(render.carregando());
      return carregar(geracaoDaLista);
    }

    /**
     * Digitação: invalida NA TECLA e agenda a consulta. É a correção do
     * buraco que a auditoria apontou — antes, durante os 300 ms de
     * espera, a resposta de um termo já abandonado ainda era aceita.
     *
     * Devolve promessa que resolve quando a consulta agendada termina,
     * ou `{status:'substituida'}` se outra tecla chegar antes.
     */
    function digitar(filtro) {
      // Primeiro a guarda, depois o relógio: qualquer resposta em voo
      // morre agora, não daqui a 300 ms.
      invalidarLista();
      descartarDigitacaoPendente({ status: 'substituida' });

      return new Promise(function (resolver) {
        resolverDigitacao = resolver;
        temporizador = agendar(function () {
          temporizador = null;
          resolverDigitacao = null;
          resolver(buscar(filtro));
        }, atrasoDaBusca);
      });
    }

    /** Vai para uma página, recusando fora dos limites. */
    function irParaPagina(destino) {
      var alvo = Number(destino);
      if (!Number.isInteger(alvo) || alvo < 1 || alvo > totalDePaginas()) {
        return Promise.resolve({ status: 'fora-do-intervalo', pagina: pagina });
      }
      if (grupoAtual === null) return Promise.resolve({ status: 'sem-grupo' });
      if (alvo === pagina) return Promise.resolve({ status: 'sem-mudanca', pagina: pagina });

      descartarDigitacaoPendente({ status: 'substituida' });
      pagina = alvo;
      invalidarLista();
      ui.renderDisponiveis(render.carregando());
      return carregar(geracaoDaLista);
    }

    var proximaPagina = function () { return irParaPagina(pagina + 1); };
    var paginaAnterior = function () { return irParaPagina(pagina - 1); };

    function recarregar() {
      return selecionar(grupoAtual, opcoesAtuais);
    }

    // ── gravação ─────────────────────────────────────────────────────

    async function vincular(usuarioId, nome, grupoDestino) {
      var meuContexto = geracaoDoContexto;
      var grupoOrigem = grupoDestino === undefined ? grupoAtual : grupoDestino;
      var nomeOrigem = nomeDoGrupo;

      if (grupoOrigem === null) return { status: 'sem-grupo' };

      // O destino é o grupo capturado AQUI, nunca o selecionado depois.
      var resposta = await chamadas.vincular(grupoOrigem, usuarioId);

      if (tratouSessao(resposta)) return { status: 'sessao' };

      if (contextoMudou(meuContexto)) {
        if (!resposta.ok) {
          ui.aviso('Não foi possível incluir em “' + nomeOrigem + '”: ' + mensagens.deErro(resposta), 'erro');
        }
        return { status: 'obsoleta', grupo: grupoOrigem, usuario: usuarioId };
      }

      if (!resposta.ok) {
        ui.aviso(mensagens.deErro(resposta), 'erro');
        return { status: 'erro', grupo: grupoOrigem, usuario: usuarioId };
      }

      ui.aviso(mensagens.deVinculo(nome || 'A pessoa', resposta.dados.vinculo, resposta.dados.alterado), 'ok');
      invalidarLista();
      await carregar(geracaoDaLista);
      return { status: 'ok', grupo: grupoOrigem, usuario: usuarioId, alterado: resposta.dados.alterado };
    }

    async function desvincular(usuarioId, nome, grupoDeOrigem) {
      var meuContexto = geracaoDoContexto;
      var grupoOrigem = grupoDeOrigem === undefined ? grupoAtual : grupoDeOrigem;
      var nomeOrigem = nomeDoGrupo;

      if (grupoOrigem === null) return { status: 'sem-grupo' };

      // Sem grupo na URL: o contrato da 3O remove o vínculo atual.
      var resposta = await chamadas.desvincular(usuarioId);

      if (tratouSessao(resposta)) return { status: 'sessao' };

      if (contextoMudou(meuContexto)) {
        if (!resposta.ok) {
          ui.aviso('Não foi possível retirar de “' + nomeOrigem + '”: ' + mensagens.deErro(resposta), 'erro');
        }
        return { status: 'obsoleta', grupo: grupoOrigem, usuario: usuarioId };
      }

      if (!resposta.ok) {
        ui.aviso(mensagens.deErro(resposta), 'erro');
        return { status: 'erro', grupo: grupoOrigem, usuario: usuarioId };
      }

      ui.aviso(mensagens.deDesvinculo(nome || 'A pessoa', resposta.dados.alterado), 'ok');
      invalidarLista();
      await carregar(geracaoDaLista);
      return { status: 'ok', grupo: grupoOrigem, usuario: usuarioId, alterado: resposta.dados.alterado };
    }

    // ── confirmação amarrada ao contexto ─────────────────────────────

    /**
     * Um PEDIDO é a confirmação congelada: guarda quem, para onde, com
     * que nome e sob qual contexto foi aberta. Sem isso, um diálogo
     * aberto para transferir alguém ao Grupo A executaria contra o
     * Grupo B se a seleção mudasse no meio — o defeito que a auditoria
     * apontou.
     *
     * Congelado de propósito: um pedido que pudesse ser alterado depois
     * de exibido não provaria nada sobre o que a pessoa leu na tela.
     */
    function prepararPedido(tipo, usuarioId, nome) {
      if (grupoAtual === null) return null;
      return Object.freeze({
        tipo: tipo,
        usuarioId: usuarioId,
        nome: nome,
        grupoId: grupoAtual,
        nomeDoGrupo: nomeDoGrupo,
        contexto: geracaoDoContexto,
      });
    }

    var prepararVinculo = function (usuarioId, nome) { return prepararPedido('vincular', usuarioId, nome); };
    var prepararDesvinculo = function (usuarioId, nome) { return prepararPedido('desvincular', usuarioId, nome); };

    /** O pedido ainda vale? Serve à tela para fechar o diálogo sozinha. */
    function pedidoValido(pedido) {
      return !!pedido && pedido.contexto === geracaoDoContexto;
    }

    /**
     * Executa um pedido, e SÓ se o contexto em que ele foi aberto ainda
     * for o vigente. Se mudou, nada é enviado — nenhuma requisição, nem
     * para o grupo antigo nem para o novo.
     */
    async function confirmar(pedido) {
      if (!pedido) return { status: 'sem-pedido' };

      if (!pedidoValido(pedido)) {
        ui.aviso(
          'A seleção mudou depois que esta confirmação foi aberta. Nada foi alterado — '
          + 'refaça a operação no grupo desejado.',
          'erro',
        );
        return { status: 'contexto-mudou', grupo: pedido.grupoId, usuario: pedido.usuarioId };
      }

      return pedido.tipo === 'vincular'
        ? vincular(pedido.usuarioId, pedido.nome, pedido.grupoId)
        : desvincular(pedido.usuarioId, pedido.nome, pedido.grupoId);
    }

    function encerrar() {
      descartarDigitacaoPendente({ status: 'sessao' });
      invalidarTudo();
      grupoAtual = null;
      nomeDoGrupo = '';
      opcoesAtuais = {};
      filtroAtual = { busca: '', vinculo: 'todos' };
      nomesDeGrupo = {};
      pagina = 1;
      total = 0;
      ui.aviso('', null);
      ui.grupoInativo(false);
      ui.resumo('');
      ui.paginacao('');
    }

    return {
      selecionar: selecionar,
      buscar: buscar,
      digitar: digitar,
      irParaPagina: irParaPagina,
      proximaPagina: proximaPagina,
      paginaAnterior: paginaAnterior,
      recarregar: recarregar,
      vincular: vincular,
      desvincular: desvincular,
      prepararVinculo: prepararVinculo,
      prepararDesvinculo: prepararDesvinculo,
      pedidoValido: pedidoValido,
      confirmar: confirmar,
      encerrar: encerrar,
      mostrarSemGrupo: mostrarSemGrupo,
      definirNomesDeGrupo: definirNomesDeGrupo,
      grupoAtual: function () { return grupoAtual; },
      nomeDoGrupo: function () { return nomeDoGrupo; },
      // Nome legível de QUALQUER grupo conhecido — a tela precisa dele
      // para dizer de onde a pessoa está saindo numa transferência, sem
      // ter de interpretar o texto da própria tabela.
      nomeDeGrupo: function (id) { return nomesDeGrupo[id] || 'outro grupo'; },
      estaVinculado: function (usuarioId) { return Object.prototype.hasOwnProperty.call(vinculados, usuarioId); },
      filtroAtual: function () { return { busca: filtroAtual.busca, vinculo: filtroAtual.vinculo }; },
      paginacao: estadoDaPaginacao,
    };
  }

  global.EpiGrupoUsuarios = {
    acoes: acoes,
    mensagens: mensagens,
    render: render,
    criarControlador: criarControlador,
    indexarPor: indexarPor,
    // Cópia nova a cada leitura — a lição de CAMPOS_DE_AUTORIDADE_PROIBIDOS
    // (3R) e de OPERACOES (3T): lista compartilhada é lista adulterável.
    get VINCULOS() { return VINCULOS.slice(); },
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.EpiGrupoUsuarios;
  }
})(typeof window !== 'undefined' ? window : globalThis);
