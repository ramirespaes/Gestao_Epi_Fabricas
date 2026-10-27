(function (global) {
  'use strict';

  /**
   * EpiDashboardGraficos — os dois gráficos do Dashboard (12I), sobre
   *   GET /dashboard/graficos/setores?periodo=        (funcionários ATIVOS cadastrados no período, por setor)
   *   GET /dashboard/graficos/epis-entregues?periodo= (unidades entregues por produto: top 5 do período, por dia ou por mês)
   * A rota exige dashboard.visualizar e o SERVIDOR decide cada gráfico pela permissão da fonte (permitido:false = "sem permissão").
   * Períodos (Mês | 6 meses | 1 ano), chaves do eixo, totais e top 5 vêm do servidor; aqui só se desenha: percentuais e proporções são
   * proporções visuais, nunca um número novo. DOM só por nós e texto. Nada é guardado no navegador.
   */

  function http() {
    if (!global.EpiHttp) throw new Error('EpiHttp não carregado: inclua js/api-http.js antes de js/dashboard-graficos.js');
    return global.EpiHttp;
  }

  var PERIODOS = [{ codigo: 'MES', rotulo: 'Mês' }, { codigo: 'SEIS_MESES', rotulo: '6 meses' }, { codigo: 'ANO', rotulo: '1 ano' }];
  var CODIGOS = PERIODOS.map(function (p) { return p.codigo; });
  var PADRAO = 'MES';
  var MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  // Paleta inicial suave, estendida para novos materiais sem repetir as cinco cores; a cor é fixa por produto (materialId) enquanto a página vive.
  var PALETA = ['#3982c4', '#318c72', '#8771c3', '#c8913b', '#c66c89'];

  function exigirPeriodo(periodo) {
    if (CODIGOS.indexOf(periodo) === -1) throw new TypeError('período do gráfico inválido');
    return periodo;
  }

  var acoes = {
    setores: function (periodo) { return http().requisitar('GET', '/dashboard/graficos/setores?periodo=' + exigirPeriodo(periodo)); },
    episEntregues: function (periodo) { return http().requisitar('GET', '/dashboard/graficos/epis-entregues?periodo=' + exigirPeriodo(periodo)); },
  };

  function inteiro(v, minimo) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v && v >= minimo; }
  function texto(v) { return typeof v === 'string' && v.length > 0; }
  function proporcao(parte, todo) { return todo > 0 ? Math.round((parte / todo) * 100) : 0; }
  function dois(n) { return String(n).length < 2 ? '0' + n : String(n); }
  function dataBr(iso) { return iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4); }
  function mesAbrev(chave) { return MESES[Number(chave.slice(5, 7)) - 1] || chave; }
  function plural(n, um, varios) { return n + ' ' + (n === 1 ? um : varios); }

  var coresPorMaterial = {};
  var proximaCor = 0;
  var cores = {
    PALETA: PALETA.slice(),
    de: function (materialId) {
      var chave = String(materialId);
      if (!Object.prototype.hasOwnProperty.call(coresPorMaterial, chave)) {
        coresPorMaterial[chave] = proximaCor < PALETA.length ? PALETA[proximaCor]
          : 'hsl(' + ((proximaCor * 137.508 + 200) % 360).toFixed(1) + ', 38%, 55%)';
        proximaCor += 1;
      }
      return coresPorMaterial[chave];
    },
  };

  function base(g) {
    if (!g || typeof g !== 'object') return { estado: 'invalido' };
    if (g.permitido === false) return { estado: 'negado' };
    if (g.permitido !== true || CODIGOS.indexOf(g.periodo) === -1 || !texto(g.de) || !texto(g.ate) || !inteiro(g.total, 0)) return { estado: 'invalido' };
    return null;
  }

  var modelo = {
    setores: function (g) {
      var erro = base(g);
      if (erro) return erro;
      if (!Array.isArray(g.setores)) return { estado: 'invalido' };
      var maior = 0;
      for (var i = 0; i < g.setores.length; i += 1) {
        var s = g.setores[i];
        if (!s || !texto(s.setor) || !inteiro(s.quantidade, 0)) return { estado: 'invalido' };
        if (s.quantidade > maior) maior = s.quantidade;
      }
      var barras = g.setores.map(function (s) {
        return { rotulo: s.setor, quantidade: s.quantidade, percentual: proporcao(s.quantidade, maior), texto: plural(s.quantidade, 'funcionário', 'funcionários') };
      });
      return { estado: barras.length === 0 ? 'vazio' : 'ok', periodo: g.periodo, de: g.de, ate: g.ate, total: g.total, barras: barras };
    },
    episEntregues: function (g) {
      var erro = base(g);
      if (erro) return erro;
      if ((g.agrupamento !== 'DIA' && g.agrupamento !== 'MES') || !Array.isArray(g.produtos) || !Array.isArray(g.series)) return { estado: 'invalido' };
      var produtos = [];
      for (var i = 0; i < g.produtos.length; i += 1) {
        var p = g.produtos[i];
        if (!p || !inteiro(p.materialId, 1) || !texto(p.nome) || !inteiro(p.total, 0)) return { estado: 'invalido' };
        produtos.push({ materialId: p.materialId, nome: p.nome, total: p.total, cor: cores.de(p.materialId) });
      }
      var colunas = [];
      var maximo = 0;
      for (var c = 0; c < g.series.length; c += 1) {
        var s = g.series[c];
        if (!s || !texto(s.chave) || !Array.isArray(s.quantidades) || s.quantidades.length !== produtos.length) return { estado: 'invalido' };
        var total = 0;
        for (var q = 0; q < s.quantidades.length; q += 1) {
          if (!inteiro(s.quantidades[q], 0)) return { estado: 'invalido' };
          total += s.quantidades[q];
        }
        if (total > maximo) maximo = total;
        colunas.push({ chave: s.chave, quantidades: s.quantidades, total: total });
      }
      var porDia = g.agrupamento === 'DIA';
      colunas = colunas.map(function (col) {
        var rotulo = porDia ? col.chave.slice(8, 10) : mesAbrev(col.chave) + '/' + col.chave.slice(2, 4);
        var longo = porDia ? dataBr(col.chave) : mesAbrev(col.chave) + '/' + col.chave.slice(0, 4);
        var segmentos = produtos.map(function (p, idx) {
          return { nome: p.nome, quantidade: col.quantidades[idx], cor: p.cor, altura: proporcao(col.quantidades[idx], maximo) };
        });
        var partes = segmentos.map(function (sg) { return sg.nome + ' ' + sg.quantidade; });
        return { chave: col.chave, rotulo: rotulo, total: col.total, segmentos: segmentos, leitura: [longo].concat(partes, ['total ' + col.total]).join(' · ') };
      });
      return { estado: produtos.length === 0 && g.total === 0 ? 'vazio' : 'ok', periodo: g.periodo, de: g.de, ate: g.ate, agrupamento: g.agrupamento, total: g.total, produtos: produtos, colunas: colunas, maximo: maximo };
    },
  };

  var mensagens = {
    CARREGANDO: 'Carregando…',
    SEM_PERMISSAO: 'Sem permissão para ver este gráfico.',
    INDISPONIVEL: 'Dados indisponíveis.',
    VAZIO_SETORES: 'Nenhum funcionário ativo cadastrado no período.',
    VAZIO_ENTREGAS: 'Nenhuma entrega registrada no período.',
    DICA_LEITURA: 'Passe o mouse ou use Tab sobre as colunas para ver os valores.',
    erro: function (r) {
      if (!r || !r.status) return 'Falha de rede: não foi possível carregar o gráfico.';
      if (r.status === 403) return 'Seu perfil não pode consultar o dashboard nesta empresa.';
      return 'Não foi possível carregar o gráfico. Tente novamente.';
    },
    resumoSetores: function (m) { return plural(m.total, 'funcionário ativo cadastrado', 'funcionários ativos cadastrados') + ' de ' + dataBr(m.de) + ' a ' + dataBr(m.ate); },
    resumoEntregas: function (m) { return plural(m.total, 'unidade entregue', 'unidades entregues') + ' de ' + dataBr(m.de) + ' a ' + dataBr(m.ate) + (m.produtos.length > 0 ? ' · ' + plural(m.produtos.length, 'produto', 'produtos') + ' com mais saída' : ''); },
  };

  function limpar(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  function no(doc, tag, classe, conteudo) {
    var el = doc.createElement(tag);
    if (classe) el.className = classe;
    if (conteudo !== undefined) el.textContent = conteudo;
    return el;
  }

  // SVG nativo no navegador; o documento injetado nos testes pode oferecer só createElement.
  function svgNo(doc, tag, classe) {
    var el = typeof doc.createElementNS === 'function'
      ? doc.createElementNS('http:' + '//www.w3.org/2000/svg', tag) : doc.createElement(tag);
    if (classe) el.setAttribute('class', classe);
    return el;
  }
  function circuloRosca(el) {
    el.setAttribute('cx', '120');
    el.setAttribute('cy', '120');
    el.setAttribute('r', '104');
    el.setAttribute('fill', 'none');
    el.setAttribute('stroke-width', '26');
  }
  // Legenda dos setores: de início só os 10 com mais funcionários; o restante continua no DOM (oculto) e na rosca.
  var LIMITE_LEGENDA = 10;
  var CORES_SETORES = ['#5599c9', '#55a78e', '#9280bf', '#63b7ba', '#c393b3', '#bca56c', '#7790c4', '#8eae83'];
  var coresPorSetor = Object.create(null);
  var proximoSetor = 0;
  function corSetor(nome) {
    if (!Object.prototype.hasOwnProperty.call(coresPorSetor, nome)) {
      var indice = proximoSetor++;
      coresPorSetor[nome] = indice < CORES_SETORES.length ? CORES_SETORES[indice]
        : 'hsl(' + ((indice * 137.508 + 200) % 360).toFixed(1) + ', 38%, 55%)';
    }
    return coresPorSetor[nome];
  }

  var renderizar = {
    estado: function (doc, container, mensagem) {
      limpar(container);
      container.appendChild(no(doc, 'p', 'gr-estado', mensagem));
    },
    setores: function (doc, container, m) {
      limpar(container);
      // Proporções exclusivamente visuais; o centro conserva o total recebido do servidor.
      var soma = m.barras.reduce(function (total, setor) { return total + setor.quantidade; }, 0);
      if (soma !== m.total) { renderizar.estado(doc, container, mensagens.INDISPONIVEL); return; }
      if (m.total === 0) { renderizar.estado(doc, container, mensagens.VAZIO_SETORES); return; }

      var composicao = no(doc, 'div', 'gr-rosca-composicao');
      var desenho = no(doc, 'div', 'gr-rosca-desenho');
      var svg = svgNo(doc, 'svg', 'gr-rosca-svg');
      svg.setAttribute('viewBox', '0 0 240 240');
      svg.setAttribute('role', 'group');
      svg.setAttribute('aria-label', 'Distribuição por setor: ' + plural(m.total, 'funcionário ativo', 'funcionários ativos'));
      var pista = svgNo(doc, 'circle', 'gr-rosca-pista');
      circuloRosca(pista);
      svg.appendChild(pista);

      var centro = no(doc, 'div', 'gr-rosca-centro');
      var numero = m.total.toLocaleString('pt-BR');
      centro.appendChild(no(doc, 'strong', 'gr-rosca-total' + (numero.length > 6 ? ' gr-rosca-total-longo' : ''), numero));
      centro.appendChild(no(doc, 'span', 'gr-rosca-descricao', 'Funcionários ativos'));

      var legenda = no(doc, 'ul', 'gr-rosca-legenda');
      legenda.setAttribute('aria-label', 'Setores, quantidades de funcionários e participação no total');
      var pares = [];
      var expandida = false;
      var alternar = null;
      function mostrarLegenda() {
        pares.forEach(function (p) { p.item.hidden = !expandida && p.posicao >= LIMITE_LEGENDA; });
        legenda.classList.toggle('is-expandida', expandida);
        if (alternar) {
          alternar.setAttribute('aria-expanded', expandida ? 'true' : 'false');
          alternar.textContent = expandida ? 'Mostrar menos' : 'Ver todos os setores (' + pares.length + ')';
        }
      }
      function destacar(indice) {
        composicao.classList.toggle('gr-rosca-em-destaque', indice >= 0);
        pares.forEach(function (p, i) {
          p.botao.classList.toggle('is-ativo', i === indice);
          if (p.segmento) p.segmento.classList.toggle('is-ativo', i === indice);
        });
      }
      function restaurar() {
        var indice = -1;
        pares.forEach(function (p, i) { if (doc.activeElement === p.botao || doc.activeElement === p.segmento) indice = i; });
        destacar(indice);
      }
      var deslocamento = 0;
      m.barras.forEach(function (b, indice) {
        var fracao = b.quantidade / m.total;
        var percentual = (fracao * 100).toLocaleString('pt-BR', { maximumSignificantDigits: 3 }) + '%';
        var cor = corSetor(b.rotulo);
        var leitura = b.rotulo + ': ' + b.texto + ', ' + percentual + ' do total';
        var segmento = null;
        if (b.quantidade > 0) {
          segmento = svgNo(doc, 'circle', 'gr-rosca-segmento');
          circuloRosca(segmento);
          segmento.setAttribute('pathLength', '100');
          segmento.setAttribute('stroke', cor);
          segmento.setAttribute('stroke-dasharray', String(fracao * 100) + ' ' + String(100 - fracao * 100));
          segmento.setAttribute('stroke-dashoffset', String(-deslocamento));
          segmento.setAttribute('transform', 'rotate(-90 120 120)');
          segmento.setAttribute('tabindex', '0');
          segmento.setAttribute('role', 'img');
          segmento.setAttribute('aria-label', leitura);
          svg.appendChild(segmento);
          segmento.addEventListener('mouseenter', function () { destacar(indice); });
          segmento.addEventListener('mouseleave', restaurar);
          segmento.addEventListener('focus', function () { destacar(indice); });
          segmento.addEventListener('blur', restaurar);
        }
        deslocamento += fracao * 100;

        var item = no(doc, 'li', 'gr-rosca-item');
        item.setAttribute('data-setor', b.rotulo);
        var botao = no(doc, 'button', 'gr-rosca-setor');
        botao.setAttribute('type', 'button');
        botao.setAttribute('aria-label', leitura + '. Destacar no gráfico.');
        botao.setAttribute('title', leitura);
        var amostra = no(doc, 'span', 'gr-rosca-cor');
        amostra.style.background = cor;
        amostra.setAttribute('aria-hidden', 'true');
        botao.appendChild(amostra);
        botao.appendChild(no(doc, 'span', 'gr-rosca-nome', b.rotulo));
        var valores = no(doc, 'span', 'gr-rosca-valores');
        valores.appendChild(no(doc, 'strong', 'gr-rosca-quantidade', b.quantidade.toLocaleString('pt-BR')));
        valores.appendChild(no(doc, 'span', 'gr-rosca-percentual', percentual));
        botao.appendChild(valores);
        item.appendChild(botao);
        pares.push({ botao: botao, segmento: segmento, item: item, quantidade: b.quantidade, indice: indice, posicao: 0 });
        botao.addEventListener('mouseenter', function () { destacar(indice); });
        botao.addEventListener('mouseleave', restaurar);
        botao.addEventListener('focus', function () { destacar(indice); });
        botao.addEventListener('blur', restaurar);
        botao.addEventListener('click', function () { destacar(indice); });
      });
      // Legenda em ordem decrescente de funcionários (empate: ordem do servidor); a rosca mantém a ordem do servidor.
      pares.slice().sort(function (a, b) { return b.quantidade - a.quantidade || a.indice - b.indice; })
        .forEach(function (p, posicao) { p.posicao = posicao; legenda.appendChild(p.item); });
      if (pares.length > LIMITE_LEGENDA) {
        alternar = no(doc, 'button', 'gr-rosca-alternar');
        alternar.setAttribute('type', 'button');
        alternar.setAttribute('aria-controls', 'legendaSetores');
        legenda.setAttribute('id', 'legendaSetores');
        alternar.addEventListener('click', function () { expandida = !expandida; mostrarLegenda(); });
      }
      mostrarLegenda();
      // Reflexo decorativo sobre os arcos, sem reduzir nenhuma participação.
      var defs = svgNo(doc, 'defs');
      var gradiente = svgNo(doc, 'linearGradient');
      gradiente.setAttribute('id', 'gr-setores-reflexo');
      gradiente.setAttribute('x1', '0');
      gradiente.setAttribute('y1', '0');
      gradiente.setAttribute('x2', '0');
      gradiente.setAttribute('y2', '1');
      [['0%', '0.22'], ['48%', '0'], ['100%', '0.035']].forEach(function (valor) {
        var stop = svgNo(doc, 'stop');
        stop.setAttribute('offset', valor[0]);
        stop.setAttribute('stop-color', '#ffffff');
        stop.setAttribute('stop-opacity', valor[1]);
        gradiente.appendChild(stop);
      });
      defs.appendChild(gradiente);
      svg.appendChild(defs);
      var reflexo = svgNo(doc, 'circle', 'gr-rosca-reflexo');
      circuloRosca(reflexo);
      reflexo.setAttribute('stroke', 'url(#gr-setores-reflexo)');
      reflexo.setAttribute('aria-hidden', 'true');
      svg.appendChild(reflexo);
      desenho.appendChild(svg);
      desenho.appendChild(centro);
      composicao.appendChild(desenho);
      var lado = no(doc, 'div', 'gr-rosca-lado');
      lado.appendChild(legenda);
      if (alternar) lado.appendChild(alternar);
      composicao.appendChild(lado);
      container.appendChild(composicao);
    },
    episEntregues: function (doc, el, m) {
      limpar(el.grafico);
      // O total oficial e o ranking vêm da API. A diferença é apenas uma categoria visual.
      var soma = 0, ids = Object.create(null), nomes = Object.create(null);
      var valido = Number.isSafeInteger(m.total) && m.total >= 0;
      m.produtos.forEach(function (p) {
        if (!Number.isSafeInteger(p.total) || p.total < 0 || ids[p.materialId]) valido = false;
        ids[p.materialId] = true;
        nomes[p.nome] = (nomes[p.nome] || 0) + 1;
        soma += p.total;
      });
      if (!valido || !Number.isSafeInteger(soma) || soma > m.total) {
        renderizar.estado(doc, el.grafico, mensagens.INDISPONIVEL); return;
      }
      if (m.total === 0) { renderizar.estado(doc, el.grafico, mensagens.VAZIO_ENTREGAS); return; }
      var itens = m.produtos.map(function (p) {
        return { materialId: p.materialId, rotulo: p.nome, quantidade: p.total, cor: p.cor,
          texto: plural(p.total, 'unidade entregue', 'unidades entregues'),
          leitura: p.nome + ' (material ' + p.materialId + ')',
          nota: nomes[p.nome] > 1 ? 'Material ' + p.materialId : '' };
      });
      if (soma < m.total) itens.push({ rotulo: 'Outros', quantidade: m.total - soma, cor: '#8e99a9',
        texto: plural(m.total - soma, 'unidade entregue', 'unidades entregues'),
        leitura: 'Outros (fora do top 5)', nota: 'Fora do top 5' });
      var composicao = no(doc, 'div', 'gr-rosca-composicao');
      var desenho = no(doc, 'div', 'gr-rosca-desenho');
      var svg = svgNo(doc, 'svg', 'gr-rosca-svg');
      svg.setAttribute('viewBox', '0 0 240 240');
      svg.setAttribute('role', 'group');
      svg.setAttribute('aria-label', 'Unidades entregues por produto: ' + plural(m.total, 'unidade entregue', 'unidades entregues'));
      var pista = svgNo(doc, 'circle', 'gr-rosca-pista');
      circuloRosca(pista);
      svg.appendChild(pista);

      var centro = no(doc, 'div', 'gr-rosca-centro');
      var numero = m.total.toLocaleString('pt-BR');
      centro.appendChild(no(doc, 'strong', 'gr-rosca-total' + (numero.length > 6 ? ' gr-rosca-total-longo' : ''), numero));
      centro.appendChild(no(doc, 'span', 'gr-rosca-descricao', 'Unidades entregues'));

      var legenda = no(doc, 'ul', 'gr-rosca-legenda');
      legenda.setAttribute('id', 'legendaEntregas');
      legenda.setAttribute('aria-label', 'Produtos por material, unidades entregues e participação no total; Outros reúne os materiais fora do top 5');
      var pares = [];
      function destacar(indice) {
        composicao.classList.toggle('gr-rosca-em-destaque', indice >= 0);
        pares.forEach(function (p, i) {
          p.botao.classList.toggle('is-ativo', i === indice);
          if (p.segmento) p.segmento.classList.toggle('is-ativo', i === indice);
        });
      }
      function restaurar() {
        var indice = -1;
        pares.forEach(function (p, i) { if (doc.activeElement === p.botao || doc.activeElement === p.segmento) indice = i; });
        destacar(indice);
      }
      var deslocamento = 0;
      itens.forEach(function (b, indice) {
        var fracao = b.quantidade / m.total;
        var percentual = (fracao * 100).toLocaleString('pt-BR', { maximumSignificantDigits: 3 }) + '%';
        var cor = b.cor;
        var leitura = b.leitura + ': ' + b.texto + ', ' + percentual + ' do total';
        var segmento = null;
        if (b.quantidade > 0) {
          segmento = svgNo(doc, 'circle', 'gr-rosca-segmento');
          circuloRosca(segmento);
          segmento.setAttribute('pathLength', '100');
          segmento.setAttribute('stroke', cor);
          segmento.setAttribute('stroke-dasharray', String(fracao * 100) + ' ' + String(100 - fracao * 100));
          segmento.setAttribute('stroke-dashoffset', String(-deslocamento));
          segmento.setAttribute('transform', 'rotate(-90 120 120)');
          segmento.setAttribute('tabindex', '0');
          segmento.setAttribute('role', 'img');
          if (b.materialId) segmento.setAttribute('data-material-id', String(b.materialId));
          else segmento.setAttribute('data-outros', 'true');
          segmento.setAttribute('aria-label', leitura);
          var dica = svgNo(doc, 'title');
          dica.textContent = leitura;
          segmento.appendChild(dica);
          svg.appendChild(segmento);
          segmento.addEventListener('mouseenter', function () { destacar(indice); });
          segmento.addEventListener('mouseleave', restaurar);
          segmento.addEventListener('focus', function () { destacar(indice); });
          segmento.addEventListener('blur', restaurar);
        }
        deslocamento += fracao * 100;

        var item = no(doc, 'li', 'gr-rosca-item');
        if (b.materialId) item.setAttribute('data-material-id', String(b.materialId));
        else item.setAttribute('data-outros', 'true');
        var botao = no(doc, 'button', 'gr-rosca-setor');
        botao.setAttribute('type', 'button');
        botao.setAttribute('aria-label', leitura + '. Destacar no gráfico.');
        botao.setAttribute('title', leitura);
        var amostra = no(doc, 'span', 'gr-rosca-cor');
        amostra.style.background = cor;
        amostra.setAttribute('aria-hidden', 'true');
        botao.appendChild(amostra);
        var nome = no(doc, 'span', 'gr-rosca-nome', b.rotulo);
        if (b.nota) nome.appendChild(no(doc, 'small', 'gr-rosca-nota', b.nota));
        botao.appendChild(nome);
        var valores = no(doc, 'span', 'gr-rosca-valores');
        valores.appendChild(no(doc, 'strong', 'gr-rosca-quantidade', b.quantidade.toLocaleString('pt-BR')));
        valores.appendChild(no(doc, 'span', 'gr-rosca-percentual', percentual));
        botao.appendChild(valores);
        item.appendChild(botao);
        legenda.appendChild(item);
        pares.push({ botao: botao, segmento: segmento });
        botao.addEventListener('mouseenter', function () { destacar(indice); });
        botao.addEventListener('mouseleave', restaurar);
        botao.addEventListener('focus', function () { destacar(indice); });
        botao.addEventListener('blur', restaurar);
        botao.addEventListener('click', function () { destacar(indice); });
      });
      // Reflexo decorativo sobre os arcos, sem reduzir nenhuma participação.
      var defs = svgNo(doc, 'defs');
      var gradiente = svgNo(doc, 'linearGradient');
      gradiente.setAttribute('id', 'gr-entregas-reflexo');
      gradiente.setAttribute('x1', '0');
      gradiente.setAttribute('y1', '0');
      gradiente.setAttribute('x2', '0');
      gradiente.setAttribute('y2', '1');
      [['0%', '0.22'], ['48%', '0'], ['100%', '0.035']].forEach(function (valor) {
        var stop = svgNo(doc, 'stop');
        stop.setAttribute('offset', valor[0]);
        stop.setAttribute('stop-color', '#ffffff');
        stop.setAttribute('stop-opacity', valor[1]);
        gradiente.appendChild(stop);
      });
      defs.appendChild(gradiente);
      svg.appendChild(defs);
      var reflexo = svgNo(doc, 'circle', 'gr-rosca-reflexo');
      circuloRosca(reflexo);
      reflexo.setAttribute('stroke', 'url(#gr-entregas-reflexo)');
      reflexo.setAttribute('aria-hidden', 'true');
      svg.appendChild(reflexo);
      desenho.appendChild(svg);
      desenho.appendChild(centro);
      composicao.appendChild(desenho);
      var colunaLegenda = no(doc, 'div', 'gr-rosca-legenda-coluna');
      colunaLegenda.appendChild(legenda);
      var nota = no(doc, 'p', 'gr-rosca-arredondamento', 'Percentuais arredondados.');
      nota.setAttribute('id', 'notaPercentuaisEntregas');
      svg.setAttribute('aria-describedby', 'notaPercentuaisEntregas');
      colunaLegenda.appendChild(nota);
      composicao.appendChild(colunaLegenda);
      el.grafico.appendChild(composicao);
    },
  };

  /**
   * Um painel = um seletor de período + um gráfico. Cada troca de período consulta SÓ este gráfico; a resposta de uma seleção anterior
   * que chegue depois é descartada (contador). 401 encerra a sessão pela página; qualquer outra falha fica no painel, sem gráfico inventado.
   */
  function painel(doc, o) {
    var atual = 0;
    var encerrado = false;
    function resumo(textoResumo) { if (o.resumo) o.resumo.textContent = textoResumo || ''; }
    function estado(mensagem) {
      renderizar.estado(doc, o.container, mensagem);
      if (o.legenda) limpar(o.legenda);
      if (o.leitura) o.leitura.textContent = '';
    }
    async function carregar() {
      if (encerrado) return;
      atual += 1;
      var minha = atual;
      if (CODIGOS.indexOf(o.select.value) === -1) o.select.value = PADRAO;
      var periodo = o.select.value;
      o.select.disabled = false;
      estado(mensagens.CARREGANDO);
      var r;
      try { r = await o.consultar(periodo); } catch (falha) { r = { ok: false, status: 0 }; }
      if (encerrado || minha !== atual) return;
      if (!r.ok) {
        if (r.status === 401) { estado(''); o.aoNaoAutenticado(); return; }
        estado(mensagens.erro(r));
        resumo('');
        return;
      }
      var m = o.modelo(r.dados && r.dados.grafico);
      if (m.estado === 'negado') { estado(mensagens.SEM_PERMISSAO); o.select.disabled = true; resumo(''); return; }
      if (m.estado === 'invalido') { estado(mensagens.INDISPONIVEL); resumo(''); return; }
      resumo(o.resumir(m));
      if (m.estado === 'vazio') { estado(o.vazio); return; }
      o.desenhar(m);
    }
    o.select.addEventListener('change', function () { carregar(); });
    return {
      carregar: carregar,
      encerrar: function () { encerrado = true; atual += 1; estado(''); resumo(''); o.select.disabled = false; },
    };
  }

  global.EpiDashboardGraficos = { PERIODOS: PERIODOS, PADRAO: PADRAO, acoes: acoes, modelo: modelo, cores: cores, mensagens: mensagens, renderizar: renderizar, painel: painel };

  if (typeof module !== 'undefined' && module.exports) module.exports = global.EpiDashboardGraficos;
})(typeof window !== 'undefined' ? window : globalThis);
