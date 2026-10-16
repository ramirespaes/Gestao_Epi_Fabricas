/*
 * Totem — adaptador da PRÉVIA VISUAL (K7). Carregado por previa.html ANTES do totem.js.
 *
 * Define o `fetch` desta página e responde TUDO em memória, com dados fictícios. Nenhuma requisição sai do navegador: o endereço
 * da API é de um domínio que nunca resolve, a CSP da página bloqueia a rede (connect-src 'none') e o `fetch` original não é
 * guardado nem chamado. Sem cookie, sem armazenamento, sem credencial de tablet, sem CPF: o CPF nunca identifica ninguém aqui.
 *
 * As respostas imitam o contrato real do tablet só no que o totem.js lê. A sessão de 60 s é simulada com o relógio da página.
 *
 * Dois modos, travados UMA vez na carga (pela query da página; nunca por fragmento, que o boot.js apaga):
 *  - demonstração (padrão): matrículas fictícias, tudo em memória;
 *  - consulta real (`?modo=real&pai=<origem da Central>`): a identificação sai por UM postMessage para a janela pai (a Central, que tem a
 *    sessão administrativa e consulta o servidor); o destino é a origem exata do pai, nunca '*'. A resposta só vale se vier da janela pai,
 *    dessa origem, no formato estrito e com o id da consulta pendente. Catálogo, carrinho, revisão e pedido seguem simulados em memória.
 */
