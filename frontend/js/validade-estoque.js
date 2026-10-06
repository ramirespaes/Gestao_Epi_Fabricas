(function (global) {
  'use strict';

  /**
   * EpiValidadeEstoque — Validade de estoque (Bloco 9, E7): lotes com saldo,
   * a situação do CA de cada um e os indicadores, pelo GET /estoque/validade.
   *
   *   acoes     — fala com a API e devolve o envelope do EpiHttp.
   *   texto     — tamanho, CA e datas em texto de tela (funções puras).
   *   render    — HTML escapado da tabela.
   *   mensagens — falha de consulta em texto próprio, sem repetir o servidor.
   *
   * A situação e o bloqueio chegam prontos do servidor, calculados na data de
   * São Paulo: aqui nada é recalculado. Lote de material inativo com saldo
   * continua na lista, marcado como tal. A baixa usa o módulo de materiais
   * (EpiMateriais), o mesmo da Gestão de estoque.
   */

  var CAMINHO = '/estoque/validade';
  var LIMITE = 50;
  var TAMANHO_UNICO = 'Único';
  var TRACO = '—';

  var SITUACOES = Object.freeze({
    VENCIDO: Object.freeze({ rotulo: 'Vencido', classe: 'badge-danger' }),
    VENCE_HOJE: Object.freeze({ rotulo: 'Vence hoje', classe: 'badge-warning' }),
    A_VENCER: Object.freeze({ rotulo: 'A vencer', classe: 'badge-warning' }),
    VALIDO: Object.freeze({ rotulo: 'Válido', classe: 'badge-ok' }),
    SEM_CA: Object.freeze({ rotulo: 'Sem CA', classe: 'badge-danger' }),
    NAO_EXIGE_CA: Object.freeze({ rotulo: 'Não exige CA', classe: 'badge-ok' }),
  });

  // Opções do filtro, na ordem da tela; '' é "Todos". O servidor confere de novo.
  var FILTROS = Object.freeze([
    ['', 'Todos'], ['VENCIDO', 'Vencidos'], ['VENCE_HOJE', 'Vence hoje'], ['A_VENCER', 'A vencer'],
    ['VENCIMENTO_PROXIMO', 'Vence hoje ou a vencer'], ['VALIDO', 'Válidos'], ['SEM_CA', 'Sem CA'], ['NAO_EXIGE_CA', 'Não exige CA'],
  ]);

  function http() {
    var cliente = global.EpiHttp;
    if (!cliente) {
      throw new Error('EpiHttp não carregado: inclua js/api-http.js antes de js/validade-estoque.js');
    }
    return cliente;
  }

  function hasOwn(obj, chave) { return Object.prototype.hasOwnProperty.call(obj, chave); }
  function texto(v) { return String(v === undefined || v === null ? '' : v).trim(); }
  function inteiroPositivo(v) { return typeof v === 'number' && Math.floor(v) === v && v > 0; }

  function filtroPermitido(valor) {
    if (typeof valor !== 'string' || valor === '') return false;
    for (var i = 1; i < FILTROS.length; i += 1) if (FILTROS[i][0] === valor) return true;
    return false;
  }

  /** Filtro vindo da URL (?situacao=...): só um valor da lista; qualquer outra coisa é "todos". */
  function filtroDaUrl(busca) {
    var valor;
    try {
      valor = new URLSearchParams(String(busca || '')).get('situacao');
    } catch (e) {
      return '';
    }
    return filtroPermitido(valor) ? valor : '';
  }

  // ─── Ações ─────────────────────────────────────────────────────────
  var acoes = {
    listar: function (filtro) {
      var f = filtro || {};
      var q = [];
      if (filtroPermitido(f.situacao)) q.push('situacao=' + f.situacao);
      var busca = texto(f.busca);
      if (busca) q.push('busca=' + encodeURIComponent(busca));
      q.push('pagina=' + (inteiroPositivo(f.pagina) ? f.pagina : 1));
      q.push('limite=' + (inteiroPositivo(f.limite) ? f.limite : LIMITE));
      return http().requisitar('GET', CAMINHO + '?' + q.join('&'));
    },
  };

  // ─── Texto ─────────────────────────────────────────────────────────
  /** AAAA-MM-DD → DD/MM/AAAA, sem converter fuso; '' quando não é data. */
  function data(valor) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(texto(valor));
    return m ? m[3] + '/' + m[2] + '/' + m[1] : '';
  }

  var textoDe = {
    data: data,
    tamanho: function (t) { return t === null || t === undefined || t === '' ? TAMANHO_UNICO : String(t); },
    ca: function (l) {
      if (l.situacaoCa === 'NAO_EXIGE_CA') return 'Não exige CA';
      return texto(l.caNumero) || 'Sem CA';
    },
    validade: function (l) {
      if (l.situacaoCa === 'NAO_EXIGE_CA') return TRACO;
      return data(l.caValidade) || TRACO;
    },
  };

  // ─── Render ────────────────────────────────────────────────────────
  function escaparHtml(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // 12G-7: pictograma do material (js/catalogo-visual.js); em Node os testes o carregam pelo require.
  function catalogo() {
    if (global.EpiCatalogoVisual) return global.EpiCatalogoVisual;
    if (typeof module !== 'undefined' && module.exports) return require('./catalogo-visual'); // eslint-disable-line global-require
    throw new Error('EpiCatalogoVisual não carregado: inclua js/catalogo-visual.js antes de js/validade-estoque.js');
  }

  function situacaoDe(codigo) {
    return hasOwn(SITUACOES, codigo) ? SITUACOES[codigo] : { rotulo: texto(codigo), classe: 'badge-warning' };
  }

  function linha(l, podeBaixar) {
    var s = situacaoDe(l.situacaoCa);
    var fisico = Number(l.fisico) || 0;
    var bloqueado = Number(l.bloqueado) || 0;
    var detalhe = function (v) { return texto(v) ? ' <small class="detalhe">' + escaparHtml(v) + '</small>' : ''; };
    return '<tr>'
      + '<td>' + catalogo().marcacao(l) + escaparHtml(l.material)
        + (l.materialAtivo === false ? ' <span class="tag-inativo">Material inativo</span>' : '') + detalhe(l.codigoInterno) + '</td>'
      + '<td>' + escaparHtml(texto(l.tipo) || TRACO) + detalhe(l.categoria) + '</td>'
      + '<td>' + escaparHtml(textoDe.tamanho(l.tamanho)) + '</td>'
      + '<td>' + escaparHtml(textoDe.ca(l)) + '</td>'
      + '<td>' + escaparHtml(textoDe.validade(l)) + '</td>'
      + '<td class="numero">' + escaparHtml(fisico) + '</td>'
      + '<td><span class="badge ' + s.classe + '">' + escaparHtml(s.rotulo) + '</span></td>'
      + '<td>' + (bloqueado > 0 ? '<span class="disp disp-bloqueado">Bloqueado</span>' : '<span class="disp disp-livre">Disponível</span>') + '</td>'
      + '<td>' + (podeBaixar && fisico > 0
        ? '<button type="button" class="outlined-btn botao-baixa" data-baixa-lote="' + escaparHtml(l.loteId) + '">Dar baixa</button>'
        : '') + '</td>'
      + '</tr>';
  }

  var render = {
    escaparHtml: escaparHtml,
    linhas: function (lotes, opcoes) {
      var podeBaixar = !!(opcoes && opcoes.podeBaixar);
      return (lotes || []).map(function (l) { return linha(l, podeBaixar); }).join('');
    },
    vazio: function (mensagem) {
      return '<tr><td colspan="9" class="estado">' + escaparHtml(mensagem) + '</td></tr>';
    },
    /** Linhas, ou a mensagem de lista vazia. */
    tabela: function (lotes, opcoes) {
      var o = opcoes || {};
      return lotes && lotes.length ? render.linhas(lotes, o) : render.vazio(o.mensagemVazia || 'Nenhum lote com saldo.');
    },
    paginacao: function (total, pagina, limite, quantidade) {
      if (!total) return { texto: 'Nenhum lote', anterior: false, proxima: false };
      var paginas = Math.ceil(total / limite);
      var inicio = (pagina - 1) * limite + 1;
      var fim = inicio + quantidade - 1;
      return { texto: 'Lotes ' + inicio + '–' + fim + ' de ' + total + ' · página ' + pagina + ' de ' + paginas, anterior: pagina > 1, proxima: pagina < paginas };
    },
  };

  // ─── Mensagens ─────────────────────────────────────────────────────
  var mensagens = {
    erroListagem: function (r) {
      if (!r || typeof r.status !== 'number' || r.status === 0) return 'Falha de rede ao consultar a validade do estoque. Verifique a conexão e tente novamente.';
      if (r.status === 401) return 'Sua sessão terminou. Entre novamente pelo Portal do Cliente.';
      if (r.status === 403) return 'Seu perfil não pode consultar o estoque nesta empresa.';
      if (r.status === 400) return 'Filtro não aceito pelo servidor. Escolha uma das opções da lista.';
      return 'Não foi possível consultar a validade do estoque. Tente novamente.';
    },
  };

  global.EpiValidadeEstoque = {
    CAMINHO: CAMINHO,
    LIMITE: LIMITE,
    SITUACOES: SITUACOES,
    FILTROS: FILTROS,
    filtroDaUrl: filtroDaUrl,
    filtroPermitido: filtroPermitido,
    acoes: acoes,
    texto: textoDe,
    render: render,
    mensagens: mensagens,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.EpiValidadeEstoque;
  }
})(typeof window !== 'undefined' ? window : globalThis);
