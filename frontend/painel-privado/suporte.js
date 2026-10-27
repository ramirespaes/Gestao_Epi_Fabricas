(function () {
  'use strict';

  /**
   * Atendimento dos chamados de suporte no Painel Privado — CONVERSA por chamado (093). Toda autoridade vem do cookie
   * administrativo (credentials:'include' em EpiHttp); nenhum id de administrador, empresa ou usuário é enviado pelo navegador.
   * Sessão inválida -> login. Nada da área protegida fica visível antes de a sessão ser confirmada, e tudo some no "Sair" e na
   * volta pelo histórico (BFCache).
   *
   * Rotas (sob /api/plataforma):
   *   GET   /suporte/chamados[?situacao&busca&naoLidas&pagina&limite]   fila (naoLidas = mensagens do solicitante não lidas)
   *   GET   /suporte/chamados/:id                                        detalhe, mensagens dos dois lados e histórico (marca como lido)
   *   GET   /suporte/chamados/:id/mensagens?aposId=N                     só as mais novas (sondagem com a conversa aberta)
   *   POST  /suporte/chamados/:id/respostas                              { texto, chaveIdempotencia } (leva a RESPONDIDO)
   *   PATCH /suporte/chamados/:id/situacao                               { situacao } (de ENCERRADO só para ABERTO = reabertura)
   *
   * Sondagem: só com um chamado aberto, uma requisição em voo por vez, pausada com a aba oculta, e NUNCA toca no texto que
   * está sendo digitado (só acrescenta mensagens novas pelo id). A fila é relida em intervalo maior e quando chega mensagem.
   * Todo texto do servidor entra só por textContent (nenhuma API de HTML).
   */

  window.EpiHttp.configurar({ baseUrl: window.SAFEWORK_PLATAFORMA_API_BASE_URL });
  var Http = window.EpiHttp;

  var SITUACOES = { ABERTO: 'Aberto', EM_ATENDIMENTO: 'Em atendimento', RESPONDIDO: 'Respondido', ENCERRADO: 'Encerrado' };
  var CATEGORIAS = { ERRO: 'Erro ou falha', LENTIDAO: 'Lentidão', ACESSO: 'Acesso ou senha', DUVIDA: 'Dúvida de uso', SUGESTAO: 'Sugestão', OUTRO: 'Outro' };
  var LIMITE = 20;
  var INTERVALO_CONVERSA_MS = Number(window.SAFEWORK_SUPORTE_POLL_MS) > 0 ? Number(window.SAFEWORK_SUPORTE_POLL_MS) : 8000;
  var INTERVALO_FILA_MS = Number(window.SAFEWORK_SUPORTE_FILA_POLL_MS) > 0 ? Number(window.SAFEWORK_SUPORTE_FILA_POLL_MS) : 30000;
  var TEXTOS = {
    LISTA_VAZIA: 'Nenhum chamado encontrado.',
    FALHA: 'Não foi possível concluir agora. Tente novamente.',
    REDE: 'Não foi possível falar com o servidor. Verifique sua conexão.',
    ENCERRADO: 'O chamado está encerrado: a conversa fica disponível para leitura. Para continuar o atendimento, reabra o chamado.',
    RESPOSTA_VAZIA: 'Escreva a resposta (até 4000 caracteres).',
    ENVIADA: 'Resposta enviada. O chamado passou a Respondido.',
    REPETIDA: 'Esta resposta já tinha sido enviada.',
    ALTERADA: 'Situação atualizada.',
    ENCERRADO_AGORA: 'Atendimento encerrado. Para continuar, use "Reabrir atendimento".',
    REABERTO: 'Atendimento reaberto. O chamado voltou a Aberto.',
    SEM_ALTERACAO: 'O chamado já está nessa situação.',
    CONFIRMAR_ENCERRAR: 'Encerrar o atendimento? O solicitante deixa de poder escrever nesta conversa até uma reabertura.',
    CONFIRMAR_REABRIR: 'Reabrir o atendimento? O chamado volta a Aberto e o solicitante volta a poder escrever.',
    TELA_DESATUALIZADA: 'Não foi possível atualizar a tela em seguida: selecione o chamado de novo na lista para ver o estado atual. Não reenvie.',
    NOVAS: function (n) { return n === 1 ? '1 mensagem nova' : n + ' mensagens novas'; },
    REMETENTE_SOLICITANTE: 'Solicitante',
    REMETENTE_SUPORTE: 'SafeWork',
    SEM_MENSAGENS: 'Ainda sem mensagens nesta conversa.',
    NOVA_MENSAGEM: 'O solicitante enviou uma nova mensagem.',
    FALHA_SONDAGEM: 'Não foi possível buscar novas mensagens agora. Tentando de novo em instantes.',
  };

  var el = function (id) { return document.getElementById(id); };
  var estado = { pagina: 1, total: 0, atual: null, ocupado: false, encerrado: false };
  var conversa = { id: null, ultimoId: 0, timer: null, emVoo: false, timerFila: null, vazio: null };
  var chaves = {};

  function irParaLogin() { window.location.href = 'index.html'; }
  function mensagem(id, texto, classe) { var e = el(id); e.textContent = texto || ''; e.className = 'mensagem ' + (classe || ''); }
  function avisarSaida(texto) { el('erro').textContent = texto || ''; el('erro').style.display = texto ? 'block' : 'none'; }
  function data(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    try { return new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }).format(d); } catch (e) { return d.toISOString(); }
  }
  function no(tag, props, filhos) {
    var n = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) { if (k === 'texto') n.textContent = props[k]; else n.setAttribute(k, props[k]); });
    (filhos || []).forEach(function (f) { n.appendChild(f); });
    return n;
  }
  function uuid() {
    var c = window.crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    var b = new Uint8Array(16);
    c.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
  /** Mesma chave enquanto o texto do rascunho não muda (reenvio após falha não duplica); descartada após o sucesso. */
  function chaveDoRascunho(id, texto) {
    var atual = chaves[id];
    if (!atual || atual.texto !== texto) chaves[id] = atual = { texto: texto, chave: uuid() };
    return atual.chave;
  }
  /** Mensagem pelo código/status do servidor; nunca o texto dele. */
  function textoDoErro(r) {
    if (r.status === 0) return TEXTOS.REDE;
    if (r.status === 409 && r.codigo === 'CHAMADO_ENCERRADO') return TEXTOS.ENCERRADO;
    if (r.status === 429) return 'Muitas tentativas em pouco tempo. Aguarde um momento.';
    if (r.status === 404) return 'Chamado não encontrado.';
    if (r.status === 400) return 'Dados inválidos. Confira o texto e a situação.';
    return TEXTOS.FALHA;
  }
  /** false (e redireciona) se a sessão administrativa acabou. */
  function sessaoViva(r) {
    if (Http.ehNaoAutenticado(r)) { irParaLogin(); return false; }
    return true;
  }

  // ----- fila -----
  function linhaDoChamado(c) {
    var tr = no('tr', { class: 'selecionavel' + (estado.atual === c.id ? ' selecionada' : '') + (c.naoLidas > 0 ? ' nao-lida' : ''), 'data-id': String(c.id) });
    var a = no('td', {});
    a.appendChild(no('strong', { texto: c.protocolo }));
    if (c.naoLidas > 0) a.appendChild(no('span', { class: 'novas', 'data-nao-lidas': String(c.naoLidas), texto: TEXTOS.NOVAS(c.naoLidas) }));
    a.appendChild(document.createElement('br'));
    a.appendChild(no('small', { texto: c.assunto }));
    var b = no('td', {});
    b.appendChild(no('span', { texto: c.empresa.nome }));
    b.appendChild(document.createElement('br'));
    b.appendChild(no('small', { texto: data(c.criadoEm) }));
    var s = no('td', {}, [no('span', { class: 'selo ' + c.situacao, texto: SITUACOES[c.situacao] || c.situacao })]);
    tr.appendChild(a); tr.appendChild(b); tr.appendChild(s);
    return tr;
  }

  function carregarLista() {
    var consulta = ['pagina=' + estado.pagina, 'limite=' + LIMITE];
    var situacao = el('filtro-situacao').value;
    var busca = el('busca').value.trim();
    if (situacao) consulta.push('situacao=' + encodeURIComponent(situacao));
    if (busca) consulta.push('busca=' + encodeURIComponent(busca));
    if (el('filtro-nao-lidas').checked) consulta.push('naoLidas=true');
    return Http.requisitar('GET', '/suporte/chamados?' + consulta.join('&')).then(function (r) {
      if (!sessaoViva(r)) return;
      if (!r.ok) { mensagem('msg-lista', textoDoErro(r), 'erro'); return; }
      var corpo = el('lista');
      corpo.textContent = '';
      r.dados.itens.forEach(function (c) { corpo.appendChild(linhaDoChamado(c)); });
      estado.total = r.dados.total;
      mensagem('msg-lista', r.dados.itens.length === 0 ? TEXTOS.LISTA_VAZIA : r.dados.total + ' chamado(s).');
      el('btn-anterior').disabled = estado.pagina <= 1;
      el('btn-proxima').disabled = estado.pagina * LIMITE >= r.dados.total;
    }).catch(function () { mensagem('msg-lista', TEXTOS.REDE, 'erro'); });
  }
  /** Temporizador que nunca segura o processo (no navegador é um número; fora dele, um handle com unref). */
  function temporizador(fn, ms) {
    var t = window.setTimeout(fn, ms);
    if (t && typeof t.unref === 'function') t.unref();
    return t;
  }
  function agendarFila() {
    if (conversa.timerFila !== null) window.clearTimeout(conversa.timerFila);
    conversa.timerFila = temporizador(function () {
      conversa.timerFila = null;
      if (el('conteudo').style.display === 'none') return;
      if (document.visibilityState !== 'hidden') carregarLista();
      agendarFila();
    }, INTERVALO_FILA_MS);
  }

  // ----- conversa -----
  function bolha(m) {
    var doSolicitante = m.autor === 'SOLICITANTE';
    return no('div', { class: 'resposta ' + (doSolicitante ? 'solicitante' : 'suporte'), 'data-mensagem': String(m.id), 'data-autor': m.autor }, [
      no('small', { texto: (doSolicitante ? TEXTOS.REMETENTE_SOLICITANTE : TEXTOS.REMETENTE_SUPORTE) + ' · ' + data(m.criadoEm) }),
      no('div', { class: 'texto', texto: m.texto }),
    ]);
  }
  /** Acrescenta só o que ainda não está na tela (ordem por id). Devolve quantas do SOLICITANTE entraram. */
  function anexarMensagens(mensagens) {
    var area = el('det-conversa');
    var novasDoSolicitante = 0;
    mensagens.forEach(function (m) {
      if (typeof m.id !== 'number' || m.id <= conversa.ultimoId) return;
      if (conversa.vazio) conversa.vazio.style.display = 'none';
      area.appendChild(bolha(m));
      conversa.ultimoId = m.id;
      if (m.autor === 'SOLICITANTE') novasDoSolicitante += 1;
    });
    return novasDoSolicitante;
  }
  function aplicarSituacao(situacao) {
    var selo = el('det-situacao');
    selo.className = 'selo ' + situacao;
    selo.textContent = SITUACOES[situacao] || situacao;
    var encerrado = situacao === 'ENCERRADO';
    estado.encerrado = encerrado;
    aplicarControles();
    el('btn-reabrir').style.display = encerrado ? '' : 'none';
    el('btn-encerrar').style.display = encerrado ? 'none' : '';
    if (!encerrado) el('nova-situacao').value = situacao;
  }
  /** Os controles de escrita só funcionam num chamado aberto e sem ação em voo; "Reabrir" só depende da ação em voo. */
  function aplicarControles() {
    ['resposta-texto', 'btn-responder', 'nova-situacao', 'btn-situacao', 'btn-encerrar'].forEach(function (id) { el(id).disabled = estado.encerrado === true || estado.ocupado === true; });
    el('btn-reabrir').disabled = estado.ocupado === true;
  }
  function pararSondagem() {
    if (conversa.timer !== null) { window.clearTimeout(conversa.timer); conversa.timer = null; }
  }
  function agendarSondagem() {
    pararSondagem();
    if (conversa.id === null) return;
    conversa.timer = temporizador(sondar, INTERVALO_CONVERSA_MS);
  }
  function sondar() {
    conversa.timer = null;
    if (conversa.id === null) return Promise.resolve();
    if (document.visibilityState === 'hidden' || conversa.emVoo) { agendarSondagem(); return Promise.resolve(); }
    var id = conversa.id;
    conversa.emVoo = true;
    return Http.requisitar('GET', '/suporte/chamados/' + id + '/mensagens?aposId=' + conversa.ultimoId).then(function (r) {
      conversa.emVoo = false;
      if (conversa.id !== id) return;
      if (!sessaoViva(r)) return;
      if (!r.ok || !r.dados || !Array.isArray(r.dados.mensagens)) { mensagem('msg-detalhe', TEXTOS.FALHA_SONDAGEM, 'aviso'); agendarSondagem(); return; }
      var novas = anexarMensagens(r.dados.mensagens);
      if (typeof r.dados.situacao === 'string') aplicarSituacao(r.dados.situacao);
      if (novas > 0) { mensagem('msg-detalhe', TEXTOS.NOVA_MENSAGEM, 'aviso'); carregarLista(); } else if (el('msg-detalhe').textContent === TEXTOS.FALHA_SONDAGEM) mensagem('msg-detalhe', '');
      agendarSondagem();
    }, function () {
      conversa.emVoo = false;
      if (conversa.id !== id) return;
      mensagem('msg-detalhe', TEXTOS.FALHA_SONDAGEM, 'aviso');
      agendarSondagem();
    });
  }

  // ----- detalhe -----
  function mostrarDetalhe(d) {
    var c = d.chamado;
    estado.atual = c.id;
    pararSondagem();
    conversa.id = c.id;
    conversa.ultimoId = 0;
    el('vazio').style.display = 'none';
    el('detalhe').style.display = 'block';
    el('titulo-detalhe').textContent = c.protocolo;
    el('det-empresa').textContent = 'Empresa: ' + c.empresa.nome + ' (CNPJ ' + c.empresa.cnpj + ')';
    el('det-solicitante').textContent = 'Solicitante: ' + c.solicitante.nome + ' · ' + c.solicitante.email + ' · aberto em ' + data(c.criadoEm) + ' · ' + (CATEGORIAS[c.categoria] || c.categoria);
    el('det-assunto').textContent = c.assunto;
    el('det-descricao').textContent = c.descricao;
    var area = el('det-conversa');
    area.textContent = '';
    conversa.vazio = no('p', { class: 'mensagem', texto: TEXTOS.SEM_MENSAGENS });
    area.appendChild(conversa.vazio);
    anexarMensagens(Array.isArray(d.mensagens) ? d.mensagens : []);
    var historico = el('det-historico');
    historico.textContent = '';
    (d.historico || []).forEach(function (h) {
      historico.appendChild(no('li', { texto: (SITUACOES[h.para] || h.para) + ' · ' + data(h.criadoEm) }));
    });
    el('confirmar-encerrar').style.display = 'none';
    el('confirmar-reabrir').style.display = 'none';
    aplicarSituacao(c.situacao);
    if (c.situacao === 'ENCERRADO') mensagem('msg-detalhe', TEXTOS.ENCERRADO, 'aviso');
    agendarSondagem();
  }

  function limparDetalhe() {
    pararSondagem();
    conversa.id = null;
    conversa.ultimoId = 0;
    conversa.vazio = null;
    estado.atual = null;
    estado.encerrado = false;
    el('confirmar-encerrar').style.display = 'none';
    el('confirmar-reabrir').style.display = 'none';
    el('texto-encerrar').textContent = '';
    el('texto-reabrir').textContent = '';
    el('detalhe').style.display = 'none';
    el('vazio').style.display = '';
    el('titulo-detalhe').textContent = 'Atendimento';
    ['det-empresa', 'det-solicitante', 'det-assunto', 'det-descricao'].forEach(function (id) { el(id).textContent = ''; });
    el('det-conversa').textContent = '';
    el('det-historico').textContent = '';
    el('resposta-texto').value = '';
    mensagem('msg-detalhe', '');
  }

  /**
   * Relê o chamado do servidor; `aviso` ({ texto, classe }) é o resultado de um ato JÁ GRAVADO e é mostrado depois da releitura.
   * Se só a releitura falhar, o ato gravado continua sendo comunicado (nunca como falha).
   */
  function abrirChamado(id, aviso) {
    if (!aviso) mensagem('msg-detalhe', '');
    var releituraFalhou = function () {
      if (aviso) mensagem('msg-detalhe', aviso.texto + ' ' + TEXTOS.TELA_DESATUALIZADA, 'aviso');
      else mensagem('msg-detalhe', TEXTOS.REDE, 'erro');
    };
    return Http.requisitar('GET', '/suporte/chamados/' + id).then(function (r) {
      if (!sessaoViva(r)) return;
      if (!r.ok) { if (aviso) releituraFalhou(); else mensagem('msg-detalhe', textoDoErro(r), 'erro'); return; }
      mostrarDetalhe(r.dados);
      if (aviso) mensagem('msg-detalhe', aviso.texto, aviso.classe);
      carregarLista();
    }).catch(releituraFalhou);
  }

  el('lista').addEventListener('click', function (ev) {
    var tr = ev.target && ev.target.closest ? ev.target.closest('tr[data-id]') : null;
    if (tr) abrirChamado(Number(tr.getAttribute('data-id')));
  });
  el('btn-buscar').addEventListener('click', function () { estado.pagina = 1; carregarLista(); });
  el('filtro-situacao').addEventListener('change', function () { estado.pagina = 1; carregarLista(); });
  el('filtro-nao-lidas').addEventListener('change', function () { estado.pagina = 1; carregarLista(); });
  el('btn-anterior').addEventListener('click', function () { if (estado.pagina > 1) { estado.pagina -= 1; carregarLista(); } });
  el('btn-proxima').addEventListener('click', function () { if (estado.pagina * LIMITE < estado.total) { estado.pagina += 1; carregarLista(); } });

  // ----- ações (uma de cada vez) -----
  function agir(operacao) {
    if (estado.ocupado || estado.atual === null) return Promise.resolve();
    estado.ocupado = true;
    aplicarControles();
    var liberar = function () {
      estado.ocupado = false;
      aplicarControles();
    };
    return operacao().then(liberar, function () {
      mensagem('msg-detalhe', TEXTOS.REDE, 'erro');
      liberar();
    });
  }

  el('form-resposta').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var texto = el('resposta-texto').value.trim();
    if (texto === '' || Array.from(texto).length > 4000) { mensagem('msg-detalhe', TEXTOS.RESPOSTA_VAZIA, 'erro'); return; }
    var id = estado.atual;
    agir(function () {
      return Http.requisitar('POST', '/suporte/chamados/' + id + '/respostas', { corpo: { texto: texto, chaveIdempotencia: chaveDoRascunho(id, texto) } }).then(function (r) {
        if (!sessaoViva(r)) return null;
        if (!r.ok) { return abrirChamado(id, { texto: textoDoErro(r), classe: 'erro' }); }
        delete chaves[id];
        el('resposta-texto').value = '';
        return abrirChamado(id, { texto: r.dados && r.dados.repetido === true ? TEXTOS.REPETIDA : TEXTOS.ENVIADA, classe: 'ok' });
      });
    });
  });

  function alterarSituacao(situacao) {
    var id = estado.atual;
    agir(function () {
      return Http.requisitar('PATCH', '/suporte/chamados/' + id + '/situacao', { corpo: { situacao: situacao } }).then(function (r) {
        if (!sessaoViva(r)) return null;
        if (!r.ok) { return abrirChamado(id, { texto: textoDoErro(r), classe: 'erro' }); }
        var alterado = r.dados.alterado;
        if (situacao === 'ENCERRADO') estado.encerrado = true;
        var texto = !alterado ? TEXTOS.SEM_ALTERACAO : (situacao === 'ENCERRADO' ? TEXTOS.ENCERRADO_AGORA : (estado.encerrado && situacao === 'ABERTO' ? TEXTOS.REABERTO : TEXTOS.ALTERADA));
        if (situacao === 'ABERTO') estado.encerrado = false;
        return abrirChamado(id, { texto: texto, classe: alterado ? 'ok' : 'aviso' });
      });
    });
  }
  el('btn-situacao').addEventListener('click', function () { alterarSituacao(el('nova-situacao').value); });
  // Encerrar e reabrir pedem confirmação na própria página (sem diálogo do navegador).
  function confirmacao(id, textoId, visivel, texto) {
    el(id).style.display = visivel ? '' : 'none';
    el(textoId).textContent = visivel ? texto : '';
  }
  el('btn-encerrar').addEventListener('click', function () { if (estado.atual !== null && !estado.ocupado) confirmacao('confirmar-encerrar', 'texto-encerrar', true, TEXTOS.CONFIRMAR_ENCERRAR); });
  el('btn-cancelar-encerrar').addEventListener('click', function () { confirmacao('confirmar-encerrar', 'texto-encerrar', false); });
  el('btn-confirmar-encerrar').addEventListener('click', function () {
    confirmacao('confirmar-encerrar', 'texto-encerrar', false);
    alterarSituacao('ENCERRADO');
  });
  el('btn-reabrir').addEventListener('click', function () { if (estado.atual !== null && !estado.ocupado) confirmacao('confirmar-reabrir', 'texto-reabrir', true, TEXTOS.CONFIRMAR_REABRIR); });
  el('btn-cancelar-reabrir').addEventListener('click', function () { confirmacao('confirmar-reabrir', 'texto-reabrir', false); });
  el('btn-confirmar-reabrir').addEventListener('click', function () {
    confirmacao('confirmar-reabrir', 'texto-reabrir', false);
    alterarSituacao('ABERTO');
  });

  // ----- sessão -----
  /** Nada da área protegida fica visível enquanto a sessão não é confirmada. */
  function ocultarProtegido() {
    if (conversa.timerFila !== null) { window.clearTimeout(conversa.timerFila); conversa.timerFila = null; }
    el('conteudo').style.display = 'none';
    el('lista').textContent = '';
    el('busca').value = '';
    el('filtro-situacao').value = '';
    el('filtro-nao-lidas').checked = false;
    estado.pagina = 1;
    estado.total = 0;
    limparDetalhe();
    mensagem('msg-lista', '');
    avisarSaida('');
    el('carregando').style.display = '';
  }

  function confirmarSessao() {
    return Http.requisitar('GET', '/auth/me').then(function (r) {
      el('carregando').style.display = 'none';
      if (Http.ehNaoAutenticado(r)) { irParaLogin(); return; }
      if (!r.ok) { avisarSaida(r.mensagem || 'Não foi possível confirmar a sessão.'); return; }
      el('conteudo').style.display = 'block';
      carregarLista();
      agendarFila();
    }).catch(function () {
      el('carregando').style.display = 'none';
      avisarSaida(TEXTOS.REDE);
    });
  }

  window.SafeworkSair.ligar({
    botao: el('sair'),
    requisitar: function () { return Http.requisitar('POST', '/auth/logout'); },
    aoIniciar: function () { avisarSaida(''); },
    aoFalhar: avisarSaida,
    aoConcluir: function () {
      ocultarProtegido();
      irParaLogin();
    },
  });

  window.addEventListener('pageshow', function (evento) {
    if (!evento || !evento.persisted) return;
    ocultarProtegido();
    confirmarSessao();
  });

  // Gancho de teste/diagnóstico: dispara a sondagem agora (sem esperar o intervalo); nada mais é exposto.
  window.SafeworkSuporteAtendimento = { sondarAgora: sondar, conversaAberta: function () { return conversa.id; } };

  confirmarSessao();
})();
