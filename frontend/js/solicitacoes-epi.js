(function (global) {
  'use strict';

  /**
   * EpiSolicitacoesEpi — contratos do frontend com a solicitação de EPI
   * (Bloco 12, 12G-1): as rotas da 12F (minhas, fila, entregáveis, detalhe,
   * criar, cancelar, decidir, encerrar e entregar) e as da 12G-0 (encerráveis
   * e o contexto da criação).
   *
   * CONSULTA ESTRITA: cada consulta monta só os parâmetros que o servidor
   * aceita (os schemas da 12F e da 12G-0 são strictObject). Filtro
   * desconhecido, id, página, limite, status ou "previsto no GHE" fora do
   * formato é erro de programação (TypeError antes de qualquer rede): empresa,
   * usuário e CPF nunca vão na consulta. A busca é texto da pessoa: vazia não
   * vai; acima do limite volta como validação local, sem rede.
   *
   * ESCRITA: só caminho, método e o corpo recebido. Montar e validar o corpo é
   * de cada fluxo (12G-2 a 12G-4); campos de autoridade são recusados por
   * EpiHttp antes de sair do navegador, e o servidor revalida tudo.
   *
   * MENSAGENS: toda solicitação não encontrada tem o mesmo texto, venha o que
   * vier do servidor (anti-enumeração: a de outro solicitante, a de outra
   * empresa e a inexistente são a mesma). Falha do servidor nunca mostra
   * detalhe interno.
   *
   * CAPACIDADES: só as permissões reais (EpiPermissoes), nunca o nome do
   * perfil. O MASTER não ganha nada de solicitação por ser MASTER.
   */

  var LIMITE_PADRAO = 20;
  var LIMITE_MAXIMO = 100;
  var PAGINA_MAXIMA = 10000;
  var BUSCA_MAXIMA = 100;
  var ID_MAXIMO = 2147483647;

  var STATUS = Object.freeze(['PENDENTE', 'APROVADA', 'APROVADA_PARCIAL', 'REPROVADA', 'CANCELADA', 'ENTREGUE', 'ENCERRADA']);
  var ROTULOS_STATUS = Object.freeze({
    PENDENTE: 'Pendente',
    APROVADA: 'Aprovada',
    APROVADA_PARCIAL: 'Aprovada parcialmente',
    REPROVADA: 'Reprovada',
    CANCELADA: 'Cancelada',
    ENTREGUE: 'Entregue',
    ENCERRADA: 'Encerrada',
  });
  // Situação operacional derivada pelo servidor (nunca recalculada aqui).
  var SITUACOES = Object.freeze(['AGUARDANDO_ESTOQUE', 'PARCIALMENTE_COBERTA', 'PRONTA_PARA_ENTREGA', 'PARCIALMENTE_ENTREGUE', 'ENTREGUE', 'SUSPENSA']);
  var ROTULOS_SITUACAO = Object.freeze({
    AGUARDANDO_ESTOQUE: 'Aguardando estoque',
    PARCIALMENTE_COBERTA: 'Parcialmente coberta',
    PRONTA_PARA_ENTREGA: 'Pronta para entrega',
    PARCIALMENTE_ENTREGUE: 'Parcialmente entregue',
    ENTREGUE: 'Entregue',
    SUSPENSA: 'Suspensa',
  });

  // 12G-2: os motivos e os limites do pedido são os do backend (conferidos nos testes contra os repositórios e o serviço).
  var MOTIVOS = Object.freeze(['ADMISSAO', 'SUBSTITUICAO_PRAZO', 'DESGASTE_DANO', 'PERDA_EXTRAVIO', 'OUTRO']);
  var ROTULOS_MOTIVO = Object.freeze({
    ADMISSAO: 'Admissão',
    SUBSTITUICAO_PRAZO: 'Substituição por prazo',
    DESGASTE_DANO: 'Desgaste ou dano',
    PERDA_EXTRAVIO: 'Perda ou extravio',
    OUTRO: 'Outro',
  });
  var LIMITES_PEDIDO = Object.freeze({
    itens: 20, tamanho: 20, justificativa: 500, observacao: 500, justificativaCancelamento: 500, quantidade: 2147483647,
  });

  var BASE = '/solicitacoes-epi';

  function http() {
    var cliente = global.EpiHttp;
    if (!cliente) throw new Error('EpiHttp não carregado: inclua js/api-http.js antes de js/solicitacoes-epi.js');
    return cliente;
  }

  function idValido(v) { return typeof v === 'number' && Math.floor(v) === v && v > 0 && v <= ID_MAXIMO; }
  function exigirId(v, nome) { if (!idValido(v)) throw new TypeError(nome + ' inválido'); }
  function inteiroEntre(v, minimo, maximo) { return typeof v === 'number' && Math.floor(v) === v && v >= minimo && v <= maximo; }

  function exigirConhecidos(filtro, permitidos) {
    var chaves = Object.keys(filtro);
    for (var i = 0; i < chaves.length; i += 1) {
      if (permitidos.indexOf(chaves[i]) === -1) throw new TypeError('filtro desconhecido: ' + chaves[i]);
    }
  }

  function paginacao(f) {
    var pagina = f.pagina === undefined ? 1 : f.pagina;
    var limite = f.limite === undefined ? LIMITE_PADRAO : f.limite;
    if (!inteiroEntre(pagina, 1, PAGINA_MAXIMA)) throw new TypeError('página inválida');
    if (!inteiroEntre(limite, 1, LIMITE_MAXIMO)) throw new TypeError('limite inválido');
    return [['pagina', pagina], ['limite', limite]];
  }

  /** null: sem busca; undefined: busca longa demais (validação local). */
  function busca(v) {
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string') throw new TypeError('busca inválida');
    var texto = v.trim();
    if (texto.length === 0) return null;
    return Array.from(texto).length > BUSCA_MAXIMA ? undefined : texto;
  }

  function consulta(pares) {
    var partes = [];
    for (var i = 0; i < pares.length; i += 1) {
      if (pares[i][1] !== null && pares[i][1] !== undefined) partes.push(pares[i][0] + '=' + encodeURIComponent(String(pares[i][1])));
    }
    return partes.length === 0 ? '' : '?' + partes.join('&');
  }

  function filtroDe(f) {
    if (f === undefined || f === null) return {};
    if (typeof f !== 'object' || Array.isArray(f)) throw new TypeError('filtro inválido');
    return f;
  }

  function funcionarioOpcional(v) {
    if (v === undefined || v === null) return null;
    exigirId(v, 'identificador de funcionário');
    return v;
  }

  // Mesmo envelope de EpiHttp, sem rede: a busca longa demais nem sai do navegador.
  function validacaoLocal() {
    return Promise.resolve({
      ok: false, status: 400, dados: null, codigo: 'BUSCA_INVALIDA', mensagem: POR_CODIGO.BUSCA_INVALIDA, detalhes: null,
    });
  }

  function caminhoDe(id, sufixo) {
    exigirId(id, 'identificador de solicitação');
    return BASE + '/' + id + (sufixo || '');
  }

  var acoes = {
    /** GET /solicitacoes-epi/minhas — recurso request, visualizar. */
    minhas: function (filtro) {
      var f = filtroDe(filtro);
      exigirConhecidos(f, ['status', 'pagina', 'limite']);
      if (f.status !== undefined && f.status !== null && STATUS.indexOf(f.status) === -1) throw new TypeError('status inválido');
      return http().requisitar('GET', BASE + '/minhas' + consulta([['status', f.status]].concat(paginacao(f))));
    },

    /** GET /solicitacoes-epi/fila — ação APROVAR_SOLICITACAO. */
    fila: function (filtro) {
      var f = filtroDe(filtro);
      exigirConhecidos(f, ['pagina', 'limite']);
      return http().requisitar('GET', BASE + '/fila' + consulta(paginacao(f)));
    },

    /** GET /solicitacoes-epi/entregaveis — ação REALIZAR_ENTREGA. */
    entregaveis: function (filtro) {
      var f = filtroDe(filtro);
      exigirConhecidos(f, ['funcionarioId', 'pagina', 'limite']);
      return http().requisitar('GET', BASE + '/entregaveis' + consulta([['funcionarioId', funcionarioOpcional(f.funcionarioId)]].concat(paginacao(f))));
    },

    /** GET /solicitacoes-epi/encerraveis — ação ENCERRAR_SOLICITACAO (12G-0). */
    encerraveis: function (filtro) {
      var f = filtroDe(filtro);
      exigirConhecidos(f, ['funcionarioId', 'pagina', 'limite']);
      return http().requisitar('GET', BASE + '/encerraveis' + consulta([['funcionarioId', funcionarioOpcional(f.funcionarioId)]].concat(paginacao(f))));
    },

    /** GET /solicitacoes-epi/:id — quem vê, e o quê, decide o servidor. */
    detalhe: function (id) {
      return http().requisitar('GET', caminhoDe(id));
    },

    /** GET /solicitacoes-epi/contexto/funcionarios — recurso request, criar (12G-0). */
    contextoFuncionarios: function (filtro) {
      var f = filtroDe(filtro);
      exigirConhecidos(f, ['busca', 'pagina', 'limite']);
      var termo = busca(f.busca);
      var pares = [['busca', termo]].concat(paginacao(f));
      if (termo === undefined) return validacaoLocal();
      return http().requisitar('GET', BASE + '/contexto/funcionarios' + consulta(pares));
    },

    /** GET /solicitacoes-epi/contexto/:funcionarioId/materiais — recurso request, criar (12G-0). */
    contextoMateriais: function (funcionarioId, filtro) {
      exigirId(funcionarioId, 'identificador de funcionário');
      var f = filtroDe(filtro);
      exigirConhecidos(f, ['busca', 'previstoNoGhe', 'pagina', 'limite']);
      if (f.previstoNoGhe !== undefined && f.previstoNoGhe !== null && typeof f.previstoNoGhe !== 'boolean') throw new TypeError('previstoNoGhe inválido');
      var termo = busca(f.busca);
      var pares = [['busca', termo], ['previstoNoGhe', f.previstoNoGhe]].concat(paginacao(f));
      if (termo === undefined) return validacaoLocal();
      return http().requisitar('GET', BASE + '/contexto/' + funcionarioId + '/materiais' + consulta(pares));
    },

    /** POST /solicitacoes-epi — recurso request, criar. */
    criar: function (corpo) {
      return http().requisitar('POST', BASE, { corpo: corpo });
    },

    /** POST /solicitacoes-epi/:id/cancelamento — recurso request, editar. */
    cancelar: function (id, corpo) {
      return http().requisitar('POST', caminhoDe(id, '/cancelamento'), { corpo: corpo });
    },

    /** POST /solicitacoes-epi/:id/decisao — APROVAR e/ou REPROVAR, conforme os itens. */
    decidir: function (id, corpo) {
      return http().requisitar('POST', caminhoDe(id, '/decisao'), { corpo: corpo });
    },

    /** POST /solicitacoes-epi/:id/encerramento — ação ENCERRAR_SOLICITACAO. */
    encerrar: function (id, corpo) {
      return http().requisitar('POST', caminhoDe(id, '/encerramento'), { corpo: corpo });
    },

    /** POST /solicitacoes-epi/:id/entregas — ação REALIZAR_ENTREGA. */
    entregar: function (id, corpo) {
      return http().requisitar('POST', caminhoDe(id, '/entregas'), { corpo: corpo });
    },
  };

  // Por código do servidor (e o da validação local da busca).
  var POR_CODIGO = {
    SOLICITACAO_NAO_ENCONTRADA: 'Solicitação não encontrada.',
    FUNCIONARIO_NAO_ENCONTRADO: 'Trabalhador não encontrado.',
    FUNCIONARIO_INATIVO: 'Trabalhador inativo não recebe EPI.',
    PERMISSAO_NEGADA: 'Você não tem permissão para esta operação.',
    BUSCA_INVALIDA: 'O termo de busca deve ter no máximo 100 caracteres.',
    VALIDACAO: 'Dados inválidos. Revise os campos e tente novamente.',
    RESPOSTA_INVALIDA: 'O servidor respondeu de forma inesperada. Tente novamente.',
    // 12G-2: criação e cancelamento do pedido (códigos do serviço e do schema).
    TAMANHO_OBRIGATORIO: 'Informe o tamanho deste EPI.',
    TAMANHO_NAO_SE_APLICA: 'Este EPI não usa tamanho.',
    TAMANHO_INVALIDO: 'Tamanho inválido (até 20 caracteres).',
    QUANTIDADE_INVALIDA: 'Informe uma quantidade inteira a partir de 1.',
    JUSTIFICATIVA_OBRIGATORIA: 'Explique o motivo deste item.',
    JUSTIFICATIVA_INVALIDA: 'Justificativa inválida (até 500 caracteres).',
    OBSERVACAO_INVALIDA: 'Observação inválida (até 500 caracteres).',
    ITEM_REPETIDO: 'Cada EPI e tamanho aparece uma vez só no pedido.',
    ITENS_FORA_DO_LIMITE: 'O pedido precisa ter de 1 a 20 itens.',
    VALOR_NAO_PERMITIDO: 'Escolha uma das opções da lista.',
    MATERIAL_NAO_ENCONTRADO: 'Um dos EPIs não está mais disponível para pedido. A lista de EPIs foi recarregada.',
    MATERIAL_INATIVO: 'Um dos EPIs foi desativado e não pode ser pedido. A lista de EPIs foi recarregada.',
    MATERIAL_TAMANHO_NAO_CLASSIFICADO: 'Um dos EPIs ainda não tem a classificação de tamanho no cadastro e não pode ser pedido.',
    IDEMPOTENCIA_CONFLITO: 'Este envio conflita com um pedido anterior. Revise os dados e envie de novo.',
    USUARIO_INATIVO: 'Seu usuário está inativo nesta empresa.',
    SOLICITACAO_NAO_PENDENTE: 'Este pedido já foi decidido ou cancelado e não pode mais ser cancelado.',
    SOLICITACAO_ALTERADA: 'O pedido foi alterado por outra operação. Os dados foram recarregados.',
  };
  var TEXTO_SESSAO = 'Sua sessão expirou. Entre novamente para continuar.';
  var TEXTO_REDE = 'Não foi possível falar com o servidor. Verifique sua conexão.';
  var TEXTO_FALHA = 'Não foi possível concluir a operação. Tente novamente.';

  var mensagens = {
    exigeNovoLogin: function (r) { return !!r && r.ok === false && r.status === 401; },

    /** O texto de um código conhecido (a validação local usa os mesmos textos do servidor). */
    doCodigo: function (codigo) {
      return Object.prototype.hasOwnProperty.call(POR_CODIGO, codigo) ? POR_CODIGO[codigo] : POR_CODIGO.VALIDACAO;
    },

    deErro: function (r) {
      if (!r || r.ok) return '';
      if (r.status === 0) return TEXTO_REDE;
      if (r.status === 401) return TEXTO_SESSAO;
      if (r.status >= 500) return TEXTO_FALHA;
      if (r.codigo && Object.prototype.hasOwnProperty.call(POR_CODIGO, r.codigo)) return POR_CODIGO[r.codigo];
      // 404 sem código conhecido também é "não encontrada": nunca se diz por quê.
      if (r.status === 404) return POR_CODIGO.SOLICITACAO_NAO_ENCONTRADA;
      if (r.status === 403) return POR_CODIGO.PERMISSAO_NEGADA;
      if (r.status === 400) return POR_CODIGO.VALIDACAO;
      return r.mensagem || TEXTO_FALHA;
    },

    /**
     * Os erros de campo de um 400 (validação do schema ou do serviço): o
     * caminho do campo (ex.: 'body.itens[1].tamanho') e um texto conhecido.
     * Código desconhecido vira o texto genérico, nunca o do servidor.
     */
    deCampos: function (r) {
      if (!r || r.ok || r.status !== 400 || !Array.isArray(r.detalhes)) return [];
      return r.detalhes.filter(function (d) { return d && typeof d.campo === 'string'; }).map(function (d) {
        var codigo = typeof d.codigo === 'string' && Object.prototype.hasOwnProperty.call(POR_CODIGO, d.codigo) ? d.codigo : 'VALIDACAO';
        return { campo: d.campo, codigo: codigo, mensagem: POR_CODIGO[codigo] };
      });
    },
  };

  /**
   * O que a pessoa pode fazer nas telas da solicitação, pelas permissões
   * reais. Apresentação apenas: o servidor decide cada operação de novo.
   */
  function capacidades(permissoes) {
    var P = global.EpiPermissoes;
    if (!P) throw new Error('EpiPermissoes não carregado: inclua js/permissoes-efetivas.js antes de js/solicitacoes-epi.js');
    return {
      verMinhas: P.recurso(permissoes, 'request', 'visualizar'),
      criar: P.recurso(permissoes, 'request', 'criar'),
      cancelar: P.recurso(permissoes, 'request', 'editar'),
      aprovar: P.acao(permissoes, 'APROVAR_SOLICITACAO'),
      reprovar: P.acao(permissoes, 'REPROVAR_SOLICITACAO'),
      entregar: P.acao(permissoes, 'REALIZAR_ENTREGA'),
      encerrar: P.acao(permissoes, 'ENCERRAR_SOLICITACAO'),
      consultarVinculosSst: P.administra(permissoes, 'vinculosSst', 'consultar'),
      alterarVinculosSst: P.administra(permissoes, 'vinculosSst', 'alterar'),
    };
  }

  global.EpiSolicitacoesEpi = {
    acoes: acoes,
    mensagens: mensagens,
    capacidades: capacidades,
    STATUS: STATUS,
    ROTULOS_STATUS: ROTULOS_STATUS,
    SITUACOES: SITUACOES,
    ROTULOS_SITUACAO: ROTULOS_SITUACAO,
    MOTIVOS: MOTIVOS,
    ROTULOS_MOTIVO: ROTULOS_MOTIVO,
    LIMITES_PEDIDO: LIMITES_PEDIDO,
    LIMITE_PADRAO: LIMITE_PADRAO,
    LIMITE_MAXIMO: LIMITE_MAXIMO,
    BUSCA_MAXIMA: BUSCA_MAXIMA,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.EpiSolicitacoesEpi;
  }
})(typeof window !== 'undefined' ? window : globalThis);
