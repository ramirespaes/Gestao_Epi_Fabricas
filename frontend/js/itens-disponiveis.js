(function (global) {
  'use strict';

  /**
   * EpiItensDisponiveis — Itens Disponíveis (Bloco 9, Etapa C, Parte C3; posição
   * de estoque na 12D-3). Somente leitura, sobre GET /api/estoque/itens-disponiveis
   * (permissão de recurso `availableItems`, visualizar).
   *
   *   acoes     — consultas à API (envelope do EpiHttp).
   *   render    — HTML escapado: linhas da tabela (13 colunas), opções dos
   *               filtros, paginação e estados.
   *   mensagens — textos de vazio e de falha.
   *   csv       — exportação com as mesmas colunas da tabela, mais a origem do mínimo.
   *
   * Cada item é um par (material, tamanho) da posição de estoque calculada pelo
   * SERVIDOR: físico utilizável, comprometido (com solicitações já aprovadas),
   * saldo livre, demanda sem cobertura, mínimo efetivo (próprio ou padrão),
   * déficit e necessidade. O frontend só mostra: não recalcula livre, mínimo,
   * déficit nem necessidade, e a situação é a que o servidor mediu pelo saldo
   * livre (`abaixoDoMinimo`). `disponivel` é o apelido antigo do físico
   * utilizável e só entra se `fisicoUtilizavel` faltar. A validade filtrada é só
   * a do CA e é informativa: não bloqueia o estoque.
   */

  var CAMINHO = '/estoque/itens-disponiveis';
  var LIMITE_PAGINA = 50;
  var LIMITE_POR_PAGINA_EXPORTACAO = 100; // máximo aceito pela API
  var PAGINAS_MAXIMAS_EXPORTACAO = 100;
  // Teto de itens exportáveis (100 páginas × 100). Acima disso a exportação é
  // recusada antes de buscar as demais páginas: nunca se gera CSV parcial.
  var LIMITE_EXPORTACAO = LIMITE_POR_PAGINA_EXPORTACAO * PAGINAS_MAXIMAS_EXPORTACAO;
  var ORDEM_FILTROS = ['categoria', 'tipo', 'tamanho', 'validade', 'busca'];
  // As quatro situações que o servidor aceita; '' é "Todas". O servidor confere de novo.
  var SITUACOES = Object.freeze([
    ['', 'Todas'],
    ['SEM_ESTOQUE', 'Sem estoque'],
    ['ABAIXO_MINIMO', 'Abaixo do mínimo'],
    ['COM_COMPROMETIDO', 'Com saldo comprometido'],
    ['SEM_COBERTURA', 'Sem cobertura'],
  ]);
  var ORIGENS_MINIMO = { PROPRIO: 'Próprio', PADRAO: 'Padrão' };
  var SITUACAO = {
    semCobertura: { texto: 'Sem cobertura', classe: 'status-inactive' },
    semEstoque: { texto: 'Sem estoque', classe: 'status-inactive' },
    comprometido: { texto: 'Com saldo comprometido', classe: 'badge-warning' },
    abaixoMinimo: { texto: 'Abaixo do mínimo', classe: 'role-supervisor' },
    disponivel: { texto: 'Disponível', classe: 'status-active' },
  };
  var CABECALHO_CSV = ['Categoria', 'Tipo', 'Material', 'Tamanho', 'Físico utilizável', 'Comprometido', 'Saldo livre', 'Sem cobertura', 'Mínimo', 'Origem do mínimo', 'Déficit', 'Necessidade', 'Unidade', 'Status'];

  function http() {
    if (!global.EpiHttp) throw new Error('EpiHttp não carregado: inclua js/api-http.js antes de js/itens-disponiveis.js');
    return global.EpiHttp;
  }
  function texto(v) { return v === null || v === undefined ? '' : String(v); }
  function situacaoValida(v) { return SITUACOES.some(function (s) { return s[0] !== '' && s[0] === v; }); }

  // ─── Ações ─────────────────────────────────────────────────────────
  function montarQuery(filtro) {
    var f = filtro || {};
    var partes = [];
    ORDEM_FILTROS.forEach(function (k) {
      var v = texto(f[k]).trim();
      if (v) partes.push(k + '=' + encodeURIComponent(v));
    });
    if (situacaoValida(f.situacao)) partes.push('situacao=' + f.situacao);
    if (f.somenteComNecessidade === true) partes.push('somenteComNecessidade=true');
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
  // 12G-7: pictograma do material (js/catalogo-visual.js); em Node os testes o carregam pelo require.
  function catalogo() {
    if (global.EpiCatalogoVisual) return global.EpiCatalogoVisual;
    if (typeof module !== 'undefined' && module.exports) return require('./catalogo-visual'); // eslint-disable-line global-require
    throw new Error('EpiCatalogoVisual não carregado: inclua js/catalogo-visual.js antes de js/itens-disponiveis.js');
  }
  function unidadeExibida(u) {
    var t = texto(u);
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : '—';
  }
  function numero(v) { return typeof v === 'number' ? v : Number(v); }
  function fisicoDe(item) {
    return item.fisicoUtilizavel === undefined || item.fisicoUtilizavel === null ? item.disponivel : item.fisicoUtilizavel;
  }
  function origemDoMinimo(item) {
    return ORIGENS_MINIMO[item.minimoOrigem] || '';
  }

  /**
   * As situações do par, em ordem de exibição, a partir do que o servidor mandou.
   * Primeiro a disponibilidade (sem cobertura, sem estoque ou saldo comprometido);
   * "abaixo do mínimo" é a medida do servidor sobre o saldo livre e acompanha a
   * primeira, ou vale sozinha quando o par não tem outro problema.
   */
  function situacoesDe(item) {
    var primeira = null;
    if (numero(item.semCobertura) > 0) primeira = SITUACAO.semCobertura;
    else if (numero(fisicoDe(item)) === 0) primeira = SITUACAO.semEstoque;
    else if (numero(item.comprometido) > 0) primeira = SITUACAO.comprometido;
    var abaixo = item.abaixoDoMinimo === true ? SITUACAO.abaixoMinimo : null;
    if (primeira && abaixo) return [primeira, abaixo];
    if (primeira) return [primeira];
    if (abaixo) return [abaixo];
    return [SITUACAO.disponivel];
  }

  function celula(v, classe) {
    return '<td' + (classe ? ' class="' + classe + '"' : '') + '>' + (texto(v) ? escaparHtml(v) : '—') + '</td>';
  }
  function celulaNumero(v, classe) {
    return '<td' + (classe ? ' class="' + classe + '"' : '') + '>' + escaparHtml(v) + '</td>';
  }

  var render = {
    escaparHtml: escaparHtml,
    linhas: function (itens) {
      return (itens || []).map(function (i) {
        var material = catalogo().marcacao(i) + escaparHtml(i.material)
          + (i.codigoInterno ? ' <small style="color:var(--on-surface-variant)">' + escaparHtml(i.codigoInterno) + '</small>' : '');
        var origem = origemDoMinimo(i);
        var minimo = escaparHtml(i.estoqueMinimo) + (origem ? ' <small style="color:var(--on-surface-variant)">' + escaparHtml(origem) + '</small>' : '');
        var status = situacoesDe(i).map(function (s) { return '<span class="badge ' + s.classe + '">' + s.texto + '</span>'; }).join(' ');
        return '<tr>' + celula(i.categoria, 'col-sec') + celula(i.tipo, 'col-sec') + '<td>' + material + '</td>'
          + celula(i.tamanho)
          + celulaNumero(fisicoDe(i)) + celulaNumero(i.comprometido) + celulaNumero(i.saldoLivre) + celulaNumero(i.semCobertura)
          + '<td>' + minimo + '</td>' + celulaNumero(i.deficit, 'col-sec') + celulaNumero(i.necessidade)
          + '<td class="col-sec">' + escaparHtml(unidadeExibida(i.unidade)) + '</td>'
          + '<td>' + status + '</td></tr>';
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
      return '<tr><td colspan="13" style="text-align:center;color:var(--on-surface-variant);padding:32px">' + escaparHtml(mensagem) + '</td></tr>';
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
          + '. Nenhum arquivo foi gerado. Restrinja os filtros (categoria, tipo, tamanho, situação ou validade do CA) e exporte novamente.';
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
        var situacao = situacoesDe(i).map(function (s) { return s.texto; }).join(' · ');
        linhas.push([
          i.categoria || '—', i.tipo || '—', material, i.tamanho, fisicoDe(i), i.comprometido, i.saldoLivre, i.semCobertura,
          i.estoqueMinimo, origemDoMinimo(i), i.deficit, i.necessidade, unidadeExibida(i.unidade), situacao,
        ].map(campoCsv).join(';'));
      });
      return '﻿' + linhas.join('\r\n');
    },
  };

  global.EpiItensDisponiveis = { acoes: acoes, render: render, mensagens: mensagens, csv: csv, LIMITE_PAGINA: LIMITE_PAGINA, SITUACOES: SITUACOES };

  if (typeof module !== 'undefined' && module.exports) module.exports = global.EpiItensDisponiveis;
})(typeof window !== 'undefined' ? window : globalThis);
