(function (global) {
  'use strict';

  /**
   * EpiGrupos — gestão dos grupos de acesso (Bloco 8, Incremento 8, Etapa
   * 5A, Subetapa 3S).
   *
   * Primeira tela do projeto que fala com o backend de verdade. Construída
   * inteiramente sobre a fundação aprovada na 3R (EpiHttp + EpiAuth, que
   * precisam ser carregados antes) e sobre os contratos HTTP aprovados na
   * 3M. Nada aqui usa js/db-api.js: o mock de localStorage continua
   * intocado servindo as telas antigas.
   *
   * TRÊS CAMADAS SEPARADAS, de propósito — é o que torna esta tela
   * testável sem navegador e sem biblioteca nova:
   *
   *   acoes     — fala com a API (os seis contratos da 3M). Devolve o
   *               envelope do EpiHttp, sem interpretar nada.
   *   mensagens — traduz um envelope em texto para a pessoa. Funções
   *               puras.
   *   render    — monta HTML já escapado. Funções puras.
   *
   * O acoplamento com o DOM mora na página (pages/grupos-acesso.html) e é
   * deliberadamente fino: ele chama estas três camadas e nada mais.
   *
   * O BACKEND É A AUTORIDADE FINAL: esta tela NÃO esconde botões por
   * perfil e não pergunta "quem é você" antes de agir. Ela tenta a
   * operação e trata o 403 que vier — que é o que a 3Q decide, relendo
   * perfil e autorizações individuais do banco a cada chamada. Um perfil
   * exibido pelo EpiAuth serve para escrever "Olá, Fulano", nunca para
   * autorizar.
   *
   * ENQUANTO A MIGRATION 024 NÃO FOR APLICADA no banco principal, as três
   * ações administrativas granulares da 3Q não existem no catálogo, então
   * apenas o MASTER administra grupos e todo ADMINISTRADOR recebe 403.
   * Isso é o comportamento CORRETO e esta tela não tem nenhum atalho para
   * contorná-lo — ela apenas mostra a recusa com clareza.
   */

  var CAMINHO = '/grupos-acesso';

  function http() {
    var cliente = global.EpiHttp;
    if (!cliente) {
      throw new Error('EpiHttp não carregado: inclua js/api-http.js antes de js/grupos-acesso.js');
    }
    return cliente;
  }

  // ───────────────────────────────────────────────────────────────────
  // Ações — os seis contratos reais da Subetapa 3M
  // ───────────────────────────────────────────────────────────────────

  var acoes = {
    /**
     * GET /api/grupos-acesso[?ativo=true|false]
     * `ativo` ausente lista ativos E inativos (contrato da 3M).
     */
    listar: function (filtro) {
      var f = filtro || {};
      var caminho = CAMINHO;
      if (f.ativo === true || f.ativo === false) {
        caminho += '?ativo=' + (f.ativo ? 'true' : 'false');
      }
      return http().requisitar('GET', caminho);
    },

    /** GET /api/grupos-acesso/:id */
    buscar: function (id) {
      return http().requisitar('GET', CAMINHO + '/' + encodeURIComponent(id));
    },

    /**
     * POST /api/grupos-acesso — 201.
     * `descricao` só é enviada quando informada; string vazia vira null
     * (o serviço da 3J trata null como "sem descrição").
     */
    criar: function (dados) {
      var d = dados || {};
      var corpo = { nome: d.nome };
      if (Object.prototype.hasOwnProperty.call(d, 'descricao')) {
        corpo.descricao = d.descricao === '' ? null : d.descricao;
      }
      return http().requisitar('POST', CAMINHO, { corpo: corpo });
    },

    /**
     * PATCH /api/grupos-acesso/:id.
     *
     * A distinção AUSENTE x null é o contrato de alterar() na 3J e
     * precisa sobreviver até aqui: campo não informado não é enviado (o
     * serviço preserva o valor), `descricao` vazia é enviada como null
     * (limpa a descrição). `ativo` não existe neste corpo — inativar e
     * reativar têm rotas próprias, decisão da 3J preservada.
     */
    alterar: function (id, campos) {
      var c = campos || {};
      var corpo = {};
      if (Object.prototype.hasOwnProperty.call(c, 'nome')) corpo.nome = c.nome;
      if (Object.prototype.hasOwnProperty.call(c, 'descricao')) {
        corpo.descricao = c.descricao === '' ? null : c.descricao;
      }
      return http().requisitar('PATCH', CAMINHO + '/' + encodeURIComponent(id), { corpo: corpo });
    },

    /**
     * POST /api/grupos-acesso/:id/inativar — sem corpo.
     * O schema da 3M (após o Ajuste Final) aceita corpo ausente e recusa
     * qualquer campo, então nada é enviado aqui de propósito.
     */
    inativar: function (id) {
      return http().requisitar('POST', CAMINHO + '/' + encodeURIComponent(id) + '/inativar');
    },

    /** POST /api/grupos-acesso/:id/reativar — sem corpo, mesma razão. */
    reativar: function (id) {
      return http().requisitar('POST', CAMINHO + '/' + encodeURIComponent(id) + '/reativar');
    },
  };

  // ───────────────────────────────────────────────────────────────────
  // Mensagens — um envelope vira texto para a pessoa
  // ───────────────────────────────────────────────────────────────────

  // Códigos de negócio da 3M/3J que merecem texto próprio. Os demais
  // caem na mensagem pública do backend, que já é segura por contrato
  // (HttpError nunca devolve valor recebido, SQL ou stack).
  var TEXTOS = {
    SESSAO_INVALIDA: 'Sua sessão expirou. Entre novamente para continuar.',
    GRUPO_NAO_AUTORIZADO: 'Você não tem autorização para administrar grupos de acesso.',
    GRUPO_NAO_ENCONTRADO: 'Este grupo não existe mais.',
    GRUPO_NOME_EM_USO: 'Já existe um grupo com este nome nesta empresa.',
    GRUPO_NOME_INVALIDO: 'Informe um nome de grupo válido (até 100 caracteres).',
    GRUPO_SEM_ALTERACAO: 'Altere o nome ou a descrição antes de salvar.',
    FALHA_DE_REDE: 'Não foi possível falar com o servidor. Verifique sua conexão.',
    RESPOSTA_INVALIDA: 'O servidor respondeu de forma inesperada. Tente novamente.',
  };

  var mensagens = {
    /**
     * Texto de UMA linha para qualquer desfecho de erro. Em 400 de
     * validação, prefere o detalhe do primeiro campo — é o que diz à
     * pessoa o que corrigir.
     */
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

    /** Sessão perdida: a página precisa voltar ao login, não só avisar. */
    exigeNovoLogin: function (resposta) {
      return !!resposta && resposta.ok === false && resposta.status === 401;
    },

    deSucesso: function (operacao, grupo) {
      var nome = (grupo && grupo.nome) || 'Grupo';
      switch (operacao) {
        case 'criar': return 'Grupo "' + nome + '" criado.';
        case 'alterar': return 'Grupo "' + nome + '" atualizado.';
        case 'inativar': return 'Grupo "' + nome + '" inativado. Ele continua existindo e mantém suas permissões e vínculos.';
        case 'reativar': return 'Grupo "' + nome + '" reativado. As concessões dele voltam a valer para quem estiver vinculado.';
        default: return 'Operação concluída.';
      }
    },
  };

  // ───────────────────────────────────────────────────────────────────
  // Render — HTML sempre escapado
  // ───────────────────────────────────────────────────────────────────

  /**
   * Escapa TUDO que vem do banco antes de virar HTML. Nome e descrição de
   * grupo são texto livre digitado por uma pessoa da empresa: sem isto,
   * um grupo chamado `<img onerror=...>` executaria script na tela de
   * quem administra. O backend aceita esse texto (é um rótulo legítimo,
   * e ele não interpreta HTML) — escapar é responsabilidade de quem
   * renderiza.
   */
  function escaparHtml(valor) {
    if (valor === null || valor === undefined) return '';
    return String(valor)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  var render = {
    escaparHtml: escaparHtml,

    /** Selo visual de ativo/inativo (item G da subetapa). */
    selo: function (ativo) {
      return ativo
        ? '<span class="badge badge-ok"><span class="material-symbols-outlined" style="font-size:14px">check_circle</span>Ativo</span>'
        : '<span class="badge badge-danger"><span class="material-symbols-outlined" style="font-size:14px">cancel</span>Inativo</span>';
    },

    linha: function (grupo) {
      var id = Number(grupo.id);
      var acao = grupo.ativo
        ? '<button class="mini-btn" data-acao="inativar" data-id="' + id + '">Inativar</button>'
        : '<button class="mini-btn" data-acao="reativar" data-id="' + id + '">Reativar</button>';

      return '<tr data-id="' + id + '">'
        + '<td><strong>' + escaparHtml(grupo.nome) + '</strong></td>'
        + '<td>' + (grupo.descricao ? escaparHtml(grupo.descricao) : '<span style="color:var(--on-surface-variant)">—</span>') + '</td>'
        + '<td>' + render.selo(grupo.ativo) + '</td>'
        + '<td><div class="inline-actions">'
        + '<button class="mini-btn" data-acao="editar" data-id="' + id + '">Editar</button>'
        + acao
        + '</div></td>'
        + '</tr>';
    },

    tabela: function (grupos) {
      var linhas = grupos.map(render.linha).join('');
      return '<div class="table-wrap"><table>'
        + '<thead><tr><th>Nome</th><th>Descrição</th><th>Situação</th><th>Ações</th></tr></thead>'
        + '<tbody>' + linhas + '</tbody>'
        + '</table></div>';
    },

    /** Estados da lista (item I): carregando, vazia e falha. */
    carregando: function () {
      return '<div class="preview-note" style="text-align:center">Carregando grupos…</div>';
    },

    vazia: function () {
      return '<div class="preview-note" style="text-align:center">'
        + 'Nenhum grupo de acesso cadastrado ainda. Crie o primeiro no botão “Novo grupo”.'
        + '</div>';
    },

    falha: function (mensagem) {
      return '<div class="notice" style="background:var(--error-container);color:var(--error);border-color:rgba(255,59,48,0.2)">'
        + escaparHtml(mensagem)
        + '</div>';
    },
  };

  global.EpiGrupos = {
    acoes: acoes,
    mensagens: mensagens,
    render: render,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.EpiGrupos;
  }
})(typeof window !== 'undefined' ? window : globalThis);
