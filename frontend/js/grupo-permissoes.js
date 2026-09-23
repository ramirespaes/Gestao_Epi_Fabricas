(function (global) {
  'use strict';

  /**
   * EpiGrupoPermissoes — configuração das permissões de um grupo (Bloco
   * 8, Incremento 8, Etapa 5A, Subetapa 3T).
   *
   * Construída sobre a mesma fundação das telas anteriores: EpiHttp e
   * EpiAuth (3R), contratos da 3N, serviços da 3K e autoridade granular
   * da 3Q. Mesma separação em três camadas da 3S — acoes, mensagens e
   * render — que é o que permite testar tudo sem navegador.
   *
   * O TRI-STATE É O CORAÇÃO DESTA TELA. Cada operação de um recurso
   * (visualizar, criar, editar, excluir) e cada ação têm três estados,
   * e eles NÃO são um "ligado/desligado":
   *
   *   TRUE  — o grupo CONCEDE, mesmo que o perfil não conceda;
   *   FALSE — o grupo NEGA, mesmo que o perfil conceda;
   *   NULL  — o grupo não opina: herda a decisão do perfil.
   *
   * FALSE e NULL são coisas diferentes, e confundi-los é o erro mais
   * fácil de cometer aqui: "negar" tira um acesso que o perfil daria;
   * "herdar" devolve a decisão ao perfil. Esta camada nunca converte um
   * no outro — nem ao ler, nem ao gravar, nem ao comparar.
   *
   * ALTERAÇÃO PARCIAL, A REGRA QUE PROTEGE O QUE NINGUÉM MEXEU: o
   * serviço da 3K distingue "campo ausente" (preserva o valor atual) de
   * "campo enviado como null" (passa a herdar). Por isso
   * `diferencaDeRecurso` monta o corpo com SOMENTE as operações que
   * mudaram de fato. Mandar as quatro a cada gravação funcionaria na
   * aparência e destruiria essa garantia: duas pessoas editando
   * operações diferentes do mesmo recurso sobrescreveriam uma à outra.
   *
   * MODO DA AÇÃO: a 3K só aceita conceder ou negar (TRUE/FALSE) em ações
   * cujo modo é ALTERNATIVA. Em NENHUMA e OBRIGATORIA, apenas NULL é
   * aceito — e o backend responde 409 a qualquer outra coisa. A tela lê
   * o modo do catálogo real (GET /api/catalogo/acoes, Subetapa 3T) e
   * apresenta só o que faz sentido, mas isso é conforto, não segurança:
   * o backend continua sendo quem recusa.
   */

  function http() {
    var cliente = global.EpiHttp;
    if (!cliente) {
      throw new Error('EpiHttp não carregado: inclua js/api-http.js antes de js/grupo-permissoes.js');
    }
    return cliente;
  }

  var OPERACOES = ['podeVisualizar', 'podeCriar', 'podeEditar', 'podeExcluir'];

  var ROTULOS_OPERACAO = {
    podeVisualizar: 'Visualizar',
    podeCriar: 'Criar',
    podeEditar: 'Editar',
    podeExcluir: 'Excluir',
  };

  var MODO_ALTERNATIVA = 'ALTERNATIVA';

  /**
   * Os recursos configuráveis — as páginas/módulos do sistema.
   *
   * DE ONDE VEM, e por que não é uma lista inventada: a migration 009,
   * que criou `permissoes_recurso`, define no próprio comentário que
   * "recurso" usa "os mesmos identificadores de página já usados no
   * front ('dashboard', 'materials', 'userAdmin' etc.)". A fonte é,
   * literalmente, a constante `allPages` de js/main.js — os 21
   * identificadores que a navegação legada reconhece. Os rótulos são os
   * textos que o menu já exibe, para que quem configura veja o mesmo
   * nome que a pessoa verá no sistema.
   *
   * Não existe tabela `recursos` no banco: `permissoes_recurso` guarda o
   * identificador como VARCHAR, sem FK para catálogo nenhum. Enquanto
   * for assim, esta lista é a única fonte fiel, e fica aqui — do lado do
   * frontend, que é quem a define — em vez de duplicada no backend.
   *
   * 'self-service' (o totem) aparece no menu mas está FORA de
   * `allPages`: não é uma página sujeita a perfil, e por isso também não
   * entra aqui.
   */
  var RECURSOS = [
    { id: 'dashboard', nome: 'Dashboard' },
    { id: 'operations', nome: 'Operações' },
    { id: 'reports', nome: 'Relatórios' },
    { id: 'materials', nome: 'Materiais' },
    { id: 'eligibilityRules', nome: 'Regras Função / Setor' },
    { id: 'purchases', nome: 'Compras / Entradas' },
    { id: 'stockValidity', nome: 'Validade do Estoque' },
    { id: 'availableItems', nome: 'Itens Disponíveis' },
    { id: 'deliveredItems', nome: 'EPIs Entregues' },
    { id: 'epiFicha', nome: 'Ficha de EPI' },
    { id: 'employeeHistory', nome: 'Histórico de Funcionários' },
    { id: 'request', nome: 'Pedido de EPI' },
    { id: 'supervisorApproval', nome: 'Aprovação do Supervisor' },
    { id: 'stockRequests', nome: 'Sem Estoque' },
    { id: 'importEmployees', nome: 'Importar Funcionários' },
    { id: 'newUser', nome: 'Novo Usuário' },
    { id: 'userAdmin', nome: 'Administração de Usuários' },
    { id: 'emailsGestao', nome: 'Gestão de E-mails' },
    { id: 'config', nome: 'Configurações' },
    { id: 'support', nome: 'Suporte' },
    { id: 'lgpd', nome: 'Privacidade / LGPD' },
  ];

  function caminhoGrupo(grupoId) {
    return '/grupos-acesso/' + encodeURIComponent(grupoId) + '/permissoes';
  }

  // ───────────────────────────────────────────────────────────────────
  // Ações — os quatro contratos da 3N, mais o catálogo da 3T
  // ───────────────────────────────────────────────────────────────────

  var acoes = {
    /** GET /api/grupos-acesso/:id/permissoes/recursos — só o que já está configurado. */
    listarRecursos: function (grupoId) {
      return http().requisitar('GET', caminhoGrupo(grupoId) + '/recursos');
    },

    /** GET /api/grupos-acesso/:id/permissoes/acoes — idem, para ações. */
    listarAcoes: function (grupoId) {
      return http().requisitar('GET', caminhoGrupo(grupoId) + '/acoes');
    },

    /** GET /api/catalogo/acoes — o catálogo real (Subetapa 3T). */
    catalogoDeAcoes: function () {
      return http().requisitar('GET', '/catalogo/acoes');
    },

    /**
     * PATCH .../permissoes/recursos/:recurso
     *
     * `operacoes` deve conter APENAS o que mudou: cada chave ausente é o
     * que faz o serviço da 3K preservar o valor atual daquela operação.
     */
    configurarRecurso: function (grupoId, recurso, operacoes) {
      var corpo = {};
      for (var i = 0; i < OPERACOES.length; i += 1) {
        var operacao = OPERACOES[i];
        if (Object.prototype.hasOwnProperty.call(operacoes || {}, operacao)) {
          corpo[operacao] = operacoes[operacao];
        }
      }
      return http().requisitar('PATCH', caminhoGrupo(grupoId) + '/recursos/' + encodeURIComponent(recurso), { corpo: corpo });
    },

    /**
     * PATCH .../permissoes/acoes/:acaoCodigo
     * `permitido` é obrigatório e tri-state (o schema da 3N recusa a
     * ausência com CAMPO_OBRIGATORIO).
     */
    configurarAcao: function (grupoId, acaoCodigo, permitido) {
      return http().requisitar('PATCH', caminhoGrupo(grupoId) + '/acoes/' + encodeURIComponent(acaoCodigo), {
        corpo: { permitido: permitido },
      });
    },
  };

  // ───────────────────────────────────────────────────────────────────
  // Diferença — o que realmente mudou
  // ───────────────────────────────────────────────────────────────────

  /**
   * Compara o estado atual com o editado e devolve SOMENTE as operações
   * diferentes. Usa comparação estrita: false !== null, então "negar" e
   * "herdar" nunca se confundem, e uma operação que continua FALSE não
   * entra no corpo (não há o que gravar) nem vira NULL por acidente.
   *
   * Devolve `{}` quando nada mudou — a tela usa isso para não chamar a
   * API à toa (o serviço responderia 400 GRUPO_PERMISSAO_SEM_ALTERACAO).
   */
  function diferencaDeRecurso(atual, editado) {
    var base = atual || {};
    var novo = editado || {};
    var diferenca = {};

    for (var i = 0; i < OPERACOES.length; i += 1) {
      var operacao = OPERACOES[i];
      if (!Object.prototype.hasOwnProperty.call(novo, operacao)) continue;

      var valorAtual = Object.prototype.hasOwnProperty.call(base, operacao) ? base[operacao] : null;
      if (novo[operacao] !== valorAtual) {
        diferenca[operacao] = novo[operacao];
      }
    }
    return diferenca;
  }

  var temDiferenca = function (diferenca) { return Object.keys(diferenca).length > 0; };

  // ───────────────────────────────────────────────────────────────────
  // Mensagens
  // ───────────────────────────────────────────────────────────────────

  var TEXTOS = {
    SESSAO_INVALIDA: 'Sua sessão expirou. Entre novamente para continuar.',
    GRUPO_PERMISSAO_NAO_AUTORIZADA: 'Você não tem autorização para configurar as permissões deste grupo.',
    GRUPO_NAO_AUTORIZADO: 'Você não tem autorização para administrar grupos de acesso.',
    CATALOGO_NAO_AUTORIZADO: 'Você não tem autorização para consultar o catálogo de ações.',
    GRUPO_NAO_ENCONTRADO: 'Este grupo não existe mais.',
    GRUPO_PERMISSAO_SEM_ALTERACAO: 'Nada foi alterado nesta permissão.',
    GRUPO_PERMISSAO_ACAO_INVALIDA: 'Esta ação não existe mais no catálogo ou foi desativada.',
    GRUPO_PERMISSAO_ACAO_NAO_ALTERNATIVA:
      'Esta ação não aceita permitir ou negar por grupo: ela só pode herdar do perfil. '
      + 'Permitir ou negar aqui só vale para ações do tipo "alternativa".',
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

    /** Frase que explica o que cada estado significa, em português comum. */
    explicacaoDoEstado: function (valor) {
      if (valor === true) return 'O grupo permite, mesmo que o perfil não permita.';
      if (valor === false) return 'O grupo nega, mesmo que o perfil permita.';
      return 'O grupo não opina: vale o que o perfil da pessoa permitir.';
    },

    deSucesso: function (alvo, alterado) {
      if (alterado === false) return 'Nada mudou em “' + alvo + '”.';
      return 'Permissões de “' + alvo + '” salvas.';
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

  /** Valor tri-state <-> texto do <select>, sem nunca passar por booleano solto. */
  function paraTexto(valor) {
    if (valor === true) return 'true';
    if (valor === false) return 'false';
    return 'null';
  }

  function paraValor(texto) {
    if (texto === 'true') return true;
    if (texto === 'false') return false;
    return null;
  }

  var render = {
    escaparHtml: escaparHtml,
    paraTexto: paraTexto,
    paraValor: paraValor,
    get OPERACOES() { return OPERACOES.slice(); },
    get ROTULOS_OPERACAO() { return Object.assign({}, ROTULOS_OPERACAO); },

    /** Os três estados, com rótulos que uma pessoa sem RBAC entende. */
    seletor: function (nome, valor, desabilitado) {
      var atributos = 'class="select" data-campo="' + escaparHtml(nome) + '"'
        + (desabilitado ? ' disabled' : '');
      var selecionado = paraTexto(valor);
      var opcao = function (v, rotulo) {
        return '<option value="' + v + '"' + (selecionado === v ? ' selected' : '') + '>' + rotulo + '</option>';
      };
      return '<select ' + atributos + '>'
        + opcao('null', 'Herdar do perfil')
        + opcao('true', 'Permitir')
        + opcao('false', 'Negar')
        + '</select>';
    },

    /**
     * Uma linha por recurso, com as quatro operações independentes.
     * `configuracao` pode ser null (recurso ainda sem configuração
     * nenhuma): as quatro nascem herdando, que é o estado real de quem
     * não tem linha em grupo_permissoes_recurso.
     */
    linhaRecurso: function (recurso, configuracao) {
      var atual = configuracao || {};
      var celulas = OPERACOES.map(function (operacao) {
        var valor = Object.prototype.hasOwnProperty.call(atual, operacao) ? atual[operacao] : null;
        return '<td>' + render.seletor(operacao, valor, false) + '</td>';
      }).join('');

      return '<tr data-recurso="' + escaparHtml(recurso.id) + '">'
        + '<td><strong>' + escaparHtml(recurso.nome) + '</strong>'
        + '<div style="font-size:11px;color:var(--on-surface-variant)">' + escaparHtml(recurso.id) + '</div></td>'
        + celulas
        + '<td><button class="mini-btn" data-acao="salvar-recurso" data-recurso="' + escaparHtml(recurso.id) + '">Salvar</button></td>'
        + '</tr>';
    },

    tabelaRecursos: function (recursos, configuracoesPorRecurso) {
      var mapa = configuracoesPorRecurso || {};
      var cabecalho = OPERACOES.map(function (o) { return '<th>' + ROTULOS_OPERACAO[o] + '</th>'; }).join('');
      var linhas = recursos.map(function (recurso) {
        return render.linhaRecurso(recurso, mapa[recurso.id] || null);
      }).join('');

      return '<div class="table-wrap"><table>'
        + '<thead><tr><th>Página / módulo</th>' + cabecalho + '<th></th></tr></thead>'
        + '<tbody>' + linhas + '</tbody></table></div>';
    },

    /**
     * Uma linha por ação do catálogo. Ações fora de ALTERNATIVA só
     * aceitam "Herdar": o seletor aparece desabilitado com a explicação
     * — conforto para quem configura, nunca a barreira (quem recusa é o
     * backend, com 409).
     */
    linhaAcao: function (acao, configuracao) {
      var permitido = configuracao && Object.prototype.hasOwnProperty.call(configuracao, 'permitido')
        ? configuracao.permitido
        : null;
      var configuravel = acao.ativo === true && acao.modoAutorizacaoIndividual === MODO_ALTERNATIVA;

      var nota = '';
      if (acao.ativo !== true) {
        nota = 'Ação desativada no catálogo.';
      } else if (!configuravel) {
        nota = 'Modo ' + escaparHtml(acao.modoAutorizacaoIndividual) + ': só pode herdar do perfil.';
      } else if (acao.exigeSst === true) {
        nota = 'Exige participação na SST, além desta permissão.';
      }

      return '<tr data-acao-codigo="' + escaparHtml(acao.codigo) + '">'
        + '<td><strong>' + escaparHtml(acao.nome) + '</strong>'
        + '<div style="font-size:11px;color:var(--on-surface-variant)">' + escaparHtml(acao.codigo) + '</div></td>'
        + '<td>' + render.seletor('permitido', permitido, !configuravel) + '</td>'
        + '<td style="font-size:12px;color:var(--on-surface-variant)">' + nota + '</td>'
        + '<td><button class="mini-btn" data-acao="salvar-acao" data-acao-codigo="' + escaparHtml(acao.codigo) + '"'
        + (configuravel ? '' : ' disabled') + '>Salvar</button></td>'
        + '</tr>';
    },

    tabelaAcoes: function (catalogo, configuracoesPorAcao) {
      var mapa = configuracoesPorAcao || {};
      var linhas = catalogo.map(function (acao) {
        return render.linhaAcao(acao, mapa[acao.codigo] || null);
      }).join('');

      return '<div class="table-wrap"><table>'
        + '<thead><tr><th>Ação</th><th>Permissão do grupo</th><th>Observação</th><th></th></tr></thead>'
        + '<tbody>' + linhas + '</tbody></table></div>';
    },

    carregando: function () {
      return '<div class="preview-note" style="text-align:center">Carregando permissões…</div>';
    },

    semGrupo: function () {
      return '<div class="preview-note" style="text-align:center">Selecione um grupo para configurar as permissões dele.</div>';
    },

    falha: function (mensagem) {
      return '<div class="notice" style="background:var(--error-container);color:var(--error);border-color:rgba(255,59,48,0.2)">'
        + escaparHtml(mensagem) + '</div>';
    },
  };

  /** Índice por chave, para casar catálogo com o que está configurado. */
  function indexarPor(lista, chave) {
    var mapa = {};
    (lista || []).forEach(function (item) { mapa[item[chave]] = item; });
    return mapa;
  }

  // ───────────────────────────────────────────────────────────────────
  // Controlador — a sequência assíncrona da tela
  // ───────────────────────────────────────────────────────────────────

  /**
   * O PROBLEMA QUE ESTE CONTROLADOR RESOLVE (correção pós-auditoria da
   * 3T): requisição HTTP não chega na ordem em que sai.
   *
   * Selecionar o Grupo A e logo depois o Grupo B dispara duas cargas. Se
   * a resposta de A chegar DEPOIS da de B, a tela passa a exibir as
   * permissões de A enquanto o seletor diz "B" — e quem estiver
   * configurando acredita estar mexendo em B. O mesmo vale para uma
   * gravação iniciada em A e concluída depois da troca: o resultado não
   * pode substituir o estado visual de B, nem contaminar o cache de
   * permissões que passou a ser o de B.
   *
   * A GUARDA é uma geração monotônica. Cada carga anota a geração
   * vigente quando começou; qualquer coisa que mude o contexto —
   * selecionar outro grupo, recarregar, encerrar a sessão — incrementa a
   * geração. Ao voltar do `await`, a resposta só age se a geração ainda
   * for a dela. Não é "cancelar a requisição" (fetch já saiu e o
   * servidor já fez o trabalho): é recusar-se a APLICAR um resultado que
   * já não descreve o que está na tela.
   *
   * Na gravação existe uma segunda captura, além da geração: o
   * IDENTIFICADOR DO GRUPO DE ORIGEM. Ele vai no PATCH, de modo que a
   * escrita sempre atinge o grupo que a pessoa estava vendo quando
   * clicou — nunca o que ela selecionou no meio do caminho.
   *
   * O 401 é a exceção deliberada à guarda: sessão não é por grupo. Uma
   * resposta obsoleta que diz "sessão expirou" continua verdadeira sobre
   * o estado global, e é tratada antes de qualquer verificação de
   * obsolescência.
   *
   * POR QUE ISSO MORA NO MÓDULO, e não no <script> da página: dentro do
   * HTML essa sequência não é alcançável por teste nenhum. Aqui ela é
   * exercitada com um `ui` falso e respostas resolvidas fora de ordem de
   * propósito — que é o que a auditoria pediu para verificar.
   *
   * `ui` é o adaptador de DOM, e é tudo o que a página precisa fornecer:
   *   renderRecursos(html), renderAcoes(html)   — as duas tabelas
   *   aviso(texto, tipo|null)                   — a faixa de recado
   *   grupoInativo(bool)                        — o aviso de grupo inativo
   *   sessaoExpirada(mensagem)                  — devolver ao login
   */
  function criarControlador(opcoes) {
    var ui = opcoes.ui;
    var chamadas = opcoes.acoes || acoes;
    var recursosDaTela = opcoes.recursos || RECURSOS;

    var geracao = 0;
    var grupoAtual = null;
    var nomeAtual = '';
    var opcoesAtuais = {};
    var estado = { recursos: {}, acoes: {} };

    var obsoleta = function (minha) { return minha !== geracao; };

    /** Invalida tudo o que estiver em voo. */
    function invalidar() {
      geracao += 1;
      estado = { recursos: {}, acoes: {} };
    }

    /**
     * 401 vale sempre, obsoleta ou não: a sessão é global. Devolve true
     * quando tratou, e nesse caso nada mais deve acontecer.
     */
    function tratouSessao(resposta) {
      if (!mensagens.exigeNovoLogin(resposta)) return false;
      invalidar();
      grupoAtual = null;
      nomeAtual = '';
      ui.sessaoExpirada(mensagens.deErro(resposta));
      return true;
    }

    function mostrarSemGrupo() {
      ui.renderRecursos(render.semGrupo());
      ui.renderAcoes(render.semGrupo());
    }

    /**
     * Carrega as permissões de um grupo. `extras.nome` e `extras.inativo`
     * vêm do seletor e servem só para exibição.
     */
    async function selecionar(grupoId, extras) {
      invalidar();
      var minha = geracao;

      grupoAtual = (grupoId === null || grupoId === undefined || grupoId === '') ? null : Number(grupoId);
      opcoesAtuais = extras || {};
      nomeAtual = opcoesAtuais.nome || (grupoAtual === null ? '' : String(grupoAtual));

      ui.grupoInativo(grupoAtual !== null && opcoesAtuais.inativo === true);
      ui.aviso('', null);

      if (grupoAtual === null) {
        mostrarSemGrupo();
        return { status: 'sem-grupo' };
      }

      ui.renderRecursos(render.carregando());
      ui.renderAcoes(render.carregando());

      var grupoOrigem = grupoAtual;
      var respostas = await Promise.all([
        chamadas.listarRecursos(grupoOrigem),
        chamadas.listarAcoes(grupoOrigem),
        chamadas.catalogoDeAcoes(),
      ]);

      for (var i = 0; i < respostas.length; i += 1) {
        if (tratouSessao(respostas[i])) return { status: 'sessao' };
      }

      // A GUARDA. Daqui para baixo nada pode tocar a tela se outra
      // seleção (ou um recarregar, ou o logout) já aconteceu.
      if (obsoleta(minha)) return { status: 'obsoleta', grupo: grupoOrigem };

      for (var j = 0; j < respostas.length; j += 1) {
        if (respostas[j].ok) continue;
        var texto = mensagens.deErro(respostas[j]);
        ui.renderRecursos(render.falha(texto));
        ui.renderAcoes(render.falha(texto));
        return { status: 'erro', grupo: grupoOrigem };
      }

      estado = {
        recursos: indexarPor(respostas[0].dados.recursos || [], 'recurso'),
        acoes: indexarPor(respostas[1].dados.acoes || [], 'acaoCodigo'),
      };

      ui.renderRecursos(render.tabelaRecursos(recursosDaTela, estado.recursos));
      ui.renderAcoes(render.tabelaAcoes(respostas[2].dados.acoes || [], estado.acoes));
      return { status: 'ok', grupo: grupoOrigem };
    }

    function recarregar() {
      return selecionar(grupoAtual, opcoesAtuais);
    }

    /**
     * Uma gravação obsoleta não mexe na tela. Se ela FALHOU, o recado
     * ainda aparece — nomeando o grupo de origem, para não dar a
     * entender que o erro é do grupo que está sendo exibido agora.
     * Silenciar um erro seria pior do que exibi-lo identificado.
     */
    function avisarFalhaObsoleta(resposta, nomeOrigem) {
      if (resposta.ok) return;
      ui.aviso('Não foi possível salvar em “' + nomeOrigem + '”: ' + mensagens.deErro(resposta), 'erro');
    }

    /**
     * `valoresDaTela` são as quatro operações lidas dos <select> da
     * linha. Só a diferença em relação ao estado carregado é enviada —
     * é isso que preserva no banco as operações que ninguém tocou.
     */
    async function salvarRecurso(recurso, valoresDaTela) {
      var minha = geracao;
      var grupoOrigem = grupoAtual;
      var nomeOrigem = nomeAtual;

      if (grupoOrigem === null) return { status: 'sem-grupo' };

      var diferenca = diferencaDeRecurso(estado.recursos[recurso], valoresDaTela);
      if (!temDiferenca(diferenca)) {
        ui.aviso(mensagens.deSucesso(recurso, false), 'ok');
        return { status: 'sem-mudanca', grupo: grupoOrigem };
      }

      // O destino da escrita é o grupo capturado AQUI, nunca o que
      // estiver selecionado quando a resposta voltar.
      var resposta = await chamadas.configurarRecurso(grupoOrigem, recurso, diferenca);

      if (tratouSessao(resposta)) return { status: 'sessao' };

      if (obsoleta(minha)) {
        avisarFalhaObsoleta(resposta, nomeOrigem);
        return { status: 'obsoleta', grupo: grupoOrigem };
      }

      if (!resposta.ok) {
        ui.aviso(mensagens.deErro(resposta), 'erro');
        return { status: 'erro', grupo: grupoOrigem };
      }

      estado.recursos[recurso] = resposta.dados.configuracao;
      ui.aviso(mensagens.deSucesso(recurso, resposta.dados.alterado), 'ok');
      return { status: 'ok', grupo: grupoOrigem, alterado: resposta.dados.alterado };
    }

    async function salvarAcao(codigo, valorDaTela) {
      var minha = geracao;
      var grupoOrigem = grupoAtual;
      var nomeOrigem = nomeAtual;

      if (grupoOrigem === null) return { status: 'sem-grupo' };

      var anterior = estado.acoes[codigo] ? estado.acoes[codigo].permitido : null;
      if (valorDaTela === anterior) {
        ui.aviso(mensagens.deSucesso(codigo, false), 'ok');
        return { status: 'sem-mudanca', grupo: grupoOrigem };
      }

      var resposta = await chamadas.configurarAcao(grupoOrigem, codigo, valorDaTela);

      if (tratouSessao(resposta)) return { status: 'sessao' };

      if (obsoleta(minha)) {
        avisarFalhaObsoleta(resposta, nomeOrigem);
        return { status: 'obsoleta', grupo: grupoOrigem };
      }

      if (!resposta.ok) {
        ui.aviso(mensagens.deErro(resposta), 'erro');
        return { status: 'erro', grupo: grupoOrigem };
      }

      estado.acoes[codigo] = resposta.dados.configuracao;
      ui.aviso(mensagens.deSucesso(codigo, resposta.dados.alterado), 'ok');
      return { status: 'ok', grupo: grupoOrigem, alterado: resposta.dados.alterado };
    }

    /** Logout, ou qualquer saída: o que estiver em voo morre obsoleto. */
    function encerrar() {
      invalidar();
      grupoAtual = null;
      nomeAtual = '';
      opcoesAtuais = {};
      ui.aviso('', null);
      ui.grupoInativo(false);
    }

    return {
      selecionar: selecionar,
      recarregar: recarregar,
      salvarRecurso: salvarRecurso,
      salvarAcao: salvarAcao,
      encerrar: encerrar,
      mostrarSemGrupo: mostrarSemGrupo,
      // Leitura para a página e para os testes — cópias, nunca o estado.
      grupoAtual: function () { return grupoAtual; },
      configuracaoDeRecurso: function (recurso) {
        var atual = estado.recursos[recurso];
        return atual ? Object.assign({}, atual) : null;
      },
      configuracaoDeAcao: function (codigo) {
        var atual = estado.acoes[codigo];
        return atual ? Object.assign({}, atual) : null;
      },
    };
  }

  global.EpiGrupoPermissoes = {
    acoes: acoes,
    mensagens: mensagens,
    render: render,
    criarControlador: criarControlador,
    diferencaDeRecurso: diferencaDeRecurso,
    temDiferenca: temDiferenca,
    indexarPor: indexarPor,
    // Cópia nova a cada leitura, nas duas listas. `OPERACOES.slice()`
    // direto no objeto seria UMA cópia, criada no carregamento: quem a
    // lesse e a mutasse contaminaria todas as leituras seguintes — o
    // mesmo defeito real que a 3R encontrou em
    // CAMPOS_DE_AUTORIDADE_PROIBIDOS. O getter devolve um array novo, e
    // RECURSOS devolve também objetos novos, para que nem os itens
    // sejam compartilhados.
    get OPERACOES() { return OPERACOES.slice(); },
    get RECURSOS() { return RECURSOS.map(function (r) { return { id: r.id, nome: r.nome }; }); },
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.EpiGrupoPermissoes;
  }
})(typeof window !== 'undefined' ? window : globalThis);
