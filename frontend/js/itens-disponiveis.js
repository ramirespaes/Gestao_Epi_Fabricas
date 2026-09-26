(function (global) {
  'use strict';

  /**
   * EpiItensDisponiveis — Itens Disponíveis (Bloco 9, Etapa C, Parte C3).
   * Somente leitura, sobre GET /api/estoque/itens-disponiveis
   * (permissão de recurso `availableItems`, visualizar).
   *
   *   acoes     — consultas à API (envelope do EpiHttp).
   *   render    — HTML escapado: linhas da tabela (7 colunas originais),
   *               opções dos filtros, paginação e estados.
   *   mensagens — textos de vazio e de falha.
   *   csv       — exportação com as mesmas 7 colunas da tabela.
   *
   * Regras: materiais ativos da empresa da sessão, todos os tamanhos
   * cadastrados (saldo 0 = "Sem estoque"); o status usa a MESMA regra da
   * grade da C2 (EpiMateriais.grade.situacao) sobre `disponivel`, que nesta
   * etapa é igual ao saldo (não há reserva). A validade filtrada é só a do
   * CA e é informativa: não bloqueia o estoque.
   */

  var CAMINHO = '/estoque/itens-disponiveis';
  var LIMITE_PAGINA = 50;
  var LIMITE_POR_PAGINA_EXPORTACAO = 100; // máximo aceito pela API
  var PAGINAS_MAXIMAS_EXPORTACAO = 100;
  // Teto de itens exportáveis (100 páginas × 100). Acima disso a exportação é
  // recusada antes de buscar as demais páginas: nunca se gera CSV parcial.
  var LIMITE_EXPORTACAO = LIMITE_POR_PAGINA_EXPORTACAO * PAGINAS_MAXIMAS_EXPORTACAO;
  var ORDEM_FILTROS = ['categoria', 'tipo', 'tamanho', 'validade'];
  var ROTULOS_SITUACAO = {
    'com-saldo': { texto: 'Disponível', classe: 'status-active' },
    'abaixo-minimo': { texto: 'Baixo', classe: 'role-supervisor' },
    'sem-estoque': { texto: 'Sem estoque', classe: 'status-inactive' },
  };
  var CABECALHO_CSV = ['Categoria', 'Tipo', 'Material', 'Tamanho', 'Quantidade disponível', 'Unidade', 'Status'];

  function http() {
    if (!global.EpiHttp) throw new Error('EpiHttp não carregado: inclua js/api-http.js antes de js/itens-disponiveis.js');
    return global.EpiHttp;
  }
  function regraSituacao() {
    if (!global.EpiMateriais || !global.EpiMateriais.grade) throw new Error('EpiMateriais não carregado: inclua js/materiais.js antes de js/itens-disponiveis.js');
    return global.EpiMateriais.grade.situacao;
  }
  function texto(v) { return v === null || v === undefined ? '' : String(v); }

  // ─── Ações ─────────────────────────────────────────────────────────
  function montarQuery(filtro) {
    var f = filtro || {};
    var partes = [];
    ORDEM_FILTROS.forEach(function (k) {
      var v = texto(f[k]).trim();
      if (v) partes.push(k + '=' + encodeURIComponent(v));
    });
    partes.push('pagina=' + (f.pagina || 1));
    partes.push('limite=' + (f.limite || LIMITE_PAGINA));
    return '?' + partes.join('&');
  }

  var acoes = {
    listar: function (filtro) {
      return http().requisitar('GET', CAMINHO + montarQuery(filtro));
    },
    /**
     * Todas as páginas do filtro (exportação), sempre COMPLETAS ou nada:
     *   - falha HTTP/rede em qualquer página → devolve a falha;
     *   - total acima de LIMITE_EXPORTACAO → { ok:false, motivo:'LIMITE_EXPORTACAO' } já na 1ª página;
     *   - total que muda entre páginas ou página vazia antes do total →
     *     { ok:false, motivo:'EXPORTACAO_INCOMPLETA' }.
     */
    listarTodos: async function (filtro) {
      var itens = [];
      var total = null;
      var recusa = function (motivo, extra) {
        return Object.assign({ ok: false, status: 200, motivo: motivo, codigo: null, mensagem: null, detalhes: null }, extra || {});
      };
      for (var pagina = 1; pagina <= PAGINAS_MAXIMAS_EXPORTACAO; pagina += 1) {
        var f = Object.assign({}, filtro || {}, { pagina: pagina, limite: LIMITE_POR_PAGINA_EXPORTACAO });
        var r = await acoes.listar(f);
        if (!r.ok) return r;
        var lote = r.dados && Array.isArray(r.dados.itens) ? r.dados.itens : [];
        var totalPagina = r.dados && typeof r.dados.total === 'number' ? r.dados.total : null;
        if (totalPagina === null) return recusa('EXPORTACAO_INCOMPLETA');
        if (pagina === 1) {
          total = totalPagina;
          if (total > LIMITE_EXPORTACAO) return recusa('LIMITE_EXPORTACAO', { total: total, limite: LIMITE_EXPORTACAO });
        } else if (totalPagina !== total) {
          return recusa('EXPORTACAO_INCOMPLETA');
        }
        itens = itens.concat(lote);
        if (itens.length >= total) break;
        if (lote.length === 0) return recusa('EXPORTACAO_INCOMPLETA');
      }
      if (itens.length !== total) return recusa('EXPORTACAO_INCOMPLETA');
      return { ok: true, status: 200, dados: { itens: itens, total: total, completo: true }, codigo: null, mensagem: null, detalhes: null };
    },
    LIMITE_EXPORTACAO: LIMITE_EXPORTACAO,
  };

  // ─── Render ────────────────────────────────────────────────────────
  function escaparHtml(s) {
    return texto(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function unidadeExibida(u) {
    var t = texto(u);
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : '—';
  }
  function situacaoDe(item) {
    var chave = regraSituacao()(item.disponivel, item.estoqueMinimo);
    return ROTULOS_SITUACAO[chave] || ROTULOS_SITUACAO['sem-estoque'];
  }
  function celula(v) { return '<td>' + (texto(v) ? escaparHtml(v) : '—') + '</td>'; }

  var render = {
    escaparHtml: escaparHtml,
    linhas: function (itens) {
      return (itens || []).map(function (i) {
        var s = situacaoDe(i);
        var material = escaparHtml(i.material)
          + (i.codigoInterno ? ' <small style="color:var(--on-surface-variant)">' + escaparHtml(i.codigoInterno) + '</small>' : '');
        return '<tr>' + celula(i.categoria) + celula(i.tipo) + '<td>' + material + '</td>'
          + celula(i.tamanho) + '<td>' + escaparHtml(i.disponivel) + '</td>' + '<td>' + escaparHtml(unidadeExibida(i.unidade)) + '</td>'
          + '<td><span class="badge ' + s.classe + '">' + s.texto + '</span></td></tr>';
      }).join('');
    },
    opcoes: function (lista, rotuloTodos, selecionado) {
      return '<option value="">' + escaparHtml(rotuloTodos) + '</option>' + (lista || []).map(function (v) {
        return '<option value="' + escaparHtml(v) + '"' + (v === selecionado ? ' selected' : '') + '>' + escaparHtml(v) + '</option>';
      }).join('');
    },
    paginacao: function (total, pagina, limite, quantidade) {
      if (!total) return { texto: 'Nenhum item', anterior: false, proxima: false };
      var paginas = Math.ceil(total / limite);
      var inicio = (pagina - 1) * limite + 1;
      var fim = typeof quantidade === 'number' ? inicio + quantidade - 1 : Math.min(pagina * limite, total);
      return { texto: 'Itens ' + inicio + '–' + fim + ' de ' + total + ' · página ' + pagina + ' de ' + paginas, anterior: pagina > 1, proxima: pagina < paginas };
    },
    estado: function (mensagem) {
      return '<tr><td colspan="7" style="text-align:center;color:var(--on-surface-variant);padding:32px">' + escaparHtml(mensagem) + '</td></tr>';
    },
  };

  // ─── Mensagens ─────────────────────────────────────────────────────
  var mensagens = {
    vazio: function (comFiltros) {
      return comFiltros
        ? 'Nenhum item encontrado para os filtros escolhidos. Use Limpar para ver todos os itens.'
        : 'Nenhum material ativo com tamanho cadastrado nesta empresa.';
    },
    erroConsulta: function (r) {
      if (!r || !r.status) return 'Falha de rede: não foi possível consultar os itens disponíveis. Verifique a conexão e tente novamente.';
      if (r.status === 401) return 'Sua sessão terminou. Entre novamente pelo Portal do Cliente.';
      if (r.status === 403) return 'Seu perfil não pode consultar os itens disponíveis nesta empresa.';
      if (r.status === 400) return 'Filtros recusados pelo servidor. Use Limpar e tente novamente.';
      return 'Não foi possível consultar os itens disponíveis. Tente novamente.';
    },
    exigeNovoLogin: function (r) { return !!r && r.status === 401; },
    erroExportacao: function (r) {
      if (r && r.motivo === 'LIMITE_EXPORTACAO') {
        return 'A exportação teria ' + milhar(r.total) + ' itens, acima do limite de ' + milhar(r.limite)
          + '. Nenhum arquivo foi gerado. Restrinja os filtros (categoria, tipo, tamanho ou validade do CA) e exporte novamente.';
      }
      if (r && r.motivo === 'EXPORTACAO_INCOMPLETA') {
        return 'Os itens mudaram durante a exportação e o arquivo ficaria incompleto. Nenhum arquivo foi gerado. Tente exportar novamente.';
      }
      return mensagens.erroConsulta(r);
    },
  };
  function milhar(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.'); }

  // ─── CSV ───────────────────────────────────────────────────────────
  // Separador ";" (Excel pt-BR). Valores que começam com = + - @ (fórmulas)
  // recebem apóstrofo para não serem executados pela planilha.
  function campoCsv(v) {
    var t = texto(v);
    if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
    return '"' + t.replace(/"/g, '""') + '"';
  }
  var csv = {
    NOME_ARQUIVO: 'itens_disponiveis.csv',
    gerar: function (itens) {
      var linhas = [CABECALHO_CSV.map(campoCsv).join(';')];
      (itens || []).forEach(function (i) {
        var material = texto(i.material) + (i.codigoInterno ? ' (' + i.codigoInterno + ')' : '');
        linhas.push([i.categoria || '—', i.tipo || '—', material, i.tamanho, i.disponivel, unidadeExibida(i.unidade), situacaoDe(i).texto].map(campoCsv).join(';'));
      });
      return '﻿' + linhas.join('\r\n');
    },
  };

  global.EpiItensDisponiveis = { acoes: acoes, render: render, mensagens: mensagens, csv: csv, LIMITE_PAGINA: LIMITE_PAGINA };

  if (typeof module !== 'undefined' && module.exports) module.exports = global.EpiItensDisponiveis;
})(typeof window !== 'undefined' ? window : globalThis);
