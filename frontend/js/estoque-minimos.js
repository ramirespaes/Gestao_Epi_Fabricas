(function (global) {
  'use strict';

  /**
   * EpiEstoqueMinimos — mínimo de estoque por tamanho (12D-3), sobre
   * GET/PUT/DELETE /materiais/:id/minimos[/:tamanho].
   *
   *   acoes     — fala com a API e devolve o envelope do EpiHttp.
   *   validar   — mínimo e tamanho digitados na tela.
   *   painel    — o que a tela mostra: uma linha por tamanho conhecido.
   *   render    — HTML escapado da tabela e das opções do campo de tamanho.
   *   mensagens — textos próprios, sem repetir o que o servidor mandou.
   *
   * O mínimo PADRÃO é o do cadastro do material e vale para o tamanho sem
   * sobrescrita; a sobrescrita é por tamanho e só existe para material que exige
   * tamanho. O zero próprio é válido ("este tamanho não tem mínimo") e vale mais
   * que o padrão; remover a sobrescrita faz o tamanho voltar a herdar o padrão
   * (a linha some, nunca vira zero). Material de tamanho único ou ainda não
   * classificado não aceita sobrescrita: o painel só explica, e o servidor
   * continua sendo quem recusa (409). Nenhuma linha é criada para "todos os
   * tamanhos": só aparecem os que têm lote ou sobrescrita. Nada é guardado no
   * navegador.
   */

  var LIMITES = Object.freeze({ tamanho: 20, minimo: 2147483647 });
  var CONTROLE = /[\u0000-\u001f\u007f]/;
  var ORDEM_LETRAS = ['PP', 'P', 'M', 'G', 'GG', 'XG', 'XGG', 'EG', 'EGG'];

  function http() {
    if (!global.EpiHttp) throw new Error('EpiHttp não carregado: inclua js/api-http.js antes de js/estoque-minimos.js');
    return global.EpiHttp;
  }

  function idValido(v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v && v > 0; }
  function minimoValido(v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v && v >= 0 && v <= LIMITES.minimo; }
  function tamanhoValido(t) {
    return typeof t === 'string' && t.length > 0 && t === t.trim() && Array.from(t).length <= LIMITES.tamanho && !CONTROLE.test(t);
  }

  /** Recusa local: nada foi enviado. Tem a forma de um 400 para as mensagens tratarem igual. */
  function recusaLocal() {
    return Promise.resolve({ ok: false, status: 400, dados: null, codigo: 'ENTRADA_INVALIDA', mensagem: null, detalhes: null, local: true });
  }

  function caminho(materialId, tamanho) {
    var base = '/materiais/' + materialId + '/minimos';
    return tamanho === undefined ? base : base + '/' + encodeURIComponent(tamanho);
  }

  // ─── Ações ─────────────────────────────────────────────────────────
  var acoes = {
    consultar: function (materialId) {
      if (!idValido(materialId)) return recusaLocal();
      return http().requisitar('GET', caminho(materialId));
    },
    definir: function (materialId, tamanho, minimo) {
      if (!idValido(materialId) || !tamanhoValido(tamanho) || !minimoValido(minimo)) return recusaLocal();
      return http().requisitar('PUT', caminho(materialId, tamanho), { corpo: { minimo: minimo } });
    },
    remover: function (materialId, tamanho) {
      if (!idValido(materialId) || !tamanhoValido(tamanho)) return recusaLocal();
      return http().requisitar('DELETE', caminho(materialId, tamanho));
    },
  };

  // ─── Validação do que foi digitado ─────────────────────────────────
  var validar = {
    minimo: function (valor) {
      var t = valor === undefined || valor === null ? '' : String(valor).trim();
      if (!t) return { ok: false, mensagem: 'Informe o mínimo do tamanho (use 0 para nenhum).' };
      if (!/^\d+$/.test(t)) return { ok: false, mensagem: 'O mínimo deve ser um inteiro maior ou igual a zero.' };
      var n = Number(t);
      if (n > LIMITES.minimo) return { ok: false, mensagem: 'Mínimo acima do limite (' + LIMITES.minimo + ').' };
      return { ok: true, valor: n };
    },
    tamanho: function (valor) {
      var t = valor === undefined || valor === null ? '' : String(valor).trim();
      if (!t) return { ok: false, mensagem: 'Informe o tamanho.' };
      if (Array.from(t).length > LIMITES.tamanho) return { ok: false, mensagem: 'Tamanho com mais de ' + LIMITES.tamanho + ' caracteres.' };
      if (CONTROLE.test(t)) return { ok: false, mensagem: 'Tamanho com caractere inválido.' };
      return { ok: true, tamanho: t };
    },
  };

  // ─── Painel ────────────────────────────────────────────────────────
  // Números primeiro, depois as letras na ordem usual de tamanhos, depois o resto em ordem alfabética.
  function chaveDeOrdem(t) {
    if (/^\d+$/.test(t)) return [0, Number(t), t];
    var i = ORDEM_LETRAS.indexOf(t.toUpperCase());
    return i >= 0 ? [1, i, t] : [2, 0, t];
  }
  function compararTamanhos(a, b) {
    var x = chaveDeOrdem(a); var y = chaveDeOrdem(b);
    if (x[0] !== y[0]) return x[0] - y[0];
    if (x[1] !== y[1]) return x[1] - y[1];
    return x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0;
  }

  function painelSem(modo, padrao) { return { modo: modo, padrao: padrao === undefined ? null : padrao, linhas: [] }; }

  /**
   * `dados` é o estado devolvido pelo servidor; `tamanhosDosLotes`, os tamanhos dos lotes
   * do material na tela. A linha de cada tamanho leva o mínimo próprio (ou null), o efetivo
   * e a origem; o zero próprio é próprio, nunca "herdado".
   */
  function montar(dados, tamanhosDosLotes) {
    if (!dados || typeof dados !== 'object') return painelSem('INDISPONIVEL');
    var exige = dados.exigeTamanho;
    var padrao = dados.estoqueMinimoPadrao;
    var overrides = dados.overrides;
    if (!minimoValido(padrao) || (exige !== true && exige !== false && exige !== null)) return painelSem('INDISPONIVEL');
    if (exige === false) return painelSem('UNICO', padrao);
    if (exige === null) return painelSem('NAO_CLASSIFICADO', padrao);
    if (!Array.isArray(overrides)) return painelSem('INDISPONIVEL');

    var proprios = {};
    overrides.forEach(function (o) {
      if (o && tamanhoValido(o.tamanho) && minimoValido(o.minimo)) proprios[o.tamanho] = o.minimo;
    });
    var tamanhos = Object.keys(proprios);
    (Array.isArray(tamanhosDosLotes) ? tamanhosDosLotes : []).forEach(function (t) {
      if (tamanhoValido(t) && tamanhos.indexOf(t) < 0) tamanhos.push(t);
    });
    tamanhos.sort(compararTamanhos);
    return {
      modo: 'TAMANHOS',
      padrao: padrao,
      linhas: tamanhos.map(function (t) {
        var proprio = Object.prototype.hasOwnProperty.call(proprios, t) ? proprios[t] : null;
        return { tamanho: t, proprio: proprio, efetivo: proprio === null ? padrao : proprio, origem: proprio === null ? 'PADRAO' : 'PROPRIO' };
      }),
    };
  }

  // ─── Render ────────────────────────────────────────────────────────
  function escaparHtml(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function botao(acao, rotulo, tamanho, classe) {
    return '<button type="button" class="' + classe + '" style="padding:4px 10px;font-size:12px" aria-label="' + escaparHtml(rotulo + ' o mínimo do tamanho ' + tamanho) + '"'
      + ' data-acao="' + acao + '" data-tamanho="' + escaparHtml(tamanho) + '">' + rotulo + '</button>';
  }

  var render = {
    escaparHtml: escaparHtml,
    linhas: function (painel, opcoes) {
      if (!painel || painel.modo !== 'TAMANHOS') return '';
      var podeEditar = !!(opcoes && opcoes.podeEditar);
      return painel.linhas.map(function (l) {
        var proprio = l.proprio === null
          ? '<em style="color:var(--on-surface-variant)">herdando padrão</em>'
          : '<strong>' + escaparHtml(l.proprio) + '</strong> <small>próprio</small>';
        var acoesLinha = '';
        if (podeEditar) {
          acoesLinha = l.proprio === null
            ? botao('definir', 'Definir', l.tamanho, 'outlined-btn')
            : botao('alterar', 'Alterar', l.tamanho, 'outlined-btn') + ' ' + botao('remover', 'Remover', l.tamanho, 'outlined-btn');
        }
        return '<tr>'
          + '<td>' + escaparHtml(l.tamanho) + '</td>'
          + '<td style="text-align:right">' + proprio + '</td>'
          + '<td style="text-align:right"><strong>' + escaparHtml(l.efetivo) + '</strong></td>'
          + '<td>' + (l.origem === 'PROPRIO' ? 'Próprio' : 'Padrão') + '</td>'
          + '<td style="text-align:right;white-space:nowrap">' + acoesLinha + '</td>'
          + '</tr>';
      }).join('');
    },
    opcoesTamanhos: function (painel) {
      if (!painel || painel.modo !== 'TAMANHOS') return '';
      return painel.linhas.map(function (l) { return '<option value="' + escaparHtml(l.tamanho) + '"></option>'; }).join('');
    },
  };

  // ─── Mensagens ─────────────────────────────────────────────────────
  function ehRede(r) { return !r || r.status === 0 || typeof r.status !== 'number'; }
  function ehServidor(r) { return !!r && typeof r.status === 'number' && r.status >= 500; }

  var mensagens = {
    exigeNovoLogin: function (r) { return !!r && r.status === 401; },
    aviso: function (painel) {
      var p = painel || { modo: 'INDISPONIVEL' };
      if (p.modo === 'UNICO') return 'Este material não usa tamanho: o mínimo dele é o mínimo padrão (' + p.padrao + ').';
      if (p.modo === 'NAO_CLASSIFICADO') return 'Defina no cadastro se o material exige tamanho antes de configurar o mínimo por tamanho.';
      if (p.modo === 'TAMANHOS') {
        return p.linhas.length
          ? 'Tamanhos sem mínimo próprio usam o mínimo padrão (' + p.padrao + ').'
          : 'Nenhum tamanho listado ainda: aparecem aqui os tamanhos com lote ou com mínimo próprio. Os demais usam o mínimo padrão (' + p.padrao + ').';
      }
      return 'Não foi possível ler os mínimos deste material. Recarregue o painel.';
    },
    erroConsulta: function (r) {
      if (ehRede(r)) return 'Falha de rede ao consultar os mínimos. Verifique a conexão e tente novamente.';
      if (r.status === 401) return 'Sua sessão terminou. Entre novamente pelo Portal do Cliente.';
      if (r.status === 403) return 'Seu perfil não pode consultar os mínimos deste material.';
      if (r.status === 404) return 'Material não encontrado nesta empresa.';
      return 'Não foi possível consultar os mínimos deste material. Tente novamente.';
    },
    /** PUT e DELETE: rede e 5xx não dizem se gravou; o painel precisa ser recarregado para conferir. */
    erroGravacao: function (r) {
      if (ehRede(r) || ehServidor(r)) return 'Não foi possível confirmar se o mínimo foi salvo (falha de rede ou do servidor). Recarregue o painel para conferir antes de repetir.';
      if (r.status === 401) return 'Sua sessão terminou. Entre novamente pelo Portal do Cliente.';
      if (r.status === 403) return 'Seu perfil não pode editar materiais nesta empresa.';
      if (r.status === 404) return 'Material não encontrado nesta empresa.';
      if (r.codigo === 'MATERIAL_NAO_EXIGE_TAMANHO') return 'Este material não usa tamanho: o mínimo dele é o mínimo padrão do cadastro.';
      if (r.codigo === 'MATERIAL_TAMANHO_NAO_CLASSIFICADO') return 'Defina no cadastro se o material exige tamanho antes de configurar o mínimo por tamanho.';
      if (r.status === 400) return 'Mínimo ou tamanho recusados pelo servidor. Confira os valores.';
      if (r.status === 409) return 'A operação não pôde ser concluída no estado atual. Recarregue o painel e tente de novo.';
      return 'Não foi possível salvar o mínimo. Tente novamente.';
    },
    sucessoDefinir: function (dados, tamanho, minimo) {
      if (dados && dados.alterado === false) return 'O tamanho ' + tamanho + ' já tinha o mínimo ' + minimo + '; nada foi alterado.';
      if (dados && dados.criado === true) return 'Mínimo do tamanho ' + tamanho + ' definido: ' + minimo + '.';
      return 'Mínimo do tamanho ' + tamanho + ' alterado para ' + minimo + '.';
    },
    sucessoRemover: function (dados, tamanho) {
      var padrao = dados && dados.estoqueMinimoPadrao;
      if (dados && dados.alterado === false) return 'O tamanho ' + tamanho + ' já usava o mínimo padrão (' + padrao + '); nada foi alterado.';
      return 'Mínimo próprio do tamanho ' + tamanho + ' removido: o tamanho volta a usar o mínimo padrão (' + padrao + ').';
    },
  };

  global.EpiEstoqueMinimos = {
    LIMITES: LIMITES,
    acoes: acoes,
    validar: validar,
    painel: { montar: montar },
    render: render,
    mensagens: mensagens,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = global.EpiEstoqueMinimos;
})(typeof window !== 'undefined' ? window : globalThis);
