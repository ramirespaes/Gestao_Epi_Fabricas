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

  // DEMO-FOTOS: recorte de 8 EPIs do GHE-017 (FORNO FUSÃO) com nomes limpos e a fotografia da Biblioteca de Imagens padrão de cada um (`imagem.id` = id da imagem
  // padrão). As fotografias vêm de previa-imagens-demo.js e são servidas em memória pelo caminho de imagem do Totem; nada sai da página.
  var FOTO = function (id) { return { disponivel: true, origem: 'PADRAO', id: id, versao: 1 }; };
  var TAMANHOS_SAPATO = ['33', '34', '35', '36', '37', '38', '39', '40', '41', '42', '43', '44', '45', '46'];
  var CATALOGO = [
    { id: 11, nome: 'Calça de Segurança', unidade: 'UN', categoria: 'EPI', grupoProtecao: 'Proteção das pernas', tipo: { id: 1, nome: 'Calça de Segurança' }, exigeTamanho: true, tamanhos: ['P', 'M', 'G', 'GG', 'XGG'], imagem: FOTO('4') },
    { id: 12, nome: 'Capacete de Segurança', unidade: 'UN', categoria: 'EPI', grupoProtecao: 'Proteção da cabeça', tipo: { id: 2, nome: 'Capacete de Segurança' }, exigeTamanho: false, tamanhos: [], imagem: FOTO('6') },
    { id: 13, nome: 'Luva de Segurança', unidade: 'PAR', categoria: 'EPI', grupoProtecao: 'Proteção das mãos', tipo: { id: 3, nome: 'Luva de Segurança' }, exigeTamanho: true, tamanhos: ['P', 'M', 'G', 'GG'], imagem: FOTO('12') },
    { id: 14, nome: 'Óculos de Proteção Incolor', unidade: 'UN', categoria: 'EPI', grupoProtecao: 'Proteção ocular', tipo: { id: 4, nome: 'Óculos de Proteção Incolor' }, exigeTamanho: false, tamanhos: [], imagem: FOTO('29') },
    { id: 15, nome: 'Protetor Auricular Concha', unidade: 'UN', categoria: 'EPI', grupoProtecao: 'Proteção auditiva', tipo: { id: 5, nome: 'Protetor Auricular Concha' }, exigeTamanho: false, tamanhos: [], imagem: FOTO('18') },
    { id: 16, nome: 'Respirador PFF2', unidade: 'UN', categoria: 'EPI', grupoProtecao: 'Proteção respiratória', tipo: { id: 6, nome: 'Respirador PFF2' }, exigeTamanho: false, tamanhos: [], imagem: FOTO('21') },
    { id: 17, nome: 'Sapato de Segurança', unidade: 'PAR', categoria: 'EPI', grupoProtecao: 'Proteção dos pés', tipo: { id: 7, nome: 'Sapato de Segurança' }, exigeTamanho: true, tamanhos: TAMANHOS_SAPATO, imagem: FOTO('22') },
    { id: 18, nome: 'Vestimenta para Proteção do Tronco', unidade: 'UN', categoria: 'EPI', grupoProtecao: 'Proteção do tronco', tipo: { id: 8, nome: 'Vestimenta para Proteção do Tronco' }, exigeTamanho: true, tamanhos: ['P', 'M', 'G', 'GG'], imagem: FOTO('23') },
  ];

  var EM_ABERTO = [
    { materialId: 13, nome: 'Luva de Segurança', tamanho: 'M', situacao: 'AGUARDANDO_APROVACAO', quantidade: 2, retiradaParcial: false },
    { materialId: 12, nome: 'Capacete de Segurança', tamanho: null, situacao: 'DISPONIVEL_PARA_RETIRADA', quantidade: 1, retiradaParcial: false },
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

  // Fotografias (consulta real): o Totem pede a foto pelo fetch desta página; o pedido vira UMA mensagem à janela pai, que tem a sessão da Central
  // e a rota autorizada, e a resposta vira um objeto compatível com o que o totem.js lê (status, cabeçalhos, blob, texto). Erro administrativo
  // (sem acesso, não encontrada) volta como 404 e NUNCA como 401 ou 403, que o totem.js trataria como tablet ou rede não autorizados.
  var RESULTADOS_IMAGEM = ['OK', 'NAO_ENCONTRADA', 'SEM_ACESSO', 'LIMITE', 'INDISPONIVEL'];
  var ESPERA_IMAGEM_DO_PAI_MS = 20000;
  var IMAGEM_BYTES_MAXIMOS = 4 * 1024 * 1024;
  var ESPERA_MAXIMA_S = 120;
  var ROTA_IMAGEM = /^\/atendimento\/imagens\/(empresa|padrao)\/([1-9][0-9]{0,18})\/(miniatura|exibicao)$/;
  var imagensPendentes = {};

  function enviarAoPai(mensagem) {
    window.parent.postMessage(mensagem, pai);
  }

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
      enviarAoPai({ canal: CANAL, versao: 1, tipo: 'IDENTIFICAR', id: id, tipoId: corpo.tipo, valor: corpo.valor });
    });
  }

  function blobValido(b) {
    return b !== null && typeof b === 'object' && typeof b.size === 'number' && b.size > 0 && b.size <= IMAGEM_BYTES_MAXIMOS
      && (typeof Blob !== 'function' || b instanceof Blob);
  }

  function imagemDoPaiValida(ev) {
    if (!ev || ev.source !== window.parent || ev.origin !== pai || !ehObjeto(ev.data)) return false;
    var d = ev.data;
    if (d.canal !== CANAL || d.versao !== 1 || d.tipo !== 'IMAGEM_RESULTADO' || typeof d.id !== 'string'
      || !Object.prototype.hasOwnProperty.call(imagensPendentes, d.id) || RESULTADOS_IMAGEM.indexOf(d.resultado) === -1) return false;
    var base = ['canal', 'id', 'resultado', 'tipo', 'versao'];
    if (d.resultado === 'OK') return chavesIguais(d, base.concat('blob').sort()) && blobValido(d.blob);
    if (d.resultado === 'LIMITE') return chavesIguais(d, base.concat('espera').sort()) && Number.isInteger(d.espera) && d.espera >= 1 && d.espera <= ESPERA_MAXIMA_S;
    return chavesIguais(d, base);
  }

  function respostaImagem(status, cabecalhos, corpo, blob) {
    var texto = corpo === null ? '' : JSON.stringify(corpo);
    return {
      status: status,
      ok: status >= 200 && status < 300,
      headers: { get: function (nome) { var k = String(nome).toLowerCase(); return Object.prototype.hasOwnProperty.call(cabecalhos, k) ? cabecalhos[k] : null; } },
      blob: function () { return Promise.resolve(blob); },
      text: function () { return Promise.resolve(texto); },
    };
  }

  function respostaDaImagem(d) {
    if (d.resultado === 'OK') return respostaImagem(200, { 'content-type': 'image/webp' }, null, d.blob);
    if (d.resultado === 'LIMITE') return respostaImagem(429, { 'retry-after': String(d.espera) }, { status: 'error', codigo: 'LIMITE_REQUISICOES_EXCEDIDO', message: 'Operação simulada na prévia.' }, null);
    if (d.resultado === 'INDISPONIVEL') return erro(503, 'INDISPONIVEL');
    return erro(404, 'IMAGEM_NAO_ENCONTRADA');
  }

  function liberarPedidoDeImagem(id) {
    var p = imagensPendentes[id];
    delete imagensPendentes[id];
    clearTimeout(p.relogio);
    if (p.sinal && p.aoAbortar) p.sinal.removeEventListener('abort', p.aoAbortar);
    return p;
  }

  function responderImagem(d) {
    liberarPedidoDeImagem(d.id).resolver(respostaDaImagem(d));
  }

  function erroDeAborto() {
    var e = new Error('abortado');
    e.name = 'AbortError';
    return e;
  }

  function buscarImagemDoPai(rota, alvo, opcoes) {
    var consulta = /\?v=([1-9][0-9]{0,9})$/.exec(alvo);
    var versaoImagem = consulta ? Number(consulta[1]) : 0;
    if (!PAI_VALIDO || versaoImagem < 1 || versaoImagem > 2147483647) return Promise.resolve(erro(404, 'IMAGEM_NAO_ENCONTRADA'));
    registro.push({ metodo: 'GET', caminho: '/atendimento/imagens/:origem/:id/:variante' });
    var sinal = opcoes && opcoes.signal;
    if (sinal && sinal.aborted) return Promise.reject(erroDeAborto());
    return new Promise(function (resolver, rejeitar) {
      var id = window.crypto.randomUUID();
      var p = { resolver: resolver, relogio: null, sinal: sinal, aoAbortar: null };
      imagensPendentes[id] = p;
      p.relogio = setTimeout(function () {
        if (!Object.prototype.hasOwnProperty.call(imagensPendentes, id)) return;
        liberarPedidoDeImagem(id);
        enviarAoPai({ canal: CANAL, versao: 1, tipo: 'IMAGEM_CANCELAR', id: id });
        resolver(erro(503, 'INDISPONIVEL'));
      }, ESPERA_IMAGEM_DO_PAI_MS);
      if (sinal && typeof sinal.addEventListener === 'function') {
        p.aoAbortar = function () {
          if (!Object.prototype.hasOwnProperty.call(imagensPendentes, id)) return;
          liberarPedidoDeImagem(id);
          enviarAoPai({ canal: CANAL, versao: 1, tipo: 'IMAGEM_CANCELAR', id: id });
          rejeitar(erroDeAborto());
        };
        sinal.addEventListener('abort', p.aoAbortar);
      }
      enviarAoPai({ canal: CANAL, versao: 1, tipo: 'IMAGEM', id: id, origem: rota[1] === 'empresa' ? 'EMPRESA' : 'PADRAO', imagemId: rota[2], versaoImagem: versaoImagem, variante: rota[3] });
    });
  }

  if (PAI_VALIDO) {
    window.addEventListener('message', function (ev) {
      if (mensagemDoPaiValida(ev)) responderDoPai(ev.data);
      else if (imagemDoPaiValida(ev)) responderImagem(ev.data);
    });
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

  // ─── Demonstração: fotografias embutidas ───────────────────────────
  // Só no modo demonstração (o modo real pede a foto à janela pai). Os dados são os de previa-imagens-demo.js (WebP em base64, estáticos); a resposta imita a do
  // tablet no que o totem.js lê: 200, Content-Type image/webp e o Blob. Só vale origem padrao, versão ?v= válida, variante miniatura|exibicao e um id embutido;
  // o resto é 404. Nada é pedido à rede ou à janela pai.
  var ALFABETO_BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var INDICE_BASE64 = {};
  for (var posicao = 0; posicao < ALFABETO_BASE64.length; posicao += 1) INDICE_BASE64[ALFABETO_BASE64.charAt(posicao)] = posicao;

  function decodificarBase64(texto) {
    var limpo = String(texto).replace(/=+$/, '');
    var saida = new Uint8Array(Math.floor(limpo.length * 3 / 4));
    var acumulado = 0;
    var bits = 0;
    var escritos = 0;
    for (var i = 0; i < limpo.length; i += 1) {
      acumulado = (acumulado << 6) | INDICE_BASE64[limpo.charAt(i)];
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        saida[escritos] = (acumulado >> bits) & 255;
        escritos += 1;
        acumulado &= (1 << bits) - 1;
      }
    }
    return saida.subarray(0, escritos);
  }

  function fotoDaDemonstracao(rota, alvo) {
    registro.push({ metodo: 'GET', caminho: '/atendimento/imagens/:origem/:id/:variante' });
    var consulta = /\?v=([1-9][0-9]{0,9})$/.exec(alvo);
    var fotos = window.TOTEM_PREVIA_IMAGENS;
    var dados = fotos !== null && typeof fotos === 'object' && rota[1] === 'padrao' && consulta !== null && Number(consulta[1]) === 1
      && Object.prototype.hasOwnProperty.call(fotos, rota[2]) ? fotos[rota[2]] : null;
    var base64 = dados !== null && typeof dados[rota[3]] === 'string' ? dados[rota[3]] : null;
    if (base64 === null || typeof Blob !== 'function') return erro(404, 'IMAGEM_NAO_ENCONTRADA');
    return respostaImagem(200, { 'content-type': 'image/webp' }, null, new Blob([decodificarBase64(base64)], { type: 'image/webp' }));
  }

  window.fetch = function (destino, opcoes) {
    var alvo = String(destino);
    var prefixo = BASE + TABLET;
    if (alvo.indexOf(prefixo) !== 0) return Promise.reject(new TypeError('Prévia: destino fora da simulação.'));
    var metodo = String((opcoes && opcoes.method) || 'GET').toUpperCase();
    var caminho = alvo.slice(prefixo.length).split('?')[0];
    var imagem = MODO_REAL && metodo === 'GET' ? ROTA_IMAGEM.exec(caminho) : null;
    if (imagem !== null) return buscarImagemDoPai(imagem, alvo, opcoes);
    var fotoDaDemo = !MODO_REAL && metodo === 'GET' ? ROTA_IMAGEM.exec(caminho) : null;
    if (fotoDaDemo !== null) return Promise.resolve(fotoDaDemonstracao(fotoDaDemo, alvo));
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
