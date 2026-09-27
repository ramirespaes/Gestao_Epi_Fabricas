(function (global) {
  'use strict';

  /**
   * EpiOperacoesEstoque — Operações de estoque (Bloco 9, E8): o histórico de
   * saldo inicial, entradas e baixas, pelo GET /estoque/operacoes.
   *
   *   acoes     — fala com a API e devolve o envelope do EpiHttp. Só lê.
   *   texto     — data e hora, sinal, motivo e campos vazios em texto de tela.
   *   render    — HTML escapado da tabela, sem nenhuma ação por linha.
   *   mensagens — falha de consulta em texto próprio, sem repetir o servidor.
   *
   * A ordem, o fuso do período e a empresa são decididos pelo servidor. O
   * sinal da quantidade é só de tela: o servidor manda a quantidade positiva.
   */

  var CAMINHO = '/estoque/operacoes';
  var LIMITE = 50;
  var TAMANHO_UNICO = 'Único';
  var TRACO = '—';
  var MENOS = '−';
  var DATA = /^\d{4}-\d{2}-\d{2}$/;

  var TIPOS = Object.freeze({
    SALDO_INICIAL: Object.freeze({ rotulo: 'Saldo inicial', classe: 'tipo-saldo', sinal: '+', nota: 'migrado do controle anterior' }),
    ENTRADA: Object.freeze({ rotulo: 'Entrada', classe: 'tipo-entrada', sinal: '+', nota: '' }),
    BAIXA: Object.freeze({ rotulo: 'Baixa', classe: 'tipo-baixa', sinal: MENOS, nota: '' }),
  });

  var MOTIVOS = Object.freeze({
    CA_VENCIDO: 'CA vencido',
    AVARIA: 'Avaria',
    DESCARTE: 'Descarte',
    PERDA: 'Perda',
    AJUSTE_INVENTARIO: 'Ajuste de inventário',
    DEVOLUCAO_FORNECEDOR: 'Devolução ao fornecedor',
    OUTRO: 'Outro',
  });

  // Opções do filtro, na ordem da tela; '' é "Todas". O servidor confere de novo.
  var FILTROS = Object.freeze([['', 'Todas'], ['SALDO_INICIAL', 'Saldo inicial'], ['ENTRADA', 'Entrada'], ['BAIXA', 'Baixa']]);

  // dd/mm/aaaa HH:mm no relógio de São Paulo, qualquer que seja o fuso do navegador.
  var FORMATO_DATA_HORA = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });

  function http() {
    var cliente = global.EpiHttp;
    if (!cliente) {
      throw new Error('EpiHttp não carregado: inclua js/api-http.js antes de js/operacoes-estoque.js');
    }
    return cliente;
  }

  function hasOwn(obj, chave) { return Object.prototype.hasOwnProperty.call(obj, chave); }
  function texto(v) { return String(v === undefined || v === null ? '' : v).trim(); }
  function inteiroPositivo(v) { return typeof v === 'number' && Math.floor(v) === v && v > 0; }
  function tipoPermitido(valor) { return typeof valor === 'string' && valor !== '' && hasOwn(TIPOS, valor); }
  function dataPermitida(valor) { return typeof valor === 'string' && DATA.test(valor); }

  // ─── Ações ─────────────────────────────────────────────────────────
  var acoes = {
    listar: function (filtro) {
      var f = filtro || {};
      var q = [];
      if (tipoPermitido(f.tipo)) q.push('tipo=' + f.tipo);
      if (dataPermitida(f.de)) q.push('de=' + f.de);
      if (dataPermitida(f.ate)) q.push('ate=' + f.ate);
      var busca = texto(f.busca);
      if (busca) q.push('busca=' + encodeURIComponent(busca));
      q.push('pagina=' + (inteiroPositivo(f.pagina) ? f.pagina : 1));
      q.push('limite=' + (inteiroPositivo(f.limite) ? f.limite : LIMITE));
      return http().requisitar('GET', CAMINHO + '?' + q.join('&'));
    },
  };

  // ─── Texto ─────────────────────────────────────────────────────────
  function dataHora(valor) {
    if (typeof valor !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(valor)) return TRACO;
    var instante = new Date(valor);
    if (isNaN(instante.getTime())) return TRACO;
    var p = {};
    FORMATO_DATA_HORA.formatToParts(instante).forEach(function (parte) { p[parte.type] = parte.value; });
    return p.day + '/' + p.month + '/' + p.year + ' ' + p.hour + ':' + p.minute;
  }

  var textoDe = {
    dataHora: dataHora,
    tamanho: function (t) { return t === null || t === undefined || t === '' ? TAMANHO_UNICO : String(t); },
    quantidade: function (o) {
      var sinal = hasOwn(TIPOS, o.tipo) ? TIPOS[o.tipo].sinal : '';
      return sinal + texto(o.quantidade);
    },
    motivo: function (o) {
      if (o.tipo !== 'BAIXA' || !texto(o.motivo)) return TRACO;
      return hasOwn(MOTIVOS, o.motivo) ? MOTIVOS[o.motivo] : texto(o.motivo);
    },
    justificativa: function (o) { return texto(o.justificativa) || TRACO; },
    responsavel: function (o) { return texto(o.responsavel) || TRACO; },
    ca: function (o) { return texto(o.caNumero) || TRACO; },
  };

  // ─── Render ────────────────────────────────────────────────────────
  function escaparHtml(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function tipoDe(codigo) {
    return hasOwn(TIPOS, codigo) ? TIPOS[codigo] : { rotulo: texto(codigo) || TRACO, classe: 'tipo-outro', nota: '' };
  }

  function detalhe(v) {
    return texto(v) ? ' <small class="detalhe">' + escaparHtml(v) + '</small>' : '';
  }

  function linha(o) {
    var t = tipoDe(o.tipo);
    return '<tr>'
      + '<td class="data">' + escaparHtml(dataHora(o.criadoEm)) + '</td>'
      + '<td><span class="tipo ' + t.classe + '">' + escaparHtml(t.rotulo) + '</span>' + detalhe(t.nota) + '</td>'
      + '<td>' + escaparHtml(texto(o.material) || TRACO) + detalhe(o.codigoInterno) + '</td>'
      + '<td>' + escaparHtml(textoDe.tamanho(o.tamanho)) + '</td>'
      + '<td>' + escaparHtml(textoDe.ca(o)) + detalhe(texto(o.loteId) ? 'Lote ' + o.loteId : '') + '</td>'
      + '<td class="numero ' + t.classe + '">' + escaparHtml(textoDe.quantidade(o)) + '</td>'
      + '<td>' + escaparHtml(textoDe.motivo(o)) + '</td>'
      + '<td class="justificativa">' + escaparHtml(textoDe.justificativa(o)) + '</td>'
      + '<td>' + escaparHtml(textoDe.responsavel(o)) + '</td>'
      + '<td class="referencia">' + escaparHtml(texto(o.operacaoId) ? 'Op. ' + o.operacaoId : TRACO) + '</td>'
      + '</tr>';
  }

  var render = {
    escaparHtml: escaparHtml,
    linhas: function (operacoes) {
      return (operacoes || []).map(linha).join('');
    },
    vazio: function (mensagem) {
      return '<tr><td colspan="10" class="estado">' + escaparHtml(mensagem) + '</td></tr>';
    },
    /** Linhas, ou a mensagem de lista vazia. */
    tabela: function (operacoes, opcoes) {
      var o = opcoes || {};
      return operacoes && operacoes.length ? render.linhas(operacoes) : render.vazio(o.mensagemVazia || 'Nenhuma operação registrada.');
    },
    paginacao: function (d, quantidade) {
      var total = d && Number(d.total);
      if (!total) return { texto: 'Nenhuma operação', anterior: false, proxima: false };
      var inicio = (d.pagina - 1) * d.limite + 1;
      var fim = inicio + quantidade - 1;
      return { texto: 'Operações ' + inicio + '–' + fim + ' de ' + total + ' · página ' + d.pagina + ' de ' + d.paginas, anterior: d.pagina > 1, proxima: d.pagina < d.paginas };
    },
  };

  // ─── Mensagens ─────────────────────────────────────────────────────
  var mensagens = {
    erroListagem: function (r) {
      if (!r || typeof r.status !== 'number' || r.status === 0) return 'Falha de rede ao consultar as operações de estoque. Verifique a conexão e tente novamente.';
      if (r.status === 401) return 'Sua sessão terminou. Entre novamente pelo Portal do Cliente.';
      if (r.status === 403) return 'Seu perfil não pode consultar o estoque nesta empresa.';
      if (r.status === 400) return 'Filtro não aceito pelo servidor. Confira a operação, o período e a busca.';
      return 'Não foi possível consultar as operações de estoque. Tente novamente.';
    },
  };

  global.EpiOperacoesEstoque = {
    CAMINHO: CAMINHO,
    LIMITE: LIMITE,
    TIPOS: TIPOS,
    MOTIVOS: MOTIVOS,
    FILTROS: FILTROS,
    tipoPermitido: tipoPermitido,
    dataPermitida: dataPermitida,
    acoes: acoes,
    texto: textoDe,
    render: render,
    mensagens: mensagens,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.EpiOperacoesEstoque;
  }
})(typeof window !== 'undefined' ? window : globalThis);
