(function (global) {
  'use strict';

  /**
   * EpiEntregasSolicitacao — a tela Entregas por solicitação (Bloco 12, 12G-4),
   * só sobre os contratos da 12F e da 12G-0 (EpiSolicitacoesEpi) e do contexto
   * da entrega do Bloco 10 (EpiFicha):
   *   - a lista é a do servidor: os entregáveis para quem entrega
   *     (REALIZAR_ENTREGA) ou as encerráveis para quem só encerra
   *     (ENCERRAR_SOLICITACAO); a tela não decide solicitação;
   *   - o detalhe mostra o aprovado, o entregue e o pendente de cada item e o
   *     que a fila de cobertura do servidor dá ao item agora (nunca recalculado);
   *   - a entrega usa os lotes do contexto da entrega, só do tamanho do item e
   *     com CA aceito, na ordem do servidor (validade do CA), com a sugestão
   *     FIFO até o disponível agora; exige a confirmação do trabalhador (a
   *     mesma declaração da Ficha) e é idempotente: a mesma chave enquanto o
   *     corpo não muda, e a tentativa sem resposta trava a entrega até ser
   *     resolvida;
   *   - o encerramento pede a justificativa e não desfaz nenhuma entrega.
   *
   * Tudo é montado com createElement e textContent; nada vai para armazenamento
   * do navegador. O servidor revalida tudo.
   */

  var LIMITE_LISTA = 20;
  var JUSTIFICATIVA_MAXIMA = 500;
  var STATUS_ATIVOS = ['APROVADA', 'APROVADA_PARCIAL'];
  var CONTROLE = /\p{Cc}/u;

  function S() { return global.EpiSolicitacoesEpi; }
  function E() { return global.EpiEstadoPagina; }
  function F() { return global.EpiFicha; }

  var ROTULO_SITUACAO = {
    PRONTA_PARA_ENTREGA: 'Disponível para entrega',
    PARCIALMENTE_COBERTA: 'Disponível em parte',
    AGUARDANDO_ESTOQUE: 'Aguardando estoque',
    PARCIALMENTE_ENTREGUE: 'Parcialmente entregue',
    ENTREGUE: 'Entregue',
    SUSPENSA: 'Suspensa',
  };

  // Os códigos desta tela com o seu texto; o resto vem de EpiSolicitacoesEpi.mensagens.
  var TEXTOS = {
    SOLICITACAO_NAO_ENCONTRADA: 'Solicitação não encontrada. A lista foi atualizada.',
    SOLICITACAO_NAO_ENTREGAVEL: 'Esta solicitação não pode mais receber entrega (foi encerrada, ou o trabalhador ou um EPI foi inativado). Os dados foram atualizados.',
    SOLICITACAO_NAO_ENCERRAVEL: 'Esta solicitação não pode ser encerrada na situação atual. Os dados foram atualizados.',
    QUANTIDADE_ACIMA_DA_COBERTURA: 'O estoque disponível para este pedido mudou (outra entrega ou baixa chegou antes). Os dados e os lotes foram recarregados: revise as quantidades e colete de novo a confirmação.',
    QUANTIDADE_ACIMA_DO_PENDENTE: 'A quantidade pendente mudou (outra entrega deste pedido chegou antes). Os dados e os lotes foram recarregados: revise as quantidades e colete de novo a confirmação.',
    SALDO_INSUFICIENTE: 'O saldo do lote mudou e não cobre a quantidade. Os dados e os lotes foram recarregados: revise as quantidades e colete de novo a confirmação.',
    LOTE_NAO_ENCONTRADO: 'Um dos lotes não está mais disponível. Os dados e os lotes foram recarregados.',
    LOTE_DIVERGENTE_DO_ITEM: 'Um dos lotes não é do EPI e do tamanho do item. Os dados e os lotes foram recarregados.',
    CA_VENCIDO: 'O CA de um dos lotes venceu. Os dados e os lotes foram recarregados: escolha outro lote.',
    CA_AUSENTE: 'Um dos lotes não tem CA e o EPI exige CA. Os dados e os lotes foram recarregados.',
    ITEM_SOLICITACAO_NAO_ENCONTRADO: 'Um dos itens não pertence mais ao pedido. Os dados e os lotes foram recarregados.',
    ITEM_NAO_APROVADO: 'Um dos itens não foi aprovado pela Segurança do Trabalho e não pode ser entregue.',
    IDEMPOTENCIA_CONFLITO: 'Esta tentativa já foi usada com outro conteúdo. Revise os dados e registre como uma nova entrega.',
    FUNCIONARIO_INATIVO: 'O trabalhador está inativo e não pode receber EPI.',
    PERMISSAO_NEGADA_ENTREGA: 'Você não tem a autorização "Realizar entrega" para esta operação.',
    PERMISSAO_NEGADA_ENCERRAMENTO: 'Você não tem a autorização "Encerrar solicitação" para esta operação.',
    MATERIAL_PRAZO_NAO_CLASSIFICADO: 'Cadastro incompleto: defina o prazo de uso do EPI antes de entregá-lo.',
    MATERIAL_TAMANHO_NAO_CLASSIFICADO: 'Cadastro incompleto: defina no cadastro se o EPI exige tamanho antes de entregá-lo.',
    MATERIAL_OCULOS_NAO_CLASSIFICADO: 'Cadastro incompleto: defina se os óculos são com ou sem grau antes de entregá-los.',
    JUSTIFICATIVA_OBRIGATORIA: 'Informe a justificativa do encerramento.',
    JUSTIFICATIVA_INVALIDA: 'Justificativa inválida: até 500 caracteres, sem caracteres de controle.',
    QUANTIDADE_INVALIDA: 'Informe uma quantidade inteira a partir de 0.',
    INCERTA: 'Não foi possível confirmar se a entrega foi registrada. Use "Tentar novamente": o mesmo envio não duplica a entrega. Nada pode ser alterado até a tentativa ser resolvida.',
    ENCERRAMENTO_INCERTO: 'Não foi possível confirmar se o encerramento foi registrado. O pedido foi relido do servidor: confira a situação antes de tentar de novo.',
  };
  // Códigos da entrega que mudam o estado: o detalhe e os lotes são relidos.
  var RELER_ENTREGA = ['QUANTIDADE_ACIMA_DA_COBERTURA', 'QUANTIDADE_ACIMA_DO_PENDENTE', 'SALDO_INSUFICIENTE', 'LOTE_NAO_ENCONTRADO', 'LOTE_DIVERGENTE_DO_ITEM', 'CA_VENCIDO', 'CA_AUSENTE', 'ITEM_SOLICITACAO_NAO_ENCONTRADO'];

  function textoDoCodigo(codigo) {
    return typeof codigo === 'string' && Object.prototype.hasOwnProperty.call(TEXTOS, codigo) ? TEXTOS[codigo] : null;
  }

  function textoDoErro(r, permissao) {
    if (r.status === 403 && (!r.codigo || r.codigo === 'PERMISSAO_NEGADA')) return TEXTOS[permissao];
    if (r.status > 0 && r.status < 500 && textoDoCodigo(r.codigo)) return textoDoCodigo(r.codigo);
    return S().mensagens.deErro(r);
  }

  // ───────────────────────────────────────────────────────────────────
  // Rascunho da entrega (sem DOM): leitura do que o servidor mediu e as regras do ato
  // ───────────────────────────────────────────────────────────────────

  function pendente(item) {
    return item.decisao === 'APROVADO' && Number.isInteger(item.quantidadePendente) && item.quantidadePendente > 0 ? item.quantidadePendente : 0;
  }

  /** O que pode ser entregue agora: o pendente, limitado ao que a fila de cobertura do servidor dá ao item. */
  function disponivelAgora(item) {
    if (item.decisao !== 'APROVADO' || !item.cobertura || !Number.isInteger(item.cobertura.coberta)) return 0;
    return Math.max(0, Math.min(pendente(item), item.cobertura.coberta));
  }

  /** Lotes que servem ao item: o mesmo tamanho, com saldo e CA aceito, na ordem recebida do servidor. */
  function lotesDoItem(item, lotes) {
    var situacoes = F().SITUACOES_CA;
    var tamanho = item.tamanho === undefined ? null : item.tamanho;
    return (lotes || []).filter(function (l) {
      var s = situacoes[l.situacaoCa];
      return (l.tamanho === undefined ? null : l.tamanho) === tamanho && Number.isInteger(l.saldo) && l.saldo > 0 && !!s && s.permitido === true;
    });
  }

  /** Sugestão FIFO: o lote que vence primeiro até o saldo, depois o próximo, até o disponível agora. */
  function sugestaoFifo(item, lotes) {
    var falta = disponivelAgora(item);
    var sugestao = {};
    lotes.forEach(function (l) {
      var q = Math.min(falta, l.saldo);
      sugestao[l.loteId] = String(q);
      falta -= q;
    });
    return sugestao;
  }

  function quantidadeDe(texto) {
    var q = String(texto === undefined || texto === null ? '' : texto).trim();
    if (q === '') return 0;
    return /^\d+$/.test(q) ? Number(q) : NaN;
  }

  /**
   * Valida a entrega (quantidade por item e lote) e monta os itens do corpo, na
   * ordem dos itens e dos lotes. Erros: [{itemId, loteId, campo, mensagem}].
   */
  function validar(itens, alocacoes, lotesPorItem) {
    var erros = [];
    var saida = [];
    itens.forEach(function (item) {
      var lotes = lotesPorItem[item.id];
      if (!lotes) return;
      var total = 0;
      lotes.forEach(function (l) {
        var q = quantidadeDe((alocacoes[item.id] || {})[l.loteId]);
        if (!(q >= 0)) { erros.push({ itemId: item.id, loteId: l.loteId, campo: 'quantidade', mensagem: TEXTOS.QUANTIDADE_INVALIDA }); return; }
        if (q > l.saldo) { erros.push({ itemId: item.id, loteId: l.loteId, campo: 'quantidade', mensagem: 'Este lote tem só ' + l.saldo + '.' }); return; }
        total += q;
        if (q > 0) saida.push({ solicitacaoItemId: item.id, loteId: l.loteId, quantidade: q });
      });
      // O disponível agora já é o pendente limitado à cobertura: um teto só.
      if (total > disponivelAgora(item)) erros.push({ itemId: item.id, loteId: null, campo: 'item', mensagem: 'O disponível agora para este item é ' + disponivelAgora(item) + '; o restante aguarda estoque.' });
    });
    if (erros.length === 0 && saida.length === 0) erros.push({ itemId: null, loteId: null, campo: 'geral', mensagem: 'Informe a quantidade a entregar em pelo menos um lote.' });
    return erros.length > 0 ? { ok: false, erros: erros } : { ok: true, itens: saida };
  }

  /** O corpo do POST sem a chave: a mesma declaração da Ficha; null sem confirmação válida. */
  function corpo(itensDaEntrega, confirmacao) {
    if (!confirmacao || (confirmacao.modo !== 'DESENHO' && confirmacao.modo !== 'ACEITE_PRESENCIAL')) return null;
    var conf = { modo: confirmacao.modo };
    if (confirmacao.modo === 'DESENHO') {
      if (!Array.isArray(confirmacao.tracos) || confirmacao.tracos.length === 0) return null;
      conf.tracos = confirmacao.tracos;
    }
    conf.declaracaoVersao = F().DECLARACAO.versao;
    conf.declaracaoTexto = F().DECLARACAO.texto;
    return { itens: itensDaEntrega, confirmacao: conf };
  }

  /** A justificativa do encerramento como o servidor a aceita (1 a 500, sem só espaços nem controle). */
  function justificativaDoEncerramento(valor) {
    var t = typeof valor === 'string' ? valor.trim().normalize('NFC') : '';
    if (t === '') return { ok: false, mensagem: TEXTOS.JUSTIFICATIVA_OBRIGATORIA };
    if (Array.from(t).length > JUSTIFICATIVA_MAXIMA || CONTROLE.test(t)) return { ok: false, mensagem: TEXTOS.JUSTIFICATIVA_INVALIDA };
    return { ok: true, valor: t };
  }

  // ───────────────────────────────────────────────────────────────────
  // Tela
  // ───────────────────────────────────────────────────────────────────

  var CORES_AVISO = {
    erro: 'background:var(--error-container);color:var(--error);border-color:rgba(255,59,48,0.2)',
    sucesso: 'background:rgba(52,199,89,0.10);color:#1A7A35;border-color:rgba(52,199,89,0.25)',
    atencao: 'background:var(--warning-container);color:var(--on-surface);border-color:rgba(255,149,0,0.25)',
  };

  function plural(n, um, varios) { return n + ' ' + (n === 1 ? um : varios); }
  function comUnidade(n, unidade) { return n + (unidade ? ' ' + unidade : ''); }
  function dataBr(iso) {
    if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
    return iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4);
  }

  /**
   * @param {{capacidades: object, aoSessaoEncerrada: Function, aoMudarDetalhe?: Function, documento?: object}} o
   */
  function criarTela(o) {
    var doc = o.documento || global.document;
    var $ = function (id) { return doc.getElementById(id); };
    var cap = o.capacidades;
    var encerrada = false;
    var lista = { pagina: 1, seq: 0 };
    var det = { id: null, dados: null, seq: 0 };
    var seqEntrega = 0;
    var ent = novaEntrega();
    var enc = { enviando: false };
    var coletor = F().tracos.criarColetor();
    var instalacao = null;

    function novaEntrega() {
      return {
        aberta: false, bloqueada: false, lotesPorItem: {}, alocacoes: {}, erros: {}, modo: 'DESENHO', confirmacao: null, idem: F().idempotencia.novoEstado(), enviando: false, incerta: null,
      };
    }

    function no(tag, atributos, filhos) {
      var el = doc.createElement(tag);
      Object.keys(atributos || {}).forEach(function (k) {
        var v = atributos[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'texto') el.textContent = String(v);
        else el.setAttribute(k, v === true ? '' : String(v));
      });
      (filhos || []).forEach(function (f) { if (f) el.appendChild(typeof f === 'string' ? doc.createTextNode(f) : f); });
      return el;
    }
    function mostrar(el, sim) { el.style.display = sim ? '' : 'none'; }
    function aviso(caixa, tipo, texto) {
      caixa.textContent = '';
      if (!texto) { mostrar(caixa, false); return; }
      caixa.appendChild(no('div', { class: 'notice', style: CORES_AVISO[tipo], role: tipo === 'erro' ? 'alert' : 'status', texto: texto }));
      mostrar(caixa, true);
    }
    function dataHora(v) { return F().render.dataHoraBr(v) || '—'; }
    function sessao(r) {
      if (!S().mensagens.exigeNovoLogin(r)) return false;
      o.aoSessaoEncerrada();
      return true;
    }
    function rotuloStatus(status) { return S().ROTULOS_STATUS[status] || status; }
    function travada() { return ent.enviando || ent.incerta !== null; }

    // ── lista ────────────────────────────────────────────────────────

    function paginacao(texto, anterior, proxima) {
      $('listaPaginacaoTexto').textContent = texto;
      $('listaAnterior').disabled = !anterior;
      $('listaProxima').disabled = !proxima;
    }

    function linhaDaLista(s) {
      var q = s.quantidades;
      var selos = [no('span', { class: 'request-status', 'data-status': s.status, texto: rotuloStatus(s.status) })];
      if (s.situacaoOperacional) selos.push(no('span', { class: 'selo-situacao', 'data-situacao': s.situacaoOperacional, texto: ROTULO_SITUACAO[s.situacaoOperacional] || s.situacaoOperacional }));
      if (cap.encerrar === true) selos.push(no('span', { class: 'selo-situacao', 'data-situacao': 'ENCERRAVEL', texto: 'Encerrável' }));
      var botao = no('button', { type: 'button', class: 'request-item lista-linha', 'data-solicitacao-id': s.id, 'aria-current': s.id === det.id ? 'true' : null }, [
        no('span', { class: 'request-meta' }, [
          no('strong', { texto: 'Pedido nº ' + s.numero }),
          no('span', { texto: s.funcionario.nome + (s.funcionario.matricula ? ' · matrícula ' + s.funcionario.matricula : '') }),
          no('span', { texto: 'Criado em ' + dataHora(s.criadaEm) + (s.decididaEm ? ' · decidido em ' + dataHora(s.decididaEm) : '') }),
          no('span', { texto: 'Aprovadas ' + q.aprovada + ' · Entregues ' + q.entregue + ' · Restantes ' + q.restante }),
        ]),
        no('span', { class: 'selos' }, selos),
      ]);
      // Com a entrega em envio ou sem resposta, só "Tentar novamente" ou "Descartar" saem dela.
      botao.addEventListener('click', function () { return travada() || enc.enviando ? undefined : abrirDetalhe(s.id); });
      return no('li', {}, [botao]);
    }

    function carregarLista() {
      if (encerrada) return Promise.resolve();
      var seq = ++lista.seq;
      var caixa = $('listaEntregas');
      E().mostrar(caixa, E().TIPOS.CARREGANDO, 'Carregando as solicitações…');
      paginacao('—', false, false);
      var filtro = { pagina: lista.pagina, limite: LIMITE_LISTA };
      var pedido = cap.entregar === true ? S().acoes.entregaveis(filtro) : S().acoes.encerraveis(filtro);
      return pedido.then(function (r) {
        if (encerrada || seq !== lista.seq) return undefined;
        if (!r.ok) {
          if (!sessao(r)) E().mostrar(caixa, E().TIPOS.ERRO, S().mensagens.deErro(r));
          return undefined;
        }
        var paginas = Math.max(1, Math.ceil(r.dados.total / LIMITE_LISTA));
        // A página esvaziou (entregas e encerramentos tiram pedidos da lista): volta uma.
        if (r.dados.solicitacoes.length === 0 && lista.pagina > 1) {
          lista.pagina -= 1;
          return carregarLista();
        }
        paginacao('Página ' + lista.pagina + ' de ' + paginas + ' · ' + plural(r.dados.total, 'solicitação', 'solicitações'), lista.pagina > 1, lista.pagina < paginas);
        if (r.dados.solicitacoes.length === 0) {
          E().mostrar(caixa, E().TIPOS.VAZIO, 'Não há solicitações aprovadas aguardando entrega.');
          return undefined;
        }
        caixa.textContent = '';
        caixa.appendChild(no('ul', { class: 'lista-linhas', 'aria-label': 'Solicitações aprovadas' }, r.dados.solicitacoes.map(linhaDaLista)));
        return undefined;
      });
    }

    function marcarSelecionada() {
      Array.prototype.forEach.call(doc.querySelectorAll('#listaEntregas [data-solicitacao-id]'), function (b) {
        if (Number(b.getAttribute('data-solicitacao-id')) === det.id) b.setAttribute('aria-current', 'true');
        else b.removeAttribute('aria-current');
      });
    }

    // ── detalhe ──────────────────────────────────────────────────────

    function fecharPaineis() {
      seqEntrega += 1;
      ent = novaEntrega();
      coletor.limpar();
      $('entregaItens').textContent = '';
      aviso($('avisoEntrega'), null);
      mostrar($('painelEntrega'), false);
      fecharEncerramento();
    }

    function limparDetalhe() {
      det.seq += 1;
      det.id = null;
      det.dados = null;
      fecharPaineis();
      $('detalheItens').textContent = '';
      $('detalheResumo').textContent = '';
      $('detalheTitulo').textContent = 'Detalhe';
      aviso($('avisoDetalhe'), null);
      mostrar($('detalheConteudo'), false);
      mostrar($('detalheVazio'), true);
      atualizarAcoes();
      marcarSelecionada();
    }

    function fecharComAviso(texto, tipo) {
      limparDetalhe();
      aviso($('avisoLista'), tipo || 'erro', texto);
      return carregarLista();
    }

    function ativa() { return det.dados !== null && STATUS_ATIVOS.indexOf(det.dados.solicitacao.status) !== -1; }
    function algoDisponivel() { return det.dados !== null && det.dados.itens.some(function (i) { return disponivelAgora(i) > 0; }); }

    /** `depois()`: o que fazer depois de reler (um aviso, reabrir a entrega). */
    function abrirDetalhe(id, depois) {
      if (encerrada) return Promise.resolve();
      var seq = ++det.seq;
      det.id = id;
      det.dados = null;
      fecharPaineis();
      marcarSelecionada();
      aviso($('avisoDetalhe'), null);
      aviso($('avisoLista'), null);
      mostrar($('detalheVazio'), false);
      mostrar($('detalheConteudo'), true);
      $('detalheResumo').textContent = '';
      atualizarAcoes();
      E().mostrar($('detalheItens'), E().TIPOS.CARREGANDO, 'Carregando o pedido…');
      return S().acoes.detalhe(id).then(function (r) {
        if (encerrada || seq !== det.seq) return undefined;
        if (!r.ok) {
          if (sessao(r)) return undefined;
          if (r.status === 404) return fecharComAviso(TEXTOS.SOLICITACAO_NAO_ENCONTRADA);
          E().mostrar($('detalheItens'), E().TIPOS.ERRO, S().mensagens.deErro(r));
          return undefined;
        }
        det.dados = r.dados;
        renderDetalhe();
        if (!ativa()) {
          aviso($('avisoDetalhe'), 'atencao', 'Esta solicitação não aguarda mais entrega (situação: ' + rotuloStatus(r.dados.solicitacao.status) + '). A lista foi atualizada.');
          carregarLista();
        }
        if (typeof depois === 'function') return depois();
        $('detalheTitulo').focus();
        return undefined;
      });
    }

    function par(dl, rotulo, valor) {
      if (valor === null || valor === undefined || valor === '') return;
      dl.appendChild(no('dt', { texto: rotulo }));
      dl.appendChild(no('dd', { texto: valor }));
    }

    function renderDetalhe() {
      var s = det.dados.solicitacao;
      $('detalheTitulo').textContent = 'Pedido nº ' + s.numero;
      var dl = $('detalheResumo');
      dl.textContent = '';
      if (s.funcionario) {
        par(dl, 'Trabalhador', s.funcionario.nome + (s.funcionario.ativo === false ? ' (inativo)' : ''));
        par(dl, 'Matrícula', s.funcionario.matricula || '—');
        par(dl, 'Setor', s.funcionario.setor);
        par(dl, 'Função', s.funcionario.funcao);
      }
      if (s.solicitante) par(dl, 'Solicitado por', s.solicitante.nome);
      par(dl, 'Criado em', dataHora(s.criadaEm));
      par(dl, 'Decisão da SST', rotuloStatus(s.status) + (s.decisao ? ' em ' + dataHora(s.decisao.decididaEm) + (s.decisao.decisor ? ' por ' + s.decisao.decisor.nome : '') : ''));
      par(dl, 'Situação', s.situacaoOperacional ? ROTULO_SITUACAO[s.situacaoOperacional] || s.situacaoOperacional : null);
      par(dl, 'Observação', s.observacao);
      var caixa = $('detalheItens');
      caixa.textContent = '';
      caixa.appendChild(no('ul', { class: 'itens-detalhe' }, det.dados.itens.map(cartaoDoItem)));
      atualizarAcoes();
    }

    function cartaoDoItem(item) {
      var unidade = item.material ? item.material.unidade : '';
      var filhos = [
        no('span', { class: 'item-topo' }, [
          no('strong', { texto: item.material ? item.material.nome : 'EPI' }),
          item.situacao ? no('span', { class: 'selo-situacao', 'data-situacao': item.situacao, texto: ROTULO_SITUACAO[item.situacao] || item.situacao }) : null,
        ]),
        no('span', { texto: item.tamanho ? 'Tamanho: ' + item.tamanho : 'Não usa tamanho' }),
      ];
      if (item.decisao !== 'APROVADO') {
        filhos.push(no('span', { texto: 'Solicitada: ' + comUnidade(item.quantidade, unidade) }));
        filhos.push(no('span', { class: 'item-reprovado', texto: 'Reprovado pela Segurança do Trabalho' + (item.justificativaDecisao ? ': ' + item.justificativaDecisao : '') }));
      } else {
        filhos.push(no('span', {
          texto: 'Solicitada: ' + comUnidade(item.quantidade, unidade) + ' · Aprovada: ' + comUnidade(item.quantidadeAprovada, unidade)
            + ' · Entregue: ' + comUnidade(item.quantidadeEntregue, unidade) + ' · Pendente: ' + comUnidade(pendente(item), unidade),
        }));
        var agora = disponivelAgora(item);
        var falta = pendente(item) - agora;
        if (item.cobertura && pendente(item) > 0) {
          filhos.push(no('span', { class: 'item-cobertura' }, [
            agora > 0 ? 'Disponível agora: ' + comUnidade(agora, unidade) : '',
            agora > 0 && falta > 0 ? ' · ' : '',
            falta > 0 ? 'Aguardando estoque: ' + comUnidade(falta, unidade) : '',
          ]));
        }
        if (item.situacao === 'SUSPENSA') filhos.push(no('span', { class: 'dica', texto: 'O trabalhador ou o EPI está inativo: a entrega fica suspensa.' }));
      }
      return no('li', { class: 'request-item item-detalhe', 'data-item-id': item.id }, [no('span', { class: 'request-meta' }, filhos)]);
    }

    function atualizarAcoes() {
      var livre = ativa() && !travada() && !enc.enviando;
      mostrar($('botaoPrepararEntrega'), cap.entregar === true && ativa());
      $('botaoPrepararEntrega').disabled = !livre || !algoDisponivel() || ent.aberta;
      mostrar($('botaoEncerrar'), cap.encerrar === true && ativa());
      $('botaoEncerrar').disabled = !livre;
      $('botaoFecharDetalhe').disabled = travada() || enc.enviando;
      $('detalheAcoesDica').textContent = cap.entregar === true && ativa() && !algoDisponivel()
        ? 'Nada disponível agora para entrega: os itens pendentes aguardam estoque ou estão suspensos.' : '';
      // 12G-6: o "Gerar alerta" acompanha o pedido aberto.
      if (typeof o.aoMudarDetalhe === 'function') o.aoMudarDetalhe(ativa() ? det.dados : null);
    }

    // ── entrega ──────────────────────────────────────────────────────

    function prepararEntrega() {
      if (encerrada || cap.entregar !== true || !ativa() || !algoDisponivel() || ent.aberta) return Promise.resolve();
      fecharPaineis();
      ent.aberta = true;
      var seq = seqEntrega;
      var funcionarioId = det.dados.solicitacao.funcionarioId;
      var alvos = det.dados.itens.filter(function (i) { return disponivelAgora(i) > 0; });
      mostrar($('painelEntrega'), true);
      E().mostrar($('entregaItens'), E().TIPOS.CARREGANDO, 'Carregando os lotes…');
      renderConfirmacao();
      atualizarBotoesEntrega();
      return Promise.all(alvos.map(function (item) { return F().acoes.lotes(funcionarioId, item.materialId); })).then(function (respostas) {
        if (encerrada || seq !== seqEntrega) return undefined;
        var falha = respostas.filter(function (r) { return !r.ok; })[0];
        if (falha) {
          if (sessao(falha)) return undefined;
          ent.bloqueada = true;
          $('entregaItens').textContent = '';
          aviso($('avisoEntrega'), 'erro', textoDoErro(falha, 'PERMISSAO_NEGADA_ENTREGA'));
          renderConfirmacao();
          atualizarBotoesEntrega();
          return undefined;
        }
        respostas.forEach(function (r, i) {
          var item = alvos[i];
          ent.lotesPorItem[item.id] = lotesDoItem(item, r.dados.lotes);
          ent.alocacoes[item.id] = sugestaoFifo(item, ent.lotesPorItem[item.id]);
        });
        renderEntrega();
        return undefined;
      });
    }

    function renderEntrega() {
      var caixa = $('entregaItens');
      caixa.textContent = '';
      det.dados.itens.forEach(function (item) {
        var lotes = ent.lotesPorItem[item.id];
        if (!lotes) return;
        var unidade = item.material ? item.material.unidade : '';
        var titulo = 'entrega-item-' + item.id + '-titulo';
        var grupo = no('div', { class: 'entrega-item', 'data-item-id': item.id, role: 'group', 'aria-labelledby': titulo }, [
          no('p', { id: titulo, class: 'entrega-item-titulo' }, [
            no('strong', { texto: (item.material ? item.material.nome : 'EPI') + (item.tamanho ? ' · tamanho ' + item.tamanho : '') }),
            no('span', { texto: 'Pendente ' + comUnidade(pendente(item), unidade) + ' · disponível agora ' + comUnidade(disponivelAgora(item), unidade) }),
          ]),
        ]);
        if (lotes.length === 0) grupo.appendChild(no('p', { class: 'dica', texto: 'Nenhum lote deste tamanho com saldo e CA válido no momento.' }));
        lotes.forEach(function (l) { grupo.appendChild(campoDoLote(item, l, grupo)); });
        grupo.appendChild(no('p', { class: 'campo-erro', 'data-erro': 'item', role: 'alert', texto: ent.erros['item-' + item.id] || '' }));
        caixa.appendChild(grupo);
      });
    }

    function campoDoLote(item, l, grupo) {
      var base = 'lote-' + l.loteId + '-quantidade';
      var erro = ent.erros['lote-' + l.loteId] || '';
      var campo = no('input', {
        class: 'input', type: 'number', id: base, min: 0, max: Math.min(l.saldo, disponivelAgora(item)), step: 1, inputmode: 'numeric',
        disabled: travada(), 'aria-describedby': base + '-erro', 'aria-invalid': erro ? 'true' : null,
      });
      campo.value = ent.alocacoes[item.id][l.loteId];
      campo.addEventListener('input', function () {
        ent.alocacoes[item.id][l.loteId] = campo.value;
        delete ent.erros['lote-' + l.loteId];
        delete ent.erros['item-' + item.id];
        campo.removeAttribute('aria-invalid');
        $(base + '-erro').textContent = '';
        grupo.querySelector('[data-erro="item"]').textContent = '';
        descartarConfirmacao();
      });
      var situacao = F().SITUACOES_CA[l.situacaoCa];
      var ca = l.caNumero ? 'CA ' + l.caNumero + (l.caValidade ? ' · válido até ' + dataBr(l.caValidade) : '') : situacao.rotulo;
      return no('div', { class: 'entrega-lote', 'data-lote-id': l.loteId }, [
        no('label', { for: base }, [
          no('strong', { texto: 'Lote nº ' + l.loteId }),
          no('span', { texto: ca + ' · Saldo: ' + l.saldo }),
        ]),
        campo,
        no('p', { id: base + '-erro', class: 'campo-erro', 'data-erro': 'quantidade', texto: erro }),
      ]);
    }

    function renderConfirmacao() {
      var bloqueio = travada() || ent.bloqueada;
      Array.prototype.forEach.call(doc.querySelectorAll('input[name="modoConfirmacao"]'), function (r) {
        r.checked = r.value === ent.modo;
        r.disabled = bloqueio;
      });
      mostrar($('areaAceite'), ent.modo === 'ACEITE_PRESENCIAL');
      mostrar($('areaDesenho'), ent.modo === 'DESENHO');
      $('aceitePresencial').checked = ent.confirmacao !== null && ent.confirmacao.modo === 'ACEITE_PRESENCIAL';
      $('aceitePresencial').disabled = bloqueio;
      $('botaoColetarAssinatura').disabled = bloqueio;
      $('assinaturaStatus').textContent = ent.confirmacao !== null && ent.confirmacao.modo === 'DESENHO'
        ? 'Assinatura coletada (' + plural(ent.confirmacao.tracos.length, 'traço', 'traços') + ').' : 'Nenhuma assinatura coletada.';
    }

    /** A entrega mudou depois da confirmação: a confirmação antiga não vale para a nova. */
    function descartarConfirmacao() {
      if (ent.confirmacao === null) return;
      ent.confirmacao = null;
      coletor.limpar();
      renderConfirmacao();
      aviso($('avisoEntrega'), 'atencao', 'A entrega mudou depois da confirmação: colete de novo a confirmação do trabalhador.');
    }

    function atualizarBotoesEntrega() {
      var botao = $('botaoRegistrarEntrega');
      botao.disabled = !ent.aberta || ent.bloqueada || travada();
      if (ent.enviando) botao.setAttribute('aria-busy', 'true'); else botao.removeAttribute('aria-busy');
      $('rotuloRegistrar').textContent = ent.enviando ? 'Registrando…' : 'Registrar entrega';
      mostrar($('botaoTentarNovamente'), ent.incerta !== null);
      mostrar($('botaoDescartarTentativa'), ent.incerta !== null);
      $('botaoTentarNovamente').disabled = ent.enviando;
      $('botaoDescartarTentativa').disabled = ent.enviando;
      $('botaoCancelarEntrega').disabled = travada();
      atualizarAcoes();
    }

    function redesenharEntrega() {
      renderEntrega();
      renderConfirmacao();
      atualizarBotoesEntrega();
    }

    function marcarErros(erros) {
      ent.erros = {};
      erros.forEach(function (e) {
        var chave = e.campo === 'item' ? 'item-' + e.itemId : 'lote-' + e.loteId;
        if (!ent.erros[chave]) ent.erros[chave] = e.mensagem;
      });
    }

    /** Os erros de campo de um 400, no lote certo (o índice é o do corpo enviado); texto da tela, nunca o do servidor. */
    function camposDoServidor(r, enviados) {
      if (r.status !== 400 || !Array.isArray(r.detalhes)) return [];
      var erros = [];
      r.detalhes.forEach(function (d) {
        var m = d && typeof d.campo === 'string' ? /^body\.itens\[(\d+)\]\./.exec(d.campo) : null;
        var enviado = m ? enviados[Number(m[1])] : undefined;
        if (enviado) erros.push({ itemId: enviado.solicitacaoItemId, loteId: enviado.loteId, campo: 'quantidade', mensagem: textoDoCodigo(d.codigo) || S().mensagens.doCodigo(d.codigo) });
      });
      return erros;
    }

    function reler(id, depois) {
      carregarLista();
      return abrirDetalhe(id, depois);
    }

    function enviarEntrega(corpoLogico) {
      var id = det.id;
      var seq = seqEntrega;
      var chave = F().idempotencia.chavePara(ent.idem, corpoLogico);
      ent.enviando = true;
      redesenharEntrega();
      return S().acoes.entregar(id, { itens: corpoLogico.itens, confirmacao: corpoLogico.confirmacao, chaveIdempotencia: chave }).then(function (r) {
        if (encerrada || seq !== seqEntrega) return undefined;
        ent.enviando = false;
        if (r.ok) {
          var ficha = r.dados.entrega && r.dados.entrega.ficha ? ' (ficha nº ' + r.dados.entrega.ficha.numero + ')' : '';
          var texto = r.dados.repetida
            ? 'Esta entrega já havia sido registrada' + ficha + '. Nenhuma entrega nova foi criada.'
            : 'Entrega registrada' + ficha + '.';
          return reler(id, function () { aviso($('avisoDetalhe'), 'sucesso', texto); $('detalheTitulo').focus(); });
        }
        if (sessao(r)) return undefined;
        if (r.status === 0) {
          ent.incerta = corpoLogico;
          redesenharEntrega();
          aviso($('avisoEntrega'), 'erro', TEXTOS.INCERTA);
          return undefined;
        }
        if (r.status === 404) return fecharComAviso(TEXTOS.SOLICITACAO_NAO_ENCONTRADA);
        if (r.codigo === 'SOLICITACAO_NAO_ENTREGAVEL') {
          return reler(id, function () { aviso($('avisoDetalhe'), 'erro', TEXTOS.SOLICITACAO_NAO_ENTREGAVEL); });
        }
        if (RELER_ENTREGA.indexOf(r.codigo) !== -1) {
          // Reabre a entrega com os lotes novos; se nada mais puder ser entregue, o aviso fica no detalhe.
          return reler(id, function () {
            return prepararEntrega().then(function () { aviso(ent.aberta ? $('avisoEntrega') : $('avisoDetalhe'), 'erro', TEXTOS[r.codigo]); });
          });
        }
        var erros = camposDoServidor(r, corpoLogico.itens);
        marcarErros(erros);
        redesenharEntrega();
        aviso($('avisoEntrega'), 'erro', erros.length > 0 ? 'Revise as quantidades destacadas.' : textoDoErro(r, 'PERMISSAO_NEGADA_ENTREGA'));
        return undefined;
      });
    }

    function registrarEntrega() {
      if (encerrada || !ent.aberta || ent.bloqueada || travada()) return Promise.resolve();
      var v = validar(det.dados.itens, ent.alocacoes, ent.lotesPorItem);
      marcarErros(v.ok ? [] : v.erros.filter(function (e) { return e.campo !== 'geral'; }));
      renderEntrega();
      if (!v.ok) {
        var geral = v.erros.filter(function (e) { return e.campo === 'geral'; })[0];
        aviso($('avisoEntrega'), 'erro', geral ? geral.mensagem : 'Revise as quantidades destacadas.');
        return Promise.resolve();
      }
      var c = corpo(v.itens, ent.confirmacao);
      if (c === null) {
        aviso($('avisoEntrega'), 'erro', 'Colete a confirmação do trabalhador (assinatura desenhada ou aceite presencial) antes de registrar.');
        return Promise.resolve();
      }
      aviso($('avisoEntrega'), null);
      return enviarEntrega(c);
    }

    function tentarNovamente() {
      if (encerrada || ent.enviando || ent.incerta === null) return Promise.resolve();
      aviso($('avisoEntrega'), null);
      return enviarEntrega(ent.incerta);
    }

    function descartarTentativa() {
      if (encerrada || ent.enviando || ent.incerta === null) return Promise.resolve();
      return reler(det.id, function () {
        aviso($('avisoDetalhe'), 'atencao', 'A tentativa sem resposta foi descartada e o pedido foi relido do servidor: confira o que já foi entregue antes de uma nova entrega.');
      });
    }

    function cancelarEntrega() {
      if (travada()) return;
      fecharPaineis();
      atualizarAcoes();
      $('botaoPrepararEntrega').focus();
    }

    // ── confirmação do trabalhador ───────────────────────────────────

    function trocarModo(modo) {
      if (travada() || ent.bloqueada || modo === ent.modo) return;
      ent.modo = modo;
      ent.confirmacao = null;
      coletor.limpar();
      renderConfirmacao();
    }

    function abrirAssinatura() {
      if (travada() || ent.bloqueada) return;
      if (instalacao === null) {
        var canvas = $('assinaturaCanvas');
        var ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
        if (ctx) { ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.strokeStyle = '#1a3a6b'; }
        instalacao = F().assinatura.instalar(canvas, coletor);
      }
      instalacao.limpar();
      $('assinaturaModalAviso').textContent = '';
      $('assinaturaModal').classList.add('open');
      $('btnAssinaturaFechar').focus();
    }
    function fecharAssinatura() {
      $('assinaturaModal').classList.remove('open');
      $('botaoColetarAssinatura').focus();
    }
    function confirmarAssinatura() {
      if (coletor.vazio()) { $('assinaturaModalAviso').textContent = 'A assinatura está vazia: o trabalhador precisa desenhar antes de confirmar.'; return; }
      ent.confirmacao = { modo: 'DESENHO', tracos: coletor.valores() };
      aviso($('avisoEntrega'), null);
      renderConfirmacao();
      fecharAssinatura();
    }

    // ── encerramento ─────────────────────────────────────────────────

    function erroDaJustificativa(texto) {
      $('justificativaEncerramento-erro').textContent = texto;
      if (texto) $('justificativaEncerramento').setAttribute('aria-invalid', 'true');
      else $('justificativaEncerramento').removeAttribute('aria-invalid');
    }

    function fecharEncerramento() {
      mostrar($('painelEncerramento'), false);
      $('justificativaEncerramento').value = '';
      erroDaJustificativa('');
    }

    function abrirEncerramento() {
      if (encerrada || cap.encerrar !== true || !ativa() || travada() || enc.enviando) return;
      fecharPaineis();
      mostrar($('painelEncerramento'), true);
      atualizarAcoes();
      $('justificativaEncerramento').focus();
    }

    function confirmarEncerramento() {
      if (encerrada || enc.enviando || cap.encerrar !== true || !ativa()) return Promise.resolve();
      var j = justificativaDoEncerramento($('justificativaEncerramento').value);
      if (!j.ok) { erroDaJustificativa(j.mensagem); $('justificativaEncerramento').focus(); return Promise.resolve(); }
      erroDaJustificativa('');
      var id = det.id;
      var numero = det.dados.solicitacao.numero;
      var botao = $('botaoConfirmarEncerramento');
      enc.enviando = true;
      botao.disabled = true;
      botao.setAttribute('aria-busy', 'true');
      atualizarAcoes();
      return S().acoes.encerrar(id, { justificativa: j.valor }).then(function (r) {
        enc.enviando = false;
        botao.disabled = false;
        botao.removeAttribute('aria-busy');
        if (encerrada) return undefined;
        atualizarAcoes();
        if (r.ok) return fecharComAviso('Pedido nº ' + numero + ' encerrado. O que já foi entregue continua registrado.', 'sucesso');
        if (sessao(r)) return undefined;
        if (r.status === 404) return fecharComAviso(TEXTOS.SOLICITACAO_NAO_ENCONTRADA);
        if (r.status === 0) return reler(id, function () { aviso($('avisoDetalhe'), 'erro', TEXTOS.ENCERRAMENTO_INCERTO); });
        if (r.codigo === 'SOLICITACAO_NAO_ENCERRAVEL') return reler(id, function () { aviso($('avisoDetalhe'), 'erro', TEXTOS.SOLICITACAO_NAO_ENCERRAVEL); });
        if (r.status === 400) {
          erroDaJustificativa(textoDoCodigo(Array.isArray(r.detalhes) && r.detalhes[0] ? r.detalhes[0].codigo : null) || TEXTOS.JUSTIFICATIVA_INVALIDA);
          $('justificativaEncerramento').focus();
          return undefined;
        }
        aviso($('avisoDetalhe'), 'erro', textoDoErro(r, 'PERMISSAO_NEGADA_ENCERRAMENTO'));
        return undefined;
      });
    }

    // ── ciclo da tela ────────────────────────────────────────────────

    function ligar() {
      $('botaoAtualizarLista').addEventListener('click', function () { aviso($('avisoLista'), null); return carregarLista(); });
      $('listaAnterior').addEventListener('click', function () { lista.pagina = Math.max(1, lista.pagina - 1); return carregarLista(); });
      $('listaProxima').addEventListener('click', function () { lista.pagina += 1; return carregarLista(); });
      $('botaoFecharDetalhe').addEventListener('click', function () {
        if (travada() || enc.enviando) return;
        limparDetalhe();
        $('tituloLista').focus();
      });
      $('botaoPrepararEntrega').addEventListener('click', prepararEntrega);
      $('botaoRegistrarEntrega').addEventListener('click', registrarEntrega);
      $('botaoTentarNovamente').addEventListener('click', tentarNovamente);
      $('botaoDescartarTentativa').addEventListener('click', descartarTentativa);
      $('botaoCancelarEntrega').addEventListener('click', cancelarEntrega);
      Array.prototype.forEach.call(doc.querySelectorAll('input[name="modoConfirmacao"]'), function (r) {
        r.addEventListener('change', function () { if (r.checked) trocarModo(r.value); });
      });
      $('aceitePresencial').addEventListener('change', function () {
        if (travada() || ent.bloqueada) return;
        ent.confirmacao = $('aceitePresencial').checked ? { modo: 'ACEITE_PRESENCIAL' } : null;
        aviso($('avisoEntrega'), null);
      });
      $('botaoColetarAssinatura').addEventListener('click', abrirAssinatura);
      $('btnAssinaturaLimpar').addEventListener('click', function () { instalacao.limpar(); });
      $('btnAssinaturaCancelar').addEventListener('click', fecharAssinatura);
      $('btnAssinaturaFechar').addEventListener('click', fecharAssinatura);
      $('btnAssinaturaConfirmar').addEventListener('click', confirmarAssinatura);
      $('botaoEncerrar').addEventListener('click', abrirEncerramento);
      $('botaoVoltarEncerramento').addEventListener('click', function () {
        if (enc.enviando) return;
        fecharEncerramento();
        atualizarAcoes();
        $('botaoEncerrar').focus();
      });
      $('botaoConfirmarEncerramento').addEventListener('click', confirmarEncerramento);
    }

    function iniciar() {
      $('entregaDeclaracao').textContent = F().DECLARACAO.texto;
      $('justificativaEncerramento').setAttribute('maxlength', String(JUSTIFICATIVA_MAXIMA));
      limparDetalhe();
      ligar();
      return carregarLista();
    }

    /** Sessão encerrada ou trocada: nada do que estava na tela fica nela. */
    function encerrar() {
      encerrada = true;
      lista.seq += 1;
      det.seq += 1;
      seqEntrega += 1;
      det.id = null;
      det.dados = null;
      ent = novaEntrega();
      coletor.limpar();
      ['listaEntregas', 'detalheItens', 'detalheResumo', 'entregaItens', 'avisoLista', 'avisoDetalhe', 'avisoEntrega', 'detalheAcoesDica'].forEach(function (id) { $(id).textContent = ''; });
      $('detalheTitulo').textContent = 'Detalhe';
      $('justificativaEncerramento').value = '';
      mostrar($('detalheConteudo'), false);
      $('assinaturaModal').classList.remove('open');
    }

    return { iniciar: iniciar, encerrar: encerrar };
  }

  global.EpiEntregasSolicitacao = {
    rascunho: {
      pendente: pendente,
      disponivelAgora: disponivelAgora,
      lotesDoItem: lotesDoItem,
      sugestaoFifo: sugestaoFifo,
      validar: validar,
      corpo: corpo,
      justificativaDoEncerramento: justificativaDoEncerramento,
    },
    criarTela: criarTela,
    TEXTOS: TEXTOS,
    ROTULO_SITUACAO: ROTULO_SITUACAO,
    LIMITE_LISTA: LIMITE_LISTA,
    JUSTIFICATIVA_MAXIMA: JUSTIFICATIVA_MAXIMA,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.EpiEntregasSolicitacao;
  }
})(typeof window !== 'undefined' ? window : globalThis);
