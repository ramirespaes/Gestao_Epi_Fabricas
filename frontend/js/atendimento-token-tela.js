(function (global) {
  'use strict';

  /**
   * EpiAtendimentoTokenTela — a Central Administrativa do Atendimento Token (Etapa H, bloco frontend): seis abas numa só
   * página (Visão Geral, Dispositivos, Ativação, Monitoramento, Prévia e Testes, Histórico), sobre as rotas reais das Etapas
   * B, C e H do backend. Liga o DOM de pages/atendimento-token.html aos contratos de js/atendimento-token.js.
   *
   * SEGURANÇA. Só apresentação: o servidor decide cada operação de novo (sessão, permissão, empresa). Texto sempre por
   * textContent (nunca innerHTML). Nada vai para localStorage, sessionStorage, cookie, URL ou console. O CÓDIGO DE ATIVAÇÃO
   * existe só na memória do QR exibido (uma variável desta tela): nunca é escrito como texto, atributo ou registro, e é
   * descartado quando a janela do QR fecha, a pessoa sai da aba Ativação, o prazo termina, a página é recarregada ou
   * encerrada, ou a sessão acaba.
   *
   * Monitoramento e Histórico são só a estrutura da Etapa J: nenhuma chamada, nenhum dado.
   */

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var MARGEM_QR = 4;
  var PREVIA_LIMITE_BUSCA = 20;
  var CAMINHO_PREVIA_TOTEM = '../totem/previa.html';
  var CANAL_PREVIA = 'safework-previa-totem';
  var ID_CONSULTA = /^[A-Za-z0-9-]{8,64}$/;
  var CONTROLE_TEXTO = /[\u0000-\u001f\u007f-\u009f]/;

  var TEXTOS = {
    PREVIA_AVISO: 'Prévia administrativa, somente leitura: mostra o que o tablet exibiria para o funcionário escolhido. Não abre atendimento, não cria pedido, reserva nem entrega e não é o atendimento real.',
    PREVIA_SEM_BUSCA: 'Para escolher o funcionário é preciso a permissão de consultar o cadastro de funcionários. Sem ela, a busca não está disponível.',
    PREVIA_NAO_ATIVO: 'Só funcionário ativo pode ser usado na prévia.',
    PREVIA_VER: 'Ver prévia',
    PREVIA_FECHAR: 'Fechar prévia',
    ATIVACAO_SEM_LISTA: 'Para escolher o dispositivo é preciso a permissão de visualizar dispositivos.',
    ATIVACAO_ORIENTACAO: 'O código aparece uma única vez, em QR, logo depois de gerado. Vale por até 10 minutos e só pode ser usado uma vez. Se a janela for fechada antes de o tablet ler o QR, gere uma nova ativação.',
    REDES_ORIENTACAO: 'O tablet só atende se o servidor enxergar o pedido vindo de um IP autorizado aqui. Informe o IP exato (por exemplo, o IP fixo de saída da internet da unidade). Faixas, máscaras e túneis não são aceitos.',
    REDES_VAZIAS: 'Nenhuma rede autorizada. Enquanto não houver uma, nenhum tablet consegue usar o atendimento.',
    MONITORAMENTO: 'O acompanhamento da comunicação dos tablets (sinal de vida, situação e alertas) será ligado na Etapa J. Em integração: nenhum dado é exibido ainda.',
    HISTORICO: 'O histórico de eventos dos dispositivos e dos atendimentos será ligado na Etapa J. Em integração: nenhum dado é exibido ainda.',
    LISTA_INCOMPLETA: 'A lista tem mais itens do que a tela consegue carregar de uma vez. O que aparece pode estar incompleto.',
    RESPOSTA_INESPERADA: 'O servidor respondeu em um formato inesperado. Tente novamente mais tarde.',
    SESSAO_QR: 'O código de ativação foi descartado.',
    QR_EXPIRADO: 'O prazo do código terminou e ele foi descartado. Gere uma nova ativação.',
    QR_INDISPONIVEL: 'Não foi possível desenhar o QR neste navegador. O código foi descartado; recarregue a página e gere uma nova ativação.',
    NADA_ALTERADO: 'Nada foi alterado.',
    GHE_SEM_CODIGO: 'Sem código (cadastro anterior)',
    CONSULTA_AGUARDANDO: 'Digite o CPF ou a matrícula no Totem abaixo. O resultado aparece aqui.',
    CONSULTA_NAO_IDENTIFICADO: 'Colaborador não identificado. Confira o CPF ou a matrícula.',
    CONSULTA_LIMITE: 'Muitas consultas em pouco tempo. Aguarde um minuto e tente de novo.',
    CONSULTA_SEM_PERMISSAO: 'Sem permissão para a consulta real.',
    CONSULTA_ERRO: 'Não foi possível consultar agora. Tente novamente.',
    POSSUI_TAMANHOS: 'Possui tamanhos',
    SEM_TAMANHO: 'Sem tamanho',
    ULTIMA_REDE:'Este é o ÚNICO IP autorizado da empresa. Ao desativá-lo, TODOS os tablets perdem o acesso imediatamente.',
  };

  function criar(o) {
    var T = global.EpiAtendimentoToken;
    var E = global.EpiEstadoPagina;
    if (!T) throw new Error('EpiAtendimentoToken não carregado: inclua js/atendimento-token.js antes de js/atendimento-token-tela.js');
    if (!E) throw new Error('EpiEstadoPagina não carregado: inclua js/estado-pagina.js antes de js/atendimento-token-tela.js');

    var doc = o.documento || global.document;
    var janela = o.janela || global;
    var cap = o.capacidades;
    var agora = typeof o.agora === 'function' ? o.agora : function () { return Date.now(); };
    var aoSessaoEncerrada = typeof o.aoSessaoEncerrada === 'function' ? o.aoSessaoEncerrada : function () {};

    var estado = {
      encerrada: false,
      aba: null,
      seq: {},
      carregado: {},
      dispositivos: { pagina: 1, itens: [], total: 0 },
      todosDispositivos: [],
      redes: { itens: [], incompleta: false },
      selecionado: null,
      ativacaoEstado: null,
      ocupado: {},
      modais: [],
      qr: null,
      previaFuncionario: null,
      previaAberta: null,
      busca: [],
      modoPrevia: 'demo',
      ponte: { gen: 0, frame: null, ouvinte: null, emAndamento: false },
    };
    // A caixa da prévia é uma só: vai para dentro do item do funcionário escolhido e volta ao seu lugar de origem (`caixaPai`) ao fechar.
    var caixaPai = null;
    var itensDaBusca = {};

    // ─── DOM ──────────────────────────────────────────────────────────
    function $(id) { return doc.getElementById(id); }
    function limpar(el) { while (el.firstChild) el.removeChild(el.firstChild); }
    function h(tag, props, filhos) {
      var el = doc.createElement(tag);
      var p = props || {};
      Object.keys(p).forEach(function (k) {
        if (k === 'texto') el.textContent = p[k];
        else if (k === 'classe') el.setAttribute('class', p[k]);
        else el.setAttribute(k, p[k]);
      });
      (filhos || []).forEach(function (f) { if (f) el.appendChild(typeof f === 'string' ? doc.createTextNode(f) : f); });
      return el;
    }
    function mostrar(el) { if (el) el.style.display = ''; }
    function ocultar(el) { if (el) el.style.display = 'none'; }
    function define(el, visivel) { if (visivel) mostrar(el); else ocultar(el); }

    function textoOu(v) { return v === null || v === undefined || v === '' ? '—' : String(v); }

    function aviso(id, tipo, texto) {
      var caixa = $(id);
      limpar(caixa);
      if (!texto) { ocultar(caixa); return; }
      var cor = tipo === 'erro' ? 'background:var(--error-container);color:var(--error);border-color:rgba(255,59,48,0.2)'
        : 'background:rgba(52,199,89,0.10);color:#1A7A35;border-color:rgba(52,199,89,0.25)';
      caixa.appendChild(h('div', { classe: 'notice', style: cor, role: tipo === 'erro' ? 'alert' : 'status', texto: texto }));
      mostrar(caixa);
    }

    function painelEstado(nome, tipo, mensagem) {
      var caixa = $('estado-' + nome);
      if (tipo === null) { E.limpar(caixa); return; }
      E.mostrar(caixa, tipo, mensagem);
    }

    // Falha de leitura de um painel: 401 leva ao Portal; o resto vira o estado de erro com texto conhecido.
    function falhaDeLeitura(nome, r) {
      if (T.mensagens.exigeNovoLogin(r)) { sessaoExpirou(); return; }
      var negado = r && r.status === 403;
      painelEstado(nome, negado ? E.TIPOS.ACESSO_NEGADO : E.TIPOS.ERRO, negado ? T.POR_CODIGO.PERMISSAO_NEGADA : T.mensagens.deErro(r));
    }

    function sessaoExpirou() {
      if (estado.encerrada) return;
      aoSessaoEncerrada();
    }

    function proximaSeq(chave) { estado.seq[chave] = (estado.seq[chave] || 0) + 1; return estado.seq[chave]; }
    function vigente(chave, minha) { return !estado.encerrada && estado.seq[chave] === minha; }

    // ─── Modais ───────────────────────────────────────────────────────
    function abrirModal(id, aoFechar, foco) {
      var el = $(id);
      estado.modais.push({ id: id, aoFechar: aoFechar || null, retorno: doc.activeElement || null });
      el.classList.add('open');
      el.setAttribute('aria-hidden', 'false');
      var alvo = foco ? $(foco) : null;
      if (alvo && typeof alvo.focus === 'function') alvo.focus();
    }
    function fecharModal(id, semCallback) {
      var i = estado.modais.map(function (m) { return m.id; }).lastIndexOf(id);
      if (i === -1) return;
      var m = estado.modais.splice(i, 1)[0];
      var el = $(id);
      el.classList.remove('open');
      el.setAttribute('aria-hidden', 'true');
      if (!semCallback && m.aoFechar) m.aoFechar();
      if (m.retorno && typeof m.retorno.focus === 'function' && estado.modais.length === 0) m.retorno.focus();
    }
    function aoTeclar(evento) {
      if (evento && evento.key === 'Escape' && estado.modais.length > 0) {
        fecharModal(estado.modais[estado.modais.length - 1].id);
      }
    }

    // ─── Abas ─────────────────────────────────────────────────────────
    function abasPermitidas() { return T.ABAS.filter(function (a) { return cap.abas[a] === true; }); }

    // A aba aberta fica no fragmento da URL (#aba=<nome>) para sobreviver a F5/Cmd+R e ao histórico do navegador. Só o NOME de uma aba
    // conhecida: nunca CPF, matrícula, token, carrinho ou qualquer dado da prévia. O fragmento não vai ao servidor, e a permissão é
    // reavaliada aqui: nome desconhecido é ignorado e aba sem permissão cai na aba padrão, sem montar o conteúdo restrito.
    function abaPadrao() { return cap.abas.visaoGeral === true ? 'visaoGeral' : (abasPermitidas()[0] || null); }

    function abaDoEndereco() {
      var hash = janela.location && typeof janela.location.hash === 'string' ? janela.location.hash : '';
      var m = /^#aba=([A-Za-z]{1,30})$/.exec(hash);
      return m && T.ABAS.indexOf(m[1]) !== -1 ? m[1] : null;
    }

    function gravarAbaNoEndereco(nome, substituir) {
      var h5 = janela.history;
      if (!h5 || !janela.location || janela.location.hash === '#aba=' + nome) return;
      var metodo = substituir ? 'replaceState' : 'pushState';
      if (typeof h5[metodo] !== 'function') return;
      try { h5[metodo](null, '', '#aba=' + nome); } catch (e) { /* sem histórico: a aba só não sobrevive à atualização */ }
    }

    function aoMudarEndereco() {
      if (estado.encerrada) return;
      var pedida = abaDoEndereco();
      var destino = pedida !== null && cap.abas[pedida] === true ? pedida : abaPadrao();
      if (pedida !== null && destino !== pedida && destino !== null) gravarAbaNoEndereco(destino, true);
      if (destino !== null && destino !== estado.aba) mostrarAba(destino, false, false);
    }

    function mostrarAba(nome, comFoco, registrar) {
      if (estado.encerrada || !cap.abas[nome]) return;
      if (registrar === true && nome !== estado.aba) gravarAbaNoEndereco(nome, false);
      if (estado.aba === 'ativacao' && nome !== 'ativacao') descartarQr();
      if (estado.aba === 'visualizarTotem' && nome !== 'visualizarTotem') sairDaPreviaTotem();
      estado.aba = nome;
      T.ABAS.forEach(function (a) {
        var botao = $('aba-' + a);
        var ativa = a === nome;
        botao.classList.toggle('active', ativa);
        botao.setAttribute('aria-selected', ativa ? 'true' : 'false');
        botao.setAttribute('tabindex', ativa ? '0' : '-1');
        define($('painel-' + a), ativa && cap.abas[a] === true);
      });
      if (comFoco) $('aba-' + nome).focus();
      carregarAba(nome, false);
    }

    // ─── Visualizar Totem (K7) ────────────────────────────────────────
    // O iframe só existe com a aba aberta. Sandbox só com scripts, sem mesma origem: a prévia roda em origem opaca, sem acesso a
    // cookies, armazenamento nem a esta página. A prévia não chama a API (previa-adaptador.js responde tudo em memória).
    // Consulta real: o iframe não tem credencial nem rede. Ele pede a identificação por postMessage; ESTA tela, que tem a sessão
    // administrativa, consulta o servidor e devolve só o primeiro nome e o catálogo. O identificador digitado vive numa variável local
    // até a chamada terminar: nunca vai a armazenamento, URL, console, cartão nem resposta.
    function consultaRealPermitida() { return cap.previa === true && cap.buscarFuncionario === true; }
    function objetoSimples(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
    function mesmasChaves(objeto, esperadas) {
      var chaves = Object.keys(objeto).sort();
      return chaves.length === esperadas.length && chaves.every(function (c, i) { return c === esperadas[i]; });
    }

    function enderecoDaPrevia() {
      if (estado.modoPrevia !== 'real') return CAMINHO_PREVIA_TOTEM;
      return CAMINHO_PREVIA_TOTEM + '?modo=real&pai=' + encodeURIComponent(janela.location && janela.location.origin);
    }

    function montarPreviaTotem() {
      var quadro = $('totemPreviaQuadro');
      if (!quadro || quadro.firstChild) return;
      var f = doc.createElement('iframe');
      f.setAttribute('src', enderecoDaPrevia());
      f.setAttribute('sandbox', 'allow-scripts');
      f.setAttribute('referrerpolicy', 'no-referrer');
      f.setAttribute('title', estado.modoPrevia === 'real' ? 'Prévia visual do Totem, consulta real' : 'Prévia visual do Totem, com dados fictícios');
      quadro.appendChild(f);
      if (estado.modoPrevia === 'real') ligarPonte(f);
    }

    function descartarPreviaTotem() {
      desligarPonte();
      var quadro = $('totemPreviaQuadro');
      if (quadro) limpar(quadro);
      limparCartao();
    }

    function ligarPonte(f) {
      desligarPonte();
      var gen = estado.ponte.gen;
      estado.ponte.frame = f;
      estado.ponte.ouvinte = function (ev) { return aoMensagemDoQuadro(ev, gen); };
      janela.addEventListener('message', estado.ponte.ouvinte);
    }

    function desligarPonte() {
      if (estado.ponte.ouvinte) janela.removeEventListener('message', estado.ponte.ouvinte);
      estado.ponte.ouvinte = null;
      estado.ponte.frame = null;
      estado.ponte.emAndamento = false;
      estado.ponte.gen += 1; // respostas de consultas de um iframe descartado nunca são entregues
    }

    function mensagemDeIdentificacaoValida(m) {
      return objetoSimples(m) && mesmasChaves(m, ['canal', 'id', 'tipo', 'tipoId', 'valor', 'versao'])
        && m.canal === CANAL_PREVIA && m.versao === 1 && m.tipo === 'IDENTIFICAR'
        && typeof m.id === 'string' && ID_CONSULTA.test(m.id)
        && (m.tipoId === 'CPF' || m.tipoId === 'MATRICULA')
        && typeof m.valor === 'string' && m.valor.length > 0 && Array.from(m.valor).length <= 30 && !CONTROLE_TEXTO.test(m.valor);
    }

    function responderAoQuadro(f, id, extra) {
      if (estado.ponte.frame !== f || !f.contentWindow) return;
      var m = { canal: CANAL_PREVIA, versao: 1, tipo: 'RESULTADO', id: id };
      Object.keys(extra).forEach(function (k) { m[k] = extra[k]; });
      // A origem do iframe é opaca: o destino é a janela exata deste iframe, não uma origem.
      f.contentWindow.postMessage(m, '*');
    }

    function mostrarCartao(d) {
      $('crMensagem').textContent = '';
      $('crColaborador').textContent = d.primeiroNome;
      $('crGhe').textContent = d.ghe === null ? 'Sem GHE' : (d.ghe.codigo !== null ? d.ghe.codigo : TEXTOS.GHE_SEM_CODIGO) + ' — ' + d.ghe.descricao;
      $('crGheSituacao').textContent = d.ghe === null ? '—' : (d.ghe.ativo ? 'Ativo' : 'Inativo');
      $('crCatalogo').textContent = T.ESTADOS_CATALOGO[d.catalogo.estado];
      $('crTotal').textContent = String(d.catalogo.total);
      var lista = $('crMateriais');
      limpar(lista);
      d.catalogo.materiais.forEach(function (m) {
        var li = doc.createElement('li');
        li.textContent = m.nome + (m.tipo ? ' · ' + m.tipo.nome : '') + ' · ' + (m.exigeTamanho ? TEXTOS.POSSUI_TAMANHOS : TEXTOS.SEM_TAMANHO);
        lista.appendChild(li);
      });
    }

    function limparCartao(mensagem) {
      ['crColaborador', 'crGhe', 'crGheSituacao', 'crCatalogo', 'crTotal'].forEach(function (id) { var el = $(id); if (el) el.textContent = '—'; });
      var lista = $('crMateriais');
      if (lista) limpar(lista);
      var m = $('crMensagem');
      if (m) m.textContent = mensagem || '';
    }

    async function aoMensagemDoQuadro(ev, gen) {
      if (estado.encerrada || gen !== estado.ponte.gen) return;
      var f = estado.ponte.frame;
      if (!f || !f.contentWindow || !ev || ev.source !== f.contentWindow || ev.origin !== 'null') return;
      var m = ev.data;
      if (!mensagemDeIdentificacaoValida(m) || estado.ponte.emAndamento) return;
      estado.ponte.emAndamento = true;
      var id = m.id;
      var r;
      try {
        r = await T.acoes.previaIdentificar(m.tipoId, m.valor);
      } catch (e) {
        r = null;
      }
      m = null;
      if (estado.encerrada || gen !== estado.ponte.gen) return;
      estado.ponte.emAndamento = false;
      if (r && T.mensagens.exigeNovoLogin(r)) { sessaoExpirou(); return; }
      if (r && r.ok) {
        var d = T.modelo.previaIdentificar(r.dados);
        if (d !== null) {
          mostrarCartao(d);
          responderAoQuadro(f, id, { resultado: 'OK', primeiroNome: d.primeiroNome, catalogo: d.catalogo });
          return;
        }
        limparCartao(TEXTOS.CONSULTA_ERRO);
        responderAoQuadro(f, id, { resultado: 'INDISPONIVEL' });
        return;
      }
      var status = r ? r.status : 0;
      if (status === 404) { limparCartao(TEXTOS.CONSULTA_NAO_IDENTIFICADO); responderAoQuadro(f, id, { resultado: 'NAO_IDENTIFICADO' }); return; }
      if (status === 429) { limparCartao(TEXTOS.CONSULTA_LIMITE); responderAoQuadro(f, id, { resultado: 'LIMITE' }); return; }
      limparCartao(status === 403 ? TEXTOS.CONSULTA_SEM_PERMISSAO : TEXTOS.CONSULTA_ERRO);
      responderAoQuadro(f, id, { resultado: 'INDISPONIVEL' });
    }

    function aplicarModoPrevia() {
      var real = estado.modoPrevia === 'real';
      $('modoPreviaDemo').checked = !real;
      $('modoPreviaReal').checked = real;
      define($('avisoPreviaDemo'), !real);
      define($('previaTotemCodigos'), !real);
      define($('avisoPreviaReal'), real);
      define($('cartaoConsultaReal'), real);
      if (real) limparCartao(TEXTOS.CONSULTA_AGUARDANDO);
    }

    function trocarModoPrevia(modo) {
      if (modo === 'real' && !consultaRealPermitida()) modo = 'demo';
      if (estado.modoPrevia === modo) { aplicarModoPrevia(); return; }
      descartarPreviaTotem();
      estado.modoPrevia = modo;
      aplicarModoPrevia();
      montarPreviaTotem();
    }

    function sairDaPreviaTotem() {
      descartarPreviaTotem();
      estado.modoPrevia = 'demo';
      aplicarModoPrevia();
    }

    function carregarAba(nome, forcar) {
      if (nome === 'visualizarTotem') { montarPreviaTotem(); return Promise.resolve(); }
      if (!forcar && estado.carregado[nome]) return Promise.resolve();
      estado.carregado[nome] = true;
      if (nome === 'visaoGeral') return carregarVisaoGeral();
      if (nome === 'dispositivos') return carregarDispositivos();
      if (nome === 'ativacao') return carregarAtivacao();
      if (nome === 'previa') { montarPrevia(); return Promise.resolve(); }
      if (nome === 'monitoramento') { painelEstado('monitoramento', E.TIPOS.EM_INTEGRACAO, TEXTOS.MONITORAMENTO); return Promise.resolve(); }
      if (nome === 'historico') { painelEstado('historico', E.TIPOS.EM_INTEGRACAO, TEXTOS.HISTORICO); return Promise.resolve(); }
      return Promise.resolve();
    }

    function invalidar() {
      // O que foi alterado muda os números da visão geral e a lista de ativação; relê na próxima vez que a aba abrir.
      estado.carregado.visaoGeral = false;
      if (estado.aba !== 'ativacao') estado.carregado.ativacao = false;
    }

    function aoTeclarNasAbas(evento) {
      var lista = abasPermitidas();
      var i = lista.indexOf(estado.aba);
      var k = evento && evento.key;
      var destino = null;
      if (k === 'ArrowRight') destino = lista[(i + 1) % lista.length];
      else if (k === 'ArrowLeft') destino = lista[(i - 1 + lista.length) % lista.length];
      else if (k === 'Home') destino = lista[0];
      else if (k === 'End') destino = lista[lista.length - 1];
      if (destino) { if (evento.preventDefault) evento.preventDefault(); mostrarAba(destino, true, true); }
    }

    // ─── Visão Geral ──────────────────────────────────────────────────
    async function carregarVisaoGeral() {
      var minha = proximaSeq('visaoGeral');
      ocultar($('conteudo-visaoGeral'));
      painelEstado('visaoGeral', E.TIPOS.CARREGANDO, 'Carregando a visão geral…');
      var r = await T.acoes.visaoGeral();
      if (!vigente('visaoGeral', minha)) return;
      if (!r.ok) { estado.carregado.visaoGeral = false; falhaDeLeitura('visaoGeral', r); return; }
      var v = T.modelo.visaoGeral(r.dados);
      if (v === null) { estado.carregado.visaoGeral = false; painelEstado('visaoGeral', E.TIPOS.ERRO, TEXTOS.RESPOSTA_INESPERADA); return; }
      painelEstado('visaoGeral', null);
      var grade = $('visaoGeralCartoes');
      limpar(grade);
      // Tom e ícone são só apresentação: o significado vem sempre do título em texto (a cor nunca é o único indicador).
      [
        ['Dispositivos cadastrados', v.dispositivos.cadastrados, 'azul', 'tablet_android'],
        ['Dispositivos ativos', v.dispositivos.ativos, 'verde', 'check_circle'],
        ['Aguardando ativação', v.dispositivos.pendentes, 'laranja', 'hourglass_top'],
        ['Dispositivos revogados', v.dispositivos.revogados, 'vermelho', 'block'],
        ['Ativações pendentes', v.ativacoesPendentes, 'roxo', 'qr_code_2'],
      ].forEach(function (c) {
        grade.appendChild(h('div', { classe: 'stat stat-token', 'data-cartao': c[0], 'data-tom': c[2] }, [
          h('div', { classe: 'stat-token-topo' }, [h('span', { texto: c[0] }), h('i', { classe: 'stat-token-icone', 'aria-hidden': 'true', 'data-icone': c[3] })]),
          h('strong', { texto: String(c[1]) }),
        ]));
      });
      $('visaoGeralSituacao').textContent = T.SITUACOES_GERAIS[v.situacaoGeral];
      $('visaoGeralSituacao').setAttribute('data-situacao', v.situacaoGeral);
      mostrar($('conteudo-visaoGeral'));
    }

    // ─── Dispositivos ─────────────────────────────────────────────────
    function distintivoSituacao(situacao) {
      var classe = situacao === 'ATIVO' ? 'badge badge-ok' : (situacao === 'REVOGADO' ? 'badge badge-danger' : 'badge badge-warning');
      return h('span', { classe: classe, 'data-situacao': situacao, texto: T.SITUACOES_DISPOSITIVO[situacao] });
    }

    async function carregarDispositivos() {
      var minha = proximaSeq('dispositivos');
      ocultar($('conteudo-dispositivos'));
      painelEstado('dispositivos', E.TIPOS.CARREGANDO, 'Carregando os dispositivos…');
      var r = await T.acoes.listarDispositivos(estado.dispositivos.pagina, T.LIMITE_LISTA);
      if (!vigente('dispositivos', minha)) return;
      if (!r.ok) { estado.carregado.dispositivos = false; falhaDeLeitura('dispositivos', r); return; }
      var d = r.dados;
      var itens = d && Array.isArray(d.dispositivos) ? d.dispositivos.map(T.modelo.dispositivo) : null;
      if (itens === null || itens.indexOf(null) !== -1 || !Number.isInteger(d.total) || d.total < 0) {
        estado.carregado.dispositivos = false;
        painelEstado('dispositivos', E.TIPOS.ERRO, TEXTOS.RESPOSTA_INESPERADA);
        return;
      }
      if (itens.length === 0 && d.total > 0 && estado.dispositivos.pagina > 1) {
        estado.dispositivos.pagina -= 1;
        return carregarDispositivos();
      }
      estado.dispositivos.itens = itens;
      estado.dispositivos.total = d.total;
      desenharDispositivos();
    }

    function desenharDispositivos() {
      var corpo = $('corpoDispositivos');
      limpar(corpo);
      var itens = estado.dispositivos.itens;
      if (itens.length === 0) {
        painelEstado('dispositivos', E.TIPOS.VAZIO, cap.criar ? 'Nenhum dispositivo cadastrado. Use "Novo dispositivo" para cadastrar o primeiro tablet.' : 'Nenhum dispositivo cadastrado.');
        ocultar($('tabelaDispositivos'));
      } else {
        painelEstado('dispositivos', null);
        mostrar($('tabelaDispositivos'));
      }
      itens.forEach(function (d) {
        var acoesLinha = h('div', { classe: 'acoes-linha' });
        var abrir = h('button', { classe: 'outlined-btn', type: 'button', 'data-icone': cap.editar && d.situacao !== 'REVOGADO' ? 'edit' : 'visibility', 'data-acao': cap.editar && d.situacao !== 'REVOGADO' ? 'editar' : 'detalhes', 'data-dispositivo-id': String(d.id) });
        abrir.textContent = cap.editar && d.situacao !== 'REVOGADO' ? 'Editar' : 'Detalhes';
        acoesLinha.appendChild(abrir);
        if (cap.revogar && d.situacao !== 'REVOGADO') {
          acoesLinha.appendChild(h('button', { classe: 'outlined-btn perigo-texto', type: 'button', 'data-icone': 'block', 'data-acao': 'revogar', 'data-dispositivo-id': String(d.id), texto: 'Revogar' }));
        }
        corpo.appendChild(h('tr', { 'data-dispositivo-id': String(d.id) }, [
          h('td', {}, [h('strong', { texto: d.nome }), h('div', { classe: 'dica', texto: textoOu(d.localInstalacao) })]),
          h('td', { texto: [d.unidade, d.setor].filter(Boolean).join(' / ') || '—' }),
          h('td', {}, [distintivoSituacao(d.situacao)]),
          h('td', { texto: T.tempo.instante(d.ativadoEm) }),
          h('td', {}, [acoesLinha]),
        ]));
      });
      var paginaAtual = estado.dispositivos.pagina;
      var ultima = Math.max(1, Math.ceil(estado.dispositivos.total / T.LIMITE_LISTA));
      $('dispositivosPaginacaoTexto').textContent = estado.dispositivos.total === 0 ? '—' : 'Página ' + paginaAtual + ' de ' + ultima + ' · ' + estado.dispositivos.total + (estado.dispositivos.total === 1 ? ' dispositivo' : ' dispositivos');
      $('dispositivosAnterior').disabled = paginaAtual <= 1;
      $('dispositivosProxima').disabled = paginaAtual >= ultima;
      mostrar($('conteudo-dispositivos'));
    }

    function mudarPaginaDispositivos(delta) {
      var nova = estado.dispositivos.pagina + delta;
      if (nova < 1) return Promise.resolve();
      estado.dispositivos.pagina = nova;
      return carregarDispositivos();
    }

    // Formulário (cadastro, edição e detalhes no mesmo modal).
    var CAMPOS_FORM = T.formulario.CAMPOS;
    var modoForm = null;
    var dispositivoForm = null;

    function campoForm(c) { return $('nd-' + c); }

    function limparErrosForm() {
      CAMPOS_FORM.forEach(function (c) {
        $('nd-' + c + '-erro').textContent = '';
        campoForm(c).removeAttribute('aria-invalid');
      });
      aviso('avisoDispositivo', null, '');
    }
    function erroNoCampo(campo, mensagem) {
      $('nd-' + campo + '-erro').textContent = mensagem;
      campoForm(campo).setAttribute('aria-invalid', 'true');
    }
    function valoresForm() {
      var v = {};
      CAMPOS_FORM.forEach(function (c) { v[c] = campoForm(c).value; });
      return v;
    }

    function abrirFormulario(modo, dispositivo) {
      modoForm = modo;
      dispositivoForm = dispositivo || null;
      limparErrosForm();
      var somenteLeitura = modo === 'detalhes';
      CAMPOS_FORM.forEach(function (c) {
        campoForm(c).value = dispositivo && dispositivo[c] ? dispositivo[c] : '';
        campoForm(c).disabled = somenteLeitura;
      });
      $('tituloModalDispositivo').textContent = modo === 'criar' ? 'Novo dispositivo' : (modo === 'editar' ? 'Editar dispositivo' : 'Detalhes do dispositivo');
      $('descricaoModalDispositivo').textContent = modo === 'criar'
        ? 'Cadastre o tablet. A ativação é feita depois, na aba Ativação.'
        : (modo === 'editar' ? 'Altere os dados administrativos. A situação muda por ativação e por revogação, não por aqui.' : 'Somente leitura.');
      define($('botaoSalvarDispositivo'), !somenteLeitura);
      $('botaoSalvarDispositivo').disabled = false;
      $('botaoCancelarDispositivo').textContent = somenteLeitura ? 'Fechar' : 'Cancelar';
      var meta = $('detalheDispositivo');
      limpar(meta);
      if (dispositivo) {
        [['Situação', T.SITUACOES_DISPOSITIVO[dispositivo.situacao]], ['Ativado em', T.tempo.instante(dispositivo.ativadoEm)],
          ['Revogado em', T.tempo.instante(dispositivo.revogadoEm)], ['Cadastrado em', T.tempo.instante(dispositivo.criadoEm)],
          ['Atualizado em', T.tempo.instante(dispositivo.atualizadoEm)]].forEach(function (par) {
          meta.appendChild(h('dt', { texto: par[0] }));
          meta.appendChild(h('dd', { texto: par[1] }));
        });
        mostrar(meta);
      } else {
        ocultar(meta);
      }
      abrirModal('modalDispositivo', function () { modoForm = null; dispositivoForm = null; }, somenteLeitura ? 'botaoCancelarDispositivo' : 'nd-nome');
    }

    async function abrirDispositivo(id, preferirEdicao) {
      if (estado.ocupado.abrir) return;
      estado.ocupado.abrir = true;
      aviso('avisoDispositivos', null, '');
      var r = await T.acoes.consultarDispositivo(id);
      estado.ocupado.abrir = false;
      if (estado.encerrada) return;
      if (T.mensagens.exigeNovoLogin(r)) { sessaoExpirou(); return; }
      var d = r.ok && r.dados ? T.modelo.dispositivo(r.dados.dispositivo) : null;
      if (!r.ok || d === null) {
        aviso('avisoDispositivos', 'erro', r.ok ? TEXTOS.RESPOSTA_INESPERADA : T.mensagens.deErro(r));
        if (!r.ok && r.status === 404) carregarDispositivos();
        return;
      }
      abrirFormulario(preferirEdicao && cap.editar && d.situacao !== 'REVOGADO' ? 'editar' : 'detalhes', d);
    }

    async function salvarDispositivo() {
      if (estado.ocupado.salvar || (modoForm !== 'criar' && modoForm !== 'editar')) return;
      limparErrosForm();
      var valores = valoresForm();
      var erros = T.formulario.validar(valores);
      var comErro = CAMPOS_FORM.filter(function (c) { return erros[c]; });
      if (comErro.length > 0) {
        comErro.forEach(function (c) { erroNoCampo(c, erros[c]); });
        campoForm(comErro[0]).focus();
        return;
      }
      var corpo;
      if (modoForm === 'criar') {
        if (!cap.criar) return;
        corpo = T.formulario.corpoCriacao(valores);
      } else {
        if (!cap.editar) return;
        corpo = T.formulario.corpoEdicao(dispositivoForm, valores);
        if (Object.keys(corpo).length === 0) { aviso('avisoDispositivo', 'erro', TEXTOS.NADA_ALTERADO); return; }
      }
      estado.ocupado.salvar = true;
      $('botaoSalvarDispositivo').disabled = true;
      var criando = modoForm === 'criar';
      var r = criando ? await T.acoes.cadastrarDispositivo(corpo) : await T.acoes.editarDispositivo(dispositivoForm.id, corpo);
      estado.ocupado.salvar = false;
      if (estado.encerrada) return;
      if (T.mensagens.exigeNovoLogin(r)) { sessaoExpirou(); return; }
      if (r.ok) {
        fecharModal('modalDispositivo');
        invalidar();
        aviso('avisoDispositivos', 'sucesso', criando ? 'Dispositivo cadastrado. Gere a ativação na aba Ativação.' : 'Dispositivo atualizado.');
        if (criando) estado.dispositivos.pagina = 1;
        carregarDispositivos();
        return;
      }
      $('botaoSalvarDispositivo').disabled = false;
      var porCampo = T.mensagens.deCampos(r, CAMPOS_FORM);
      if (porCampo.length > 0) {
        porCampo.forEach(function (e) { erroNoCampo(e.campo, e.mensagem); });
        campoForm(porCampo[0].campo).focus();
        return;
      }
      aviso('avisoDispositivo', 'erro', T.mensagens.deErro(r));
      if (r.status === 404 || r.codigo === 'DISPOSITIVO_REVOGADO') carregarDispositivos();
    }

    // ─── Confirmação genérica (revogar, desativar rede, nova ativação) ─
    var confirmacao = null;

    function pedirConfirmacao(o2) {
      confirmacao = o2;
      $('tituloModalConfirmar').textContent = o2.titulo;
      var corpo = $('corpoModalConfirmar');
      limpar(corpo);
      (o2.paragrafos || []).forEach(function (p) { corpo.appendChild(h('p', { texto: p })); });
      if (o2.destaque) corpo.appendChild(h('div', { classe: 'notice destaque-perigo', role: 'alert', texto: o2.destaque }));
      aviso('avisoModalConfirmar', null, '');
      var botao = $('botaoConfirmar');
      botao.textContent = o2.rotuloConfirmar;
      botao.disabled = false;
      botao.classList.toggle('perigo', o2.perigo === true);
      abrirModal('modalConfirmar', function () { confirmacao = null; }, 'botaoCancelarConfirmar');
    }

    async function confirmar() {
      if (!confirmacao || estado.ocupado.confirmar) return;
      estado.ocupado.confirmar = true;
      $('botaoConfirmar').disabled = true;
      var atual = confirmacao;
      var resultado = await atual.executar();
      estado.ocupado.confirmar = false;
      if (estado.encerrada) return;
      if (resultado && resultado.ok) { fecharModal('modalConfirmar'); return; }
      $('botaoConfirmar').disabled = false;
      if (resultado && resultado.sessao) return;
      aviso('avisoModalConfirmar', 'erro', resultado && resultado.mensagem ? resultado.mensagem : T.mensagens.deErro(null));
    }

    // Revogação do dispositivo.
    function pedirRevogacao(id) {
      var d = estado.dispositivos.itens.filter(function (x) { return x.id === id; })[0];
      if (!d || !cap.revogar || d.situacao === 'REVOGADO') return;
      pedirConfirmacao({
        titulo: 'Revogar "' + d.nome + '"?',
        paragrafos: [
          'O tablet perde o acesso imediatamente, a credencial é invalidada, a ativação pendente é cancelada e qualquer atendimento aberto nele é encerrado.',
          'A revogação não pode ser desfeita: o dispositivo revogado não pode ser editado nem reativado. Para voltar a usar o equipamento, cadastre-o de novo.',
          'Isto é diferente de desativar um IP autorizado, que bloqueia a rede sem revogar a credencial do tablet.',
        ],
        rotuloConfirmar: 'Revogar dispositivo',
        perigo: true,
        executar: async function () {
          var r = await T.acoes.revogarDispositivo(id);
          if (estado.encerrada) return { ok: false, sessao: true };
          if (T.mensagens.exigeNovoLogin(r)) { sessaoExpirou(); return { ok: false, sessao: true }; }
          if (!r.ok) {
            if (r.status === 404) carregarDispositivos();
            return { ok: false, mensagem: T.mensagens.deErro(r) };
          }
          invalidar();
          aviso('avisoDispositivos', 'sucesso', r.dados && r.dados.alterado === false ? 'O dispositivo já estava revogado.' : 'Dispositivo "' + d.nome + '" revogado.');
          carregarDispositivos();
          return { ok: true };
        },
      });
    }

    // ─── Ativação ─────────────────────────────────────────────────────
    async function carregarAtivacao() {
      var minha = proximaSeq('ativacao');
      var promessas = [];
      if (cap.visualizar) promessas.push(carregarDispositivosDaAtivacao(minha));
      else {
        ocultar($('blocoSelecaoAtivacao'));
        $('ativacaoSemLista').textContent = TEXTOS.ATIVACAO_SEM_LISTA;
        define($('ativacaoSemLista'), cap.gerarAtivacao);
      }
      if (cap.redes) promessas.push(carregarRedes());
      await Promise.all(promessas);
    }

    async function carregarDispositivosDaAtivacao(minha) {
      painelEstado('ativacao', E.TIPOS.CARREGANDO, 'Carregando os dispositivos…');
      var resultado = await T.carregarTodos(function (n) { return T.acoes.listarDispositivos(n, T.LIMITE_API); }, 'dispositivos', T.modelo.dispositivo);
      if (!vigente('ativacao', minha)) return;
      if (!resultado.ok) {
        estado.carregado.ativacao = false;
        falhaDeLeitura('ativacao', { ok: false, status: resultado.status, codigo: resultado.codigo });
        return;
      }
      painelEstado('ativacao', null);
      estado.todosDispositivos = resultado.itens.filter(function (d) { return d.situacao !== 'REVOGADO'; });
      var select = $('ativacaoDispositivo');
      var anterior = estado.selecionado ? String(estado.selecionado) : '';
      limpar(select);
      select.appendChild(h('option', { value: '', texto: estado.todosDispositivos.length === 0 ? 'Nenhum dispositivo disponível' : 'Selecione um dispositivo' }));
      estado.todosDispositivos.slice().sort(function (a, b) { return a.nome.toLowerCase() < b.nome.toLowerCase() ? -1 : 1; }).forEach(function (d) {
        select.appendChild(h('option', { value: String(d.id), texto: d.nome + (d.localInstalacao ? ' — ' + d.localInstalacao : '') + ' (' + T.SITUACOES_DISPOSITIVO[d.situacao] + ')' }));
      });
      var existe = estado.todosDispositivos.some(function (d) { return String(d.id) === anterior; });
      select.value = existe ? anterior : '';
      estado.selecionado = existe ? Number(anterior) : null;
      aviso('avisoListaAtivacao', null, '');
      if (resultado.incompleta) aviso('avisoListaAtivacao', 'erro', TEXTOS.LISTA_INCOMPLETA);
      mostrar($('blocoSelecaoAtivacao'));
      ocultar($('ativacaoSemLista'));
      if (estado.selecionado) await carregarEstadoAtivacao(); else desenharEstadoAtivacao(null);
    }

    function dispositivoSelecionado() {
      return estado.todosDispositivos.filter(function (d) { return d.id === estado.selecionado; })[0] || null;
    }

    async function aoEscolherDispositivo() {
      var valor = $('ativacaoDispositivo').value;
      estado.selecionado = valor === '' ? null : Number(valor);
      estado.ativacaoEstado = null;
      aviso('avisoAtivacao', null, '');
      if (estado.selecionado === null) { desenharEstadoAtivacao(null); return; }
      await carregarEstadoAtivacao();
    }

    async function carregarEstadoAtivacao() {
      var id = estado.selecionado;
      if (id === null) return;
      var minha = proximaSeq('estadoAtivacao');
      desenharEstadoAtivacao(undefined);
      var r = await T.acoes.estadoAtivacao(id);
      if (!vigente('estadoAtivacao', minha) || estado.selecionado !== id) return;
      if (T.mensagens.exigeNovoLogin(r)) { sessaoExpirou(); return; }
      var a = r.ok ? T.modelo.ativacao(r.dados) : null;
      if (!r.ok || a === null) {
        estado.ativacaoEstado = null;
        desenharEstadoAtivacao(null, r.ok ? TEXTOS.RESPOSTA_INESPERADA : T.mensagens.deErro(r));
        if (!r.ok && r.status === 404) { estado.carregado.ativacao = false; carregarAtivacao(); }
        return;
      }
      estado.ativacaoEstado = a;
      desenharEstadoAtivacao(a);
    }

    // a === undefined: carregando; null: nada selecionado (ou falha, com mensagem); objeto: o estado.
    function desenharEstadoAtivacao(a, falha) {
      var dl = $('ativacaoDetalhe');
      limpar(dl);
      var botao = $('botaoGerarAtivacao');
      var d = dispositivoSelecionado();
      var podeGerar = cap.gerarAtivacao && d !== null && d.situacao !== 'REVOGADO';
      define(botao, cap.gerarAtivacao);
      // Sem o estado da ativação lido (carregando ou com falha) não se gera: a confirmação de "cancela a pendente" depende dele.
      botao.disabled = !podeGerar || a === undefined || a === null || estado.ocupado.gerar === true;
      define($('botaoAtualizarEstadoAtivacao'), estado.selecionado !== null);
      if (a === undefined) { $('ativacaoResumo').textContent = 'Consultando o estado da ativação…'; return; }
      if (a === null) {
        $('ativacaoResumo').textContent = falha || (estado.selecionado === null ? 'Escolha um dispositivo para ver o estado da ativação.' : '');
        $('ativacaoResumo').setAttribute('data-estado', '');
        return;
      }
      $('ativacaoResumo').textContent = T.ROTULOS_ATIVACAO[a.estado];
      $('ativacaoResumo').setAttribute('data-estado', a.estado);
      var linhas = [];
      if (a.estado !== 'NENHUMA') linhas.push(['Gerada em', T.tempo.instante(a.geradaEm)]);
      if (a.estado === 'PENDENTE') linhas.push(['Válida até', T.tempo.instante(a.expiraEm)]);
      if (a.estado === 'EXPIRADA') linhas.push(['Expirou em', T.tempo.instante(a.expiraEm)]);
      if (a.estado === 'CONSUMIDA') linhas.push(['Usada em', T.tempo.instante(a.usadaEm)]);
      if (a.estado === 'CANCELADA') linhas.push(['Cancelada em', T.tempo.instante(a.canceladaEm)]);
      linhas.forEach(function (l) { dl.appendChild(h('dt', { texto: l[0] })); dl.appendChild(h('dd', { texto: l[1] })); });
      var orientacao = {
        NENHUMA: 'Gere uma ativação para ligar este tablet.',
        PENDENTE: 'Há um código aguardando leitura. Ele não pode ser exibido de novo: gere outra ativação, o que cancela esta.',
        EXPIRADA: 'O código expirou sem uso. Gere uma nova ativação.',
        CONSUMIDA: 'O tablet já usou o código. Para trocar a credencial, gere uma nova ativação.',
        CANCELADA: 'A ativação foi cancelada. Gere uma nova ativação.',
      }[a.estado];
      $('ativacaoOrientacao').textContent = orientacao;
    }

    function pedirGeracao() {
      var d = dispositivoSelecionado();
      if (!cap.gerarAtivacao || d === null || d.situacao === 'REVOGADO' || estado.ocupado.gerar) return Promise.resolve();
      var pendente = estado.ativacaoEstado && estado.ativacaoEstado.estado === 'PENDENTE';
      if (d.situacao === 'ATIVO' || pendente) {
        var paragrafos = [];
        if (pendente) paragrafos.push('Gerar uma nova ativação cancela a que está aguardando leitura.');
        if (d.situacao === 'ATIVO') paragrafos.push('Este tablet já está ativo. Quando o novo código for usado, a credencial atual é substituída pela nova.');
        pedirConfirmacao({
          titulo: 'Gerar nova ativação para "' + d.nome + '"?',
          paragrafos: paragrafos,
          rotuloConfirmar: 'Gerar ativação',
          perigo: false,
          executar: async function () {
            var res = await gerarAtivacao(d);
            return res;
          },
        });
        return Promise.resolve();
      }
      return gerarAtivacao(d);
    }

    async function gerarAtivacao(d) {
      if (estado.ocupado.gerar) return { ok: false };
      estado.ocupado.gerar = true;
      $('botaoGerarAtivacao').disabled = true;
      aviso('avisoAtivacao', null, '');
      var r = await T.acoes.gerarAtivacao(d.id);
      estado.ocupado.gerar = false;
      if (estado.encerrada) return { ok: false, sessao: true };
      if (T.mensagens.exigeNovoLogin(r)) { sessaoExpirou(); return { ok: false, sessao: true }; }
      if (!r.ok) {
        desenharEstadoAtivacao(estado.ativacaoEstado);
        var texto = T.mensagens.deErro(r);
        aviso('avisoAtivacao', 'erro', texto);
        if (r.status === 404 || r.codigo === 'DISPOSITIVO_REVOGADO') { estado.carregado.ativacao = false; carregarAtivacao(); }
        return { ok: false, mensagem: texto };
      }
      var geracao = T.ativacao.daGeracao(r.dados, agora());
      r = null;
      if (geracao === null) {
        desenharEstadoAtivacao(estado.ativacaoEstado);
        aviso('avisoAtivacao', 'erro', TEXTOS.RESPOSTA_INESPERADA);
        return { ok: false, mensagem: TEXTOS.RESPOSTA_INESPERADA };
      }
      invalidar();
      exibirQr(geracao, d);
      geracao = null;
      carregarEstadoAtivacao();
      return { ok: true };
    }

    // O QR: o código só vive em estado.qr (memória) até ser descartado.
    function desenharQr(container, conteudo) {
      limpar(container);
      var qr = global.qrcode(0, 'M');
      qr.addData(conteudo, 'Byte');
      qr.make();
      var n = qr.getModuleCount();
      var lado = n + 2 * MARGEM_QR;
      var traco = '';
      for (var linha = 0; linha < n; linha += 1) {
        var coluna = 0;
        while (coluna < n) {
          if (!qr.isDark(linha, coluna)) { coluna += 1; continue; }
          var inicio = coluna;
          while (coluna < n && qr.isDark(linha, coluna)) coluna += 1;
          var largura = coluna - inicio;
          traco += 'M' + (inicio + MARGEM_QR) + ' ' + (linha + MARGEM_QR) + 'h' + largura + 'v1h-' + largura + 'z';
        }
      }
      var svg = doc.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('viewBox', '0 0 ' + lado + ' ' + lado);
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', 'QR Code de ativação do tablet');
      svg.setAttribute('shape-rendering', 'crispEdges');
      var fundo = doc.createElementNS(SVG_NS, 'rect');
      fundo.setAttribute('width', String(lado));
      fundo.setAttribute('height', String(lado));
      fundo.setAttribute('fill', '#ffffff');
      var modulos = doc.createElementNS(SVG_NS, 'path');
      modulos.setAttribute('d', traco);
      modulos.setAttribute('fill', '#000000');
      svg.appendChild(fundo);
      svg.appendChild(modulos);
      container.appendChild(svg);
    }

    function atualizarContagem() {
      if (!estado.qr) return;
      var restante = T.ativacao.restanteMs(estado.qr.fimMs, agora());
      if (restante <= 0) { expirarQr(); return; }
      $('qrContagem').textContent = 'Expira em ' + T.tempo.contagem(restante);
    }

    function exibirQr(geracao, d) {
      descartarQr();
      if (typeof global.qrcode !== 'function') {
        aviso('avisoAtivacao', 'erro', TEXTOS.QR_INDISPONIVEL);
        return;
      }
      estado.qr = { codigo: geracao.codigo, fimMs: geracao.fimMs, intervalo: null, prazo: null };
      $('qrDispositivo').textContent = d.nome;
      $('qrValidade').textContent = 'Válido até ' + T.tempo.instante(new Date(geracao.fimMs).toISOString());
      try {
        desenharQr($('qrArea'), T.ativacao.conteudoQr(estado.qr.codigo));
      } catch (erro) {
        descartarQr();
        aviso('avisoAtivacao', 'erro', TEXTOS.QR_INDISPONIVEL);
        return;
      }
      ocultar($('qrMensagem'));
      mostrar($('qrArea'));
      define($('botaoNovaAtivacaoQr'), false);
      var restante = T.ativacao.restanteMs(estado.qr.fimMs, agora());
      $('qrContagem').textContent = 'Expira em ' + T.tempo.contagem(restante);
      estado.qr.intervalo = janela.setInterval(atualizarContagem, 1000);
      estado.qr.prazo = janela.setTimeout(expirarQr, restante);
      abrirModal('modalQr', descartarQr, 'botaoFecharQr');
    }

    function apagarQr() {
      if (estado.qr) {
        if (estado.qr.intervalo !== null) janela.clearInterval(estado.qr.intervalo);
        if (estado.qr.prazo !== null) janela.clearTimeout(estado.qr.prazo);
        estado.qr.codigo = null;
        estado.qr = null;
      }
      var area = $('qrArea');
      limpar(area);
    }

    function descartarQr() {
      var aberto = estado.modais.some(function (m) { return m.id === 'modalQr'; });
      apagarQr();
      $('qrContagem').textContent = '';
      if (aberto) fecharModal('modalQr', true);
    }

    function expirarQr() {
      if (!estado.qr) return;
      apagarQr();
      ocultar($('qrArea'));
      $('qrContagem').textContent = '';
      $('qrMensagem').textContent = TEXTOS.QR_EXPIRADO;
      mostrar($('qrMensagem'));
      define($('botaoNovaAtivacaoQr'), cap.gerarAtivacao);
      carregarEstadoAtivacao();
    }

    // ─── Redes autorizadas ────────────────────────────────────────────
    async function carregarRedes() {
      var minha = proximaSeq('redes');
      painelEstado('redes', E.TIPOS.CARREGANDO, 'Carregando as redes autorizadas…');
      var resultado = await T.carregarTodos(function (n) { return T.acoes.listarRedes(n, T.LIMITE_API); }, 'redes', T.modelo.rede);
      if (!vigente('redes', minha)) return;
      if (!resultado.ok) { falhaDeLeitura('redes', { ok: false, status: resultado.status, codigo: resultado.codigo }); return; }
      estado.redes = { itens: resultado.itens, incompleta: resultado.incompleta };
      desenharRedes();
    }

    function desenharRedes() {
      var corpo = $('corpoRedes');
      limpar(corpo);
      var itens = estado.redes.itens;
      aviso('avisoListaRedes', null, '');
      if (estado.redes.incompleta) aviso('avisoListaRedes', 'erro', TEXTOS.LISTA_INCOMPLETA);
      if (itens.length === 0) {
        painelEstado('redes', E.TIPOS.VAZIO, TEXTOS.REDES_VAZIAS);
        ocultar($('tabelaRedes'));
      } else {
        painelEstado('redes', null);
        mostrar($('tabelaRedes'));
      }
      itens.forEach(function (r) {
        var celulaAcao = h('td');
        if (r.ativa) {
          celulaAcao.appendChild(h('button', { classe: 'outlined-btn perigo-texto', type: 'button', 'data-icone': 'wifi_off', 'data-acao': 'desativar-rede', 'data-rede-id': String(r.id), texto: 'Desativar' }));
        }
        corpo.appendChild(h('tr', { 'data-rede-id': String(r.id), 'data-ativa': r.ativa ? 'true' : 'false' }, [
          h('td', {}, [h('strong', { texto: r.endereco })]),
          h('td', { texto: textoOu(r.descricao) }),
          h('td', {}, [h('span', { classe: r.ativa ? 'badge badge-ok' : 'badge badge-warning', texto: r.ativa ? 'Ativa' : 'Desativada' })]),
          h('td', { texto: T.tempo.instante(r.criadaEm) }),
          h('td', { texto: T.tempo.instante(r.desativadaEm) }),
          celulaAcao,
        ]));
      });
    }

    function limparErrosRede() {
      $('rede-endereco-erro').textContent = '';
      $('rede-descricao-erro').textContent = '';
      $('redeEndereco').removeAttribute('aria-invalid');
      $('redeDescricao').removeAttribute('aria-invalid');
    }
    function erroRede(campo, mensagem) {
      var id = campo === 'rede' ? 'redeEndereco' : 'redeDescricao';
      $(campo === 'rede' ? 'rede-endereco-erro' : 'rede-descricao-erro').textContent = mensagem;
      $(id).setAttribute('aria-invalid', 'true');
    }

    async function cadastrarRede() {
      if (!cap.redes || estado.ocupado.rede) return;
      limparErrosRede();
      aviso('avisoRedes', null, '');
      var valores = { rede: $('redeEndereco').value, descricao: $('redeDescricao').value };
      var erroEndereco = T.rede.validarEndereco(valores.rede);
      var erroDescricao = T.rede.validarDescricao(valores.descricao);
      if (erroEndereco) erroRede('rede', erroEndereco);
      if (erroDescricao) erroRede('descricao', erroDescricao);
      if (erroEndereco || erroDescricao) { $(erroEndereco ? 'redeEndereco' : 'redeDescricao').focus(); return; }
      estado.ocupado.rede = true;
      $('botaoCadastrarRede').disabled = true;
      var r = await T.acoes.cadastrarRede(T.rede.corpo(valores));
      estado.ocupado.rede = false;
      $('botaoCadastrarRede').disabled = false;
      if (estado.encerrada) return;
      if (T.mensagens.exigeNovoLogin(r)) { sessaoExpirou(); return; }
      if (r.ok) {
        $('redeEndereco').value = '';
        $('redeDescricao').value = '';
        aviso('avisoRedes', 'sucesso', 'IP autorizado.');
        carregarRedes();
        return;
      }
      var porCampo = T.mensagens.deCampos(r, ['rede', 'descricao']);
      if (porCampo.length > 0) {
        porCampo.forEach(function (e) { erroRede(e.campo, e.mensagem); });
        $(porCampo[0].campo === 'rede' ? 'redeEndereco' : 'redeDescricao').focus();
        return;
      }
      aviso('avisoRedes', 'erro', T.mensagens.deErro(r));
    }

    function pedirDesativacaoRede(id) {
      var r = estado.redes.itens.filter(function (x) { return x.id === id; })[0];
      if (!r || !r.ativa || !cap.redes) return;
      var ultima = T.rede.ehUnicaAtiva(estado.redes.itens, id, estado.redes.incompleta);
      pedirConfirmacao({
        titulo: 'Desativar o IP ' + r.endereco + '?',
        paragrafos: [
          'Os tablets que dependem desta rede podem perder o acesso imediatamente: as requisições vindas dela passam a ser recusadas.',
          'A credencial dos dispositivos NÃO é revogada. Se o mesmo IP for autorizado de novo, os tablets voltam a funcionar. Para cortar um tablet específico, revogue o dispositivo na aba Dispositivos.',
        ],
        destaque: ultima ? TEXTOS.ULTIMA_REDE : null,
        rotuloConfirmar: 'Desativar IP',
        perigo: true,
        executar: async function () {
          var res = await T.acoes.desativarRede(id);
          if (estado.encerrada) return { ok: false, sessao: true };
          if (T.mensagens.exigeNovoLogin(res)) { sessaoExpirou(); return { ok: false, sessao: true }; }
          if (!res.ok) {
            if (res.status === 404) carregarRedes();
            return { ok: false, mensagem: T.mensagens.deErro(res) };
          }
          aviso('avisoRedes', 'sucesso', res.dados && res.dados.alterado === false ? 'Este IP já estava desativado.' : 'IP ' + r.endereco + ' desativado.');
          carregarRedes();
          return { ok: true };
        },
      });
    }

    // ─── Prévia ───────────────────────────────────────────────────────
    function montarPrevia() {
      $('previaAviso').textContent = TEXTOS.PREVIA_AVISO;
      var pode = cap.buscarFuncionario;
      define($('previaBuscaForm'), pode);
      $('previaSemBusca').textContent = TEXTOS.PREVIA_SEM_BUSCA;
      define($('previaSemBusca'), !pode);
    }

    async function buscarFuncionarios() {
      if (!cap.previa || !cap.buscarFuncionario || estado.ocupado.busca) return;
      var termo = $('previaBusca').value.trim();
      $('previa-busca-erro').textContent = '';
      $('previaBusca').removeAttribute('aria-invalid');
      var valido = termo.length > 0 && Array.from(termo).length <= T.BUSCA_MAXIMA && !/[\u0000-\u001f\u007f-\u009f]/.test(termo);
      if (!valido) {
        $('previa-busca-erro').textContent = 'Informe o nome ou a matrícula (até ' + T.BUSCA_MAXIMA + ' caracteres).';
        $('previaBusca').setAttribute('aria-invalid', 'true');
        return;
      }
      var minha = proximaSeq('busca');
      estado.ocupado.busca = true;
      limparResultadoPrevia();
      painelEstado('previaBusca', E.TIPOS.CARREGANDO, 'Buscando…');
      var r = await T.acoes.buscarFuncionarios(termo, PREVIA_LIMITE_BUSCA);
      estado.ocupado.busca = false;
      if (!vigente('busca', minha)) return;
      if (T.mensagens.exigeNovoLogin(r)) { sessaoExpirou(); return; }
      var lista = r.ok && r.dados && Array.isArray(r.dados.funcionarios) ? r.dados.funcionarios.map(T.modelo.funcionario) : null;
      if (!r.ok || lista === null || lista.indexOf(null) !== -1) {
        painelEstado('previaBusca', E.TIPOS.ERRO, r.ok ? TEXTOS.RESPOSTA_INESPERADA : T.mensagens.deErro(r));
        return;
      }
      var total = Number.isInteger(r.dados.total) ? r.dados.total : lista.length;
      desenharFuncionarios(lista, total);
    }

    function desenharFuncionarios(lista, total) {
      var area = $('previaFuncionarios');
      limpar(area);
      estado.busca = lista;
      if (lista.length === 0) {
        painelEstado('previaBusca', E.TIPOS.VAZIO, 'Nenhum funcionário encontrado para esta busca.');
        return;
      }
      painelEstado('previaBusca', null);
      if (total > lista.length) area.appendChild(h('p', { classe: 'dica', texto: 'Mostrando ' + lista.length + ' de ' + total + ' resultados. Refine a busca para ver os demais.' }));
      var ul = h('ul', { classe: 'lista-funcionarios' });
      itensDaBusca = {};
      lista.forEach(function (f) {
        var ativo = f.situacao === 'ATIVO';
        var botao = h('button', {
          classe: 'outlined-btn', type: 'button', 'data-icone': 'preview', id: 'previaBotao-' + f.id, 'data-acao': 'previa', 'data-funcionario-id': String(f.id),
          'aria-controls': 'previaResultadoCaixa', 'aria-expanded': 'false', texto: TEXTOS.PREVIA_VER,
        });
        if (!ativo) { botao.disabled = true; botao.setAttribute('title', TEXTOS.PREVIA_NAO_ATIVO); }
        var linhaDados = [
          f.matricula ? 'Matrícula ' + f.matricula : null,
          f.funcao ? 'Cargo ' + f.funcao : null,
          f.setor ? 'Setor ' + f.setor : null,
          f.ghe ? 'GHE ' + f.ghe : 'Sem GHE',
          ativo ? null : 'Situação: ' + f.situacao.toLowerCase(),
        ].filter(Boolean).join(' · ');
        var li = h('li', { 'data-funcionario-id': String(f.id) }, [
          h('div', { classe: 'request-meta' }, [h('strong', { texto: f.nome }), h('span', { texto: linhaDados })]),
          botao,
        ]);
        itensDaBusca[f.id] = li;
        ul.appendChild(li);
      });
      area.appendChild(ul);
      sincronizarBotoesPrevia();
    }

    // Devolve a caixa ao lugar de origem. Sempre antes de limpar a lista: o nó não pode ser destruído junto com o item.
    function devolverCaixa() {
      var caixa = $('previaResultadoCaixa');
      if (caixa && caixaPai && caixa.parentNode !== caixaPai) caixaPai.appendChild(caixa);
    }

    // Texto e estado de cada botão: o do funcionário aberto fecha; os outros ficam indisponíveis enquanto uma consulta está em curso.
    function sincronizarBotoesPrevia() {
      var emCurso = estado.ocupado.previa === true;
      estado.busca.forEach(function (f) {
        var botao = $('previaBotao-' + f.id);
        if (!botao) return;
        var aberto = estado.previaAberta === f.id;
        botao.textContent = aberto ? TEXTOS.PREVIA_FECHAR : TEXTOS.PREVIA_VER;
        botao.setAttribute('aria-expanded', aberto ? 'true' : 'false');
        botao.disabled = f.situacao !== 'ATIVO' || (emCurso && !aberto);
      });
    }

    // Fecha a prévia aberta (se houver): invalida a consulta em curso, esvazia e esconde a caixa e a devolve ao lugar de origem.
    function fecharPrevia(devolverFoco) {
      var id = estado.previaAberta;
      proximaSeq('previa');
      estado.previaAberta = null;
      estado.previaFuncionario = null;
      devolverCaixa();
      limpar($('previaResultado'));
      painelEstado('previaResultado', null);
      aviso('avisoPrevia', null, '');
      ocultar($('previaResultadoCaixa'));
      sincronizarBotoesPrevia();
      if (devolverFoco && id !== null) {
        var botao = $('previaBotao-' + id);
        if (botao && typeof botao.focus === 'function') botao.focus();
      }
    }

    function limparResultadoPrevia() {
      fecharPrevia(false);
      estado.busca = [];
      itensDaBusca = {};
      limpar($('previaFuncionarios'));
    }

    async function carregarPrevia(id) {
      if (!cap.previa || estado.ocupado.previa) return;
      var achado = estado.busca.filter(function (f) { return f.id === id; })[0];
      if (!achado) return;
      var nome = achado.nome;
      // Abrir a prévia de outro funcionário fecha a anterior: a caixa é única, muda de lugar e é esvaziada logo abaixo.
      var minha = proximaSeq('previa');
      estado.ocupado.previa = true;
      estado.previaAberta = id;
      var caixa = $('previaResultadoCaixa');
      itensDaBusca[id].appendChild(caixa);
      aviso('avisoPrevia', null, '');
      limpar($('previaResultado'));
      mostrar(caixa);
      $('previaTitulo').textContent = nome ? 'Prévia do catálogo — ' + nome : 'Prévia do catálogo';
      painelEstado('previaResultado', E.TIPOS.CARREGANDO, 'Consultando o catálogo…');
      sincronizarBotoesPrevia();
      var r = await T.acoes.previa(id);
      estado.ocupado.previa = false;
      sincronizarBotoesPrevia();
      if (!vigente('previa', minha)) return;
      if (T.mensagens.exigeNovoLogin(r)) { sessaoExpirou(); return; }
      var p = r.ok ? T.modelo.previa(r.dados) : null;
      if (!r.ok || p === null) {
        painelEstado('previaResultado', null);
        aviso('avisoPrevia', 'erro', r.ok ? TEXTOS.RESPOSTA_INESPERADA : T.mensagens.deErro(r));
        return;
      }
      painelEstado('previaResultado', null);
      estado.previaFuncionario = id;
      var area = $('previaResultado');
      area.appendChild(h('p', { classe: 'dica', 'data-estado-catalogo': p.estado, texto: T.ESTADOS_CATALOGO[p.estado] }));
      if (p.materiais.length > 0) {
        area.appendChild(h('p', { classe: 'dica', texto: p.total + (p.total === 1 ? ' material' : ' materiais') + ' no catálogo.' }));
        var ul = h('ul', { classe: 'lista-materiais' });
        p.materiais.forEach(function (m) {
          var meta = [m.tipo, m.categoria, m.unidade ? 'Unidade: ' + m.unidade : null].filter(Boolean).join(' · ');
          ul.appendChild(h('li', { 'data-material-id': String(m.id) }, [
            h('strong', { texto: m.nome }),
            h('span', { classe: 'dica', texto: meta || '—' }),
            h('span', { classe: 'dica', texto: m.exigeTamanho ? TEXTOS.POSSUI_TAMANHOS : TEXTOS.SEM_TAMANHO }),
          ]));
        });
        area.appendChild(ul);
      }
    }

    // ─── Ligações ─────────────────────────────────────────────────────
    function ligar(id, tipo, fn) { $(id).addEventListener(tipo, fn); }

    function aoClicarTabela(evento) {
      var alvo = evento.target && evento.target.closest ? evento.target.closest('[data-acao]') : null;
      if (!alvo || estado.encerrada) return;
      var acao = alvo.getAttribute('data-acao');
      var id = Number(alvo.getAttribute('data-dispositivo-id'));
      if (!Number.isInteger(id) || id <= 0) return;
      if (acao === 'detalhes') abrirDispositivo(id, false);
      else if (acao === 'editar') abrirDispositivo(id, true);
      else if (acao === 'revogar') pedirRevogacao(id);
    }

    function aoClicarRedes(evento) {
      var alvo = evento.target && evento.target.closest ? evento.target.closest('[data-acao="desativar-rede"]') : null;
      if (!alvo || estado.encerrada) return;
      var id = Number(alvo.getAttribute('data-rede-id'));
      if (Number.isInteger(id) && id > 0) pedirDesativacaoRede(id);
    }

    function aoClicarFuncionarios(evento) {
      if (estado.encerrada) return;
      var alvo = evento.target && evento.target.closest ? evento.target.closest('[data-acao="previa"]') : null;
      if (!alvo) return;
      var id = Number(alvo.getAttribute('data-funcionario-id'));
      if (!Number.isInteger(id) || id <= 0) return;
      // O único botão do funcionário alterna: aberto → fecha (sem consultar, com o foco de volta nele); qualquer outro abre a dele e fecha a anterior.
      if (id === estado.previaAberta) fecharPrevia(true);
      else carregarPrevia(id);
    }

    function aoSairDaPagina() { apagarQr(); descartarPreviaTotem(); }

    var ligacoes = [];
    function ouvir(alvo, tipo, fn) { alvo.addEventListener(tipo, fn); ligacoes.push([alvo, tipo, fn]); }

    function iniciar() {
      var caixaDaPrevia = $('previaResultadoCaixa');
      caixaPai = caixaDaPrevia ? caixaDaPrevia.parentNode : null;
      var permitidas = abasPermitidas();
      T.ABAS.forEach(function (a) {
        define($('aba-' + a), cap.abas[a] === true);
        ouvir($('aba-' + a), 'click', function () { mostrarAba(a, false, true); });
      });
      ouvir($('abas'), 'keydown', aoTeclarNasAbas);
      ouvir(doc, 'keydown', aoTeclar);

      ouvir($('botaoAtualizarVisaoGeral'), 'click', function () { carregarVisaoGeral(); });
      define($('opcaoModoReal'), consultaRealPermitida());
      ouvir($('modoPreviaDemo'), 'change', function () { trocarModoPrevia('demo'); });
      ouvir($('modoPreviaReal'), 'change', function () { trocarModoPrevia('real'); });
      ouvir($('botaoReiniciarPrevia'), 'click', function () { descartarPreviaTotem(); aplicarModoPrevia(); montarPreviaTotem(); });
      aplicarModoPrevia();

      // Dispositivos.
      define($('botaoNovoDispositivo'), cap.criar);
      ouvir($('botaoNovoDispositivo'), 'click', function () { abrirFormulario('criar', null); });
      ouvir($('botaoAtualizarDispositivos'), 'click', function () { aviso('avisoDispositivos', null, ''); carregarDispositivos(); });
      ouvir($('dispositivosAnterior'), 'click', function () { mudarPaginaDispositivos(-1); });
      ouvir($('dispositivosProxima'), 'click', function () { mudarPaginaDispositivos(1); });
      ouvir($('corpoDispositivos'), 'click', aoClicarTabela);
      ouvir($('formDispositivo'), 'submit', function (e) { e.preventDefault(); salvarDispositivo(); });
      ouvir($('botaoCancelarDispositivo'), 'click', function () { fecharModal('modalDispositivo'); });
      ouvir($('botaoFecharModalDispositivo'), 'click', function () { fecharModal('modalDispositivo'); });

      // Confirmação.
      ouvir($('botaoConfirmar'), 'click', confirmar);
      ouvir($('botaoCancelarConfirmar'), 'click', function () { fecharModal('modalConfirmar'); });

      // Ativação e redes.
      ouvir($('ativacaoDispositivo'), 'change', aoEscolherDispositivo);
      ouvir($('botaoAtualizarEstadoAtivacao'), 'click', carregarEstadoAtivacao);
      ouvir($('botaoGerarAtivacao'), 'click', pedirGeracao);
      ouvir($('botaoFecharQr'), 'click', function () { fecharModal('modalQr'); });
      ouvir($('botaoFecharQrTopo'), 'click', function () { fecharModal('modalQr'); });
      ouvir($('botaoNovaAtivacaoQr'), 'click', function () {
        var d = dispositivoSelecionado();
        fecharModal('modalQr');
        if (d) pedirGeracao();
      });
      $('ativacaoOrientacaoGeral').textContent = TEXTOS.ATIVACAO_ORIENTACAO;
      define($('blocoRedes'), cap.redes);
      $('redesOrientacao').textContent = TEXTOS.REDES_ORIENTACAO;
      ouvir($('botaoAtualizarRedes'), 'click', function () { aviso('avisoRedes', null, ''); carregarRedes(); });
      ouvir($('formRede'), 'submit', function (e) { e.preventDefault(); cadastrarRede(); });
      ouvir($('corpoRedes'), 'click', aoClicarRedes);

      // Prévia.
      ouvir($('previaBuscaForm'), 'submit', function (e) { e.preventDefault(); buscarFuncionarios(); });
      ouvir($('previaFuncionarios'), 'click', aoClicarFuncionarios);

      // O código sai da memória quando a página é recarregada, encerrada ou escondida pelo histórico.
      ouvir(janela, 'pagehide', aoSairDaPagina);
      ouvir(janela, 'beforeunload', aoSairDaPagina);

      if (permitidas.length === 0) return Promise.resolve();
      // Aba inicial: a do fragmento, se existe e é permitida; senão a Visão Geral (ou a primeira permitida). Aba pedida sem permissão
      // corrige o fragmento sem abrir (nem montar) o painel restrito.
      ouvir(janela, 'hashchange', aoMudarEndereco);
      var pedida = abaDoEndereco();
      var inicial = pedida !== null && cap.abas[pedida] === true ? pedida : abaPadrao();
      if (pedida !== null && inicial !== pedida) gravarAbaNoEndereco(inicial, true);
      mostrarAba(inicial, false, false);
      return Promise.resolve();
    }

    function encerrar() {
      if (estado.encerrada) return;
      apagarQr();
      estado.encerrada = true;
      descartarPreviaTotem();
      estado.modais.slice().forEach(function (m) { fecharModal(m.id, true); });
      ligacoes.forEach(function (l) {
        if (typeof l[0].removeEventListener === 'function') l[0].removeEventListener(l[1], l[2]);
      });
      ligacoes = [];
      estado.dispositivos = { pagina: 1, itens: [], total: 0 };
      estado.todosDispositivos = [];
      estado.redes = { itens: [], incompleta: false };
      estado.ativacaoEstado = null;
      confirmacao = null;
      devolverCaixa();
      estado.previaAberta = null;
      itensDaBusca = {};
      ['corpoDispositivos', 'corpoRedes', 'previaFuncionarios', 'previaResultado', 'visaoGeralCartoes', 'ativacaoDetalhe', 'qrArea'].forEach(function (id) {
        var el = $(id);
        if (el) limpar(el);
      });
    }

    return {
      iniciar: iniciar,
      encerrar: encerrar,
      mostrarAba: mostrarAba,
      /** Só para teste: o código está (ou não) retido na memória da tela. */
      _qrRetido: function () { return estado.qr !== null; },
    };
  }

  global.EpiAtendimentoTokenTela = { criar: criar, TEXTOS: TEXTOS };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.EpiAtendimentoTokenTela;
  }
})(typeof window !== 'undefined' ? window : globalThis);