(function () {
  'use strict';

  var BASE = 'https://previa.invalid/api';
  var TABLET = '/atendimento-token/tablet';
  var INATIVIDADE_MS = 60 * 1000;
  var MOTIVOS = ['SUBSTITUICAO_PRAZO', 'DESGASTE_DANO', 'PERDA_EXTRAVIO'];

  window.SAFEWORK_PORTAL_API_BASE_URL = BASE;

  var TAMANHOS_BOTINA = ['38', '39', '40', '41', '42', '43', '44'];
  var CATALOGO = [
    { id: 11, nome: 'Botina de Segurança', unidade: 'PAR', categoria: 'EPI', grupoProtecao: 'Proteção dos pés', tipo: { id: 1, nome: 'Botina de Segurança' }, exigeTamanho: true, tamanhos: TAMANHOS_BOTINA, imagem: { disponivel: false } },
    { id: 12, nome: 'Protetor Auricular', unidade: 'UN', categoria: 'EPI', grupoProtecao: 'Proteção auditiva', tipo: { id: 2, nome: 'Proteção Auricular Descartável' }, exigeTamanho: false, tamanhos: [], imagem: { disponivel: false } },
    { id: 13, nome: 'Camiseta', unidade: 'UN', categoria: 'Vestimenta', grupoProtecao: null, tipo: { id: 3, nome: 'Camiseta' }, exigeTamanho: true, tamanhos: ['P', 'M', 'G', 'GG'], imagem: { disponivel: false } },
    { id: 14, nome: 'Capacete', unidade: 'UN', categoria: 'EPI', grupoProtecao: 'Proteção da cabeça', tipo: { id: 4, nome: 'Capacete' }, exigeTamanho: false, tamanhos: [], imagem: { disponivel: false } },
    { id: 15, nome: 'Luva de Proteção', unidade: 'PAR', categoria: 'EPI', grupoProtecao: 'Proteção das mãos', tipo: { id: 5, nome: 'Luva' }, exigeTamanho: true, tamanhos: ['P', 'M', 'G'], imagem: { disponivel: false } },
    { id: 16, nome: 'Óculos de Proteção', unidade: 'UN', categoria: 'EPI', grupoProtecao: 'Proteção ocular', tipo: { id: 6, nome: 'Óculos de Proteção Incolor' }, exigeTamanho: false, tamanhos: [], imagem: { disponivel: false } },
  ];

  var EM_ABERTO = [
    { materialId: 15, nome: 'Luva de Proteção', tamanho: 'M', situacao: 'AGUARDANDO_APROVACAO', quantidade: 2, retiradaParcial: false },
    { materialId: 14, nome: 'Capacete', tamanho: null, situacao: 'DISPONIVEL_PARA_RETIRADA', quantidade: 1, retiradaParcial: false },
  ];

  // 1001: catálogo completo. 1002: sem GHE. 1003: catálogo completo e pedidos em aberto.
  var FUNCIONARIOS = [
    { matricula: '1001', primeiroNome: 'Ana', catalogo: 'OK', abertas: [] },
    { matricula: '1002', primeiroNome: 'Bruno', catalogo: 'SEM_GHE', abertas: [] },
    { matricula: '1003', primeiroNome: 'Carla', catalogo: 'OK', abertas: EM_ABERTO },
  ];

  var atendimento = null;
  var pedidos = {};
  var registro = [];
  var naoSuportadas = 0;

  // ─── Consulta real: ponte com a janela pai ─────────────────────────
  var CANAL = 'safework-previa-totem';
  var ESPERA_DO_PAI_MS = 8000;
  var RESULTADOS = ['OK', 'NAO_IDENTIFICADO', 'LIMITE', 'INDISPONIVEL'];
  var ORIGEM_VALIDA = /^https?:\/\/[A-Za-z0-9.-]{1,253}(:\d{1,5})?$/;
  var parametros = new URLSearchParams(window.location.search);
  var pai = parametros.get('pai');
  var MODO_REAL = parametros.get('modo') === 'real';
  var PAI_VALIDO = MODO_REAL && typeof pai === 'string' && ORIGEM_VALIDA.test(pai) && window.parent && window.parent !== window;
  var pendente = null;

  function chavesIguais(objeto, esperadas) {
    var chaves = Object.keys(objeto).sort();
    return chaves.length === esperadas.length && chaves.every(function (c, i) { return c === esperadas[i]; });
  }

  function catalogoValido(c) {
    return ehObjeto(c) && typeof c.estado === 'string' && Number.isInteger(c.total) && c.total >= 0 && Array.isArray(c.materiais) && c.materiais.length <= 200;
  }

  function mensagemDoPaiValida(ev) {
    if (!ev || ev.source !== window.parent || ev.origin !== pai || !ehObjeto(ev.data) || pendente === null) return false;
    var d = ev.data;
    if (d.canal !== CANAL || d.versao !== 1 || d.tipo !== 'RESULTADO' || d.id !== pendente.id || RESULTADOS.indexOf(d.resultado) === -1) return false;
    if (d.resultado !== 'OK') return chavesIguais(d, ['canal', 'id', 'resultado', 'tipo', 'versao']);
    return chavesIguais(d, ['canal', 'catalogo', 'id', 'primeiroNome', 'resultado', 'tipo', 'versao'])
      && typeof d.primeiroNome === 'string' && d.primeiroNome.trim() !== '' && d.primeiroNome.length <= 100 && catalogoValido(d.catalogo);
  }

  function responderDoPai(d) {
    var p = pendente;
    pendente = null;
    clearTimeout(p.relogio);
    if (d.resultado === 'OK') {
      atendimento = {
        funcionario: { primeiroNome: d.primeiroNome, catalogo: d.catalogo.estado, catalogoReal: d.catalogo, abertas: [] },
        expiraEm: Date.now() + INATIVIDADE_MS,
      };
      p.resolver(resposta(201, { status: 'ok', atendimento: resumo() }));
    } else if (d.resultado === 'NAO_IDENTIFICADO') {
      p.resolver(erro(404, 'FUNCIONARIO_NAO_IDENTIFICADO'));
    } else if (d.resultado === 'LIMITE') {
      p.resolver(erro(429, 'LIMITE_REQUISICOES_EXCEDIDO'));
    } else {
      p.resolver(erro(503, 'INDISPONIVEL'));
    }
  }

  function identificarPeloPai(corpo) {
    if (!ehObjeto(corpo) || (corpo.tipo !== 'CPF' && corpo.tipo !== 'MATRICULA') || typeof corpo.valor !== 'string') return erro(400, 'VALIDACAO');
    if (!PAI_VALIDO) return erro(503, 'INDISPONIVEL');
    if (pendente !== null) return erro(429, 'LIMITE_REQUISICOES_EXCEDIDO');
    return new Promise(function (resolver) {
      var id = window.crypto.randomUUID();
      pendente = {
        id: id,
        resolver: resolver,
        relogio: setTimeout(function () {
          if (pendente !== null && pendente.id === id) { pendente = null; resolver(erro(503, 'INDISPONIVEL')); }
        }, ESPERA_DO_PAI_MS),
      };
      window.parent.postMessage({ canal: CANAL, versao: 1, tipo: 'IDENTIFICAR', id: id, tipoId: corpo.tipo, valor: corpo.valor }, pai);
    });
  }

  if (PAI_VALIDO) {
    window.addEventListener('message', function (ev) { if (mensagemDoPaiValida(ev)) responderDoPai(ev.data); });
  }

  function resposta(status, corpo) {
    var texto = JSON.stringify(corpo);
    return {
      status: status,
      headers: { get: function () { return null; } },
      text: function () { return Promise.resolve(texto); },
    };
  }

  function erro(status, codigo, detalhes) {
    var corpo = { status: 'error', codigo: codigo, message: 'Operação simulada na prévia.' };
    if (detalhes) corpo.detalhes = detalhes;
    return resposta(status, corpo);
  }

  function ehObjeto(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }

  function vigente() {
    if (atendimento !== null && atendimento.expiraEm <= Date.now()) atendimento = null;
    return atendimento;
  }

  function resumo() {
    var restante = Math.max(1, Math.ceil((atendimento.expiraEm - Date.now()) / 1000));
    return {
      funcionario: { primeiroNome: atendimento.funcionario.primeiroNome },
      expiraEm: new Date(atendimento.expiraEm).toISOString(),
      inatividadeSegundos: INATIVIDADE_MS / 1000,
      restanteSegundos: restante,
    };
  }

  function identificar(corpo) {
    if (!ehObjeto(corpo) || (corpo.tipo !== 'CPF' && corpo.tipo !== 'MATRICULA') || typeof corpo.valor !== 'string') return erro(400, 'VALIDACAO');
    // O CPF nunca identifica ninguém na prévia; a matrícula só vale se for uma das fictícias.
    var achado = null;
    if (corpo.tipo === 'MATRICULA') {
      FUNCIONARIOS.forEach(function (f) { if (f.matricula === corpo.valor) achado = f; });
    }
    if (achado === null) return erro(404, 'FUNCIONARIO_NAO_IDENTIFICADO');
    atendimento = { funcionario: achado, expiraEm: Date.now() + INATIVIDADE_MS };
    return resposta(201, { status: 'ok', atendimento: resumo() });
  }

  // O catálogo do colaborador do atendimento: o recebido da consulta real, ou o da demonstração.
  function materialDe(id) {
    var lista = atendimento.funcionario.catalogoReal ? atendimento.funcionario.catalogoReal.materiais : CATALOGO;
    var achado = null;
    lista.forEach(function (m) { if (m && m.id === id) achado = m; });
    return achado;
  }

  function pedidoInvalido(corpo) {
    if (!ehObjeto(corpo) || typeof corpo.chaveIdempotencia !== 'string' || corpo.chaveIdempotencia.length < 8 || corpo.chaveIdempotencia.length > 64) return true;
    if (!Array.isArray(corpo.itens) || corpo.itens.length < 1 || corpo.itens.length > 20) return true;
    return corpo.itens.some(function (i) {
      return !ehObjeto(i) || !Number.isInteger(i.materialId) || !Number.isInteger(i.quantidade) || i.quantidade < 1 || MOTIVOS.indexOf(i.motivo) === -1
        || (i.tamanho !== undefined && i.tamanho !== null && typeof i.tamanho !== 'string');
    });
  }

  function enviarPedido(corpo) {
    if (pedidoInvalido(corpo)) return erro(400, 'VALIDACAO');
    if (Object.prototype.hasOwnProperty.call(pedidos, corpo.chaveIdempotencia)) {
      return resposta(200, { status: 'ok', repetida: true, pedido: pedidos[corpo.chaveIdempotencia] });
    }
    var abertas = atendimento.funcionario.abertas;
    for (var n = 0; n < corpo.itens.length; n += 1) {
      var item = corpo.itens[n];
      var material = materialDe(item.materialId);
      var tamanho = item.tamanho === undefined ? null : item.tamanho;
      var campo = [{ campo: 'body.itens[' + n + '].materialId' }];
      if (material === null || (material.exigeTamanho ? material.tamanhos.indexOf(tamanho) === -1 : tamanho !== null)) return erro(409, 'ITEM_NAO_AUTORIZADO', campo);
      var repetido = abertas.some(function (a) { return a.materialId === item.materialId && a.tamanho === tamanho; });
      if (repetido) return erro(409, 'ITEM_JA_SOLICITADO', campo);
    }
    var pedido = { estado: 'REGISTRADO', numero: 'PREVIA', status: 'PENDENTE', quantidadeItens: corpo.itens.length };
    pedidos[corpo.chaveIdempotencia] = pedido;
    atendimento = null; // o pedido encerra o atendimento, como no tablet
    return resposta(201, { status: 'ok', repetida: false, pedido: pedido });
  }

  function exigirAtendimento(fazer) {
    return vigente() === null ? erro(401, 'ATENDIMENTO_INVALIDO') : fazer();
  }

  function tratar(metodo, caminho, corpo) {
    var consulta = /^\/atendimento\/pedidos\/([^/]+)$/.exec(caminho);
    var chave = metodo + ' ' + (consulta ? '/atendimento/pedidos/:chave' : caminho);
    var conhecida = true;
    var r;
    if (chave === 'GET /estado') {
      r = resposta(200, { status: 'ok', dispositivo: { nome: 'Tablet de demonstração', unidade: 'Prévia', setor: 'Prévia', localInstalacao: 'Prévia' } });
    } else if (chave === 'POST /heartbeat') {
      r = resposta(200, { status: 'ok' });
    } else if (chave === 'POST /atendimento') {
      r = MODO_REAL ? identificarPeloPai(corpo) : identificar(corpo);
    } else if (chave === 'GET /atendimento') {
      r = exigirAtendimento(function () { return resposta(200, { status: 'ok', atendimento: resumo() }); });
    } else if (chave === 'POST /atendimento/atividade') {
      r = exigirAtendimento(function () {
        atendimento.expiraEm = Date.now() + INATIVIDADE_MS;
        return resposta(200, { status: 'ok', atendimento: resumo() });
      });
    } else if (chave === 'POST /atendimento/encerrar') {
      atendimento = null;
      r = resposta(200, { status: 'ok' });
    } else if (chave === 'GET /atendimento/catalogo') {
      r = exigirAtendimento(function () {
        var f = atendimento.funcionario;
        if (f.catalogoReal) return resposta(200, { status: 'ok', catalogo: f.catalogoReal });
        var vazio = f.catalogo !== 'OK';
        return resposta(200, { status: 'ok', catalogo: vazio ? { estado: 'SEM_GHE', total: 0, materiais: [] } : { estado: 'OK', total: CATALOGO.length, materiais: CATALOGO } });
      });
    } else if (chave === 'GET /atendimento/solicitacoes') {
      r = exigirAtendimento(function () {
        var itens = atendimento.funcionario.abertas;
        return resposta(200, { status: 'ok', temDisponiveis: itens.some(function (i) { return i.situacao === 'DISPONIVEL_PARA_RETIRADA'; }), itens: itens });
      });
    } else if (chave === 'POST /atendimento/pedido') {
      r = exigirAtendimento(function () { return enviarPedido(corpo); });
    } else if (chave === 'GET /atendimento/pedidos/:chave') {
      var existente = pedidos[decodeURIComponent(consulta[1])];
      r = existente ? resposta(200, { status: 'ok', pedido: existente }) : erro(404, 'PEDIDO_NAO_ENCONTRADO');
    } else {
      conhecida = false;
      naoSuportadas += 1;
      r = erro(404, 'NAO_ENCONTRADO');
    }
    if (conhecida) registro.push({ metodo: metodo, caminho: consulta ? '/atendimento/pedidos/:chave' : caminho });
    return r;
  }

  window.fetch = function (destino, opcoes) {
    var alvo = String(destino);
    var prefixo = BASE + TABLET;
    if (alvo.indexOf(prefixo) !== 0) return Promise.reject(new TypeError('Prévia: destino fora da simulação.'));
    var metodo = String((opcoes && opcoes.method) || 'GET').toUpperCase();
    var caminho = alvo.slice(prefixo.length).split('?')[0];
    var corpo;
    try {
      corpo = opcoes && typeof opcoes.body === 'string' ? JSON.parse(opcoes.body) : undefined;
    } catch (e) {
      return Promise.resolve(erro(400, 'VALIDACAO'));
    }
    return Promise.resolve().then(function () { return tratar(metodo, caminho, corpo); });
  };

  // Só para os testes e para a conferência: método e caminho já normalizados, nunca corpo, valor digitado ou chave do pedido.
  window.TotemPrevia = Object.freeze({
    chamadas: function () { return registro.map(function (c) { return { metodo: c.metodo, caminho: c.caminho }; }); },
    naoSuportadas: function () { return naoSuportadas; },
  });
})();
