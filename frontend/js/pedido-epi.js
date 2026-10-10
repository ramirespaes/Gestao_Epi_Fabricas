(function (global) {
  'use strict';

  /**
   * EpiPedidoEpi — a tela Pedido de EPI (Bloco 12, 12G-2), só sobre os
   * contratos da 12F e da 12G-0 (EpiSolicitacoesEpi):
   *   - o trabalhador vem da busca de contexto (empresa da sessão, nunca CPF);
   *   - os EPIs são só os previstos no GHE dele (previstoNoGhe=true): o GHE dá
   *     o direito, o estoque não; nenhum número de estoque aparece;
   *   - cada item tem EPI, tamanho (só quando o EPI exige; sugestões do
   *     servidor, sem esconder nada), quantidade, motivo e justificativa (só no
   *     "Outro", obrigatória);
   *   - o envio é idempotente (EpiFicha.idempotencia: a mesma chave enquanto o
   *     rascunho não muda) e um clique só vira um POST;
   *   - "Meus pedidos", o detalhe e o cancelamento usam as rotas do próprio
   *     solicitante.
   *
   * O QUE APARECE vem das permissões efetivas (EpiSolicitacoesEpi.capacidades):
   * criar mostra o formulário; visualizar mostra "Meus pedidos"; editar
   * oferece o cancelamento do pedido pendente. O servidor decide tudo de novo.
   *
   * Tudo é montado com createElement e textContent: o que vem do servidor é
   * sempre texto. Nada vai para armazenamento do navegador.
   */

  var LIMITE_PEDIDOS = 10;
  var LIMITE_TRABALHADORES = 20;
  var LIMITE_MATERIAIS = 100;
  var PAGINAS_MATERIAIS = 10;

  function S() { return global.EpiSolicitacoesEpi; }
  function E() { return global.EpiEstadoPagina; }
  function F() { return global.EpiFicha; }

  // ───────────────────────────────────────────────────────────────────
  // Rascunho (sem DOM)
  // ───────────────────────────────────────────────────────────────────

  var sequencia = 0;
  function novoItem() {
    sequencia += 1;
    return {
      chave: sequencia, materialId: null, tamanho: '', quantidade: '1', motivo: '', justificativa: '',
    };
  }

  // A criação recusa o EPI ainda sem a classificação de tamanho (exigeTamanho nulo).
  var TEXTO_NAO_CLASSIFICADO = 'Este EPI ainda não pode ser pedido: falta definir no cadastro de Materiais se ele usa tamanho.';
  function classificado(m) { return m.exigeTamanho === true || m.exigeTamanho === false; }

  function aparado(v) { return typeof v === 'string' ? v.trim().normalize('NFC') : ''; }
  function comprimento(t) { return Array.from(t).length; }

  /**
   * Valida o rascunho como o servidor validaria (ele revalida tudo) e monta o
   * corpo do POST sem a chave. `materiais` é o mapa id -> material carregado
   * para o trabalhador. Erros: [{item: chave | null, campo, mensagem}].
   */
  function validar(r) {
    var L = S().LIMITES_PEDIDO;
    var texto = S().mensagens.doCodigo;
    var erros = [];
    var erro = function (item, campo, mensagem) { erros.push({ item: item, campo: campo, mensagem: mensagem }); };
    if (!r.funcionario) erro(null, 'funcionario', 'Escolha o trabalhador.');
    if (r.itens.length < 1 || r.itens.length > L.itens) erro(null, 'itens', texto('ITENS_FORA_DO_LIMITE'));
    var vistos = {};
    var itens = r.itens.map(function (it, i) {
      var material = it.materialId === null ? null : (r.materiais[it.materialId] || null);
      if (material === null) erro(it.chave, 'materialId', 'Escolha o EPI.');
      else if (!classificado(material)) erro(it.chave, 'materialId', TEXTO_NAO_CLASSIFICADO);
      var tamanho = null;
      if (material !== null && material.exigeTamanho === true) {
        var t = aparado(it.tamanho);
        if (t === '') erro(it.chave, 'tamanho', texto('TAMANHO_OBRIGATORIO'));
        else if (comprimento(t) > L.tamanho) erro(it.chave, 'tamanho', texto('TAMANHO_INVALIDO'));
        else tamanho = t;
      }
      var q = aparado(String(it.quantidade));
      var quantidade = /^\d+$/.test(q) ? Number(q) : NaN;
      if (!(quantidade >= 1 && quantidade <= L.quantidade)) erro(it.chave, 'quantidade', texto('QUANTIDADE_INVALIDA'));
      if (S().MOTIVOS.indexOf(it.motivo) === -1) erro(it.chave, 'motivo', 'Escolha o motivo.');
      var justificativa = null;
      if (it.motivo === 'OUTRO') {
        var j = aparado(it.justificativa);
        if (j === '') erro(it.chave, 'justificativa', texto('JUSTIFICATIVA_OBRIGATORIA'));
        else if (comprimento(j) > L.justificativa) erro(it.chave, 'justificativa', texto('JUSTIFICATIVA_INVALIDA'));
        else justificativa = j;
      }
      if (material !== null && (material.exigeTamanho !== true || tamanho !== null)) {
        var par = material.id + '\n' + (tamanho || '');
        if (Object.prototype.hasOwnProperty.call(vistos, par)) {
          erro(it.chave, 'materialId', 'Este EPI' + (tamanho ? ' neste tamanho' : '') + ' já está no item ' + vistos[par] + '.');
        } else {
          vistos[par] = i + 1;
        }
      }
      return {
        materialId: material === null ? null : material.id, tamanho: tamanho, quantidade: quantidade, motivo: it.motivo, justificativa: justificativa,
      };
    });
    var observacao = aparado(r.observacao);
    if (comprimento(observacao) > L.observacao) erro(null, 'observacao', texto('OBSERVACAO_INVALIDA'));
    if (erros.length > 0) return { ok: false, erros: erros };
    return { ok: true, corpo: { funcionarioId: r.funcionario.id, itens: itens, observacao: observacao === '' ? null : observacao } };
  }

  // ───────────────────────────────────────────────────────────────────
  // Tela
  // ───────────────────────────────────────────────────────────────────

  var CORES_AVISO = {
    erro: 'background:var(--error-container);color:var(--error);border-color:rgba(255,59,48,0.2)',
    sucesso: 'background:rgba(52,199,89,0.10);color:#1A7A35;border-color:rgba(52,199,89,0.25)',
  };

  function plural(n, um, varios) { return n + ' ' + (n === 1 ? um : varios); }

  /**
   * @param {{capacidades: object, aoSessaoEncerrada: Function, documento?: object}} o
   */
  function criarTela(o) {
    var doc = o.documento || global.document;
    var $ = function (id) { return doc.getElementById(id); };
    var cap = o.capacidades;
    var L = S().LIMITES_PEDIDO;
    var encerrada = false;
    var est = {
      funcionario: null, materiais: {}, ordem: [], materiaisProntos: false, itens: [], erros: {}, enviando: false,
      idem: F().idempotencia.novoEstado(), seqBusca: 0, seqMateriais: 0,
    };
    var lista = {
      status: '', pagina: 1, total: 0, seq: 0,
    };
    var det = {
      id: null, dados: null, seq: 0, cancelando: false,
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

    // ── trabalhador ──────────────────────────────────────────────────

    function resumoTrabalhador(f) {
      return [f.matricula ? 'Matrícula ' + f.matricula : null, f.setor, f.funcao].filter(function (x) { return typeof x === 'string' && x !== ''; }).join(' · ');
    }

    function buscar(evento) {
      if (evento && typeof evento.preventDefault === 'function') evento.preventDefault();
      if (encerrada) return Promise.resolve();
      var caixa = $('resultadoTrabalhadores');
      var seq = ++est.seqBusca;
      mostrar(caixa, true);
      E().mostrar(caixa, E().TIPOS.CARREGANDO, 'Buscando trabalhadores…');
      return S().acoes.contextoFuncionarios({ busca: $('buscaTrabalhador').value, limite: LIMITE_TRABALHADORES }).then(function (r) {
        if (encerrada || seq !== est.seqBusca) return;
        if (!r.ok) {
          if (!sessao(r)) E().mostrar(caixa, E().TIPOS.ERRO, S().mensagens.deErro(r));
          return;
        }
        var trabalhadores = r.dados.funcionarios;
        if (trabalhadores.length === 0) {
          E().mostrar(caixa, E().TIPOS.VAZIO, 'Nenhum trabalhador ativo encontrado. Confira o nome ou a matrícula.');
          return;
        }
        caixa.textContent = '';
        var opcoes = no('ul', { class: 'trabalhador-opcoes', 'aria-label': 'Trabalhadores encontrados' });
        trabalhadores.forEach(function (f) {
          var botao = no('button', { type: 'button', class: 'request-item trabalhador-opcao', 'data-funcionario-id': f.id }, [
            no('span', { class: 'request-meta' }, [no('strong', { texto: f.nome }), no('span', { texto: resumoTrabalhador(f) })]),
          ]);
          botao.addEventListener('click', function () { return escolherTrabalhador(f); });
          opcoes.appendChild(no('li', {}, [botao]));
        });
        caixa.appendChild(opcoes);
        if (r.dados.total > trabalhadores.length) {
          caixa.appendChild(no('p', { class: 'dica', texto: 'Mostrando ' + trabalhadores.length + ' de ' + r.dados.total + '. Refine a busca pelo nome ou pela matrícula.' }));
        }
      });
    }

    function escolherTrabalhador(f) {
      est.funcionario = {
        id: f.id, nome: f.nome, matricula: f.matricula, setor: f.setor, funcao: f.funcao,
      };
      $('trabalhadorNome').textContent = f.nome;
      $('trabalhadorDados').textContent = resumoTrabalhador(f);
      mostrar($('formBuscaTrabalhador'), false);
      mostrar($('resultadoTrabalhadores'), false);
      mostrar($('trabalhadorSelecionado'), true);
      mostrar($('blocoItens'), true);
      aviso($('avisoNovaSolicitacao'), null);
      return carregarMateriais(false);
    }

    function trocarTrabalhador() {
      est.funcionario = null;
      est.seqMateriais += 1;
      est.materiais = {};
      est.ordem = [];
      est.materiaisProntos = false;
      est.itens = [];
      est.erros = {};
      $('listaItens').textContent = '';
      $('observacaoPedido').value = '';
      mostrarPendentes([]);
      mostrar($('trabalhadorSelecionado'), false);
      mostrar($('blocoItens'), false);
      mostrar($('formBuscaTrabalhador'), true);
      mostrar($('resultadoTrabalhadores'), false);
      aviso($('avisoNovaSolicitacao'), null);
      atualizarBotoes();
      $('buscaTrabalhador').focus();
    }

    // ── EPIs do trabalhador ──────────────────────────────────────────

    function lerPaginas(funcionarioId, pagina, acumulado) {
      return S().acoes.contextoMateriais(funcionarioId, { previstoNoGhe: true, pagina: pagina, limite: LIMITE_MATERIAIS }).then(function (r) {
        if (!r.ok) return r;
        var todos = acumulado.concat(r.dados.materiais);
        if (todos.length < r.dados.total && r.dados.materiais.length > 0 && pagina < PAGINAS_MATERIAIS) return lerPaginas(funcionarioId, pagina + 1, todos);
        return { ok: true, materiais: todos };
      });
    }

    /** EPIs do GHE que a criação recusaria por falta da classificação de tamanho: aparecem, mas não são escolhíveis. */
    function mostrarPendentes(nomes) {
      var caixa = $('materiaisPendentes');
      caixa.textContent = nomes.length === 0 ? ''
        : 'Ainda não podem ser pedidos, porque falta definir no cadastro de Materiais se usam tamanho: ' + nomes.join('; ') + '.';
      mostrar(caixa, nomes.length > 0);
    }

    /** `preservar`: recarrega a lista e mantém os itens cujo EPI continua disponível. */
    function carregarMateriais(preservar) {
      var seq = ++est.seqMateriais;
      var estado = $('estadoMateriais');
      est.materiaisProntos = false;
      mostrarPendentes([]);
      if (!preservar) {
        est.itens = [novoItem()];
        est.erros = {};
        est.idem = F().idempotencia.novoEstado();
        $('observacaoPedido').value = '';
      }
      mostrar($('listaItens'), false);
      atualizarBotoes();
      E().mostrar(estado, E().TIPOS.CARREGANDO, 'Carregando os EPIs previstos para este trabalhador…');
      return lerPaginas(est.funcionario.id, 1, []).then(function (r) {
        if (encerrada || seq !== est.seqMateriais) return;
        if (!r.ok) {
          if (!sessao(r)) E().mostrar(estado, E().TIPOS.ERRO, S().mensagens.deErro(r));
          return;
        }
        est.materiais = {};
        est.ordem = [];
        var pendentes = [];
        r.materiais.forEach(function (m) {
          if (!classificado(m)) { pendentes.push(m.nome); return; }
          var copia = {
            id: m.id, nome: m.nome, unidade: m.unidade, exigeTamanho: m.exigeTamanho, tamanhosSugeridos: Array.isArray(m.tamanhosSugeridos) ? m.tamanhosSugeridos.slice() : [],
          };
          est.materiais[m.id] = copia;
          est.ordem.push(copia);
        });
        mostrarPendentes(pendentes);
        est.itens.forEach(function (it) { if (it.materialId !== null && !est.materiais[it.materialId]) { it.materialId = null; it.tamanho = ''; } });
        if (est.ordem.length === 0) {
          E().mostrar(estado, E().TIPOS.VAZIO, pendentes.length > 0
            ? 'O GHE deste trabalhador tem ' + plural(pendentes.length, 'EPI', 'EPIs') + ', mas nenhum pode ser pedido ainda. Fale com a Segurança do Trabalho.'
            : 'Nenhum EPI está previsto no GHE deste trabalhador. Fale com a Segurança do Trabalho para revisar o GHE.');
          atualizarBotoes();
          return;
        }
        E().limpar(estado);
        est.materiaisProntos = true;
        mostrar($('listaItens'), true);
        renderItens();
        atualizarBotoes();
      });
    }

    // ── itens ────────────────────────────────────────────────────────

    function erroDe(chave, campo) { return est.erros[chave] && est.erros[chave][campo] ? est.erros[chave][campo] : ''; }
    function limparErro(it, campo, controle) {
      if (est.erros[it.chave]) delete est.erros[it.chave][campo];
      if (controle) controle.removeAttribute('aria-invalid');
      var caixa = $('item-' + it.chave + '-' + campo + '-erro');
      if (caixa) caixa.textContent = '';
    }

    function campoComRotulo(it, campo, rotulo, controle, dica, inteiro) {
      var base = 'item-' + it.chave + '-' + campo;
      var ids = [];
      var filhos = [no('label', { for: base, texto: rotulo }), controle];
      if (dica) { filhos.push(no('p', { id: base + '-dica', class: 'dica', texto: dica })); ids.push(base + '-dica'); }
      filhos.push(no('p', { id: base + '-erro', class: 'campo-erro', 'data-erro': campo, texto: erroDe(it.chave, campo) }));
      ids.push(base + '-erro');
      controle.setAttribute('id', base);
      controle.setAttribute('data-campo', campo);
      controle.setAttribute('aria-describedby', ids.join(' '));
      if (erroDe(it.chave, campo)) controle.setAttribute('aria-invalid', 'true');
      return no('div', { class: inteiro ? 'field full' : 'field' }, filhos);
    }

    function linhaItem(it, indice) {
      var material = it.materialId === null ? null : est.materiais[it.materialId] || null;
      var grupo = no('div', {
        class: 'form-grid epi-item item-pedido', 'data-item': it.chave, role: 'group', 'aria-labelledby': 'item-' + it.chave + '-titulo',
      });
      grupo.appendChild(no('p', { id: 'item-' + it.chave + '-titulo', class: 'item-titulo field full', texto: 'Item ' + (indice + 1) }));

      var epi = no('select', { class: 'select' }, [no('option', { value: '', texto: 'Escolha o EPI' })].concat(est.ordem.map(function (m) {
        return no('option', { value: m.id, texto: m.nome + ' (' + m.unidade + ')' });
      })));
      epi.value = material === null ? '' : String(material.id);
      epi.addEventListener('change', function () {
        it.materialId = epi.value === '' ? null : Number(epi.value);
        var escolhido = it.materialId === null ? null : est.materiais[it.materialId];
        if (!escolhido || escolhido.exigeTamanho !== true) it.tamanho = '';
        if (est.erros[it.chave]) { delete est.erros[it.chave].materialId; delete est.erros[it.chave].tamanho; }
        renderItens();
        $('item-' + it.chave + '-materialId').focus();
      });
      grupo.appendChild(campoComRotulo(it, 'materialId', 'EPI necessário', epi));

      if (material !== null && material.exigeTamanho === true) {
        var lista = 'item-' + it.chave + '-tamanhos';
        var tamanho = no('input', {
          class: 'input', type: 'text', maxlength: L.tamanho, list: lista, autocomplete: 'off', placeholder: 'Ex.: 40, M, G', required: true,
        });
        tamanho.value = it.tamanho;
        tamanho.addEventListener('input', function () { it.tamanho = tamanho.value; limparErro(it, 'tamanho', tamanho); });
        var dica = material.tamanhosSugeridos.length > 0 ? 'Escolha uma sugestão ou digite o tamanho.' : 'Digite o tamanho.';
        var campoTamanho = campoComRotulo(it, 'tamanho', 'Tamanho', tamanho, dica);
        campoTamanho.appendChild(no('datalist', { id: lista }, material.tamanhosSugeridos.map(function (t) { return no('option', { value: t }); })));
        grupo.appendChild(campoTamanho);
      } else if (material !== null) {
        grupo.appendChild(no('div', { class: 'field' }, [no('span', { class: 'rotulo-campo', texto: 'Tamanho' }), no('p', { class: 'dica', texto: 'Este EPI não usa tamanho.' })]));
      }

      var quantidade = no('input', {
        class: 'input', type: 'number', min: 1, step: 1, inputmode: 'numeric', required: true,
      });
      quantidade.value = it.quantidade;
      quantidade.addEventListener('input', function () { it.quantidade = quantidade.value; limparErro(it, 'quantidade', quantidade); });
      grupo.appendChild(campoComRotulo(it, 'quantidade', 'Quantidade', quantidade));

      var motivo = no('select', { class: 'select', required: true }, [no('option', { value: '', texto: 'Selecione o motivo' })].concat(S().MOTIVOS.map(function (m) {
        return no('option', { value: m, texto: S().ROTULOS_MOTIVO[m] });
      })));
      motivo.value = it.motivo;
      motivo.addEventListener('change', function () {
        var mudouOutro = (motivo.value === 'OUTRO') !== (it.motivo === 'OUTRO');
        it.motivo = motivo.value;
        if (est.erros[it.chave]) { delete est.erros[it.chave].motivo; if (it.motivo !== 'OUTRO') delete est.erros[it.chave].justificativa; }
        if (mudouOutro) {
          renderItens();
          $('item-' + it.chave + '-motivo').focus();
        } else {
          limparErro(it, 'motivo', motivo);
        }
      });
      grupo.appendChild(campoComRotulo(it, 'motivo', 'Motivo', motivo));

      if (it.motivo === 'OUTRO') {
        var justificativa = no('textarea', {
          class: 'input campo-texto-longo', rows: 2, maxlength: L.justificativa, required: true,
        });
        justificativa.value = it.justificativa;
        justificativa.addEventListener('input', function () { it.justificativa = justificativa.value; limparErro(it, 'justificativa', justificativa); });
        grupo.appendChild(campoComRotulo(it, 'justificativa', 'Justificativa (obrigatória no motivo "Outro")', justificativa, null, true));
      }

      var remover = no('button', {
        type: 'button', class: 'remove-epi-btn', 'data-acao': 'remover-item', 'aria-label': 'Remover o item ' + (indice + 1), disabled: est.itens.length === 1 || est.enviando,
      }, ['Remover']);
      remover.addEventListener('click', function () {
        if (est.itens.length === 1) return;
        est.itens = est.itens.filter(function (x) { return x !== it; });
        delete est.erros[it.chave];
        renderItens();
        atualizarBotoes();
        $('botaoAdicionarItem').focus();
      });
      grupo.appendChild(no('div', { class: 'field full epi-item-actions' }, [remover]));
      return grupo;
    }

    function renderItens() {
      var caixa = $('listaItens');
      caixa.textContent = '';
      est.itens.forEach(function (it, i) { caixa.appendChild(linhaItem(it, i)); });
      var obs = $('observacaoPedido');
      var erroObs = est.erros.geral && est.erros.geral.observacao ? est.erros.geral.observacao : '';
      $('observacaoPedido-erro').textContent = erroObs;
      if (erroObs) obs.setAttribute('aria-invalid', 'true'); else obs.removeAttribute('aria-invalid');
    }

    function adicionarItem() {
      if (!est.materiaisProntos || est.enviando || est.itens.length >= L.itens) return;
      var it = novoItem();
      est.itens.push(it);
      renderItens();
      atualizarBotoes();
      $('item-' + it.chave + '-materialId').focus();
    }

    function limparRascunho() {
      est.itens = [novoItem()];
      est.erros = {};
      est.idem = F().idempotencia.novoEstado();
      $('observacaoPedido').value = '';
      renderItens();
      atualizarBotoes();
    }

    function atualizarBotoes() {
      var adicionar = $('botaoAdicionarItem');
      var enviar = $('botaoEnviarPedido');
      adicionar.disabled = !est.materiaisProntos || est.enviando || est.itens.length >= L.itens;
      $('limiteItens').textContent = est.materiaisProntos && est.itens.length >= L.itens ? 'Limite de ' + L.itens + ' itens por pedido.' : '';
      $('botaoLimparPedido').disabled = !est.funcionario || est.enviando;
      enviar.disabled = !est.materiaisProntos || est.enviando;
      if (est.enviando) enviar.setAttribute('aria-busy', 'true'); else enviar.removeAttribute('aria-busy');
      $('rotuloEnviarPedido').textContent = est.enviando ? 'Enviando…' : 'Enviar pedido';
    }

    // ── envio ────────────────────────────────────────────────────────

    function registrarErros(erros) {
      est.erros = {};
      erros.forEach(function (e) {
        var chave = e.item === null ? 'geral' : e.item;
        est.erros[chave] = est.erros[chave] || {};
        if (!est.erros[chave][e.campo]) est.erros[chave][e.campo] = e.mensagem;
      });
    }

    function focarPrimeiroErro(erros) {
      for (var i = 0; i < erros.length; i += 1) {
        var e = erros[i];
        var alvo = e.item === null ? (e.campo === 'observacao' ? $('observacaoPedido') : null) : $('item-' + e.item + '-' + e.campo);
        if (alvo) { alvo.focus(); return; }
      }
    }

    function errosGerais(erros) {
      return erros.filter(function (e) { return e.item === null && e.campo !== 'observacao'; }).map(function (e) { return e.mensagem; });
    }

    function enviar() {
      if (encerrada || est.enviando || !est.funcionario || !est.materiaisProntos) return Promise.resolve();
      aviso($('avisoNovaSolicitacao'), null);
      var v = validar({
        funcionario: est.funcionario, materiais: est.materiais, itens: est.itens, observacao: $('observacaoPedido').value,
      });
      if (!v.ok) {
        registrarErros(v.erros);
        renderItens();
        var gerais = errosGerais(v.erros);
        aviso($('avisoNovaSolicitacao'), 'erro', gerais.length > 0 ? gerais.join(' ') : 'Revise os campos destacados.');
        focarPrimeiroErro(v.erros);
        return Promise.resolve();
      }
      est.erros = {};
      renderItens();
      var corpo = {
        funcionarioId: v.corpo.funcionarioId, itens: v.corpo.itens, observacao: v.corpo.observacao, chaveIdempotencia: F().idempotencia.chavePara(est.idem, v.corpo),
      };
      est.enviando = true;
      atualizarBotoes();
      return S().acoes.criar(corpo).then(function (r) {
        est.enviando = false;
        if (encerrada) return undefined;
        atualizarBotoes();
        return tratarEnvio(r);
      });
    }

    function tratarEnvio(r) {
      var caixa = $('avisoNovaSolicitacao');
      if (r.ok) {
        var numero = r.dados && r.dados.solicitacao ? r.dados.solicitacao.numero : '';
        limparRascunho();
        aviso(caixa, 'sucesso', r.dados.repetida
          ? 'Este pedido já tinha sido enviado (pedido nº ' + numero + '). Nenhum pedido novo foi criado.'
          : 'Pedido nº ' + numero + ' enviado. A Segurança do Trabalho vai analisar.');
        if (cap.verMinhas) { lista.pagina = 1; return carregarMinhas(); }
        return undefined;
      }
      if (sessao(r)) return undefined;
      if (r.status === 0) {
        aviso(caixa, 'erro', 'Não foi possível confirmar se o pedido foi enviado. Não altere os dados e tente de novo: o mesmo pedido não será duplicado.');
        return undefined;
      }
      var campos = S().mensagens.deCampos(r);
      if (campos.length > 0) {
        var erros = [];
        campos.forEach(function (c) {
          var m = /^body\.itens\[(\d+)\]\.(materialId|tamanho|quantidade|motivo|justificativa)$/.exec(c.campo);
          if (m && est.itens[Number(m[1])]) erros.push({ item: est.itens[Number(m[1])].chave, campo: m[2], mensagem: c.mensagem });
          else if (c.campo === 'body.observacao') erros.push({ item: null, campo: 'observacao', mensagem: c.mensagem });
          else erros.push({ item: null, campo: 'geral', mensagem: c.mensagem });
        });
        registrarErros(erros);
        renderItens();
        var gerais = errosGerais(erros);
        aviso(caixa, 'erro', gerais.length > 0 ? gerais.join(' ') : 'Revise os campos destacados.');
        focarPrimeiroErro(erros);
        return undefined;
      }
      aviso(caixa, 'erro', S().mensagens.deErro(r));
      if (['MATERIAL_NAO_ENCONTRADO', 'MATERIAL_INATIVO', 'MATERIAL_TAMANHO_NAO_CLASSIFICADO'].indexOf(r.codigo) !== -1) return carregarMateriais(true);
      return undefined;
    }

    // ── meus pedidos ─────────────────────────────────────────────────

    function paginacao(texto, anterior, proxima) {
      $('paginacaoPedidosTexto').textContent = texto;
      $('paginaAnteriorPedidos').disabled = !anterior;
      $('paginaProximaPedidos').disabled = !proxima;
    }

    function carregarMinhas() {
      if (!cap.verMinhas || encerrada) return Promise.resolve();
      var seq = ++lista.seq;
      var caixa = $('listaPedidos');
      E().mostrar(caixa, E().TIPOS.CARREGANDO, 'Carregando seus pedidos…');
      paginacao('—', false, false);
      var filtro = { pagina: lista.pagina, limite: LIMITE_PEDIDOS };
      if (lista.status) filtro.status = lista.status;
      return S().acoes.minhas(filtro).then(function (r) {
        if (encerrada || seq !== lista.seq) return;
        if (!r.ok) {
          if (!sessao(r)) E().mostrar(caixa, E().TIPOS.ERRO, S().mensagens.deErro(r));
          return;
        }
        lista.total = r.dados.total;
        var paginas = Math.max(1, Math.ceil(lista.total / LIMITE_PEDIDOS));
        paginacao('Página ' + lista.pagina + ' de ' + paginas + ' · ' + plural(lista.total, 'pedido', 'pedidos'), lista.pagina > 1, lista.pagina < paginas);
        if (r.dados.solicitacoes.length === 0) {
          E().mostrar(caixa, E().TIPOS.VAZIO, lista.status ? 'Nenhum pedido nesta situação.' : 'Você ainda não fez pedidos de EPI.');
          return;
        }
        caixa.textContent = '';
        var ul = no('ul', { class: 'pedido-linhas', 'aria-label': 'Meus pedidos' });
        r.dados.solicitacoes.forEach(function (s) {
          var trabalhador = s.funcionario ? s.funcionario.nome + (s.funcionario.matricula ? ' (matrícula ' + s.funcionario.matricula + ')' : '') : '';
          var botao = no('button', { type: 'button', class: 'request-item pedido-linha', 'data-solicitacao-id': s.id }, [
            no('span', { class: 'request-meta' }, [
              no('strong', { texto: 'Pedido nº ' + s.numero }),
              no('span', { texto: dataHora(s.criadaEm) + ' · ' + trabalhador }),
              no('span', { texto: plural(s.quantidadeItens, 'item', 'itens') + ' · ' + plural(s.quantidades.solicitada, 'unidade', 'unidades') }),
            ]),
            no('span', { class: 'request-status', 'data-status': s.status, texto: S().ROTULOS_STATUS[s.status] || s.status }),
          ]);
          botao.addEventListener('click', function () { return abrirDetalhe(s.id); });
          ul.appendChild(no('li', {}, [botao]));
        });
        caixa.appendChild(ul);
      });
    }

    // ── detalhe e cancelamento ───────────────────────────────────────

    function par(dl, rotulo, valor) {
      if (valor === null || valor === undefined || valor === '') return;
      dl.appendChild(no('dt', { texto: rotulo }));
      dl.appendChild(no('dd', { texto: valor }));
    }

    function decisaoDoItem(i, unidade) {
      if (i.decisao === 'APROVADO') return 'Aprovado: ' + i.quantidadeAprovada + ' ' + unidade + (i.quantidadeEntregue > 0 ? ' · Entregue: ' + i.quantidadeEntregue : '');
      if (i.decisao === 'REPROVADO') return 'Reprovado' + (i.justificativaDecisao ? ' · ' + i.justificativaDecisao : '');
      return 'Aguardando a decisão da Segurança do Trabalho';
    }

    function itemDoDetalhe(i) {
      var nome = i.material ? i.material.nome : 'EPI';
      var unidade = i.material ? i.material.unidade : '';
      var linhas = [
        'Tamanho: ' + (i.tamanho || 'não se aplica'),
        'Quantidade: ' + i.quantidade + (unidade ? ' ' + unidade : ''),
        'Motivo: ' + (S().ROTULOS_MOTIVO[i.motivo] || i.motivo),
      ];
      if (i.justificativa) linhas.push('Justificativa: ' + i.justificativa);
      linhas.push(decisaoDoItem(i, unidade));
      return no('li', { class: 'request-item item-detalhe' }, [
        no('span', { class: 'request-meta' }, [no('strong', { texto: nome })].concat(linhas.map(function (l) { return no('span', { texto: l }); }))),
      ]);
    }

    function renderDetalhe() {
      var s = det.dados.solicitacao;
      $('detalheTitulo').textContent = 'Pedido nº ' + s.numero;
      var caixa = $('detalheConteudo');
      caixa.textContent = '';
      mostrar(caixa, true);
      var dl = no('dl', { class: 'detalhe-pedido' });
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
      if (s.decisao) par(dl, 'Decidido em', dataHora(s.decisao.decididaEm) + (s.decisao.decisor ? ' por ' + s.decisao.decisor.nome : ''));
      if (s.cancelamento) par(dl, 'Cancelado em', dataHora(s.cancelamento.canceladaEm) + (s.cancelamento.justificativa ? ' · ' + s.cancelamento.justificativa : ''));
      if (s.entregueEm) par(dl, 'Entregue em', dataHora(s.entregueEm));
      if (s.encerramento) {
        par(dl, 'Encerrado em', dataHora(s.encerramento.encerradaEm) + (s.encerramento.encerrador ? ' por ' + s.encerramento.encerrador.nome : '')
          + (s.encerramento.justificativa ? ' · ' + s.encerramento.justificativa : ''));
      }
      caixa.appendChild(dl);
      caixa.appendChild(no('h3', { class: 'detalhe-subtitulo', texto: 'Itens' }));
      caixa.appendChild(no('ul', { class: 'pedido-linhas' }, det.dados.itens.map(itemDoDetalhe)));
      mostrar($('botaoCancelarPedido'), podeCancelar());
      mostrar($('confirmacaoCancelamento'), false);
    }

    function podeCancelar() { return cap.cancelar === true && det.dados !== null && det.dados.solicitacao.status === 'PENDENTE'; }

    function abrirDetalhe(id) {
      if (encerrada) return Promise.resolve();
      var seq = ++det.seq;
      det.id = id;
      det.dados = null;
      mostrar($('detalhePedido'), true);
      $('detalheTitulo').textContent = 'Pedido';
      aviso($('avisoDetalhe'), null);
      mostrar($('botaoCancelarPedido'), false);
      mostrar($('confirmacaoCancelamento'), false);
      E().mostrar($('detalheConteudo'), E().TIPOS.CARREGANDO, 'Carregando o pedido…');
      return S().acoes.detalhe(id).then(function (r) {
        if (encerrada || seq !== det.seq) return;
        if (!r.ok) {
          if (!sessao(r)) E().mostrar($('detalheConteudo'), E().TIPOS.ERRO, S().mensagens.deErro(r));
          return;
        }
        det.dados = r.dados;
        renderDetalhe();
        $('detalheTitulo').focus();
      });
    }

    function fecharDetalhe() {
      det.seq += 1;
      det.id = null;
      det.dados = null;
      mostrar($('detalhePedido'), false);
    }

    function pedirCancelamento() {
      if (!podeCancelar()) return;
      $('justificativaCancelamento').value = '';
      mostrar($('confirmacaoCancelamento'), true);
      $('justificativaCancelamento').focus();
    }

    function voltarCancelamento() {
      mostrar($('confirmacaoCancelamento'), false);
      $('botaoCancelarPedido').focus();
    }

    function confirmarCancelamento() {
      if (det.cancelando || !podeCancelar()) return Promise.resolve();
      var justificativa = aparado($('justificativaCancelamento').value);
      if (comprimento(justificativa) > L.justificativaCancelamento) {
        aviso($('avisoDetalhe'), 'erro', S().mensagens.doCodigo('JUSTIFICATIVA_INVALIDA'));
        return Promise.resolve();
      }
      var id = det.id;
      var numero = det.dados.solicitacao.numero;
      det.cancelando = true;
      $('botaoConfirmarCancelamento').disabled = true;
      $('botaoConfirmarCancelamento').setAttribute('aria-busy', 'true');
      return S().acoes.cancelar(id, { justificativa: justificativa === '' ? null : justificativa }).then(function (r) {
        det.cancelando = false;
        $('botaoConfirmarCancelamento').disabled = false;
        $('botaoConfirmarCancelamento').removeAttribute('aria-busy');
        if (encerrada) return undefined;
        if (r.ok) {
          return Promise.all([abrirDetalhe(id), carregarMinhas()]).then(function () {
            aviso($('avisoDetalhe'), 'sucesso', 'Pedido nº ' + numero + ' cancelado.');
          });
        }
        if (sessao(r)) return undefined;
        var mensagem = S().mensagens.deErro(r);
        if (r.status === 409 || r.status === 404) {
          return Promise.all([abrirDetalhe(id), carregarMinhas()]).then(function () { aviso($('avisoDetalhe'), 'erro', mensagem); });
        }
        aviso($('avisoDetalhe'), 'erro', mensagem);
        return undefined;
      });
    }

    // ── ciclo da tela ────────────────────────────────────────────────

    function ligar() {
      $('formBuscaTrabalhador').addEventListener('submit', buscar);
      $('botaoTrocarTrabalhador').addEventListener('click', trocarTrabalhador);
      $('botaoAdicionarItem').addEventListener('click', adicionarItem);
      $('botaoLimparPedido').addEventListener('click', function () { limparRascunho(); aviso($('avisoNovaSolicitacao'), null); });
      $('botaoEnviarPedido').addEventListener('click', enviar);
      $('observacaoPedido').addEventListener('input', function () {
        if (est.erros.geral) delete est.erros.geral.observacao;
        $('observacaoPedido').removeAttribute('aria-invalid');
        $('observacaoPedido-erro').textContent = '';
      });
      $('filtroStatusPedidos').addEventListener('change', function () {
        lista.status = $('filtroStatusPedidos').value;
        lista.pagina = 1;
        return carregarMinhas();
      });
      $('paginaAnteriorPedidos').addEventListener('click', function () { if (lista.pagina > 1) { lista.pagina -= 1; return carregarMinhas(); } return undefined; });
      $('paginaProximaPedidos').addEventListener('click', function () { lista.pagina += 1; return carregarMinhas(); });
      $('botaoFecharDetalhe').addEventListener('click', fecharDetalhe);
      $('botaoCancelarPedido').addEventListener('click', pedirCancelamento);
      $('botaoVoltarCancelamento').addEventListener('click', voltarCancelamento);
      $('botaoConfirmarCancelamento').addEventListener('click', confirmarCancelamento);
    }

    function iniciar() {
      mostrar($('cardNovaSolicitacao'), cap.criar === true);
      mostrar($('cardMeusPedidos'), cap.verMinhas === true);
      mostrar($('detalhePedido'), false);
      $('observacaoPedido').setAttribute('maxlength', String(L.observacao));
      $('justificativaCancelamento').setAttribute('maxlength', String(L.justificativaCancelamento));
      var filtro = $('filtroStatusPedidos');
      filtro.textContent = '';
      filtro.appendChild(no('option', { value: '', texto: 'Todas as situações' }));
      S().STATUS.forEach(function (s) { filtro.appendChild(no('option', { value: s, texto: S().ROTULOS_STATUS[s] })); });
      filtro.value = '';
      atualizarBotoes();
      ligar();
      return carregarMinhas();
    }

    /** Sessão encerrada ou trocada: nada do que estava na tela fica nela. */
    function encerrar() {
      encerrada = true;
      est.seqBusca += 1;
      est.seqMateriais += 1;
      lista.seq += 1;
      det.seq += 1;
      est.funcionario = null;
      est.itens = [];
      est.materiais = {};
      est.ordem = [];
      ['resultadoTrabalhadores', 'listaItens', 'estadoMateriais', 'materiaisPendentes', 'listaPedidos', 'detalheConteudo', 'avisoNovaSolicitacao', 'avisoDetalhe'].forEach(function (id) { $(id).textContent = ''; });
      mostrar($('materiaisPendentes'), false);
      $('trabalhadorNome').textContent = '';
      $('trabalhadorDados').textContent = '';
      $('observacaoPedido').value = '';
      $('justificativaCancelamento').value = '';
      $('buscaTrabalhador').value = '';
      mostrar($('detalhePedido'), false);
    }

    return {
      iniciar: iniciar, encerrar: encerrar, buscar: buscar, enviar: enviar, abrirDetalhe: abrirDetalhe,
    };
  }

  global.EpiPedidoEpi = {
    rascunho: { novoItem: novoItem, validar: validar },
    criarTela: criarTela,
    LIMITE_PEDIDOS: LIMITE_PEDIDOS,
    LIMITE_TRABALHADORES: LIMITE_TRABALHADORES,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.EpiPedidoEpi;
  }
})(typeof window !== 'undefined' ? window : globalThis);
