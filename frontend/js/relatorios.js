(function (global) {
  'use strict';

  /**
   * EpiRelatorios — Relatórios (12K-D, etapa 1): Estoque, Próximo do vencimento, Itens vencidos e EPIs entregues, pelas
   * quatro rotas GET /relatorios/*. Só leitura.
   *
   * O servidor decide tudo o que é número (saldo utilizável, dias restantes, faixa e status). Esta tela só apresenta, em
   * nós e texto (nunca HTML montado), e exporta CSV do que o servidor devolveu para o filtro e a ordem em uso — todas as
   * linhas do filtro, não só a página (páginas de 100 até o fim). Nenhum CPF, IP, hash ou dado técnico é pedido ou exibido.
   */

  var LIMITE = 20;
  var LIMITE_EXPORTACAO = 100;
  var MAXIMO_PAGINAS_EXPORTACAO = 100;
  var BUSCA_MAXIMA = 100;
  var TRACO = '—';
  var DATA = /^\d{4}-\d{2}-\d{2}$/;

  var TEXTOS = Object.freeze({
    CARREGANDO: 'Carregando…',
    VAZIO_ESTOQUE: 'Nenhum lote de estoque encontrado.',
    VAZIO_ENTREGAS: 'Nenhuma entrega encontrada para os filtros informados.',
    VAZIO_VENCIMENTO: 'Nenhum EPI próximo do vencimento para os filtros informados.',
    VAZIO_VENCIDOS: 'Nenhum item vencido para os filtros informados.',
    SEM_ALERTAS: 'Nenhum alerta de estoque no momento.',
    FALHA: 'Não foi possível carregar o relatório agora. Tente novamente.',
    SEM_AUTORIDADE: 'Sem permissão para consultar este relatório nesta empresa.',
    FILTRO_INVALIDO: 'Verifique os filtros informados.',
    PERIODO_INVERTIDO: 'Período inválido: a data final precisa ser igual ou posterior à inicial.',
    SERVIDOR_DESATUALIZADO: 'Este relatório não está disponível no servidor atual. Reinicie o servidor com a versão mais recente e tente de novo.',
    EXPORTACAO_FALHOU: 'Não foi possível exportar agora. Tente novamente.',
    EXPORTACAO_SEM_LINHAS: 'Não há linhas para exportar com os filtros atuais.',
    EXPORTACAO_INCOMPLETA: 'A exportação ficou incompleta: o relatório é maior que o limite de exportação. Refine os filtros.',
    EXPORTADO: 'Relatório exportado.',
  });

  var ESTILO = Object.freeze({
    VERMELHO: 'background:rgba(255,59,48,0.12);color:#C0221A',
    LARANJA: 'background:rgba(255,149,0,0.12);color:#C07000',
    AMARELO: 'background:rgba(255,204,0,0.18);color:#8A6D00',
    VERDE: 'background:rgba(52,199,89,0.12);color:#1A7A35',
  });
  var COR = Object.freeze({ VERMELHO: '#FF3B30', LARANJA: '#FF9500', AMARELO: '#B38F00', VERDE: '#34C759' });

  var STATUS = Object.freeze({
    estoque: Object.freeze({
      SEM_ESTOQUE: Object.freeze({ rotulo: 'Sem estoque', estilo: ESTILO.VERMELHO }),
      EM_ALERTA: Object.freeze({ rotulo: 'Em alerta', estilo: ESTILO.LARANJA }),
      DISPONIVEL: Object.freeze({ rotulo: 'Disponível', estilo: ESTILO.VERDE }),
    }),
    proximoVencimento: Object.freeze({
      TROCAR_URGENTE: Object.freeze({ rotulo: 'Trocar urgente', estilo: ESTILO.VERMELHO, cor: COR.VERMELHO }),
      ATENCAO: Object.freeze({ rotulo: 'Atenção', estilo: ESTILO.LARANJA, cor: COR.LARANJA }),
      PROXIMO: Object.freeze({ rotulo: 'Próximo do vencimento', estilo: ESTILO.AMARELO, cor: COR.AMARELO }),
    }),
    vencidos: Object.freeze({
      TROCA_URGENTE: Object.freeze({ rotulo: 'Troca urgente', estilo: ESTILO.VERMELHO, cor: COR.VERMELHO }),
    }),
  });

  var ALERTAS = Object.freeze({
    SEM_ESTOQUE: Object.freeze({ rotulo: 'Sem estoque', estilo: ESTILO.VERMELHO }),
    ABAIXO_MINIMO: Object.freeze({ rotulo: 'No mínimo ou abaixo', estilo: ESTILO.LARANJA }),
    CA_VENCIDO: Object.freeze({ rotulo: 'CA vencido', estilo: ESTILO.VERMELHO }),
    CA_AUSENTE: Object.freeze({ rotulo: 'CA ausente', estilo: ESTILO.VERMELHO }),
    CA_PROXIMO: Object.freeze({ rotulo: 'CA próximo do vencimento', estilo: ESTILO.LARANJA }),
  });

  var SITUACAO_CA = Object.freeze({
    VENCIDO: 'CA vencido', SEM_CA: 'CA ausente', VENCE_HOJE: 'CA vence hoje', A_VENCER: 'CA a vencer',
  });

  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function texto(v) { return String(v === undefined || v === null ? '' : v).trim(); }
  function inteiroPositivo(v) { return typeof v === 'number' && Math.floor(v) === v && v > 0; }
  function dataPermitida(v) { return typeof v === 'string' && DATA.test(v); }
  function dataBr(iso) {
    if (!dataPermitida(iso)) return TRACO;
    return iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4);
  }
  function tamanhoDe(t) { return t === null || t === undefined || t === '' ? 'Único' : String(t); }
  function ou(v) { return v === null || v === undefined || v === '' ? TRACO : String(v); }
  function dias(n) { return n + (n === 1 ? ' dia' : ' dias'); }
  function rotuloStatus(aba, s) { return hasOwn(STATUS[aba], s) ? STATUS[aba][s].rotulo : TRACO; }

  // ─── Definição das quatro abas ────────────────────────────────────
  var SETOR = { campo: 'setor', rotulo: 'Setor', tipo: 'texto', placeholder: 'Ex.: produção, manutenção' };
  var FUNCIONARIO = { campo: 'funcionario', rotulo: 'Funcionário', tipo: 'texto', placeholder: 'Nome ou matrícula' };
  var EPI = { campo: 'item', rotulo: 'EPI', tipo: 'texto', placeholder: 'Nome ou tipo do EPI' };

  function caStatus(l) { return l.ca && l.ca.numero ? l.ca.numero : TRACO; }

  var ABAS = Object.freeze({
    estoque: Object.freeze({
      id: 'estoque',
      caminho: '/relatorios/estoque',
      recurso: 'materials',
      arquivo: 'relatorio-estoque',
      itens: 'linhas',
      vazio: TEXTOS.VAZIO_ESTOQUE,
      ordemPadrao: Object.freeze({ ordem: 'material', direcao: 'asc' }),
      filtros: Object.freeze([
        { campo: 'busca', rotulo: 'Material, tipo ou CA', tipo: 'texto', placeholder: 'Ex.: botina, luva, 12345' },
        {
          campo: 'status', rotulo: 'Status', tipo: 'select', opcoes: [['', 'Todos'], ['SEM_ESTOQUE', 'Sem estoque'], ['EM_ALERTA', 'Em alerta'], ['DISPONIVEL', 'Disponível']],
        },
      ]),
      colunas: Object.freeze([
        { rotulo: 'Material', ordem: 'material', forte: true, valor: function (l) { return l.material; } },
        { rotulo: 'Tipo', ordem: 'tipo', valor: function (l) { return ou(l.tipo); } },
        { rotulo: 'CA', ordem: 'ca', valor: caStatus, detalhe: function (l) { return l.ca && hasOwn(SITUACAO_CA, l.ca.situacao) ? SITUACAO_CA[l.ca.situacao] : ''; } },
        { rotulo: 'Lote', ordem: 'lote', valor: function (l) { return '#' + l.loteId; }, detalhe: function (l) { return 'Tam. ' + tamanhoDe(l.tamanho); } },
        { rotulo: 'Data de entrada', ordem: 'dataEntrada', nowrap: true, valor: function (l) { return dataBr(l.dataEntrada); } },
        { rotulo: 'Quantidade entrada', ordem: 'quantidadeEntrada', valor: function (l) { return String(l.quantidadeEntrada); } },
        {
          rotulo: 'Disponível no lote',
          ordem: 'disponivel',
          valor: function (l) { return String(l.disponivelNoLote); },
          detalhe: function (l) { return l.saldoFisicoNoLote !== l.disponivelNoLote ? 'Físico ' + l.saldoFisicoNoLote + ' (bloqueado por CA)' : ''; },
        },
        { rotulo: 'Estoque mínimo', ordem: 'estoqueMinimo', valor: function (l) { return String(l.estoqueMinimo); } },
        { rotulo: 'Status', ordem: 'status', selo: function (l) { return STATUS.estoque[l.status] || null; }, valor: function (l) { return rotuloStatus('estoque', l.status); } },
      ]),
    }),
    proximoVencimento: Object.freeze({
      id: 'proximoVencimento',
      caminho: '/relatorios/proximo-vencimento',
      recurso: 'epiFicha',
      arquivo: 'relatorio-proximo-do-vencimento',
      itens: 'itens',
      vazio: TEXTOS.VAZIO_VENCIMENTO,
      ordemPadrao: Object.freeze({ ordem: 'dias', direcao: 'asc' }),
      filtros: Object.freeze([
        FUNCIONARIO, SETOR, EPI,
        {
          campo: 'faixa', rotulo: 'Faixa', tipo: 'select', opcoes: [['', 'Todos'], ['0-10', '0 a 10 dias'], ['11-20', '11 a 20 dias'], ['21-30', '21 a 30 dias']],
        },
      ]),
      colunas: Object.freeze([
        { rotulo: 'Funcionário', ordem: 'funcionario', forte: true, valor: function (l) { return l.trabalhador.nome; } },
        { rotulo: 'Setor', ordem: 'setor', valor: function (l) { return ou(l.trabalhador.setor); } },
        { rotulo: 'EPI', ordem: 'epi', valor: function (l) { return l.material.nome; } },
        { rotulo: 'CA', ordem: 'ca', valor: caStatus },
        { rotulo: 'Data da entrega', ordem: 'dataEntrega', nowrap: true, valor: function (l) { return dataBr(l.dataEntrega); } },
        { rotulo: 'Validade de uso', ordem: 'validade', nowrap: true, valor: function (l) { return dataBr(l.validadeUso); } },
        {
          rotulo: 'Dias restantes',
          ordem: 'dias',
          valor: function (l) { return String(l.diasRestantes); },
          cor: function (l) { return hasOwn(STATUS.proximoVencimento, l.status) ? STATUS.proximoVencimento[l.status].cor : null; },
        },
        { rotulo: 'Status', ordem: 'dias', selo: function (l) { return STATUS.proximoVencimento[l.status] || null; }, valor: function (l) { return rotuloStatus('proximoVencimento', l.status); } },
      ]),
    }),
    vencidos: Object.freeze({
      id: 'vencidos',
      caminho: '/relatorios/vencidos',
      recurso: 'epiFicha',
      arquivo: 'relatorio-itens-vencidos',
      itens: 'itens',
      vazio: TEXTOS.VAZIO_VENCIDOS,
      ordemPadrao: Object.freeze({ ordem: 'dias', direcao: 'asc' }),
      filtros: Object.freeze([FUNCIONARIO, SETOR, EPI]),
      colunas: Object.freeze([
        { rotulo: 'Funcionário', ordem: 'funcionario', forte: true, valor: function (l) { return l.trabalhador.nome; } },
        { rotulo: 'Setor', ordem: 'setor', valor: function (l) { return ou(l.trabalhador.setor); } },
        { rotulo: 'EPI', ordem: 'epi', valor: function (l) { return l.material.nome; } },
        { rotulo: 'CA', ordem: 'ca', valor: caStatus },
        { rotulo: 'Data da entrega', ordem: 'dataEntrega', nowrap: true, valor: function (l) { return dataBr(l.dataEntrega); } },
        { rotulo: 'Validade de uso', ordem: 'validade', nowrap: true, valor: function (l) { return dataBr(l.validadeUso); } },
        { rotulo: 'Dias vencidos', ordem: 'dias', valor: function (l) { return String(l.diasVencidos); }, cor: function () { return COR.VERMELHO; } },
        { rotulo: 'Status', ordem: 'dias', selo: function (l) { return STATUS.vencidos[l.status] || null; }, valor: function (l) { return rotuloStatus('vencidos', l.status); } },
      ]),
    }),
    episEntregues: Object.freeze({
      id: 'episEntregues',
      caminho: '/relatorios/epis-entregues',
      recurso: 'epiFicha',
      arquivo: 'relatorio-epis-entregues',
      itens: 'itens',
      vazio: TEXTOS.VAZIO_ENTREGAS,
      ordemPadrao: Object.freeze({ ordem: 'dataEntrega', direcao: 'desc' }),
      filtros: Object.freeze([
        { campo: 'de', rotulo: 'Período inicial', tipo: 'data' },
        { campo: 'ate', rotulo: 'Período final', tipo: 'data' },
        FUNCIONARIO, SETOR, EPI,
      ]),
      colunas: Object.freeze([
        { rotulo: 'Funcionário', ordem: 'funcionario', forte: true, valor: function (l) { return l.trabalhador.nome; } },
        { rotulo: 'Setor', ordem: 'setor', valor: function (l) { return ou(l.trabalhador.setor); } },
        { rotulo: 'EPI', ordem: 'epi', valor: function (l) { return l.material.nome; } },
        { rotulo: 'CA', ordem: 'ca', valor: caStatus },
        { rotulo: 'Quantidade', ordem: 'quantidade', valor: function (l) { return String(l.quantidade); } },
        { rotulo: 'Data da entrega', ordem: 'dataEntrega', nowrap: true, valor: function (l) { return dataBr(l.dataEntrega); } },
        { rotulo: 'Entregue por', ordem: 'responsavel', valor: function (l) { return ou(l.responsavel && l.responsavel.nome); } },
      ]),
    }),
  });

  function aba(id) {
    if (!hasOwn(ABAS, id)) throw new TypeError('relatório desconhecido');
    return ABAS[id];
  }

  function http() {
    if (!global.EpiHttp) throw new Error('EpiHttp não carregado: inclua js/api-http.js antes de js/relatorios.js');
    return global.EpiHttp;
  }

  // ─── Consulta ─────────────────────────────────────────────────────
  function valorDoFiltro(def, bruto) {
    var v = texto(bruto);
    if (def.tipo === 'texto') return v.slice(0, BUSCA_MAXIMA);
    if (def.tipo === 'data') return dataPermitida(v) ? v : '';
    return def.opcoes.some(function (o) { return o[0] === v; }) ? v : '';
  }

  function ordenacaoValida(a, ordenacao) {
    var o = ordenacao || {};
    var conhecida = a.colunas.some(function (c) { return c.ordem === o.ordem; });
    return {
      ordem: conhecida ? o.ordem : a.ordemPadrao.ordem,
      direcao: conhecida ? (o.direcao === 'desc' ? 'desc' : 'asc') : a.ordemPadrao.direcao,
    };
  }

  function consulta(a, filtro, ordenacao, pagina, limite) {
    var f = filtro || {};
    var q = [];
    a.filtros.forEach(function (def) {
      var v = valorDoFiltro(def, f[def.campo]);
      if (v) q.push(def.campo + '=' + encodeURIComponent(v));
    });
    var o = ordenacaoValida(a, ordenacao);
    q.push('ordem=' + o.ordem, 'direcao=' + o.direcao);
    q.push('pagina=' + (inteiroPositivo(pagina) ? pagina : 1), 'limite=' + (inteiroPositivo(limite) ? limite : LIMITE));
    return a.caminho + '?' + q.join('&');
  }

  var acoes = {
    consultar: function (id, filtro, ordenacao, pagina, limite) {
      var a = aba(id);
      return http().requisitar('GET', consulta(a, filtro, ordenacao, pagina, limite));
    },
    /** Todas as linhas do filtro e da ordem em uso, em páginas de 100; nunca só a página mostrada. */
    todas: async function (id, filtro, ordenacao) {
      var a = aba(id);
      var linhas = [];
      var total = 0;
      for (var pagina = 1; pagina <= MAXIMO_PAGINAS_EXPORTACAO; pagina += 1) {
        // eslint-disable-next-line no-await-in-loop
        var r = await http().requisitar('GET', consulta(a, filtro, ordenacao, pagina, LIMITE_EXPORTACAO));
        if (!r.ok) return { ok: false, resposta: r };
        var d = r.dados || {};
        var lote = Array.isArray(d[a.itens]) ? d[a.itens] : [];
        total = typeof d.total === 'number' ? d.total : total;
        linhas = linhas.concat(lote);
        if (!lote.length || linhas.length >= total) return { ok: true, linhas: linhas, total: total, completa: true };
      }
      return { ok: true, linhas: linhas, total: total, completa: linhas.length >= total };
    },
  };

  // ─── Modelo / texto ───────────────────────────────────────────────
  function celulaCsv(v) {
    var s = String(v === undefined || v === null ? '' : v);
    if (/^[=+\-@\t\r]/.test(s)) s = '\'' + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }

  var modelo = {
    periodoInvertido: function (de, ate) { return dataPermitida(de) && dataPermitida(ate) && de > ate; },
    /** Filtro como a tela o usa: só valores válidos para cada campo da aba. */
    normalizar: function (id, bruto) {
      var a = aba(id);
      var f = {};
      a.filtros.forEach(function (def) { f[def.campo] = valorDoFiltro(def, (bruto || {})[def.campo]); });
      return f;
    },
    comFiltro: function (id, f) { return aba(id).filtros.some(function (def) { return !!(f && f[def.campo]); }); },
    ordenacao: ordenacaoValida,
    /** Próxima ordenação ao clicar no cabeçalho: mesma coluna inverte; outra coluna começa crescente. */
    alternarOrdem: function (id, atual, ordem) {
      var a = aba(id);
      var o = ordenacaoValida(a, atual);
      if (o.ordem === ordem) return { ordem: ordem, direcao: o.direcao === 'asc' ? 'desc' : 'asc' };
      return ordenacaoValida(a, { ordem: ordem, direcao: 'asc' });
    },
    erro: function (r) {
      if (r && r.status === 403) return TEXTOS.SEM_AUTORIDADE;
      if (r && r.status === 400) {
        var campos = Array.isArray(r.detalhes) ? r.detalhes.map(function (d) { return d && d.campo; }) : [];
        if (campos.some(function (c) { return typeof c === 'string' && c.indexOf('query.') === 0; })) return TEXTOS.FILTRO_INVALIDO;
      }
      if (r && r.status === 404) return TEXTOS.SERVIDOR_DESATUALIZADO;
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
    indicadores: function (d) {
      var i = d && d.indicadores ? d.indicadores : {};
      function n(v) { return typeof v === 'number' ? String(v) : TRACO; }
      return { itensCadastrados: n(i.itensCadastrados), comEstoqueDisponivel: n(i.comEstoqueDisponivel), emAlerta: n(i.emAlerta) };
    },
    alerta: function (a) {
      var tipo = hasOwn(ALERTAS, a.tipo) ? ALERTAS[a.tipo] : null;
      var detalhe = 'Disponível: ' + a.saldoTotal + ' · Estoque mínimo: ' + a.estoqueMinimo;
      if (a.caNumero) detalhe += ' · CA ' + a.caNumero;
      return { titulo: a.material, detalhe: detalhe, rotulo: tipo ? tipo.rotulo : TRACO, estilo: tipo ? tipo.estilo : null };
    },
    cabecalhoCsv: function (id) { return aba(id).colunas.map(function (c) { return c.rotulo; }); },
    /**
     * CSV para o Excel brasileiro: UTF-8 com BOM, separador ";", fim de linha CRLF, toda célula entre aspas e
     * neutralizada contra fórmula. Mesmas colunas da tabela e só o que a tela exibe.
     */
    csv: function (id, linhas) {
      var a = aba(id);
      var corpo = [a.colunas.map(function (c) { return c.rotulo; })].concat(linhas.map(function (l) {
        return a.colunas.map(function (c) { return c.valor(l); });
      }));
      return '﻿' + corpo.map(function (l) { return l.map(celulaCsv).join(';'); }).join('\r\n');
    },
    nomeArquivo: function (id, hojeIso) { return aba(id).arquivo + '-' + (dataPermitida(hojeIso) ? hojeIso : 'exportacao') + '.csv'; },
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
  var NOTA = 'font-size:11px;color:var(--on-surface-variant);margin-top:2px';

  var render = {
    filtro: function (doc, id, def) {
      var dom = 'f-' + id + '-' + def.campo;
      var controle;
      if (def.tipo === 'select') {
        controle = no(doc, 'select', { id: dom, class: 'select', 'data-filtro': def.campo }, def.opcoes.map(function (o) { return no(doc, 'option', { value: o[0] }, [o[1]]); }));
      } else {
        controle = no(doc, 'input', {
          id: dom, class: 'input', 'data-filtro': def.campo, type: def.tipo === 'data' ? 'date' : 'search', maxlength: def.tipo === 'texto' ? BUSCA_MAXIMA : null, placeholder: def.placeholder || null, autocomplete: 'off',
        });
      }
      return no(doc, 'div', { class: 'field' }, [no(doc, 'label', { for: dom }, [def.rotulo]), controle]);
    },
    filtros: function (doc, id) {
      var a = aba(id);
      var acoesBox = no(doc, 'div', { class: 'footer-actions filters-actions' }, [
        no(doc, 'button', { type: 'button', class: 'filled-btn', 'data-acao-relatorio': 'filtrar' }, ['Filtrar']),
        no(doc, 'button', { type: 'button', class: 'outlined-btn', 'data-acao-relatorio': 'limpar' }, ['Limpar']),
      ]);
      return a.filtros.map(function (def) { return render.filtro(doc, id, def); }).concat([acoesBox]);
    },
    cabecalho: function (doc, id, ordenacao) {
      var a = aba(id);
      var o = ordenacaoValida(a, ordenacao);
      return no(doc, 'tr', {}, a.colunas.map(function (c, i) {
        var ativa = c.ordem === o.ordem && (c.rotulo !== 'Status' || a.colunas.filter(function (x) { return x.ordem === o.ordem; })[0] === c);
        var seta = ativa ? (o.direcao === 'asc' ? ' ▲' : ' ▼') : '';
        return no(doc, 'th', {
          'data-ordem': c.ordem, 'data-coluna': String(i), role: 'button', tabindex: '0', style: 'cursor:pointer;user-select:none', 'aria-sort': ativa ? (o.direcao === 'asc' ? 'ascending' : 'descending') : 'none',
        }, [c.rotulo + seta]);
      }));
    },
    mensagem: function (doc, id, textoMensagem) {
      return no(doc, 'tr', { 'data-vazio': '' }, [no(doc, 'td', { colspan: String(aba(id).colunas.length), style: 'text-align:center;color:var(--on-surface-variant);padding:32px' }, [textoMensagem])]);
    },
    linha: function (doc, id, l) {
      var a = aba(id);
      return no(doc, 'tr', { 'data-linha': String(l.itemId || l.loteId || '') }, a.colunas.map(function (c) {
        var selo = c.selo ? c.selo(l) : null;
        if (selo) return no(doc, 'td', {}, [no(doc, 'span', { class: 'badge', style: selo.estilo + ';font-size:11px' }, [selo.rotulo])]);
        var detalhe = c.detalhe ? c.detalhe(l) : '';
        var cor = c.cor ? c.cor(l) : null;
        var principal = c.forte ? no(doc, 'strong', {}, [c.valor(l)]) : (cor ? no(doc, 'span', { style: 'color:' + cor + ';font-weight:500' }, [c.valor(l)]) : c.valor(l));
        return no(doc, 'td', { style: c.nowrap ? 'white-space:nowrap' : null }, [principal, detalhe ? no(doc, 'div', { style: NOTA }, [detalhe]) : null]);
      }));
    },
    alerta: function (doc, a) {
      var m = modelo.alerta(a);
      return no(doc, 'div', { class: 'switch-row', 'data-alerta': a.tipo }, [
        no(doc, 'div', { class: 'switch-text' }, [no(doc, 'strong', {}, [m.titulo]), no(doc, 'span', {}, [m.detalhe])]),
        no(doc, 'span', { class: 'badge', style: m.estilo }, [m.rotulo]),
      ]);
    },
  };

  global.EpiRelatorios = {
    acoes: acoes, modelo: modelo, render: render, TEXTOS: TEXTOS, ABAS: ABAS, STATUS: STATUS, ALERTAS: ALERTAS, LIMITE: LIMITE, LIMITE_EXPORTACAO: LIMITE_EXPORTACAO,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.EpiRelatorios;
})(typeof window !== 'undefined' ? window : globalThis);
