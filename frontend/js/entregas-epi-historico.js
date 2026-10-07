(function (global) {
  'use strict';

  /**
   * EpiEntregasHistorico — EPIs Entregues: o histórico de itens entregues da empresa, pelo
   * GET /entregas-epi/itens. Só leitura.
   *
   * O servidor decide tudo o que é número: validade de uso (data da entrega + prazo congelado), dias restantes (pelo dia
   * operacional de São Paulo) e status (Vencido: passou da validade; Próximo: faltam de 0 a 30 dias; Válido: mais de 30).
   * Esta tela só apresenta, em nós e texto (nunca HTML montado). A busca de item e de funcionário é texto livre,
   * parcial e sem diferenciar maiúsculas nem acentos, feita no servidor; não existe busca por CPF.
   */

  var CAMINHO = '/entregas-epi/itens';
  var LIMITE = 20;
  var TRACO = '—';
  var DATA = /^\d{4}-\d{2}-\d{2}$/;
  var BUSCA_MAXIMA = 100;

  var STATUS = Object.freeze({
    VALIDO: Object.freeze({ rotulo: 'Válido', estilo: 'background:rgba(52,199,89,0.12);color:#1A7A35' }),
    PROXIMO: Object.freeze({ rotulo: 'Próximo do vencimento', estilo: 'background:rgba(255,149,0,0.12);color:#C07000' }),
    VENCIDO: Object.freeze({ rotulo: 'Vencido', estilo: 'background:rgba(255,59,48,0.12);color:#C0221A' }),
  });
  var COR_DIAS = Object.freeze({ VALIDO: '#34C759', PROXIMO: '#FF9500', VENCIDO: '#FF3B30' });
  var ORIGENS = Object.freeze({ DIRETA: 'Direta', SOLICITACAO: 'Por solicitação' });

  var TEXTOS = Object.freeze({
    CARREGANDO: 'Carregando…',
    VAZIO: 'Nenhuma entrega de EPI registrada nesta empresa.',
    VAZIO_FILTRO: 'Nenhuma entrega encontrada para os filtros informados.',
    SERVIDOR_DESATUALIZADO: 'Esta consulta não está disponível no servidor atual. Reinicie o servidor com a versão mais recente e tente de novo.',
    FALHA: 'Não foi possível carregar as entregas agora. Tente novamente.',
    SEM_AUTORIDADE: 'Sem permissão para consultar as entregas de EPI nesta empresa.',
    PERIODO_INVERTIDO: 'Período inválido: a data final precisa ser igual ou posterior à inicial.',
    FILTRO_INVALIDO: 'Verifique os filtros informados.',
  });

  function http() {
    if (!global.EpiHttp) throw new Error('EpiHttp não carregado: inclua js/api-http.js antes de js/entregas-epi-historico.js');
    return global.EpiHttp;
  }
  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function texto(v) { return String(v === undefined || v === null ? '' : v).trim(); }
  function inteiroPositivo(v) { return typeof v === 'number' && Math.floor(v) === v && v > 0; }
  function dataPermitida(v) { return typeof v === 'string' && DATA.test(v); }
  function statusPermitido(v) { return typeof v === 'string' && hasOwn(STATUS, v); }

  // ─── API ──────────────────────────────────────────────────────────
  var acoes = {
    /** Só envia o que foi preenchido e é válido; o servidor confere de novo. */
    listar: function (filtro) {
      var f = filtro || {};
      var q = [];
      var item = texto(f.item);
      var funcionario = texto(f.funcionario);
      if (item) q.push('item=' + encodeURIComponent(item.slice(0, BUSCA_MAXIMA)));
      if (funcionario) q.push('funcionario=' + encodeURIComponent(funcionario.slice(0, BUSCA_MAXIMA)));
      if (dataPermitida(f.de)) q.push('de=' + f.de);
      if (dataPermitida(f.ate)) q.push('ate=' + f.ate);
      if (statusPermitido(f.status)) q.push('status=' + f.status);
      q.push('pagina=' + (inteiroPositivo(f.pagina) ? f.pagina : 1));
      q.push('limite=' + (inteiroPositivo(f.limite) ? f.limite : LIMITE));
      return http().requisitar('GET', CAMINHO + '?' + q.join('&'));
    },
  };

  // ─── Modelo / texto ───────────────────────────────────────────────
  function dataBr(iso) {
    if (!dataPermitida(iso)) return TRACO;
    return iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4);
  }
  function diasTexto(item) {
    var dias = item.diasRestantes;
    if (typeof dias !== 'number' || !isFinite(dias)) return TRACO;
    if (dias < 0) return 'Vencido há ' + Math.abs(dias) + (Math.abs(dias) === 1 ? ' dia' : ' dias');
    if (dias === 0) return 'Vence hoje';
    if (item.status === 'PROXIMO') return 'Vence em ' + dias + (dias === 1 ? ' dia' : ' dias');
    return dias + (dias === 1 ? ' dia' : ' dias');
  }
  function prazoTexto(dias) {
    if (!inteiroPositivo(dias)) return '';
    var meses = Math.round(dias / 30);
    if (meses >= 12) return '(' + (meses / 12) + (meses === 12 ? ' ano' : ' anos') + ' de uso)';
    return '(' + meses + (meses === 1 ? ' mês' : ' meses') + ' de uso)';
  }
  function tamanho(t) { return t === null || t === undefined || t === '' ? 'Único' : String(t); }

  var modelo = {
    /** Período invertido para antes da rede; o servidor recusa de novo. */
    periodoInvertido: function (de, ate) { return dataPermitida(de) && dataPermitida(ate) && de > ate; },
    /** Filtro como a tela o usa: só valores válidos. */
    normalizar: function (bruto) {
      var b = bruto || {};
      return {
        item: texto(b.item),
        funcionario: texto(b.funcionario),
        de: dataPermitida(b.de) ? b.de : '',
        ate: dataPermitida(b.ate) ? b.ate : '',
        status: statusPermitido(b.status) ? b.status : '',
        pagina: inteiroPositivo(b.pagina) ? b.pagina : 1,
      };
    },
    comFiltro: function (f) { return !!(f.item || f.funcionario || f.de || f.ate || f.status); },
    /**
     * "Verifique os filtros" só quando o servidor aponta um parâmetro da consulta (query.*). Um 400 de outra natureza
     * (ex.: servidor antigo, que trata /entregas-epi/itens como /entregas-epi/:id e recusa params.id) não é culpa dos filtros.
     */
    erro: function (r) {
      if (r && r.status === 403) return TEXTOS.SEM_AUTORIDADE;
      if (r && r.status === 400) {
        var campos = Array.isArray(r.detalhes) ? r.detalhes.map(function (d) { return d && d.campo; }) : [];
        var daConsulta = campos.some(function (c) { return typeof c === 'string' && c.indexOf('query.') === 0; });
        var daRota = campos.some(function (c) { return typeof c === 'string' && c.indexOf('params.') === 0; });
        if (daConsulta) return TEXTOS.FILTRO_INVALIDO;
        if (daRota) return TEXTOS.SERVIDOR_DESATUALIZADO;
        return TEXTOS.FALHA;
      }
      return TEXTOS.FALHA;
    },
    paginacao: function (d, quantidade) {
      var pagina = inteiroPositivo(d.pagina) ? d.pagina : 1;
      var limite = inteiroPositivo(d.limite) ? d.limite : LIMITE;
      var total = typeof d.total === 'number' && d.total >= 0 ? d.total : quantidade;
      if (!quantidade) return { texto: '', anterior: pagina > 1, proxima: false };
      var de = (pagina - 1) * limite + 1;
      var ate = (pagina - 1) * limite + quantidade;
      return { texto: de + '–' + ate + ' de ' + total, anterior: pagina > 1, proxima: ate < total };
    },
    rotuloStatus: function (s) { return statusPermitido(s) ? STATUS[s].rotulo : TRACO; },
    textoDias: diasTexto,
    dataBr: dataBr,
    /** CSV das linhas mostradas, com as mesmas colunas da tabela; células neutralizadas contra fórmula. */
    csv: function (itens) {
      var cabecalho = ['Funcionário', 'Setor', 'Tipo', 'Item entregue', 'Tamanho', 'Quantidade', 'Data da entrega', 'Validade de uso', 'Dias restantes', 'Status', 'Entregue por'];
      function celula(v) {
        var s = String(v === undefined || v === null ? '' : v);
        if (/^[=+\-@\t\r]/.test(s)) s = '\'' + s;
        return '"' + s.replace(/"/g, '""') + '"';
      }
      var linhas = itens.map(function (i) {
        return [i.trabalhador.nome, i.trabalhador.setor || TRACO, i.material.tipo || TRACO, i.material.nome, tamanho(i.tamanho), i.quantidade,
          dataBr(i.dataEntrega), dataBr(i.validadeUso), i.diasRestantes, modelo.rotuloStatus(i.status), i.responsavel.nome];
      });
      return [cabecalho].concat(linhas).map(function (l) { return l.map(celula).join(';'); }).join('\n');
    },
  };

  // ─── Render (nós e texto) ─────────────────────────────────────────
  function no(doc, tag, atributos, filhos) {
    var el = doc.createElement(tag);
    Object.keys(atributos || {}).forEach(function (k) {
      var v = atributos[k];
      if (v === null || v === undefined || v === false) return;
      el.setAttribute(k, String(v));
    });
    (filhos || []).forEach(function (f) {
      if (f === null || f === undefined || f === false) return;
      el.appendChild(typeof f === 'string' ? doc.createTextNode(f) : f);
    });
    return el;
  }

  var render = {
    mensagem: function (doc, textoMensagem) {
      return no(doc, 'tr', { 'data-vazio': '' }, [no(doc, 'td', { colspan: '11', style: 'text-align:center;color:var(--on-surface-variant);padding:32px' }, [textoMensagem])]);
    },
    linha: function (doc, i) {
      var status = statusPermitido(i.status) ? i.status : null;
      var origem = hasOwn(ORIGENS, i.origem) ? ORIGENS[i.origem] : null;
      var prazo = prazoTexto(i.prazoUsoDias);
      return no(doc, 'tr', { 'data-item': String(i.itemId), 'data-status': status }, [
        no(doc, 'td', {}, [no(doc, 'strong', {}, [i.trabalhador.nome])]),
        no(doc, 'td', {}, [i.trabalhador.setor || TRACO]),
        no(doc, 'td', {}, [i.material.tipo || TRACO]),
        no(doc, 'td', {}, [i.material.nome, origem ? no(doc, 'div', { style: 'font-size:11px;color:var(--on-surface-variant);margin-top:2px' }, [origem]) : null]),
        no(doc, 'td', {}, [tamanho(i.tamanho)]),
        no(doc, 'td', {}, [String(i.quantidade)]),
        no(doc, 'td', { style: 'white-space:nowrap' }, [dataBr(i.dataEntrega)]),
        no(doc, 'td', { style: 'white-space:nowrap' }, [
          no(doc, 'div', { style: 'font-size:13px' }, [dataBr(i.validadeUso)]),
          prazo ? no(doc, 'div', { style: 'font-size:11px;color:var(--on-surface-variant);margin-top:2px' }, [prazo]) : null,
        ]),
        no(doc, 'td', {}, [no(doc, 'span', { style: status ? 'color:' + COR_DIAS[status] + ';font-weight:500' : null }, [diasTexto(i)])]),
        no(doc, 'td', {}, [status ? no(doc, 'span', { class: 'badge', style: STATUS[status].estilo + ';font-size:11px' }, [STATUS[status].rotulo]) : TRACO]),
        no(doc, 'td', {}, [i.responsavel.nome]),
      ]);
    },
  };

  global.EpiEntregasHistorico = {
    acoes: acoes, modelo: modelo, render: render, TEXTOS: TEXTOS, STATUS: STATUS, LIMITE: LIMITE, CAMINHO: CAMINHO,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.EpiEntregasHistorico;
})(typeof window !== 'undefined' ? window : globalThis);
