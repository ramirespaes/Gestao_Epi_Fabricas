(function (global) {
  'use strict';

  /**
   * EpiFicha — Bloco 10 (10G + 10H): Ficha de EPI e nova entrega.
   *
   * Leitura (epiFicha.visualizar):
   *   GET  /fichas-epi?busca&numero&funcionarioId&materialId&ativo&de&ate&pagina&limite
   *   POST /fichas-epi/consulta-cpf { cpf }           (CPF nunca na URL)
   *   GET  /fichas-epi/:id · GET /fichas-epi/:id/entregas · GET /entregas-epi/:id
   * Entrega (REALIZAR_ENTREGA):
   *   GET  /entregas-epi/contexto/funcionarios?busca&pagina&limite
   *   POST /entregas-epi/contexto/consulta-cpf { cpf }
   *   GET  /entregas-epi/contexto/:funcionarioId[/materiais|/materiais/:materialId/lotes]
   *   POST /entregas-epi
   *
   * Camadas: acoes (HTTP), filtros, permissoes, rascunho (itens da entrega),
   * tracos/assinatura (canvas), idempotencia, mensagens, render (HTML
   * escapado), fluxo (nova entrega) e consulta (ficha). Nenhuma chamada
   * envia empresa, ator, instantes, snapshots ou hashes: isso é do servidor.
   * O BACKEND É A AUTORIDADE FINAL: tudo o que é validado aqui é validado
   * de novo lá.
   */

  var LIMITES = { itens: 20, tracos: 64, pontos: 1500, coordenada: 10000, busca: 100, justificativa: 500, limitePagina: 20 };
  var MOTIVOS = [
    { codigo: 'ADMISSAO', rotulo: 'Admissão' },
    { codigo: 'SUBSTITUICAO_PRAZO', rotulo: 'Substituição por prazo' },
    { codigo: 'DESGASTE_DANO', rotulo: 'Desgaste ou dano' },
    { codigo: 'PERDA_EXTRAVIO', rotulo: 'Perda ou extravio' },
    { codigo: 'OUTRO', rotulo: 'Outro' },
  ];
  var MODOS = { DESENHO: 'Assinatura desenhada', ACEITE_PRESENCIAL: 'Aceite presencial' };
  var SITUACOES_CA = {
    VALIDO: { rotulo: 'CA válido', permitido: true, aviso: false },
    VENCE_HOJE: { rotulo: 'CA vence hoje', permitido: true, aviso: true },
    VENCIDO: { rotulo: 'CA vencido', permitido: false, aviso: false },
    SEM_CA: { rotulo: 'Sem CA', permitido: false, aviso: false },
    NAO_EXIGE_CA: { rotulo: 'Não exige CA', permitido: true, aviso: false },
  };
  // Texto EXATO apresentado ao trabalhador na confirmação; vai igual ao servidor.
  var DECLARACAO = {
    versao: 'NR6-ENTREGA-V1',
    texto: 'Declaro ter recebido os EPIs listados, em perfeito estado, comprometendo-me a utilizá-los conforme instruções e a comunicar qualquer necessidade de substituição.',
  };
  var TIPO_OCULOS = 'Óculos de proteção';
  var CONTROLE = /[\u0000-\u001f\u007f]/;

  function http() {
    var cliente = global.EpiHttp;
    if (!cliente) throw new Error('EpiHttp não carregado: inclua js/api-http.js antes de js/epi-ficha.js');
    return cliente;
  }
  function texto(v) { return String(v === undefined || v === null ? '' : v).trim(); }
  function inteiroPositivo(v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v && v > 0; }
  function query(campos) {
    var partes = [];
    Object.keys(campos).forEach(function (k) {
      var v = campos[k];
      if (v === undefined || v === null || v === '') return;
      partes.push(k + '=' + encodeURIComponent(String(v)));
    });
    return partes.length ? '?' + partes.join('&') : '';
  }
  function paginacao(f) {
    return { pagina: inteiroPositivo(f.pagina) ? f.pagina : 1, limite: inteiroPositivo(f.limite) ? f.limite : LIMITES.limitePagina };
  }
  function apenasDigitos(v) { return texto(v).replace(/\D/g, ''); }

  function cpfValido(d) {
    if (!/^\d{11}$/.test(d) || /^(\d)\1{10}$/.test(d)) return false;
    var dv = function (n) {
      var soma = 0;
      for (var i = 0; i < n; i += 1) soma += Number(d[i]) * (n + 1 - i);
      var r = (soma * 10) % 11;
      return r === 10 ? 0 : r;
    };
    return dv(9) === Number(d[9]) && dv(10) === Number(d[10]);
  }

  // ───────────────────────────────────────────────────────────────────
  // Ações HTTP
  // ───────────────────────────────────────────────────────────────────

  var acoes = {
    listarFichas: function (filtro) {
      var f = filtro || {};
      var p = paginacao(f);
      return http().requisitar('GET', '/fichas-epi' + query({
        busca: texto(f.busca), numero: f.numero, funcionarioId: f.funcionarioId, materialId: f.materialId,
        ativo: typeof f.ativo === 'boolean' ? String(f.ativo) : '', de: f.de, ate: f.ate, pagina: p.pagina, limite: p.limite,
      }));
    },
    consultarFichaPorCpf: function (cpf) {
      return http().requisitar('POST', '/fichas-epi/consulta-cpf', { corpo: { cpf: apenasDigitos(cpf) } });
    },
    buscarFicha: function (id) { return http().requisitar('GET', '/fichas-epi/' + encodeURIComponent(id)); },
    listarEntregasDaFicha: function (id, filtro) {
      var f = filtro || {};
      var p = paginacao(f);
      return http().requisitar('GET', '/fichas-epi/' + encodeURIComponent(id) + '/entregas' + query({ de: f.de, ate: f.ate, pagina: p.pagina, limite: p.limite }));
    },
    buscarEntrega: function (id) { return http().requisitar('GET', '/entregas-epi/' + encodeURIComponent(id)); },
    localizarTrabalhadores: function (filtro) {
      var f = filtro || {};
      var p = paginacao(f);
      return http().requisitar('GET', '/entregas-epi/contexto/funcionarios' + query({ busca: texto(f.busca), pagina: p.pagina, limite: p.limite }));
    },
    localizarTrabalhadorPorCpf: function (cpf) {
      return http().requisitar('POST', '/entregas-epi/contexto/consulta-cpf', { corpo: { cpf: apenasDigitos(cpf) } });
    },
    contexto: function (funcionarioId) {
      return http().requisitar('GET', '/entregas-epi/contexto/' + encodeURIComponent(funcionarioId));
    },
    materiais: function (funcionarioId, filtro) {
      var f = filtro || {};
      var p = paginacao(f);
      return http().requisitar('GET', '/entregas-epi/contexto/' + encodeURIComponent(funcionarioId) + '/materiais' + query({
        busca: texto(f.busca), previstoNoGhe: typeof f.previstoNoGhe === 'boolean' ? String(f.previstoNoGhe) : '', pagina: p.pagina, limite: p.limite,
      }));
    },
    lotes: function (funcionarioId, materialId) {
      return http().requisitar('GET', '/entregas-epi/contexto/' + encodeURIComponent(funcionarioId) + '/materiais/' + encodeURIComponent(materialId) + '/lotes');
    },
    registrar: function (corpo, chaveIdempotencia) {
      var c = {};
      Object.keys(corpo).forEach(function (k) { c[k] = corpo[k]; });
      c.chaveIdempotencia = chaveIdempotencia;
      return http().requisitar('POST', '/entregas-epi', { corpo: c });
    },
  };

  // ───────────────────────────────────────────────────────────────────
  // Permissões e filtros
  // ───────────────────────────────────────────────────────────────────

  var permissoes = {
    /** Duas autoridades independentes; nenhuma implica a outra. */
    capacidades: function (p) {
      var P = global.EpiPermissoes;
      return {
        consultar: !!(P && P.recurso(p, 'epiFicha', 'visualizar')),
        entregar: !!(P && P.acao(p, 'REALIZAR_ENTREGA')),
      };
    },
  };

  var DATA_ISO = /^\d{4}-\d{2}-\d{2}$/;

  var filtros = {
    /** Campos da tela → filtro da API; erro devolve mensagem para a tela. */
    fichas: function (campos) {
      var c = campos || {};
      var filtro = {};
      var busca = texto(c.busca);
      if (busca) {
        if (busca.length > LIMITES.busca || CONTROLE.test(busca)) return { ok: false, mensagem: 'Termo de busca inválido.' };
        filtro.busca = busca;
      }
      var numero = texto(c.numero);
      if (numero) {
        if (!/^[1-9]\d{0,9}$/.test(numero)) return { ok: false, mensagem: 'Número da ficha inválido: use só dígitos.' };
        filtro.numero = Number(numero);
      }
      if (c.ativo === 'true' || c.ativo === true) filtro.ativo = true;
      if (c.ativo === 'false' || c.ativo === false) filtro.ativo = false;
      var de = texto(c.de); var ate = texto(c.ate);
      if (de && !DATA_ISO.test(de)) return { ok: false, mensagem: 'Data inicial inválida.' };
      if (ate && !DATA_ISO.test(ate)) return { ok: false, mensagem: 'Data final inválida.' };
      if (de && ate && de > ate) return { ok: false, mensagem: 'A data final precisa ser igual ou posterior à inicial.' };
      if (de) filtro.de = de;
      if (ate) filtro.ate = ate;
      var p = paginacao(c);
      filtro.pagina = p.pagina;
      filtro.limite = p.limite;
      return { ok: true, filtro: filtro };
    },
    cpf: function (valor) {
      var d = apenasDigitos(valor);
      if (!cpfValido(d)) return { ok: false, mensagem: 'CPF inválido: confira os 11 dígitos.' };
      return { ok: true, cpf: d };
    },
  };

  // ───────────────────────────────────────────────────────────────────
  // Rascunho da entrega (itens, regras locais espelhando o servidor)
  // ───────────────────────────────────────────────────────────────────

  function rotuloMotivo(codigo) {
    for (var i = 0; i < MOTIVOS.length; i += 1) if (MOTIVOS[i].codigo === codigo) return MOTIVOS[i].rotulo;
    return String(codigo);
  }

  function materialCompleto(m) {
    if (!m) return false;
    if (!inteiroPositivo(m.prazoUsoDias)) return false;
    if (typeof m.exigeTamanho !== 'boolean') return false;
    if (m.tipo === TIPO_OCULOS && typeof m.oculosComGrau !== 'boolean') return false;
    return true;
  }

  function justificativaNormalizada(valor) {
    if (valor === undefined || valor === null) return { ok: true, valor: null };
    var t = texto(valor);
    if (!t) return { ok: true, valor: null };
    if (t.length > LIMITES.justificativa || CONTROLE.test(t)) return { ok: false };
    return { ok: true, valor: t };
  }

  var rascunho = {
    novo: function (funcionario, ghe) {
      return { funcionario: funcionario || null, ghe: ghe || null, itens: [] };
    },
    materialCompleto: materialCompleto,
    /** Regras locais do item; o servidor decide de novo no POST. */
    validarItem: function (r, item) {
      var recusa = function (codigo, mensagem) { return { ok: false, codigo: codigo, mensagem: mensagem }; };
      var m = item && item.material; var l = item && item.lote;
      if (!m || !l) return recusa('ITEM_INCOMPLETO', 'Escolha o material e o lote.');
      for (var i = 0; i < r.itens.length; i += 1) if (r.itens[i].loteId === l.loteId) return recusa('LOTE_REPETIDO', 'Este lote já está na entrega.');
      if (r.itens.length >= LIMITES.itens) return recusa('LIMITE_ITENS', 'A entrega aceita no máximo ' + LIMITES.itens + ' itens.');
      if (!materialCompleto(m)) return recusa('CADASTRO_INCOMPLETO', 'Cadastro incompleto: complete prazo de uso, tamanho e classificação dos óculos antes de entregar este material.');
      var s = SITUACOES_CA[l.situacaoCa];
      if (m.exigeCa && l.situacaoCa === 'VENCIDO') return recusa('CA_VENCIDO', 'O CA deste lote está vencido: escolha outro lote.');
      if (m.exigeCa && l.situacaoCa === 'SEM_CA') return recusa('CA_AUSENTE', 'Este lote não tem CA e o material exige CA.');
      if (s && !s.permitido && m.exigeCa) return recusa('CA_INVALIDO', 'Este lote não pode ser entregue.');
      if (!inteiroPositivo(l.saldo)) return recusa('SEM_SALDO', 'Este lote está sem saldo.');
      if (!inteiroPositivo(item.quantidade) || item.quantidade > l.saldo) return recusa('QUANTIDADE_INVALIDA', 'Informe uma quantidade inteira entre 1 e ' + l.saldo + '.');
      if (!MOTIVOS.some(function (x) { return x.codigo === item.motivo; })) return recusa('MOTIVO_INVALIDO', 'Escolha o motivo da entrega.');
      var j = justificativaNormalizada(item.justificativa);
      if (!j.ok) return recusa('JUSTIFICATIVA_INVALIDA', 'Justificativa inválida: até ' + LIMITES.justificativa + ' caracteres.');
      if (item.motivo === 'OUTRO' && j.valor === null) return recusa('JUSTIFICATIVA_OBRIGATORIA', 'O motivo "Outro" exige justificativa.');
      var jf = justificativaNormalizada(item.justificativaForaGhe);
      if (!jf.ok) return recusa('JUSTIFICATIVA_INVALIDA', 'Justificativa fora do GHE inválida: até ' + LIMITES.justificativa + ' caracteres.');
      var previsto = m.previstoNoGhe === true;
      if (!previsto && jf.valor === null) return recusa('JUSTIFICATIVA_FORA_GHE_OBRIGATORIA', 'Este EPI não está previsto no GHE do trabalhador: informe a justificativa da exceção.');
      if (previsto && jf.valor !== null) return recusa('JUSTIFICATIVA_FORA_GHE_NAO_SE_APLICA', 'Este EPI está previsto no GHE: a justificativa de exceção não se aplica.');
      return {
        ok: true,
        item: {
          materialId: m.id, loteId: l.loteId, quantidade: item.quantidade, motivo: item.motivo, justificativa: j.valor, justificativaForaGhe: jf.valor,
          previstoNoGhe: previsto, material: m, lote: l,
        },
      };
    },
    adicionarItem: function (r, item) {
      var v = rascunho.validarItem(r, item);
      if (!v.ok) return v;
      return { ok: true, rascunho: { funcionario: r.funcionario, ghe: r.ghe, itens: r.itens.concat([v.item]) } };
    },
    removerItem: function (r, loteId) {
      return { funcionario: r.funcionario, ghe: r.ghe, itens: r.itens.filter(function (i) { return i.loteId !== loteId; }) };
    },
    /** Conteúdo lógico que o trabalhador confirma: trabalhador e itens, nada mais. */
    conteudo: function (r) {
      if (!r || !r.funcionario) return null;
      return {
        funcionarioId: r.funcionario.id,
        itens: r.itens.map(function (i) {
          var item = { materialId: i.materialId, loteId: i.loteId, quantidade: i.quantidade, motivo: i.motivo };
          if (i.justificativa) item.justificativa = i.justificativa;
          if (i.justificativaForaGhe) item.justificativaForaGhe = i.justificativaForaGhe;
          return item;
        }),
      };
    },
    /** Corpo lógico do POST (sem chave): null quando ainda não dá para enviar. */
    corpo: function (r, confirmacao) {
      var conteudo = rascunho.conteudo(r);
      if (!conteudo || !conteudo.itens.length || !confirmacao) return null;
      var c = confirmacao;
      if (c.modo !== 'DESENHO' && c.modo !== 'ACEITE_PRESENCIAL') return null;
      var conf = { modo: c.modo };
      if (c.modo === 'DESENHO') {
        if (!Array.isArray(c.tracos) || c.tracos.length === 0) return null;
        conf.tracos = c.tracos;
      }
      conf.declaracaoVersao = DECLARACAO.versao;
      conf.declaracaoTexto = DECLARACAO.texto;
      return { funcionarioId: conteudo.funcionarioId, itens: conteudo.itens, confirmacao: conf };
    },
  };

  // ───────────────────────────────────────────────────────────────────
  // Traços da assinatura desenhada
  // ───────────────────────────────────────────────────────────────────

  function normalizar(x, y, largura, altura) {
    if (!(largura > 0) || !(altura > 0)) return null;
    var nx = Math.round((x / largura) * LIMITES.coordenada);
    var ny = Math.round((y / altura) * LIMITES.coordenada);
    return [Math.min(LIMITES.coordenada, Math.max(0, nx)), Math.min(LIMITES.coordenada, Math.max(0, ny))];
  }

  /** Guarda os traços já normalizados e nunca passa dos limites do servidor. */
  function criarColetor() {
    var tracos = [];
    var atual = null;
    var total = 0;
    return {
      iniciar: function () { atual = tracos.length < LIMITES.tracos ? [] : null; },
      ponto: function (x, y, largura, altura) {
        if (!atual || total >= LIMITES.pontos) return false;
        var p = normalizar(x, y, largura, altura);
        if (!p) return false;
        atual.push(p);
        total += 1;
        return true;
      },
      encerrar: function () {
        if (atual && atual.length) tracos.push(atual);
        atual = null;
      },
      limpar: function () { tracos = []; atual = null; total = 0; },
      valores: function () { return tracos.map(function (t) { return t.slice(); }); },
      vazio: function () { return tracos.length === 0; },
    };
  }

  var tracos = { normalizar: normalizar, criarColetor: criarColetor };

  var INSTALACAO = '__epiFichaAssinatura';

  /**
   * Liga o canvas ao coletor uma única vez por canvas: abrir e fechar o
   * modal não repete ouvintes. Eventos de ponteiro cobrem mouse e toque.
   */
  function instalar(canvas, coletor, opcoes) {
    if (canvas[INSTALACAO]) return canvas[INSTALACAO];
    var o = opcoes || {};
    var ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
    var desenhando = false;
    var ultimo = null;
    var posicao = function (e) {
      var r = canvas.getBoundingClientRect();
      var escalaX = r.width > 0 ? canvas.width / r.width : 1;
      var escalaY = r.height > 0 ? canvas.height / r.height : 1;
      return { x: (e.clientX - r.left) * escalaX, y: (e.clientY - r.top) * escalaY };
    };
    var tracar = function (de, ate) {
      if (!ctx) return;
      ctx.beginPath();
      ctx.moveTo(de.x, de.y);
      ctx.lineTo(ate.x, ate.y);
      ctx.stroke();
    };
    var iniciar = function (e) {
      if (e.isPrimary === false) return;
      if (e.preventDefault) e.preventDefault();
      desenhando = true;
      ultimo = posicao(e);
      coletor.iniciar();
      coletor.ponto(ultimo.x, ultimo.y, canvas.width, canvas.height);
      if (typeof canvas.setPointerCapture === 'function' && e.pointerId !== undefined) canvas.setPointerCapture(e.pointerId);
    };
    var mover = function (e) {
      if (!desenhando) return;
      if (e.preventDefault) e.preventDefault();
      var p = posicao(e);
      if (coletor.ponto(p.x, p.y, canvas.width, canvas.height)) tracar(ultimo, p);
      ultimo = p;
    };
    var encerrar = function (e) {
      if (!desenhando) return;
      desenhando = false;
      coletor.encerrar();
      if (typeof canvas.releasePointerCapture === 'function' && e && e.pointerId !== undefined) canvas.releasePointerCapture(e.pointerId);
      if (typeof o.aoMudar === 'function') o.aoMudar();
    };
    canvas.addEventListener('pointerdown', iniciar);
    canvas.addEventListener('pointermove', mover);
    canvas.addEventListener('pointerup', encerrar);
    canvas.addEventListener('pointercancel', encerrar);
    canvas.addEventListener('pointerleave', encerrar);
    var instalacao = {
      limpar: function () {
        coletor.limpar();
        if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
      },
    };
    canvas[INSTALACAO] = instalacao;
    return instalacao;
  }

  var assinatura = { instalar: instalar };

  // ───────────────────────────────────────────────────────────────────
  // Idempotência
  // ───────────────────────────────────────────────────────────────────

  function gerar() {
    var c = global.crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    if (c && typeof c.getRandomValues === 'function') {
      var b = new Uint8Array(16);
      c.getRandomValues(b);
      b[6] = (b[6] & 0x0f) | 0x40;
      b[8] = (b[8] & 0x3f) | 0x80;
      var h = Array.prototype.map.call(b, function (x) { return (x < 16 ? '0' : '') + x.toString(16); }).join('');
      return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
    }
    throw new Error('Este navegador não gera identificadores seguros.');
  }

  var idempotencia = {
    gerar: gerar,
    novoEstado: function () { return { chave: null, assinatura: null }; },
    /** A mesma chave enquanto o corpo lógico não muda; qualquer mudança é nova tentativa. */
    chavePara: function (estado, corpo) {
      var assinaturaCorpo = JSON.stringify(corpo);
      if (estado.chave === null || estado.assinatura !== assinaturaCorpo) {
        estado.chave = gerar();
        estado.assinatura = assinaturaCorpo;
      }
      return estado.chave;
    },
  };

  // ───────────────────────────────────────────────────────────────────
  // Mensagens
  // ───────────────────────────────────────────────────────────────────

  var MSG = {
    INCERTA: 'Não foi possível confirmar se a entrega foi registrada. Não altere os dados antes de tentar novamente.',
    REPLAY: 'Esta entrega já havia sido registrada. Os dados originais foram carregados.',
    SUCESSO: 'Entrega registrada com sucesso.',
    SESSAO: 'Sua sessão terminou. Entre novamente pelo Portal do Cliente.',
    SEM_ACESSO: 'Seu perfil não tem acesso à Ficha de EPI nesta empresa.',
    ENVIO_EM_ANDAMENTO: 'A entrega já está sendo enviada. Aguarde a resposta.',
    TENTATIVA_INCERTA: 'Há uma tentativa de registro sem resposta. Nada pode ser alterado até ela ser resolvida: use "Tentar novamente".',
    CONFIRMACAO_AUSENTE: 'Capture a confirmação do trabalhador antes de registrar.',
    CONFIRMACAO_OBSOLETA: 'A entrega mudou depois da confirmação. Capture uma nova confirmação do trabalhador.',
  };
  var POR_CODIGO = {
    IDEMPOTENCIA_CONFLITO: 'Esta tentativa já foi usada com outro conteúdo. Revise os dados e confirme como uma nova entrega.',
    FUNCIONARIO_INATIVO: 'Este trabalhador está inativo e não pode receber EPI.',
    FUNCIONARIO_NAO_ENCONTRADO: 'Trabalhador não encontrado nesta empresa.',
    MATERIAL_INATIVO: 'Este material está inativo e não pode ser entregue.',
    MATERIAL_NAO_ENCONTRADO: 'Material não encontrado nesta empresa.',
    MATERIAL_PRAZO_NAO_CLASSIFICADO: 'Cadastro incompleto: defina o prazo de uso do material antes de entregá-lo.',
    MATERIAL_TAMANHO_NAO_CLASSIFICADO: 'Cadastro incompleto: defina se o material exige tamanho antes de entregá-lo.',
    MATERIAL_OCULOS_NAO_CLASSIFICADO: 'Cadastro incompleto: defina se os óculos são com ou sem grau antes de entregá-los.',
    LOTE_NAO_ENCONTRADO: 'Lote não encontrado nesta empresa. Recarregue os lotes.',
    LOTE_MATERIAL_DIVERGENTE: 'O lote escolhido não é do material informado. Recarregue os lotes.',
    LOTE_SEM_TAMANHO: 'Este material exige lote com tamanho: escolha outro lote.',
    CA_AUSENTE: 'Este material exige CA e o lote escolhido não tem CA.',
    CA_VENCIDO: 'O CA do lote escolhido está vencido: escolha outro lote.',
    SALDO_INSUFICIENTE: 'O saldo do lote mudou e não cobre a quantidade. Os lotes foram recarregados: ajuste a quantidade ou escolha outro lote.',
    JUSTIFICATIVA_FORA_GHE_OBRIGATORIA: 'Este EPI não está previsto no GHE do trabalhador: informe a justificativa da exceção.',
    JUSTIFICATIVA_FORA_GHE_NAO_SE_APLICA: 'Este EPI está previsto no GHE do trabalhador: a justificativa de exceção não se aplica.',
    FICHA_NAO_ENCONTRADA: 'Ficha não encontrada nesta empresa.',
    ENTREGA_NAO_ENCONTRADA: 'Entrega não encontrada nesta empresa.',
    PERMISSAO_NEGADA: 'Seu perfil não tem permissão para esta operação.',
    VALIDACAO: 'Os dados enviados não foram aceitos. Confira os campos e tente de novo.',
  };

  function ehRede(r) { return !!r && r.status === 0; }
  function exigeNovoLogin(r) { return !!r && r.status === 401; }
  function erro(r) {
    if (ehRede(r)) return MSG.INCERTA;
    if (exigeNovoLogin(r)) return MSG.SESSAO;
    if (r && r.codigo && POR_CODIGO[r.codigo]) return POR_CODIGO[r.codigo];
    if (r && r.status === 403) return POR_CODIGO.PERMISSAO_NEGADA;
    if (r && r.status === 404) return 'Registro não encontrado nesta empresa.';
    if (r && r.status === 400) return POR_CODIGO.VALIDACAO;
    if (r && r.status === 409) return 'A operação não pôde ser concluída no estado atual. Recarregue os dados e tente de novo.';
    return 'Não foi possível concluir. Tente novamente em instantes.';
  }
  var mensagens = { MSG: MSG, POR_CODIGO: POR_CODIGO, ehRede: ehRede, exigeNovoLogin: exigeNovoLogin, erro: erro };

  // ───────────────────────────────────────────────────────────────────
  // Render — HTML sempre escapado
  // ───────────────────────────────────────────────────────────────────

  function escaparHtml(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  var e = escaparHtml;
  function dataBr(valor) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(texto(valor));
    return m ? m[3] + '/' + m[2] + '/' + m[1] : '';
  }
  function dataHoraBr(valor) {
    if (!valor) return '';
    var d = new Date(valor);
    if (isNaN(d.getTime())) return '';
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function ou(v, alternativa) { return v === undefined || v === null || v === '' ? alternativa : v; }
  function badge(textoBadge, cor) {
    return '<span class="badge" style="font-size:11px;' + cor + '">' + e(textoBadge) + '</span>';
  }
  var COR = {
    ok: 'background:rgba(52,199,89,0.12);color:#1f8f3a',
    aviso: 'background:rgba(255,149,0,0.12);color:#C07000',
    erro: 'background:rgba(255,59,48,0.10);color:#FF3B30',
    neutra: 'background:var(--surface-container);color:var(--on-surface-variant)',
  };

  function linhasFichas(fichas) {
    return (fichas || []).map(function (f) {
      var fa = f.funcionarioAtual || {};
      var r = f.resumo || {};
      return '<tr>'
        + '<td>' + e(f.numero) + '</td>'
        + '<td>' + e(fa.nome) + '</td>'
        + '<td>' + e(fa.matricula) + '</td>'
        + '<td>' + (fa.ativo ? badge('Ativo', COR.ok) : badge('Inativo', COR.neutra)) + '</td>'
        + '<td style="text-align:right">' + e(ou(r.totalEntregas, 0)) + '</td>'
        + '<td style="text-align:right">' + e(ou(r.totalItens, 0)) + '</td>'
        + '<td>' + e(dataHoraBr(r.ultimaEntregaEm) || '—') + '</td>'
        + '<td><button type="button" class="outlined-btn" style="padding:4px 10px;font-size:12px" data-abrir="' + e(f.id) + '">Abrir</button></td>'
        + '</tr>';
    }).join('');
  }

  function linhasHistorico(entregas) {
    var html = '';
    (entregas || []).forEach(function (en) {
      var itens = en.itens || [];
      var conf = en.confirmacao || null;
      var modo = conf ? (MODOS[conf.modo] || conf.modo) : '—';
      itens.forEach(function (i, indice) {
        var m = i.material || {};
        var l = i.lote || {};
        var motivo = rotuloMotivo(i.motivo) + (i.justificativa ? ' — ' + i.justificativa : '');
        var ghe = i.previstoNoGhe ? 'Previsto no GHE' : 'Fora do GHE' + (i.justificativaForaGhe ? ': ' + i.justificativaForaGhe : '');
        html += '<tr data-entrega="' + e(en.id) + '"' + (indice === 0 ? ' class="linha-entrega-inicio"' : '') + '>'
          + '<td style="text-align:center;white-space:nowrap">' + e(dataHoraBr(en.entregueEm)) + '</td>'
          + '<td>' + e(m.nome) + (m.codigoInterno ? ' <span style="color:var(--on-surface-variant)">(' + e(m.codigoInterno) + ')</span>' : '') + '</td>'
          + '<td style="text-align:center">' + e(ou(l.tamanho, '—')) + '</td>'
          + '<td style="text-align:center">' + e(ou(l.caNumero, '—')) + '</td>'
          + '<td style="text-align:center">' + e(dataBr(l.caValidade) || '—') + '</td>'
          + '<td style="text-align:center">' + e(i.quantidade) + ' ' + e(ou(m.unidade, '')) + '</td>'
          + '<td>' + e(motivo) + '</td>'
          + '<td>' + e(ghe) + '</td>'
          + '<td>' + e(en.responsavel ? en.responsavel.nome : '') + '</td>'
          + '<td style="text-align:center">' + e(modo) + '</td>'
          + '</tr>';
      });
    });
    return html;
  }

  function cabecalhoFicha(d) {
    var f = (d && d.ficha) || {};
    var fa = (d && d.funcionarioAtual) || {};
    var r = (d && d.resumo) || {};
    return {
      numero: 'Ficha nº ' + e(f.numero),
      criadaEm: e(dataHoraBr(f.criadaEm)),
      nome: e(fa.nome),
      cpf: e(ou(fa.cpfMascarado, '—')),
      funcao: e(ou(fa.funcao, '—')),
      setor: e(ou(fa.setor, '—')),
      matricula: e(ou(fa.matricula, '—')),
      ghe: e(fa.ghe && fa.ghe.nome ? fa.ghe.nome : '—'),
      situacao: fa.ativo === false ? badge('Inativo', COR.neutra) : badge('Ativo', COR.ok),
      totalEntregas: e(ou(r.totalEntregas, 0)),
      totalItens: e(ou(r.totalItens, 0)),
      ultimaEntrega: e(dataHoraBr(r.ultimaEntregaEm) || '—'),
    };
  }

  function linhasTrabalhadores(lista) {
    return (lista || []).map(function (f) {
      return '<tr>'
        + '<td>' + e(f.nome) + '</td><td>' + e(f.matricula) + '</td><td>' + e(f.cpfMascarado) + '</td>'
        + '<td>' + e(ou(f.setor, '—')) + ' · ' + e(ou(f.funcao, '—')) + '</td>'
        + '<td>' + e(f.ghe && f.ghe.nome ? f.ghe.nome : '—') + '</td>'
        + '<td><button type="button" class="filled-btn" style="padding:4px 10px;font-size:12px" data-funcionario="' + e(f.id) + '">Selecionar</button></td>'
        + '</tr>';
    }).join('');
  }

  function linhasMateriais(lista) {
    return (lista || []).map(function (m) {
      var completo = materialCompleto(m);
      var previsto = m.previstoNoGhe ? badge('Previsto no GHE', COR.ok) : badge('Fora do GHE', COR.aviso);
      var classificacao = completo ? '' : ' ' + badge('Cadastro incompleto', COR.erro);
      return '<tr>'
        + '<td>' + e(m.nome) + (m.codigoInterno ? ' <span style="color:var(--on-surface-variant)">(' + e(m.codigoInterno) + ')</span>' : '') + classificacao + '</td>'
        + '<td>' + e(ou(m.tipo, '—')) + '</td><td>' + e(ou(m.unidade, '—')) + '</td>'
        + '<td style="text-align:center">' + e(inteiroPositivo(m.prazoUsoDias) ? m.prazoUsoDias + ' dias' : '—') + '</td>'
        + '<td style="text-align:center">' + e(m.exigeTamanho === true ? 'Sim' : m.exigeTamanho === false ? 'Não' : '—') + '</td>'
        + '<td style="text-align:center">' + e(m.exigeCa ? 'Sim' : 'Não') + '</td>'
        + '<td>' + previsto + '</td>'
        + '<td><button type="button" class="filled-btn" style="padding:4px 10px;font-size:12px" data-material="' + e(m.id) + '"' + (completo ? '' : ' disabled') + '>Escolher</button></td>'
        + '</tr>';
    }).join('');
  }

  function linhasLotes(lista, material) {
    var exigeCa = !!(material && material.exigeCa);
    return (lista || []).map(function (l) {
      var s = SITUACOES_CA[l.situacaoCa] || { rotulo: l.situacaoCa, permitido: true, aviso: false };
      var bloqueado = exigeCa && !s.permitido;
      var cor = bloqueado ? COR.erro : s.aviso ? COR.aviso : s.permitido && l.situacaoCa !== 'NAO_EXIGE_CA' ? COR.ok : COR.neutra;
      return '<tr>'
        + '<td style="text-align:center">' + e(ou(l.tamanho, '—')) + '</td>'
        + '<td style="text-align:center">' + e(ou(l.caNumero, '—')) + '</td>'
        + '<td style="text-align:center">' + e(dataBr(l.caValidade) || '—') + '</td>'
        + '<td style="text-align:center">' + e(l.saldo) + '</td>'
        + '<td>' + badge(s.rotulo, cor) + (s.aviso ? ' <span style="font-size:11px;color:#C07000">vence hoje: pode ser entregue</span>' : '') + '</td>'
        + '<td><button type="button" class="filled-btn" style="padding:4px 10px;font-size:12px" data-lote="' + e(l.loteId) + '"' + (bloqueado ? ' disabled' : '') + '>Selecionar</button></td>'
        + '</tr>';
    }).join('');
  }

  function linhasItens(r) {
    return ((r && r.itens) || []).map(function (i) {
      var m = i.material || {}; var l = i.lote || {};
      return '<tr>'
        + '<td>' + e(m.nome) + '</td><td style="text-align:center">' + e(ou(l.tamanho, '—')) + '</td><td style="text-align:center">' + e(ou(l.caNumero, '—')) + '</td>'
        + '<td style="text-align:center">' + e(i.quantidade) + '</td><td>' + e(rotuloMotivo(i.motivo)) + (i.justificativa ? ' — ' + e(i.justificativa) : '') + '</td>'
        + '<td>' + (i.previstoNoGhe ? e('Previsto no GHE') : e('Fora do GHE: ' + (i.justificativaForaGhe || ''))) + '</td>'
        + '<td><button type="button" class="outlined-btn" style="padding:4px 10px;font-size:12px" data-remover="' + e(i.loteId) + '">Remover</button></td>'
        + '</tr>';
    }).join('');
  }

  var render = {
    escaparHtml: escaparHtml, dataBr: dataBr, dataHoraBr: dataHoraBr, badge: badge,
    linhasFichas: linhasFichas, linhasHistorico: linhasHistorico, cabecalhoFicha: cabecalhoFicha,
    linhasTrabalhadores: linhasTrabalhadores, linhasMateriais: linhasMateriais, linhasLotes: linhasLotes, linhasItens: linhasItens,
  };

  // ───────────────────────────────────────────────────────────────────
  // Fluxo da nova entrega (estado sem DOM; a página só renderiza)
  // ───────────────────────────────────────────────────────────────────

  function respostaDeErro(r) {
    return {
      ok: false, status: r.status, codigo: r.codigo || null, mensagem: erro(r), incerta: ehRede(r), sessaoEncerrada: exigeNovoLogin(r),
      recarregarLotes: r.codigo === 'SALDO_INSUFICIENTE' || r.codigo === 'LOTE_NAO_ENCONTRADO' || r.codigo === 'LOTE_MATERIAL_DIVERGENTE',
    };
  }

  function criarFluxo() {
    var estado = {
      trabalhador: null, ghe: null, ficha: null, rascunho: null, material: null, lotes: [], materiais: [], totalMateriais: 0,
      confirmacao: null, enviando: false, tentativaIncerta: null, resultado: null,
    };
    var seq = { trabalhador: 0, materiais: 0, lotes: 0, busca: 0 };
    var chave = idempotencia.novoEstado();
    var ouvintes = [];
    var avisar = function () { ouvintes.forEach(function (fn) { fn(estado); }); };

    /**
     * Conteúdo congelado enquanto um POST está em voo ou uma tentativa ficou
     * sem resposta: só "tentar novamente" (mesmo corpo, mesma chave) resolve.
     */
    function bloqueio() {
      if (estado.enviando) return { ok: false, codigo: 'ENVIO_EM_ANDAMENTO', mensagem: MSG.ENVIO_EM_ANDAMENTO };
      if (estado.tentativaIncerta) return { ok: false, codigo: 'TENTATIVA_INCERTA_PENDENTE', mensagem: MSG.TENTATIVA_INCERTA };
      return null;
    }

    function conteudoAtual() { return JSON.stringify(rascunho.conteudo(estado.rascunho)); }

    // Consultas do trabalhador anterior deixam de valer: respostas tardias são descartadas.
    function invalidarDependentes() {
      seq.materiais += 1; seq.lotes += 1;
      estado.material = null; estado.lotes = []; estado.materiais = []; estado.totalMateriais = 0;
    }

    function definirTrabalhador(contexto) {
      var b = bloqueio(); if (b) return b;
      invalidarDependentes();
      estado.trabalhador = contexto.funcionario || null;
      estado.ghe = contexto.ghe || null;
      estado.ficha = contexto.ficha || null;
      estado.rascunho = rascunho.novo(estado.trabalhador, estado.ghe);
      estado.confirmacao = null;
      estado.resultado = null;
      chave = idempotencia.novoEstado();
      avisar();
      return { ok: true };
    }

    function limpar(opcoes) {
      var b = bloqueio();
      if (b && !(b.codigo === 'TENTATIVA_INCERTA_PENDENTE' && opcoes && opcoes.descartarTentativaIncerta === true)) return b;
      seq.trabalhador += 1; seq.busca += 1;
      invalidarDependentes();
      estado.trabalhador = null; estado.ghe = null; estado.ficha = null; estado.rascunho = null;
      estado.confirmacao = null; estado.enviando = false; estado.tentativaIncerta = null; estado.resultado = null;
      chave = idempotencia.novoEstado();
      avisar();
      return { ok: true };
    }

    async function selecionarTrabalhador(id) {
      var b = bloqueio(); if (b) return b;
      var minha = ++seq.trabalhador;
      seq.materiais += 1; seq.lotes += 1;
      var r = await acoes.contexto(id);
      if (minha !== seq.trabalhador) return { ok: false, descartada: true };
      if (!r.ok) return respostaDeErro(r);
      var d = definirTrabalhador(r.dados || {});
      if (!d.ok) return d;
      return { ok: true, trabalhador: estado.trabalhador, ghe: estado.ghe, ficha: estado.ficha };
    }

    async function localizar(filtro) {
      var minha = ++seq.busca;
      var r = await acoes.localizarTrabalhadores(filtro);
      if (minha !== seq.busca) return { ok: false, descartada: true };
      if (!r.ok) return respostaDeErro(r);
      return { ok: true, funcionarios: (r.dados && r.dados.funcionarios) || [], total: (r.dados && r.dados.total) || 0 };
    }

    async function localizarPorCpf(cpf) {
      var v = filtros.cpf(cpf);
      if (!v.ok) return { ok: false, codigo: 'CPF_INVALIDO', mensagem: v.mensagem };
      var minha = ++seq.busca;
      var r = await acoes.localizarTrabalhadorPorCpf(v.cpf);
      if (minha !== seq.busca) return { ok: false, descartada: true };
      if (!r.ok) return respostaDeErro(r);
      return { ok: true, funcionario: r.dados && r.dados.funcionario };
    }

    async function carregarMateriais(filtro) {
      if (!estado.trabalhador) return { ok: false, codigo: 'SEM_TRABALHADOR', mensagem: 'Selecione o trabalhador primeiro.' };
      var minha = ++seq.materiais;
      var r = await acoes.materiais(estado.trabalhador.id, filtro);
      if (minha !== seq.materiais) return { ok: false, descartada: true };
      if (!r.ok) return respostaDeErro(r);
      estado.materiais = (r.dados && r.dados.materiais) || [];
      estado.totalMateriais = (r.dados && r.dados.total) || 0;
      avisar();
      return { ok: true, materiais: estado.materiais, total: estado.totalMateriais };
    }

    async function selecionarMaterial(m) {
      if (!estado.trabalhador) return { ok: false, codigo: 'SEM_TRABALHADOR', mensagem: 'Selecione o trabalhador primeiro.' };
      var minha = ++seq.lotes;
      estado.material = m;
      estado.lotes = [];
      avisar();
      var r = await acoes.lotes(estado.trabalhador.id, m.id);
      if (minha !== seq.lotes) return { ok: false, descartada: true };
      if (!r.ok) return respostaDeErro(r);
      estado.lotes = (r.dados && r.dados.lotes) || [];
      avisar();
      return { ok: true, lotes: estado.lotes };
    }

    async function recarregarLotes() {
      return estado.material ? selecionarMaterial(estado.material) : { ok: false, codigo: 'SEM_MATERIAL' };
    }

    // Toda mudança do conteúdo lógico derruba a confirmação já capturada.
    function mudarRascunho(novo) {
      estado.rascunho = novo;
      estado.confirmacao = null;
      estado.resultado = null;
      avisar();
    }

    function adicionarItem(item) {
      var b = bloqueio(); if (b) return b;
      if (!estado.rascunho) return { ok: false, codigo: 'SEM_TRABALHADOR', mensagem: 'Selecione o trabalhador primeiro.' };
      var r = rascunho.adicionarItem(estado.rascunho, item);
      if (r.ok) mudarRascunho(r.rascunho);
      return r;
    }

    function removerItem(loteId) {
      var b = bloqueio(); if (b) return b;
      if (!estado.rascunho) return { ok: false, codigo: 'SEM_TRABALHADOR', mensagem: 'Selecione o trabalhador primeiro.' };
      mudarRascunho(rascunho.removerItem(estado.rascunho, loteId));
      return { ok: true };
    }

    function alterarQuantidade(loteId, quantidade) {
      var b = bloqueio(); if (b) return b;
      if (!estado.rascunho) return { ok: false, codigo: 'SEM_TRABALHADOR', mensagem: 'Selecione o trabalhador primeiro.' };
      var itens = estado.rascunho.itens.map(function (i) { return i.loteId === loteId ? Object.assign({}, i, { quantidade: quantidade }) : i; });
      mudarRascunho({ funcionario: estado.rascunho.funcionario, ghe: estado.rascunho.ghe, itens: itens });
      return { ok: true };
    }

    function substituirRascunho(r) {
      var b = bloqueio(); if (b) return b;
      mudarRascunho(r);
      return { ok: true };
    }

    /** A confirmação fica presa ao conteúdo do momento em que foi capturada. */
    function definirConfirmacao(conf) {
      var b = bloqueio(); if (b) return b;
      if (!estado.rascunho || !estado.trabalhador) return { ok: false, codigo: 'SEM_TRABALHADOR', mensagem: 'Selecione o trabalhador primeiro.' };
      if (!estado.rascunho.itens.length) return { ok: false, codigo: 'ENTREGA_SEM_ITENS', mensagem: 'Adicione ao menos um item antes de confirmar.' };
      var corpo = rascunho.corpo(estado.rascunho, conf);
      if (!corpo) return { ok: false, codigo: 'CONFIRMACAO_INVALIDA', mensagem: 'Confirmação inválida: desenhe a assinatura ou marque o aceite presencial.' };
      estado.confirmacao = { modo: corpo.confirmacao.modo, tracos: corpo.confirmacao.tracos, conteudo: conteudoAtual() };
      avisar();
      return { ok: true };
    }

    function limparConfirmacao() {
      var b = bloqueio(); if (b) return b;
      estado.confirmacao = null;
      avisar();
      return { ok: true };
    }

    async function enviar(corpo, chaveDaTentativa) {
      estado.enviando = true;
      avisar();
      var r;
      try {
        r = await acoes.registrar(corpo, chaveDaTentativa);
      } finally {
        estado.enviando = false;
      }
      if (!r.ok) {
        estado.resultado = respostaDeErro(r);
        estado.tentativaIncerta = estado.resultado.incerta ? { corpo: corpo, chave: chaveDaTentativa } : null;
        avisar();
        return estado.resultado;
      }
      var repetida = !!(r.dados && r.dados.repetida);
      estado.resultado = { ok: true, repetida: repetida, entrega: r.dados && r.dados.entrega, mensagem: repetida ? MSG.REPLAY : MSG.SUCESSO };
      estado.rascunho = rascunho.novo(estado.trabalhador, estado.ghe);
      estado.confirmacao = null;
      estado.tentativaIncerta = null;
      chave = idempotencia.novoEstado();
      if (estado.resultado.entrega && estado.resultado.entrega.ficha) estado.ficha = estado.resultado.entrega.ficha;
      avisar();
      return estado.resultado;
    }

    /** Envia só a confirmação guardada no estado, e só se o conteúdo não mudou desde a captura. */
    async function confirmar() {
      if (arguments.length) return { ok: false, codigo: 'CONFIRMACAO_FORA_DO_ESTADO', mensagem: MSG.CONFIRMACAO_AUSENTE };
      var b = bloqueio(); if (b) return b;
      if (!estado.confirmacao) return { ok: false, codigo: 'CONFIRMACAO_AUSENTE', mensagem: MSG.CONFIRMACAO_AUSENTE };
      if (estado.confirmacao.conteudo !== conteudoAtual()) {
        estado.confirmacao = null;
        avisar();
        return { ok: false, codigo: 'CONFIRMACAO_OBSOLETA', mensagem: MSG.CONFIRMACAO_OBSOLETA };
      }
      var corpo = rascunho.corpo(estado.rascunho, estado.confirmacao);
      if (!corpo) return { ok: false, codigo: 'ENTREGA_INCOMPLETA', mensagem: 'Adicione ao menos um item e confirme o recebimento antes de registrar.' };
      return enviar(corpo, idempotencia.chavePara(chave, corpo));
    }

    /** Repete a MESMA tentativa (mesmo corpo, mesma chave) depois de uma falha incerta. */
    async function tentarNovamente() {
      if (estado.enviando) return { ok: false, codigo: 'ENVIO_EM_ANDAMENTO', mensagem: MSG.ENVIO_EM_ANDAMENTO };
      if (!estado.tentativaIncerta) return { ok: false, codigo: 'SEM_TENTATIVA', mensagem: 'Não há tentativa pendente.' };
      return enviar(estado.tentativaIncerta.corpo, estado.tentativaIncerta.chave);
    }

    return {
      estado: function () { return estado; },
      aoMudar: function (fn) { ouvintes.push(fn); },
      definirTrabalhador: definirTrabalhador,
      selecionarTrabalhador: selecionarTrabalhador,
      localizar: localizar,
      localizarPorCpf: localizarPorCpf,
      carregarMateriais: carregarMateriais,
      selecionarMaterial: selecionarMaterial,
      recarregarLotes: recarregarLotes,
      adicionarItem: adicionarItem,
      removerItem: removerItem,
      alterarQuantidade: alterarQuantidade,
      substituirRascunho: substituirRascunho,
      definirConfirmacao: definirConfirmacao,
      limparConfirmacao: limparConfirmacao,
      confirmar: confirmar,
      tentarNovamente: tentarNovamente,
      limpar: limpar,
    };
  }

  // ───────────────────────────────────────────────────────────────────
  // Consulta da ficha (busca, abrir, histórico) — mesma proteção de ordem
  // ───────────────────────────────────────────────────────────────────

  function criarConsulta() {
    var estado = { lista: [], total: 0, pagina: 1, ficha: null, funcionarioAtual: null, resumo: null, entregas: [], totalEntregas: 0, paginaEntregas: 1, filtro: null };
    var seq = { lista: 0, ficha: 0 };
    var ouvintes = [];
    var pendente = Promise.resolve();
    var avisar = function () { ouvintes.forEach(function (fn) { fn(estado); }); };

    async function listar(filtro) {
      var minha = ++seq.lista;
      var r = await acoes.listarFichas(filtro);
      if (minha !== seq.lista) return { ok: false, descartada: true };
      if (!r.ok) return respostaDeErro(r);
      estado.lista = (r.dados && r.dados.fichas) || [];
      estado.total = (r.dados && r.dados.total) || 0;
      estado.pagina = (r.dados && r.dados.pagina) || 1;
      estado.filtro = filtro;
      avisar();
      return { ok: true, fichas: estado.lista, total: estado.total };
    }

    async function consultarPorCpf(cpf) {
      var v = filtros.cpf(cpf);
      if (!v.ok) return { ok: false, codigo: 'CPF_INVALIDO', mensagem: v.mensagem };
      var minha = ++seq.lista;
      var r = await acoes.consultarFichaPorCpf(v.cpf);
      if (minha !== seq.lista) return { ok: false, descartada: true };
      if (!r.ok) return respostaDeErro(r);
      return { ok: true, funcionario: r.dados && r.dados.funcionario, ficha: r.dados && r.dados.ficha };
    }

    async function carregarEntregas(fichaId, filtro, minha) {
      var r = await acoes.listarEntregasDaFicha(fichaId, filtro);
      if (minha !== seq.ficha) return { ok: false, descartada: true };
      if (!r.ok) return respostaDeErro(r);
      estado.entregas = (r.dados && r.dados.entregas) || [];
      estado.totalEntregas = (r.dados && r.dados.total) || 0;
      estado.paginaEntregas = (r.dados && r.dados.pagina) || 1;
      avisar();
      return { ok: true, entregas: estado.entregas, total: estado.totalEntregas };
    }

    async function abrir(fichaId, filtro) {
      var minha = ++seq.ficha;
      var r = await acoes.buscarFicha(fichaId);
      if (minha !== seq.ficha) return { ok: false, descartada: true };
      if (!r.ok) return respostaDeErro(r);
      estado.ficha = r.dados && r.dados.ficha;
      estado.funcionarioAtual = r.dados && r.dados.funcionarioAtual;
      estado.resumo = r.dados && r.dados.resumo;
      estado.entregas = [];
      avisar();
      pendente = carregarEntregas(fichaId, filtro || { pagina: 1, limite: LIMITES.limitePagina }, minha);
      return { ok: true, ficha: estado.ficha, funcionarioAtual: estado.funcionarioAtual, resumo: estado.resumo, entregas: pendente };
    }

    async function paginaEntregas(filtro) {
      if (!estado.ficha) return { ok: false, codigo: 'SEM_FICHA' };
      return carregarEntregas(estado.ficha.id, filtro, seq.ficha);
    }

    function fechar() {
      seq.ficha += 1;
      estado.ficha = null; estado.funcionarioAtual = null; estado.resumo = null; estado.entregas = []; estado.totalEntregas = 0;
      avisar();
    }

    function limpar() { seq.lista += 1; fechar(); estado.lista = []; estado.total = 0; estado.filtro = null; avisar(); }

    return {
      estado: function () { return estado; },
      aoMudar: function (fn) { ouvintes.push(fn); },
      listar: listar,
      consultarPorCpf: consultarPorCpf,
      abrir: abrir,
      paginaEntregas: paginaEntregas,
      pendente: function () { return pendente; },
      fechar: fechar,
      limpar: limpar,
    };
  }

  global.EpiFicha = {
    LIMITES: LIMITES,
    MOTIVOS: MOTIVOS,
    MODOS: MODOS,
    SITUACOES_CA: SITUACOES_CA,
    DECLARACAO: DECLARACAO,
    rotuloMotivo: rotuloMotivo,
    acoes: acoes,
    permissoes: permissoes,
    filtros: filtros,
    rascunho: rascunho,
    tracos: tracos,
    assinatura: assinatura,
    idempotencia: idempotencia,
    mensagens: mensagens,
    render: render,
    fluxo: { criar: criarFluxo },
    consulta: { criar: criarConsulta },
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.EpiFicha;
  }
})(typeof window !== 'undefined' ? window : globalThis);
