(function (global) {
  'use strict';

  /**
   * EpiAprovacaoSst — a tela Aprovação da Segurança do Trabalho (Bloco 12,
   * 12G-3), só sobre os contratos da 12F (EpiSolicitacoesEpi):
   *   - a fila é a do servidor (PENDENTE, em ordem de criação; ação
   *     APROVAR_SOLICITACAO);
   *   - a análise abre o detalhe e decide cada item: aprovar (de 1 até a
   *     quantidade solicitada) ou reprovar; a justificativa aparece só quando
   *     o servidor a exige (reprovação, redução, aprovação fora do GHE);
   *   - a decisão cobre todos os itens num POST só, e um clique é um POST;
   *   - quem criou o pedido não decide (AUTODECISAO_PROIBIDA): a tela avisa
   *     antes, pela mesma condição do servidor, que continua decidindo;
   *   - aprovar não depende de estoque, e nenhum número de estoque aparece.
   *
   * O QUE PODE vem das permissões efetivas (EpiSolicitacoesEpi.capacidades):
   * aprovar exige APROVAR_SOLICITACAO e reprovar, REPROVAR_SOLICITACAO; nunca o
   * nome do perfil. Tudo é montado com createElement e textContent; nada vai
   * para armazenamento do navegador.
   */

  var LIMITE_FILA = 20;
  var JUSTIFICATIVA_MAXIMA = 500;
  var DECISOES = Object.freeze(['APROVADO', 'REPROVADO']);

  function S() { return global.EpiSolicitacoesEpi; }
  function E() { return global.EpiEstadoPagina; }
  function F() { return global.EpiFicha; }

  // Os códigos da decisão com o texto desta tela; o resto vem de EpiSolicitacoesEpi.mensagens.
  var TEXTOS = {
    AUTODECISAO_PROIBIDA: 'Você criou esta solicitação. Pela separação de funções, outra pessoa da Segurança do Trabalho precisa analisá-la.',
    SOLICITACAO_NAO_PENDENTE: 'Esta solicitação já foi analisada ou cancelada por outra operação. A fila foi atualizada.',
    SOLICITACAO_ALTERADA: 'Esta solicitação foi alterada por outra operação. A fila foi atualizada.',
    SOLICITACAO_NAO_ENCONTRADA: 'Solicitação não encontrada. A fila foi atualizada.',
    PERMISSAO_NEGADA: 'Você não tem a autorização necessária para esta decisão: aprovar exige "Aprovar solicitação" e reprovar exige "Reprovar solicitação".',
    FUNCIONARIO_INATIVO: 'O trabalhador está inativo e não pode receber EPI: os itens não podem ser aprovados, mas podem ser reprovados.',
    MATERIAL_INATIVO: 'Um dos EPIs foi desativado no cadastro e não pode ser aprovado. Reprove esse item ou peça a reativação do EPI.',
    MATERIAL_NAO_ENCONTRADO: 'Um dos EPIs não está mais no cadastro e não pode ser aprovado. Reprove esse item.',
    USUARIO_INATIVO: 'Seu usuário está inativo nesta empresa.',
    DECISAO_INCOMPLETA: 'Decida todos os itens antes de concluir a análise.',
    QUANTIDADE_APROVADA_INVALIDA: 'A quantidade aprovada não pode passar da solicitada.',
    QUANTIDADE_INVALIDA: 'Informe uma quantidade inteira a partir de 1.',
    JUSTIFICATIVA_OBRIGATORIA: 'Informe a justificativa desta decisão.',
    JUSTIFICATIVA_FORA_GHE_OBRIGATORIA: 'Este EPI não estava previsto no GHE do trabalhador: justifique a aprovação.',
    JUSTIFICATIVA_INVALIDA: 'Justificativa inválida (até 500 caracteres).',
  };

  function textoDoErro(r) {
    if (r && r.codigo && Object.prototype.hasOwnProperty.call(TEXTOS, r.codigo) && r.status !== 0 && r.status < 500) return TEXTOS[r.codigo];
    return S().mensagens.deErro(r);
  }
  function textoDoCodigo(codigo) {
    return Object.prototype.hasOwnProperty.call(TEXTOS, codigo) ? TEXTOS[codigo] : S().mensagens.doCodigo(codigo);
  }

  // ───────────────────────────────────────────────────────────────────
  // Rascunho da decisão (sem DOM): as mesmas regras do servidor, que revalida tudo
  // ───────────────────────────────────────────────────────────────────

  function aparado(v) { return typeof v === 'string' ? v.trim().normalize('NFC') : ''; }
  function comprimento(t) { return Array.from(t).length; }

  function novaDecisao(item) {
    return { decisao: null, quantidade: String(item.quantidade), justificativa: '' };
  }

  /** Quantidade aprovada digitada: o inteiro, ou NaN quando não é um inteiro. */
  function quantidadeDe(texto) {
    var q = aparado(String(texto));
    return /^\d+$/.test(q) ? Number(q) : NaN;
  }

  /** Por que a justificativa é obrigatória neste item (vazio quando não é), na ordem do servidor. */
  function motivosDaJustificativa(item, d) {
    if (d.decisao === 'REPROVADO') return ['reprovado'];
    if (d.decisao !== 'APROVADO') return [];
    var motivos = [];
    var q = quantidadeDe(d.quantidade);
    if (q >= 1 && q < item.quantidade) motivos.push('reduzido');
    if (item.previstoNoGhe !== true) motivos.push('foraDoGhe');
    // O servidor é a autoridade final: se ele exigiu a justificativa, o campo aparece e vai no envio.
    if (motivos.length === 0 && d.exigidaPeloServidor === true) motivos.push('servidor');
    return motivos;
  }

  var ROTULO_JUSTIFICATIVA = {
    reprovado: 'Justificativa da reprovação (obrigatória)',
    reduzido: 'Justificativa da redução (obrigatória)',
    foraDoGhe: 'Justificativa da aprovação fora do GHE (obrigatória)',
    ambos: 'Justificativa da redução e da aprovação fora do GHE (obrigatória)',
    servidor: 'Justificativa (obrigatória)',
  };
  var FALTA_JUSTIFICATIVA = {
    reprovado: 'Justifique a reprovação deste item.',
    reduzido: 'Justifique a redução da quantidade.',
    foraDoGhe: TEXTOS.JUSTIFICATIVA_FORA_GHE_OBRIGATORIA,
    ambos: 'Justifique a redução da quantidade e a aprovação fora do GHE.',
    servidor: TEXTOS.JUSTIFICATIVA_OBRIGATORIA,
  };
  function chaveDosMotivos(motivos) { return motivos.length > 1 ? 'ambos' : motivos[0]; }

  /** O mesmo cálculo do servidor; null enquanto falta decidir algum item. */
  function resultadoPrevisto(itens, decisoes) {
    var aprovados = 0;
    var integral = true;
    for (var i = 0; i < itens.length; i += 1) {
      var d = decisoes[itens[i].id];
      if (!d || DECISOES.indexOf(d.decisao) === -1) return null;
      if (d.decisao === 'APROVADO') {
        aprovados += 1;
        if (quantidadeDe(d.quantidade) !== itens[i].quantidade) integral = false;
      } else {
        integral = false;
      }
    }
    if (aprovados === 0) return 'REPROVADA';
    return integral ? 'APROVADA' : 'APROVADA_PARCIAL';
  }

  /** A condição do servidor para AUTODECISAO_PROIBIDA: só o pedido interno de quem decide. */
  function criadaPor(s, usuarioId) {
    return !!s && s.origemSolicitacao === 'USUARIO_INTERNO' && s.solicitanteUsuarioId === usuarioId;
  }

  /**
   * Valida a decisão de todos os itens e monta o corpo do POST, na ordem dos
   * itens. Erros: [{itemId, campo, mensagem}].
   */
  function validar(itens, decisoes, cap) {
    var erros = [];
    var erro = function (itemId, campo, mensagem) { erros.push({ itemId: itemId, campo: campo, mensagem: mensagem }); };
    var corpo = itens.map(function (item) {
      var d = decisoes[item.id] || novaDecisao(item);
      if (DECISOES.indexOf(d.decisao) === -1) {
        erro(item.id, 'decisao', 'Escolha aprovar ou reprovar este item.');
        return null;
      }
      if (d.decisao === 'APROVADO' && cap.aprovar !== true) erro(item.id, 'decisao', 'Você não tem a autorização "Aprovar solicitação".');
      if (d.decisao === 'REPROVADO' && cap.reprovar !== true) erro(item.id, 'decisao', 'Você não tem a autorização "Reprovar solicitação".');
      var j = aparado(d.justificativa);
      var motivos = motivosDaJustificativa(item, d);
      if (motivos.length > 0) {
        if (j === '') erro(item.id, 'justificativa', FALTA_JUSTIFICATIVA[chaveDosMotivos(motivos)]);
        else if (comprimento(j) > JUSTIFICATIVA_MAXIMA) erro(item.id, 'justificativa', TEXTOS.JUSTIFICATIVA_INVALIDA);
      }
      if (d.decisao === 'REPROVADO') return { itemId: item.id, decisao: 'REPROVADO', justificativa: j };
      var q = quantidadeDe(d.quantidade);
      if (!(q >= 1)) erro(item.id, 'quantidade', TEXTOS.QUANTIDADE_INVALIDA);
      else if (q > item.quantidade) erro(item.id, 'quantidade', 'A quantidade aprovada não pode passar da solicitada (' + item.quantidade + ').');
      return {
        itemId: item.id, decisao: 'APROVADO', quantidadeAprovada: q, justificativa: motivos.length > 0 ? j : null,
      };
    });
    if (erros.length > 0) return { ok: false, erros: erros };
    return { ok: true, corpo: { decisoes: corpo } };
  }

  // ───────────────────────────────────────────────────────────────────
  // Tela
  // ───────────────────────────────────────────────────────────────────

  var CORES_AVISO = {
    erro: 'background:var(--error-container);color:var(--error);border-color:rgba(255,59,48,0.2)',
    sucesso: 'background:rgba(52,199,89,0.10);color:#1A7A35;border-color:rgba(52,199,89,0.25)',
    atencao: 'background:var(--warning-container);color:var(--on-surface);border-color:rgba(255,149,0,0.25)',
  };
  var ROTULO_RESULTADO = { APROVADA: 'Aprovada', APROVADA_PARCIAL: 'Aprovada parcialmente', REPROVADA: 'Reprovada' };

  function plural(n, um, varios) { return n + ' ' + (n === 1 ? um : varios); }

  /**
   * @param {{capacidades: object, usuarioId: number, aoSessaoEncerrada: Function, documento?: object}} o
   */
  function criarTela(o) {
    var doc = o.documento || global.document;
    var $ = function (id) { return doc.getElementById(id); };
    var cap = o.capacidades;
    var encerrada = false;
    var fila = { pagina: 1, total: 0, seq: 0 };
    var an = {
      id: null, dados: null, decisoes: {}, erros: {}, seq: 0, enviando: false, bloqueada: false, decidivel: false,
    };

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
    function mostrar(el, sim) { if (el) el.style.display = sim ? '' : 'none'; }
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

    // ── fila ─────────────────────────────────────────────────────────

    function paginacao(texto, anterior, proxima) {
      $('filaPaginacaoTexto').textContent = texto;
      $('filaAnterior').disabled = !anterior;
      $('filaProxima').disabled = !proxima;
    }

    function carregarFila() {
      if (encerrada) return Promise.resolve();
      var seq = ++fila.seq;
      var caixa = $('listaFila');
      E().mostrar(caixa, E().TIPOS.CARREGANDO, 'Carregando as solicitações…');
      paginacao('—', false, false);
      return S().acoes.fila({ pagina: fila.pagina, limite: LIMITE_FILA }).then(function (r) {
        if (encerrada || seq !== fila.seq) return undefined;
        if (!r.ok) {
          if (!sessao(r)) E().mostrar(caixa, E().TIPOS.ERRO, S().mensagens.deErro(r));
          return undefined;
        }
        fila.total = r.dados.total;
        var paginas = Math.max(1, Math.ceil(fila.total / LIMITE_FILA));
        if (r.dados.solicitacoes.length === 0 && fila.pagina > 1) {
          fila.pagina -= 1;
          return carregarFila();
        }
        paginacao('Página ' + fila.pagina + ' de ' + paginas + ' · ' + plural(fila.total, 'solicitação', 'solicitações'), fila.pagina > 1, fila.pagina < paginas);
        if (r.dados.solicitacoes.length === 0) {
          E().mostrar(caixa, E().TIPOS.VAZIO, 'Não há solicitações aguardando análise.');
          return undefined;
        }
        caixa.textContent = '';
        var ul = no('ul', { class: 'fila-linhas', 'aria-label': 'Solicitações aguardando análise' });
        r.dados.solicitacoes.forEach(function (s) {
          var propria = s.solicitanteUsuarioId === o.usuarioId;
          var botao = no('button', {
            type: 'button', class: 'request-item fila-linha', 'data-solicitacao-id': s.id, 'aria-current': s.id === an.id ? 'true' : null,
          }, [
            no('span', { class: 'request-meta' }, [
              no('strong', { texto: 'Pedido nº ' + s.numero }),
              no('span', { texto: dataHora(s.criadaEm) + (propria ? ' · Criado por você' : '') }),
              no('span', { texto: s.funcionario.nome + (s.funcionario.matricula ? ' (matrícula ' + s.funcionario.matricula + ')' : '') }),
              no('span', { texto: plural(s.quantidadeItens, 'item', 'itens') + ' · ' + plural(s.quantidades.solicitada, 'unidade', 'unidades') }),
            ]),
            no('span', { class: 'request-status', 'data-status': s.status, texto: S().ROTULOS_STATUS[s.status] || s.status }),
          ]);
          botao.addEventListener('click', function () { return abrirAnalise(s.id); });
          ul.appendChild(no('li', {}, [botao]));
        });
        caixa.appendChild(ul);
        return undefined;
      });
    }

    function marcarSelecionada() {
      Array.prototype.forEach.call(doc.querySelectorAll('#listaFila [data-solicitacao-id]'), function (b) {
        if (Number(b.getAttribute('data-solicitacao-id')) === an.id) b.setAttribute('aria-current', 'true');
        else b.removeAttribute('aria-current');
      });
    }

    // ── análise ──────────────────────────────────────────────────────

    function limparAnalise() {
      an.seq += 1;
      an.id = null;
      an.dados = null;
      an.decisoes = {};
      an.erros = {};
      an.bloqueada = false;
      an.decidivel = false;
      $('analiseItens').textContent = '';
      $('analiseResumo').textContent = '';
      $('analiseTitulo').textContent = 'Análise';
      aviso($('avisoAnalise'), null);
      mostrar($('analiseConteudo'), false);
      mostrar($('analiseVazia'), true);
      marcarSelecionada();
      atualizarRodape();
    }

    /** Fecha a análise, avisa na fila e relê a fila (o pedido mudou ou sumiu). */
    function encerrarAnaliseComAviso(texto, tipo) {
      limparAnalise();
      aviso($('avisoFila'), tipo || 'erro', texto);
      return carregarFila();
    }

    function abrirAnalise(id) {
      if (encerrada) return Promise.resolve();
      var seq = ++an.seq;
      an.id = id;
      an.dados = null;
      an.decisoes = {};
      an.erros = {};
      an.bloqueada = false;
      an.decidivel = false;
      marcarSelecionada();
      mostrar($('analiseVazia'), false);
      mostrar($('analiseConteudo'), true);
      $('analiseTitulo').textContent = 'Pedido';
      $('analiseResumo').textContent = '';
      aviso($('avisoAnalise'), null);
      aviso($('avisoFila'), null);
      atualizarRodape();
      E().mostrar($('analiseItens'), E().TIPOS.CARREGANDO, 'Carregando o pedido…');
      return S().acoes.detalhe(id).then(function (r) {
        if (encerrada || seq !== an.seq) return undefined;
        if (!r.ok) {
          if (sessao(r)) return undefined;
          if (r.status === 404) return encerrarAnaliseComAviso(TEXTOS.SOLICITACAO_NAO_ENCONTRADA);
          E().mostrar($('analiseItens'), E().TIPOS.ERRO, S().mensagens.deErro(r));
          return undefined;
        }
        an.dados = r.dados;
        an.dados.itens.forEach(function (item) { an.decisoes[item.id] = novaDecisao(item); });
        var pendente = r.dados.solicitacao.status === 'PENDENTE';
        an.bloqueada = criadaPor(r.dados.solicitacao, o.usuarioId);
        an.decidivel = pendente && !an.bloqueada;
        renderAnalise();
        if (!pendente) {
          aviso($('avisoAnalise'), 'erro', TEXTOS.SOLICITACAO_NAO_PENDENTE);
          carregarFila();
        } else if (an.bloqueada) {
          aviso($('avisoAnalise'), 'atencao', TEXTOS.AUTODECISAO_PROIBIDA);
        }
        $('analiseTitulo').focus();
        return undefined;
      });
    }

    function par(dl, rotulo, valor) {
      if (valor === null || valor === undefined || valor === '') return;
      dl.appendChild(no('dt', { texto: rotulo }));
      dl.appendChild(no('dd', { texto: valor }));
    }

    function renderAnalise() {
      var s = an.dados.solicitacao;
      $('analiseTitulo').textContent = 'Pedido nº ' + s.numero;
      var dl = $('analiseResumo');
      dl.textContent = '';
      par(dl, 'Situação', S().ROTULOS_STATUS[s.status] || s.status);
      par(dl, 'Criado em', dataHora(s.criadaEm));
      if (s.funcionario) {
        par(dl, 'Trabalhador', s.funcionario.nome + (s.funcionario.ativo === false ? ' (inativo)' : ''));
        par(dl, 'Matrícula', s.funcionario.matricula || '—');
        par(dl, 'Setor', s.funcionario.setor);
        par(dl, 'Função', s.funcionario.funcao);
      }
      if (s.solicitante) par(dl, 'Solicitado por', s.solicitante.nome);
      par(dl, 'Observação', s.observacao);
      par(dl, 'Itens', String(an.dados.itens.length));
      renderItens();
    }

    function erroDe(itemId, campo) { return an.erros[itemId] && an.erros[itemId][campo] ? an.erros[itemId][campo] : ''; }

    function campoComRotulo(base, campo, rotulo, controle, itemId, dica) {
      var ids = [];
      var filhos = [no('label', { for: base, texto: rotulo }), controle];
      if (dica) { filhos.push(no('p', { id: base + '-dica', class: 'dica', texto: dica })); ids.push(base + '-dica'); }
      filhos.push(no('p', { id: base + '-erro', class: 'campo-erro', 'data-erro': campo, texto: erroDe(itemId, campo) }));
      ids.push(base + '-erro');
      controle.setAttribute('id', base);
      controle.setAttribute('data-campo', campo);
      controle.setAttribute('aria-describedby', ids.join(' '));
      if (erroDe(itemId, campo)) controle.setAttribute('aria-invalid', 'true');
      return no('div', { class: 'field' }, filhos);
    }

    function limparErro(itemId, campo) {
      if (an.erros[itemId]) delete an.erros[itemId][campo];
    }

    function linhaInfo(texto) { return no('span', { texto: texto }); }

    function cartaoDoItem(item, indice) {
      var d = an.decisoes[item.id];
      var bloqueado = !an.decidivel || an.enviando;
      var unidade = item.material ? item.material.unidade : '';
      var titulo = 'item-' + item.id + '-titulo';
      var cartao = no('div', {
        class: 'item-analise', 'data-item-id': item.id, 'data-decisao': d.decisao || null, role: 'group', 'aria-labelledby': titulo,
      });
      var ghe = item.previstoNoGhe === true
        ? no('span', { class: 'ghe-selo', 'data-ghe': 'previsto', texto: 'Previsto no GHE' })
        : no('span', { class: 'ghe-selo', 'data-ghe': 'fora', texto: 'Fora do GHE do trabalhador' });
      cartao.appendChild(no('div', { class: 'item-analise-topo' }, [
        no('p', { id: titulo, class: 'item-analise-nome' }, [no('span', { class: 'item-ordem', texto: 'Item ' + (indice + 1) }), no('strong', { texto: item.material ? item.material.nome : 'EPI' })]),
        ghe,
      ]));
      var info = [
        linhaInfo(item.tamanho ? 'Tamanho: ' + item.tamanho : 'Não usa tamanho'),
        linhaInfo('Quantidade solicitada: ' + item.quantidade + (unidade ? ' ' + unidade : '')),
        linhaInfo('Motivo: ' + (S().ROTULOS_MOTIVO[item.motivo] || item.motivo)),
      ];
      if (item.justificativa) info.push(linhaInfo('Justificativa do pedido: ' + item.justificativa));
      cartao.appendChild(no('div', { class: 'request-meta item-analise-info' }, info));

      // Decisão: aprovar ou reprovar, cada opção só com a autorização efetiva.
      var nome = 'decisao-' + item.id;
      var baseDecisao = 'item-' + item.id + '-decisao';
      var dicas = [];
      if (cap.aprovar !== true) dicas.push('Aprovar exige a autorização "Aprovar solicitação".');
      if (cap.reprovar !== true) dicas.push('Reprovar exige a autorização "Reprovar solicitação".');
      var idDica = dicas.length > 0 ? baseDecisao + '-dica' : null;
      var idErro = baseDecisao + '-erro';
      var opcoes = no('div', { class: 'opcoes-decisao' });
      [['APROVADO', 'Aprovar', cap.aprovar === true], ['REPROVADO', 'Reprovar', cap.reprovar === true]].forEach(function (op) {
        var id = baseDecisao + '-' + op[0].toLowerCase();
        var radio = no('input', {
          type: 'radio', name: nome, value: op[0], id: id, disabled: bloqueado || !op[2], 'aria-describedby': [idDica, idErro].filter(Boolean).join(' '),
        });
        radio.checked = d.decisao === op[0];
        if (erroDe(item.id, 'decisao')) radio.setAttribute('aria-invalid', 'true');
        radio.addEventListener('change', function () {
          if (!radio.checked) return;
          d.decisao = op[0];
          d.exigidaPeloServidor = false;
          limparErro(item.id, 'decisao');
          renderItens();
          var foco = doc.getElementById(id);
          if (foco) foco.focus();
        });
        opcoes.appendChild(no('label', { for: id, class: 'opcao-decisao', 'data-opcao': op[0] }, [radio, no('span', { texto: op[1] })]));
      });
      var filhosDecisao = [no('legend', { texto: 'Decisão' }), opcoes];
      if (idDica) filhosDecisao.push(no('p', { id: idDica, class: 'dica', texto: dicas.join(' ') }));
      filhosDecisao.push(no('p', { id: idErro, class: 'campo-erro', 'data-erro': 'decisao', texto: erroDe(item.id, 'decisao') }));
      cartao.appendChild(no('fieldset', { class: 'decisao-item' }, filhosDecisao));

      if (d.decisao === 'APROVADO') {
        var quantidade = no('input', {
          class: 'input', type: 'number', min: 1, max: item.quantidade, step: 1, inputmode: 'numeric', required: true, disabled: bloqueado,
        });
        quantidade.value = d.quantidade;
        quantidade.addEventListener('input', function () {
          d.quantidade = quantidade.value;
          limparErro(item.id, 'quantidade');
          quantidade.removeAttribute('aria-invalid');
          var caixaErro = doc.getElementById('item-' + item.id + '-quantidade-erro');
          if (caixaErro) caixaErro.textContent = '';
          renderJustificativa(item, cartao, bloqueado);
          atualizarRodape();
        });
        cartao.appendChild(campoComRotulo('item-' + item.id + '-quantidade', 'quantidade', 'Quantidade aprovada', quantidade, item.id, 'De 1 até ' + item.quantidade + ' (a solicitada).'));
      }
      cartao.appendChild(no('div', { 'data-bloco': 'justificativa' }));
      renderJustificativa(item, cartao, bloqueado);
      return cartao;
    }

    /** Só a justificativa muda ao digitar a quantidade: o campo da quantidade não é refeito (nem perde o foco). */
    function renderJustificativa(item, cartao, bloqueado) {
      var bloco = cartao.querySelector('[data-bloco="justificativa"]');
      var d = an.decisoes[item.id];
      var motivos = motivosDaJustificativa(item, d);
      var base = 'item-' + item.id + '-justificativa';
      var atual = bloco.querySelector('textarea');
      var chave = motivos.length === 0 ? '' : chaveDosMotivos(motivos);
      if (atual && atual.getAttribute('data-motivo') === chave) return;
      bloco.textContent = '';
      if (motivos.length === 0) return;
      var justificativa = no('textarea', {
        class: 'input campo-texto-longo', rows: 2, maxlength: JUSTIFICATIVA_MAXIMA, required: true, disabled: bloqueado, 'data-motivo': chave,
      });
      justificativa.value = d.justificativa;
      justificativa.addEventListener('input', function () {
        d.justificativa = justificativa.value;
        limparErro(item.id, 'justificativa');
        justificativa.removeAttribute('aria-invalid');
        var caixaErro = doc.getElementById(base + '-erro');
        if (caixaErro) caixaErro.textContent = '';
      });
      bloco.appendChild(campoComRotulo(base, 'justificativa', ROTULO_JUSTIFICATIVA[chave], justificativa, item.id));
    }

    function renderItens() {
      var caixa = $('analiseItens');
      caixa.textContent = '';
      var lista = no('div', { class: 'itens-analise' });
      an.dados.itens.forEach(function (item, i) { lista.appendChild(cartaoDoItem(item, i)); });
      caixa.appendChild(lista);
      atualizarRodape();
    }

    function atualizarRodape() {
      var botao = $('botaoConcluirAnalise');
      var pronto = an.dados !== null && an.decidivel;
      botao.disabled = !pronto || an.enviando;
      if (an.enviando) botao.setAttribute('aria-busy', 'true'); else botao.removeAttribute('aria-busy');
      $('rotuloConcluir').textContent = an.enviando ? 'Enviando…' : 'Concluir análise';
      var previsto = an.dados === null ? null : resultadoPrevisto(an.dados.itens, an.decisoes);
      var caixa = $('resultadoPrevisto');
      if (!pronto) caixa.textContent = '';
      else caixa.textContent = previsto === null ? 'Decida todos os itens para concluir.' : 'Resultado previsto: ' + ROTULO_RESULTADO[previsto];
    }

    function registrarErros(erros) {
      an.erros = {};
      erros.forEach(function (e) {
        an.erros[e.itemId] = an.erros[e.itemId] || {};
        if (!an.erros[e.itemId][e.campo]) an.erros[e.itemId][e.campo] = e.mensagem;
      });
    }

    function focarPrimeiroErro(erros) {
      for (var i = 0; i < erros.length; i += 1) {
        var e = erros[i];
        var alvo = e.campo === 'decisao'
          ? doc.querySelector('#analiseItens [data-item-id="' + e.itemId + '"] input[type="radio"]')
          : doc.getElementById('item-' + e.itemId + '-' + e.campo);
        if (alvo) { alvo.focus(); return; }
      }
    }

    function concluir() {
      if (encerrada || an.enviando || !an.decidivel || an.dados === null) return Promise.resolve();
      aviso($('avisoAnalise'), null);
      var itens = an.dados.itens;
      var v = validar(itens, an.decisoes, cap);
      if (!v.ok) {
        registrarErros(v.erros);
        renderItens();
        aviso($('avisoAnalise'), 'erro', 'Revise os itens destacados.');
        focarPrimeiroErro(v.erros);
        return Promise.resolve();
      }
      an.erros = {};
      var id = an.id;
      var numero = an.dados.solicitacao.numero;
      an.enviando = true;
      renderItens();
      return S().acoes.decidir(id, v.corpo).then(function (r) {
        an.enviando = false;
        if (encerrada) return undefined;
        if (r.ok) {
          var status = r.dados && r.dados.solicitacao ? r.dados.solicitacao.status : null;
          return encerrarAnaliseComAviso('Pedido nº ' + numero + ' analisado: ' + (ROTULO_RESULTADO[status] || S().ROTULOS_STATUS[status] || status) + '.', 'sucesso');
        }
        if (sessao(r)) return undefined;
        if (r.status === 0) {
          renderItens();
          aviso($('avisoAnalise'), 'erro', 'Não foi possível confirmar se a decisão foi registrada. A fila foi atualizada: confira o pedido antes de tentar de novo.');
          return carregarFila();
        }
        if (r.codigo === 'SOLICITACAO_NAO_PENDENTE' || r.codigo === 'SOLICITACAO_ALTERADA' || r.status === 404) {
          return encerrarAnaliseComAviso(textoDoErro(r));
        }
        if (r.codigo === 'AUTODECISAO_PROIBIDA') {
          an.bloqueada = true;
          an.decidivel = false;
          renderItens();
          aviso($('avisoAnalise'), 'atencao', TEXTOS.AUTODECISAO_PROIBIDA);
          return undefined;
        }
        var erros = camposDoServidor(r, v.corpo.decisoes);
        renderItens();
        if (erros.length > 0) {
          registrarErros(erros);
          renderItens();
          aviso($('avisoAnalise'), 'erro', 'Revise os itens destacados.');
          focarPrimeiroErro(erros);
          return undefined;
        }
        aviso($('avisoAnalise'), 'erro', textoDoErro(r));
        return undefined;
      });
    }

    /** Os erros de campo de um 400, no item certo (o índice é o do corpo enviado). */
    function camposDoServidor(r, enviadas) {
      if (r.status !== 400 || !Array.isArray(r.detalhes)) return [];
      var erros = [];
      r.detalhes.forEach(function (det) {
        var m = det && typeof det.campo === 'string' ? /^body\.decisoes\[(\d+)\]\.(quantidadeAprovada|justificativa|decisao)$/.exec(det.campo) : null;
        if (m && enviadas[Number(m[1])]) {
          var itemId = enviadas[Number(m[1])].itemId;
          if (m[2] === 'justificativa' && an.decisoes[itemId]) an.decisoes[itemId].exigidaPeloServidor = true;
          erros.push({ itemId: itemId, campo: m[2] === 'quantidadeAprovada' ? 'quantidade' : m[2], mensagem: textoDoCodigo(det.codigo) });
        }
      });
      return erros;
    }

    // ── ciclo da tela ────────────────────────────────────────────────

    function ligar() {
      $('botaoAtualizarFila').addEventListener('click', function () { aviso($('avisoFila'), null); return carregarFila(); });
      $('filaAnterior').addEventListener('click', function () { if (fila.pagina > 1) { fila.pagina -= 1; return carregarFila(); } return undefined; });
      $('filaProxima').addEventListener('click', function () { fila.pagina += 1; return carregarFila(); });
      $('botaoFecharAnalise').addEventListener('click', function () { limparAnalise(); $('tituloFila').focus(); });
      $('botaoConcluirAnalise').addEventListener('click', concluir);
    }

    function iniciar() {
      limparAnalise();
      ligar();
      return carregarFila();
    }

    /** Sessão encerrada ou trocada: nada do que estava na tela fica nela. */
    function encerrar() {
      encerrada = true;
      fila.seq += 1;
      an.seq += 1;
      an.dados = null;
      an.decisoes = {};
      ['listaFila', 'analiseItens', 'analiseResumo', 'avisoFila', 'avisoAnalise', 'resultadoPrevisto'].forEach(function (id) { $(id).textContent = ''; });
      $('analiseTitulo').textContent = 'Análise';
      mostrar($('analiseConteudo'), false);
    }

    return {
      iniciar: iniciar, encerrar: encerrar, abrirAnalise: abrirAnalise, concluir: concluir, carregarFila: carregarFila,
    };
  }

  global.EpiAprovacaoSst = {
    rascunho: {
      novaDecisao: novaDecisao, motivosDaJustificativa: motivosDaJustificativa, resultadoPrevisto: resultadoPrevisto, criadaPor: criadaPor, validar: validar,
    },
    criarTela: criarTela,
    TEXTOS: TEXTOS,
    DECISOES: DECISOES,
    JUSTIFICATIVA_MAXIMA: JUSTIFICATIVA_MAXIMA,
    LIMITE_FILA: LIMITE_FILA,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.EpiAprovacaoSst;
  }
})(typeof window !== 'undefined' ? window : globalThis);
