(function (global) {
  'use strict';

  /**
   * EpiGruposHomogeneos — GHE e matriz GHE × EPI (Bloco 9, Etapa C, Parte C5).
   * Somente endpoints reais (recurso `employeeGroups`: visualizar consulta;
   * criar cadastra GHE; editar altera GHE e os vínculos):
   *   /grupos-homogeneos                         (listar, criar)
   *   /grupos-homogeneos/:id                     (alterar)
   *
   * Interface (Incremento 6A): tabela GHE (código) | Descrição (campo `nome` da API) | Situação | Ações. Setor, Função e o
   * campo `descricao` legado saíram da TELA, não do banco: o corpo de criação e o de edição NUNCA os levam, para que a
   * ausência na tela não apague o que já existe. O código vai como digitado (aparado); quem normaliza e valida é o backend.
   *   /grupos-homogeneos/:id/inativar|reativar
   *   /grupos-homogeneos/:id/materiais[/:materialId]  (vínculos diretos GHE × material: bloco secundário, exceções / legado)
   *   /grupos-homogeneos/:id/tipos-material[/:tipoId] (6B: gestão principal GHE × tipo de material, com classificação)
   *
   *   acoes     — chamadas à API (envelope do EpiHttp).
   *   matriz    — diferença entre o estado persistido e o marcado na tela.
   *   render    — HTML escapado das tabelas e dos estados.
   *   mensagens — textos de vazio e de erro (400/401/403/404/409/500).
   *
   * A matriz na tela é só seleção pendente: o que vale é sempre o que a API
   * devolve — depois de salvar (com sucesso ou não) a matriz é consultada de
   * novo. Nada vai para armazenamento local.
   */

  var CAMINHO = '/grupos-homogeneos';
  var LIMITE_GRUPOS = 100; // máximo aceito pela API

  function http() {
    if (!global.EpiHttp) throw new Error('EpiHttp não carregado: inclua js/api-http.js antes de js/grupos-homogeneos.js');
    return global.EpiHttp;
  }
  function texto(v) { return v === null || v === undefined ? '' : String(v); }
  function opcional(v) { var t = texto(v).trim(); return t ? t : null; }
  // Corpo de criação e de edição: nome (a Descrição), riscos e, só quando preenchido, o código. Nunca setor, função nem
  // descricao: não estão na tela, então não podem ser enviados (nem como null).
  function corpoDoGrupo(d) {
    var dados = d || {};
    var corpo = { nome: texto(dados.nome).trim(), riscos: opcional(dados.riscos) };
    var codigo = texto(dados.codigo).trim();
    if (codigo) corpo.codigo = codigo;
    return corpo;
  }
  function caminhoGrupo(id) { return CAMINHO + '/' + encodeURIComponent(id); }

  // ─── Ações ─────────────────────────────────────────────────────────
  var acoes = {
    listarGrupos: function () {
      return http().requisitar('GET', CAMINHO + '?pagina=1&limite=' + LIMITE_GRUPOS);
    },
    criarGrupo: function (dados) {
      return http().requisitar('POST', CAMINHO, { corpo: corpoDoGrupo(dados) });
    },
    alterarGrupo: function (id, dados) {
      return http().requisitar('PATCH', caminhoGrupo(id), { corpo: corpoDoGrupo(dados) });
    },
    inativarGrupo: function (id) {
      return http().requisitar('POST', caminhoGrupo(id) + '/inativar', { corpo: {} });
    },
    reativarGrupo: function (id) {
      return http().requisitar('POST', caminhoGrupo(id) + '/reativar', { corpo: {} });
    },
    // GHE × tipo de material (API do Incremento 3). O servidor decide quais tipos vêm; a tela não refaz essa seleção.
    consultarTipos: function (id) {
      return http().requisitar('GET', caminhoGrupo(id) + '/tipos-material');
    },
    definirTipo: function (id, tipoId, classificacao) {
      return http().requisitar('PUT', caminhoGrupo(id) + '/tipos-material/' + encodeURIComponent(tipoId), { corpo: { classificacao: classificacao } });
    },
    desvincularTipo: function (id, tipoId) {
      return http().requisitar('DELETE', caminhoGrupo(id) + '/tipos-material/' + encodeURIComponent(tipoId));
    },
    consultarMatriz: function (id) {
      return http().requisitar('GET', caminhoGrupo(id) + '/materiais');
    },
    vincular: function (id, materialId) {
      return http().requisitar('POST', caminhoGrupo(id) + '/materiais', { corpo: { materialId: materialId } });
    },
    desvincular: function (id, materialId) {
      return http().requisitar('DELETE', caminhoGrupo(id) + '/materiais/' + encodeURIComponent(materialId));
    },
    /**
     * Aplica as alterações item a item (inclusões, depois remoções) e
     * informa cada falha. 401 interrompe: a sessão acabou.
     * @returns {Promise<{ok: boolean, falhas: Array, semSessao?: true}>}
     */
    salvarMatriz: async function (id, alteracoes) {
      var a = alteracoes || {};
      var operacoes = (a.incluir || []).map(function (m) { return { materialId: m, operacao: 'incluir' }; })
        .concat((a.remover || []).map(function (m) { return { materialId: m, operacao: 'remover' }; }));
      var falhas = [];
      for (var i = 0; i < operacoes.length; i += 1) {
        var op = operacoes[i];
        var r = op.operacao === 'incluir' ? await acoes.vincular(id, op.materialId) : await acoes.desvincular(id, op.materialId);
        if (!r.ok) {
          falhas.push({ materialId: op.materialId, operacao: op.operacao, resposta: r });
          if (r.status === 401) return { ok: false, falhas: falhas, semSessao: true };
        }
      }
      return { ok: falhas.length === 0, falhas: falhas };
    },
  };

  // ─── Matriz ────────────────────────────────────────────────────────
  var numerico = function (x, y) { return x - y; };
  var matriz = {
    vinculados: function (materiais) {
      return (materiais || []).filter(function (m) { return m.vinculado === true; }).map(function (m) { return m.id; });
    },
    alteracoes: function (persistidos, marcados) {
      var p = persistidos || [];
      var m = marcados || [];
      return {
        incluir: m.filter(function (x) { return p.indexOf(x) === -1; }).sort(numerico),
        remover: p.filter(function (x) { return m.indexOf(x) === -1; }).sort(numerico),
      };
    },
    temAlteracoes: function (a) { return !!a && (a.incluir.length > 0 || a.remover.length > 0); },
    resumo: function (a) {
      if (!matriz.temAlteracoes(a)) return 'Nenhuma alteração pendente.';
      var partes = [];
      if (a.incluir.length) partes.push(a.incluir.length + (a.incluir.length === 1 ? ' inclusão' : ' inclusões'));
      if (a.remover.length) partes.push(a.remover.length + (a.remover.length === 1 ? ' remoção' : ' remoções'));
      return 'Alterações pendentes: ' + partes.join(' e ') + '. Clique em Salvar vínculos.';
    },
  };

  // ─── Render ────────────────────────────────────────────────────────
  function escaparHtml(s) {
    return texto(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function celula(v) { return '<td>' + (texto(v) ? escaparHtml(v) : '—') + '</td>'; }
  function situacao(ativo) {
    return ativo ? '<span class="badge status-active">Ativo</span>' : '<span class="badge status-inactive">Inativo</span>';
  }
  function botao(acao, id, rotulo, icone) {
    return '<button class="outlined-btn" type="button" data-acao="' + acao + '" data-id="' + escaparHtml(id) + '">'
      + '<span class="material-symbols-outlined">' + icone + '</span>' + rotulo + '</button>';
  }

  var CLASSIFICACOES = [['OBRIGATORIO', 'Obrigatório'], ['NAO_OBRIGATORIO', 'Não obrigatório']];
  function rotuloClassificacao(valor) {
    for (var i = 0; i < CLASSIFICACOES.length; i += 1) if (CLASSIFICACOES[i][0] === valor) return CLASSIFICACOES[i][1];
    return '—';
  }
  function seletorDeClassificacao(tipo) {
    // Tipo ainda não vinculado: nada vem escolhido ("Selecione…"); a escolha é sempre da pessoa.
    var opcoes = (tipo.vinculado ? '' : '<option value="" selected>Selecione…</option>')
      + CLASSIFICACOES.map(function (c) {
        return '<option value="' + c[0] + '"' + (tipo.vinculado && tipo.classificacao === c[0] ? ' selected' : '') + '>' + c[1] + '</option>';
      }).join('');
    return '<select class="input" data-tipo-id="' + escaparHtml(tipo.id) + '" aria-label="Classificação de ' + escaparHtml(tipo.nome) + ' no GHE">' + opcoes + '</select>';
  }

  var render = {
    escaparHtml: escaparHtml,
    rotuloClassificacao: rotuloClassificacao,
    identificacaoDoGhe: function (grupo) {
      var g = grupo || {};
      return g.codigo ? texto(g.codigo) + ' · ' + texto(g.nome) : texto(g.nome);
    },
    /**
     * Linhas do bloco principal (GHE × tipo): EPI / Tipo | Grupo | Grupo de Proteção | Situação | Classificação | Ação.
     * `podeEditar` e `gheAtivo` só decidem o que se OFERECE; o backend segue a autoridade. Sem editar: texto, sem controles.
     * GHE inativo: nenhum tipo novo pode ser vinculado, mas o vínculo existente continua corrigível e removível.
     */
    linhasTipos: function (tipos, opcoes) {
      var o = opcoes || {};
      return (tipos || []).map(function (t) {
        var podeVincular = o.podeEditar === true && o.gheAtivo !== false && t.ativo === true && !t.vinculado;
        var editavel = o.podeEditar === true && (t.vinculado || podeVincular);
        var classificacao = editavel ? seletorDeClassificacao(t) : escaparHtml(t.vinculado ? rotuloClassificacao(t.classificacao) : '—');
        var acoesHtml = '';
        if (o.podeEditar === true && t.vinculado) {
          acoesHtml = botao('alterar-tipo', t.id, 'Alterar', 'check') + botao('desvincular-tipo', t.id, 'Desvincular', 'link_off');
        } else if (podeVincular) {
          acoesHtml = botao('vincular-tipo', t.id, 'Vincular', 'add');
        }
        return '<tr data-tipo-id="' + escaparHtml(t.id) + '"><td>' + escaparHtml(t.nome) + '</td>' + celula(t.grupo) + celula(t.grupoProtecao)
          + '<td>' + situacao(t.ativo) + '</td><td>' + classificacao + '</td><td><div class="inline-actions">' + acoesHtml + '</div></td></tr>';
      }).join('');
    },
    linhasGrupos: function (grupos, opcoes) {
      var o = opcoes || {};
      return (grupos || []).map(function (g) {
        var acoesHtml = botao('selecionar', g.id, 'EPIs', 'checklist');
        if (o.podeEditar) {
          acoesHtml += botao('editar', g.id, 'Editar', 'edit')
            + (g.ativo ? botao('inativar', g.id, 'Inativar', 'block') : botao('reativar', g.id, 'Reativar', 'restart_alt'));
        }
        return (g.id === o.selecionado ? '<tr class="selecionado">' : '<tr>')
          + celula(g.codigo) + '<td>' + escaparHtml(g.nome) + '</td>' + '<td>' + situacao(g.ativo) + '</td>'
          + '<td><div class="inline-actions">' + acoesHtml + '</div></td></tr>';
      }).join('');
    },
    linhasMatriz: function (materiais, marcados, opcoes) {
      var o = opcoes || {};
      var m = marcados || [];
      return (materiais || []).map(function (x) {
        var nome = escaparHtml(x.nome)
          + (x.codigoInterno ? ' <small style="color:var(--on-surface-variant)">' + escaparHtml(x.codigoInterno) + '</small>' : '');
        var caixa = '<input type="checkbox" data-material-id="' + escaparHtml(x.id) + '"'
          + (o.podeEditar ? '' : ' disabled') + (m.indexOf(x.id) !== -1 ? ' checked' : '')
          + ' aria-label="Vincular ' + escaparHtml(x.nome) + ' ao GHE">';
        var prazo = typeof x.prazoUsoDias === 'number' ? x.prazoUsoDias + ' dias' : '';
        // Sem CA: o GHE associa o material; o CA real é o do lote, conhecido na entrega.
        return '<tr><td>' + caixa + '</td><td>' + nome + '</td>' + celula(x.categoria) + celula(x.tipo)
          + celula(prazo) + '<td>' + situacao(x.ativo) + '</td></tr>';
      }).join('');
    },
    estado: function (mensagem, colunas) {
      return '<tr><td colspan="' + (colunas || 7) + '" style="text-align:center;color:var(--on-surface-variant);padding:32px">' + escaparHtml(mensagem) + '</td></tr>';
    },
  };

  // ─── Mensagens ─────────────────────────────────────────────────────
  var POR_CODIGO = {
    GHE_NAO_ENCONTRADO: 'GHE não encontrado nesta empresa. Recarregue a página.',
    MATERIAL_NAO_ENCONTRADO: 'EPI não encontrado nesta empresa. Recarregue a página.',
    GHE_MATERIAL_NAO_VINCULADO: 'Este EPI já não estava vinculado ao GHE.',
    GHE_CODIGO_OBRIGATORIO: 'Informe o código do GHE (por exemplo, GHE-001).',
    GHE_CODIGO_INVALIDO: 'Código de GHE inválido. Use GHE- seguido de 3 a 6 dígitos (por exemplo, GHE-001).',
    GHE_CODIGO_EM_USO: 'Já existe um GHE com este código nesta empresa.',
    GHE_NOME_EM_USO: 'Já existe um GHE com esta descrição nesta empresa.',
    GHE_INATIVO: 'GHE inativo não aceita novos vínculos. Reative o GHE para vincular EPIs.',
    TIPO_MATERIAL_NAO_ENCONTRADO: 'Tipo de EPI não encontrado nesta empresa. Recarregue a página.',
    TIPO_MATERIAL_INATIVO: 'Tipo de EPI inativo não pode receber novo vínculo.',
    GHE_TIPO_MATERIAL_NAO_VINCULADO: 'Este tipo de EPI já não estava vinculado ao GHE.',
    CAMPO_NAO_PERMITIDO: 'Dados inválidos: a requisição contém um campo não permitido. Recarregue a página e tente novamente.',
    MATERIAL_INATIVO: 'EPI inativo não pode ser vinculado.',
    GHE_MATERIAL_JA_VINCULADO: 'Este EPI já está vinculado ao GHE.',
  };
  var mensagens = {
    NOME_OBRIGATORIO: 'Informe a descrição do GHE.',
    CODIGO_OBRIGATORIO: POR_CODIGO.GHE_CODIGO_OBRIGATORIO,
    EM_INTEGRACAO_IMPORTACAO: 'Importação de GHE / EPIs em integração.',
    SALVO_GRUPO: 'GHE salvo.',
    SALVO_MATRIZ: 'Vínculos salvos.',
    SALVO_TIPO: 'Vínculo de EPI salvo.',
    REMOVIDO_TIPO: 'Tipo de EPI desvinculado do GHE.',
    ESCOLHA_CLASSIFICACAO: 'Escolha a classificação (Obrigatório ou Não obrigatório) antes de vincular.',
    SEM_ALTERACAO_TIPO: 'Nenhuma alteração na classificação.',
    vazioTipos: 'Nenhum tipo de EPI disponível para este GHE.',
    vazioGrupos: 'Nenhum GHE cadastrado nesta empresa.',
    vazioMateriais: 'Nenhum EPI ativo cadastrado nesta empresa.',
    erro: function (r) {
      if (!r || !r.status) return 'Falha de rede: não foi possível falar com o servidor. Verifique a conexão e tente novamente.';
      if (r.status === 401) return 'Sua sessão terminou. Entre novamente pelo Portal do Cliente.';
      if (r.status === 403) return 'Seu perfil não tem permissão para esta operação nesta empresa.';
      if ((r.status === 400 || r.status === 404 || r.status === 409) && Object.prototype.hasOwnProperty.call(POR_CODIGO, r.codigo)) return POR_CODIGO[r.codigo];
      if (r.status === 400) return 'Dados inválidos: revise os campos e tente novamente.';
      if (r.status === 404) return 'Registro não encontrado nesta empresa. Recarregue a página.';
      if (r.status === 409) return 'A operação conflita com o estado atual. Recarregue a página.';
      return 'Não foi possível concluir a operação. Tente novamente.';
    },
    exigeNovoLogin: function (r) { return !!r && r.status === 401; },
  };

  global.EpiGruposHomogeneos = { acoes: acoes, matriz: matriz, render: render, mensagens: mensagens };

  if (typeof module !== 'undefined' && module.exports) module.exports = global.EpiGruposHomogeneos;
})(typeof window !== 'undefined' ? window : globalThis);
