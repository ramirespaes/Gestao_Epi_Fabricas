(function (global) {
  'use strict';

  /**
   * EpiSuporte — Suporte do Portal Empresarial (pages/support.html).
   *
   * Só rotas reais, sempre da empresa e do usuário da SESSÃO (o navegador nunca informa empresa, usuário, e-mail do solicitante nem
   * destinatário):
   *   GET  /suporte/canais              se o e-mail do Almoxarifado e o da SST estão cadastrados (nunca o endereço)
   *   POST /suporte/chamados            abrir chamado (suporte do sistema), idempotente pela chave
   *   GET  /suporte/chamados            meus chamados
   *   GET  /suporte/chamados/:id        meu chamado, respostas e histórico
   *   POST /suporte/contatos/:canal     contato com o Almoxarifado ou a SST da própria empresa, idempotente pela chave
   *
   * O resultado de um contato nunca é anunciado como entrega sem confirmação do servidor: só ENVIO_CONFIRMADO diz "enviada";
   * os demais estados dizem o que de fato aconteceu. A chave de idempotência (UUID) é a mesma enquanto o conteúdo não muda, então
   * "tentar de novo" nunca duplica; muda quando o conteúdo muda e depois de um registro bem-sucedido.
   *
   * Todo texto do servidor ou do usuário entra no DOM só por textContent/value; nada vai para armazenamento do navegador.
   */

  var CAMINHO = '/suporte';
  var CANAIS = { almoxarifado: 'ALMOXARIFADO', sst: 'SST' };
  var CATEGORIAS = [
    ['ERRO', 'Erro ou falha'], ['LENTIDAO', 'Lentidão'], ['ACESSO', 'Acesso ou senha'],
    ['DUVIDA', 'Dúvida de uso'], ['SUGESTAO', 'Sugestão'], ['OUTRO', 'Outro'],
  ];
  var SITUACOES = {
    ABERTO: 'Aberto', EM_ATENDIMENTO: 'Em atendimento', RESPONDIDO: 'Respondido', ENCERRADO: 'Encerrado',
  };
  var LIMITES = { assunto: 150, texto: 4000 };
  // Polling da conversa: só com a janela aberta, uma requisição em voo por vez, pausado com a aba oculta.
  var INTERVALO_CONVERSA_MS = 10000;
  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  var CONTROLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

  var TEXTOS = {
    CARREGANDO: 'Carregando seus chamados…',
    SEM_CHAMADOS: 'Você ainda não abriu nenhum chamado.',
    FALHA_LISTA: 'Não foi possível carregar seus chamados agora. Recarregue a página para tentar novamente.',
    FALHA_DETALHE: 'Não foi possível abrir o chamado agora. Tente novamente.',
    ENVIANDO: 'Enviando…',
    CHAMADO_ABERTO: function (protocolo) { return 'Chamado registrado. Protocolo: ' + protocolo + '. Guarde este número para acompanhar o atendimento.'; },
    CHAMADO_REPETIDO: function (protocolo) { return 'Este chamado já estava registrado. Protocolo: ' + protocolo + '.'; },
    CONTATO: {
      ENVIO_CONFIRMADO: function (rotulo) { return 'Mensagem registrada e enviada ao e-mail cadastrado do ' + rotulo + '.'; },
      GRAVADO_EM_ARQUIVO: function () { return 'Mensagem registrada, mas o envio por e-mail não está ativo neste ambiente. Nenhum e-mail foi entregue.'; },
      NAO_ENVIADO: function () { return 'Mensagem registrada, mas o envio por e-mail não está ativo neste ambiente. Nenhum e-mail foi entregue.'; },
      FALHA: function () { return 'Mensagem registrada, mas o envio por e-mail falhou. Nenhum e-mail foi entregue. Tente novamente mais tarde ou use outro meio de contato.'; },
      REGISTRADA: function () { return 'Mensagem registrada, mas o envio ainda não foi confirmado. Não envie de novo: ela não foi duplicada.'; },
    },
    SEM_DESTINATARIO: {
      ALMOXARIFADO: 'O e-mail do Almoxarifado ainda não foi cadastrado. Quem tem acesso a Dados da Empresa pode cadastrá-lo em Dados da Empresa.',
      SST: 'O e-mail da SST ainda não foi cadastrado. Quem tem acesso a Dados da Empresa pode cadastrá-lo em Dados da Empresa.',
    },
    CANAL_SEM_EMAIL: 'E-mail ainda não cadastrado em Dados da Empresa.',
    CANAL_COM_EMAIL: 'E-mail cadastrado em Dados da Empresa.',
    LIMITE: 'Muitas tentativas em pouco tempo. Aguarde um momento e tente novamente.',
    REDE: 'Não foi possível falar com o servidor. Verifique sua conexão e tente novamente.',
    CONFLITO_CHAVE: 'Esta mensagem já foi enviada com outro conteúdo. Feche e abra o formulário para enviar uma nova.',
    NOVAS: function (n) { return n === 1 ? '1 nova resposta' : n + ' novas respostas'; },
    REMETENTE_VOCE: 'Você',
    REMETENTE_SUPORTE: 'Suporte SafeWork',
    SEM_MENSAGENS: 'Ainda não há mensagens nesta conversa. A equipe SafeWork responde por aqui.',
    CONVERSA_ENCERRADA: 'Este chamado está encerrado: a conversa fica disponível para leitura, mas não recebe novas mensagens. Se precisar, abra um novo chamado.',
    CONVERSA_ENCERRADA_AGORA: 'O suporte encerrou este chamado. A conversa continua disponível para leitura.',
    MENSAGEM_ENVIADA: 'Mensagem enviada.',
    MENSAGEM_REPETIDA: 'Esta mensagem já tinha sido enviada.',
    CONVERSA_FALHA_ATUALIZAR: 'Não foi possível buscar novas mensagens agora. Tentando de novo em instantes.',
    GENERICO: 'Não foi possível concluir agora. Tente novamente.',
    CORRIJA: 'Corrija os campos destacados.',
  };

  var MSG = {
    assunto: 'Informe o assunto (até ' + LIMITES.assunto + ' caracteres, sem quebra de linha).',
    texto: 'Informe o texto (até ' + LIMITES.texto + ' caracteres).',
    categoria: 'Escolha uma categoria.',
  };

  function http() {
    if (!global.EpiHttp) throw new Error('EpiHttp não carregado: inclua js/api-http.js antes de js/suporte.js');
    return global.EpiHttp;
  }
  function ehTexto(v) { return typeof v === 'string'; }
  function comprimento(t) { return Array.from(t).length; }

  // ─── Ações ─────────────────────────────────────────────────────────
  function exigirChave(chave) {
    if (!ehTexto(chave) || !UUID.test(chave)) throw new TypeError('chave de idempotência inválida');
  }
  function exigirId(id) {
    if (typeof id !== 'number' || Math.floor(id) !== id || id < 1) throw new TypeError('identificador inválido');
  }
  function exigirCorpo(corpo, campos) {
    if (!corpo || typeof corpo !== 'object' || Array.isArray(corpo)) throw new TypeError('corpo inválido');
    Object.keys(corpo).forEach(function (c) { if (campos.indexOf(c) === -1) throw new TypeError('campo não permitido: ' + c); });
    exigirChave(corpo.chaveIdempotencia);
  }

  var acoes = {
    canais: function () { return http().requisitar('GET', CAMINHO + '/canais'); },
    listarChamados: function (pagina) {
      var p = pagina === undefined ? 1 : pagina;
      exigirId(p);
      return http().requisitar('GET', CAMINHO + '/chamados?pagina=' + p + '&limite=20');
    },
    detalharChamado: function (id) { exigirId(id); return http().requisitar('GET', CAMINHO + '/chamados/' + id); },
    /** Só as mensagens mais novas que `aposId` (0 = todas) e a situação atual: é o que o polling da conversa aberta pede. */
    novasMensagens: function (id, aposId) {
      exigirId(id);
      var apos = aposId === undefined ? 0 : aposId;
      if (typeof apos !== 'number' || Math.floor(apos) !== apos || apos < 0) throw new TypeError('aposId inválido');
      return http().requisitar('GET', CAMINHO + '/chamados/' + id + '/mensagens?aposId=' + apos);
    },
    /** @param {{texto, chaveIdempotencia}} corpo mensagem do solicitante na conversa do próprio chamado */
    enviarMensagem: function (id, corpo) {
      exigirId(id);
      exigirCorpo(corpo, ['texto', 'chaveIdempotencia']);
      return http().requisitar('POST', CAMINHO + '/chamados/' + id + '/mensagens', { corpo: corpo });
    },
    /** @param {{assunto, categoria, descricao, chaveIdempotencia}} corpo */
    abrirChamado: function (corpo) {
      exigirCorpo(corpo, ['assunto', 'categoria', 'descricao', 'chaveIdempotencia']);
      return http().requisitar('POST', CAMINHO + '/chamados', { corpo: corpo });
    },
    /** @param {string} canal 'almoxarifado' | 'sst'; @param {{assunto, mensagem, chaveIdempotencia}} corpo */
    enviarContato: function (canal, corpo) {
      if (!Object.prototype.hasOwnProperty.call(CANAIS, canal)) throw new TypeError('canal inválido');
      exigirCorpo(corpo, ['assunto', 'mensagem', 'chaveIdempotencia']);
      return http().requisitar('POST', CAMINHO + '/contatos/' + canal, { corpo: corpo });
    },
  };

  // ─── Modelo ────────────────────────────────────────────────────────
  var modelo = {
    canais: function (r) {
      var c = r && r.ok && r.dados ? r.dados.canais : null;
      if (!c || !c.almoxarifado || !c.sst) return null;
      if (typeof c.almoxarifado.configurado !== 'boolean' || typeof c.sst.configurado !== 'boolean') return null;
      return { almoxarifado: c.almoxarifado.configurado, sst: c.sst.configurado };
    },
    chamado: function (c) {
      if (!c || typeof c !== 'object') return null;
      if (typeof c.id !== 'number' || !ehTexto(c.protocolo) || !ehTexto(c.assunto) || !ehTexto(c.situacao)) return null;
      return {
        id: c.id, protocolo: c.protocolo, assunto: c.assunto, categoria: ehTexto(c.categoria) ? c.categoria : '',
        descricao: ehTexto(c.descricao) ? c.descricao : '', situacao: c.situacao, criadoEm: ehTexto(c.criadoEm) ? c.criadoEm : '',
        naoLidas: typeof c.naoLidas === 'number' && c.naoLidas > 0 ? Math.floor(c.naoLidas) : 0,
      };
    },
    /** Uma mensagem da conversa: id, autor (SOLICITANTE | SAFEWORK), texto e instante; qualquer outra forma é descartada. */
    mensagem: function (m) {
      if (!m || typeof m !== 'object' || typeof m.id !== 'number' || !ehTexto(m.texto)) return null;
      if (m.autor !== 'SOLICITANTE' && m.autor !== 'SAFEWORK') return null;
      return { id: m.id, autor: m.autor, texto: m.texto, criadoEm: ehTexto(m.criadoEm) ? m.criadoEm : '' };
    },
    /** { situacao, mensagens } da leitura incremental, ou null. */
    novas: function (r) {
      var d = r && r.ok && r.dados ? r.dados : null;
      if (!d || !ehTexto(d.situacao) || !Array.isArray(d.mensagens)) return null;
      var mensagens = d.mensagens.map(modelo.mensagem);
      if (mensagens.some(function (m) { return m === null; })) return null;
      return { situacao: d.situacao, mensagens: mensagens };
    },
    lista: function (r) {
      var d = r && r.ok && r.dados ? r.dados : null;
      if (!d || !Array.isArray(d.itens)) return null;
      var itens = d.itens.map(modelo.chamado);
      if (itens.some(function (c) { return c === null; })) return null;
      return { itens: itens, total: typeof d.total === 'number' ? d.total : itens.length };
    },
    detalhe: function (r) {
      var d = r && r.ok && r.dados ? r.dados : null;
      var chamado = d ? modelo.chamado(d.chamado) : null;
      if (!chamado || !Array.isArray(d.mensagens) || !Array.isArray(d.historico)) return null;
      var mensagens = d.mensagens.map(modelo.mensagem);
      if (mensagens.some(function (m) { return m === null; })) return null;
      var historico = d.historico.filter(function (x) { return x && ehTexto(x.para); })
        .map(function (x) { return { de: ehTexto(x.de) ? x.de : null, para: x.para, criadoEm: ehTexto(x.criadoEm) ? x.criadoEm : '' }; });
      return { chamado: chamado, mensagens: mensagens, historico: historico };
    },
    /** { situacaoEnvio, entregaConfirmada, repetido } ou null. */
    contato: function (r) {
      var c = r && r.ok && r.dados ? r.dados.contato : null;
      if (!c || !ehTexto(c.situacaoEnvio) || !TEXTOS.CONTATO[c.situacaoEnvio]) return null;
      return { situacaoEnvio: c.situacaoEnvio, entregaConfirmada: c.entregaConfirmada === true, repetido: r.dados.repetido === true };
    },
  };

  // ─── Formulário ────────────────────────────────────────────────────
  /** Texto canônico, o mesmo que o servidor grava: CRLF→LF, aparado, NFC. */
  function normalizar(texto) {
    var t = ehTexto(texto) ? texto.replace(/\r\n?/g, '\n').trim() : '';
    return typeof t.normalize === 'function' ? t.normalize('NFC') : t;
  }
  function textoValido(t, max) { var n = comprimento(t); return n >= 1 && n <= max && !CONTROLE.test(t); }

  var formulario = {
    normalizar: normalizar,
    /** { campo: texto } com os mesmos limites do servidor. */
    validarChamado: function (v) {
      var erros = {};
      var assunto = normalizar(v && v.assunto);
      if (!textoValido(assunto, LIMITES.assunto) || /\n/.test(assunto)) erros.assunto = MSG.assunto;
      if (!CATEGORIAS.some(function (c) { return c[0] === (v && v.categoria); })) erros.categoria = MSG.categoria;
      if (!textoValido(normalizar(v && v.descricao), LIMITES.texto)) erros.descricao = MSG.texto;
      return erros;
    },
    validarContato: function (v) {
      var erros = {};
      var assunto = normalizar(v && v.assunto);
      if (!textoValido(assunto, LIMITES.assunto) || /\n/.test(assunto)) erros.assunto = MSG.assunto;
      if (!textoValido(normalizar(v && v.mensagem), LIMITES.texto)) erros.mensagem = MSG.texto;
      return erros;
    },
    /** Impressão do conteúdo: a chave só muda se ele mudar. */
    impressao: function (v) { return JSON.stringify([normalizar(v.assunto), v.categoria || '', normalizar(v.descricao || v.mensagem || '')]); },
  };

  /** UUID v4 do navegador; sem crypto, a ação fica indisponível (erro de programação), nunca uma chave previsível. */
  function novaChave() {
    var c = global.crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    if (c && typeof c.getRandomValues === 'function') {
      var b = new Uint8Array(16);
      c.getRandomValues(b);
      b[6] = (b[6] & 0x0f) | 0x40;
      b[8] = (b[8] & 0x3f) | 0x80;
      var h = Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
      return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
    }
    throw new Error('sem gerador seguro de identificador');
  }

  /** Mesma chave enquanto o conteúdo não muda; `descartar()` depois de um registro bem-sucedido. */
  function criarGuardaDeChave() {
    var atual = null;
    return {
      para: function (impressao) {
        if (atual === null || atual.impressao !== impressao) atual = { impressao: impressao, chave: novaChave() };
        return atual.chave;
      },
      descartar: function () { atual = null; },
    };
  }

  // ─── Erros ─────────────────────────────────────────────────────────
  var erros = {
    /** { sessao } | { aviso } | { campos } a partir do envelope; nunca o texto do servidor. */
    daEscrita: function (r, canal) {
      var status = r ? r.status : 0;
      var codigo = r ? r.codigo : null;
      if (status === 401) return { sessao: true };
      if (status === 409 && codigo === 'DESTINATARIO_NAO_CONFIGURADO') return { aviso: TEXTOS.SEM_DESTINATARIO[CANAIS[canal]] || TEXTOS.GENERICO };
      if (status === 409 && codigo === 'CHAVE_IDEMPOTENCIA_CONFLITO') return { aviso: TEXTOS.CONFLITO_CHAVE, descartarChave: true };
      if (status === 429) return { aviso: TEXTOS.LIMITE };
      if (status === 400) {
        if (codigo === 'VALIDACAO' && r && Array.isArray(r.detalhes)) {
          var campos = {};
          r.detalhes.forEach(function (d) {
            var m = d && ehTexto(d.campo) ? /^body\.(assunto|categoria|descricao|mensagem|texto)$/.exec(d.campo) : null;
            if (m) campos[m[1]] = m[1] === 'assunto' ? MSG.assunto : (m[1] === 'categoria' ? MSG.categoria : MSG.texto);
          });
          if (Object.keys(campos).length > 0) return { campos: campos };
        }
        return { aviso: TEXTOS.CORRIJA };
      }
      if (status === 0) return { aviso: TEXTOS.REDE };
      return { aviso: TEXTOS.GENERICO };
    },
  };

  function rotuloDoCanal(canal) { return canal === 'sst' ? 'SST' : 'Almoxarifado'; }

  /** Texto do resultado do contato: só ENVIO_CONFIRMADO fala em "enviada". */
  function textoDoContato(canal, contato) {
    var f = TEXTOS.CONTATO[contato.situacaoEnvio];
    return f(rotuloDoCanal(canal));
  }

  function formatarData(iso) {
    if (!ehTexto(iso) || iso === '') return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    try {
      return new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }).format(d);
    } catch (e) {
      return d.toISOString();
    }
  }

  // ─── Tela ──────────────────────────────────────────────────────────
  function criarTela(opcoes) {
    var o = opcoes || {};
    var doc = o.documento || global.document;
    var $ = function (id) { return doc.getElementById(id); };
    var guardas = { chamado: criarGuardaDeChave(), almoxarifado: criarGuardaDeChave(), sst: criarGuardaDeChave() };
    var enviando = false;
    var encerrada = false;
    var modalAtual = null;
    var canalAtual = null;

    function definir(id, texto) { var el = $(id); if (el) el.textContent = texto || ''; }
    function aviso(texto) {
      var caixa = $('supAviso');
      if (!caixa) return;
      caixa.textContent = texto || '';
      caixa.style.display = texto ? '' : 'none';
    }
    function erroDoCampo(id, texto) {
      var span = $('err-' + id);
      var campo = $(id);
      if (span) span.textContent = texto || '';
      if (campo) { if (texto) campo.setAttribute('aria-invalid', 'true'); else campo.removeAttribute('aria-invalid'); }
    }
    function abrirModal(id) {
      fecharModal();
      var m = $(id);
      if (!m) return;
      m.classList.add('open');
      modalAtual = id;
    }
    function fecharModal() {
      if (modalAtual === null) return;
      var m = $(modalAtual);
      if (m) m.classList.remove('open');
      var eraConversa = modalAtual === 'supDetalheModal';
      modalAtual = null;
      if (eraConversa) encerrarConversa();
    }
    function ocupado(sim) {
      enviando = sim;
      ['supChamadoEnviar', 'supContatoEnviar'].forEach(function (id) {
        var b = $(id);
        if (b) { b.disabled = sim; b.setAttribute('aria-busy', sim ? 'true' : 'false'); }
      });
      var enviar = $('supConversaEnviar');
      if (enviar) { enviar.disabled = sim || conversa.situacao === 'ENCERRADO'; enviar.setAttribute('aria-busy', sim ? 'true' : 'false'); }
    }
    function sessaoEncerrada() {
      encerrada = true;
      if (typeof o.aoSessaoEncerrada === 'function') o.aoSessaoEncerrada();
    }

    // Canais: só diz se o e-mail está cadastrado (o endereço nunca chega ao navegador).
    var canais = { almoxarifado: null, sst: null };
    async function carregarCanais() {
      var r = await acoes.canais();
      if (r && r.status === 401) { sessaoEncerrada(); return; }
      var m = modelo.canais(r);
      if (m === null) return;
      canais.almoxarifado = m.almoxarifado;
      canais.sst = m.sst;
      definir('supEstadoAlmoxarifado', m.almoxarifado ? TEXTOS.CANAL_COM_EMAIL : TEXTOS.CANAL_SEM_EMAIL);
      definir('supEstadoSst', m.sst ? TEXTOS.CANAL_COM_EMAIL : TEXTOS.CANAL_SEM_EMAIL);
    }

    // Meus chamados.
    function linhaDoChamado(c) {
      var linha = doc.createElement('div');
      linha.className = 'switch-row';
      var texto = doc.createElement('div');
      texto.className = 'switch-text';
      var titulo = doc.createElement('strong');
      titulo.textContent = c.protocolo + ' · ' + c.assunto;
      var detalhe = doc.createElement('span');
      detalhe.textContent = (SITUACOES[c.situacao] || c.situacao) + ' · ' + formatarData(c.criadoEm);
      if (c.naoLidas > 0) {
        // Indicação de resposta ainda não lida: vem do servidor (derivada do último "visto"), nunca do navegador.
        var novas = doc.createElement('strong');
        novas.setAttribute('data-nao-lidas', String(c.naoLidas));
        novas.textContent = ' · ' + TEXTOS.NOVAS(c.naoLidas);
        detalhe.appendChild(novas);
      }
      texto.appendChild(titulo);
      texto.appendChild(detalhe);
      var botao = doc.createElement('button');
      botao.className = 'mini-btn';
      botao.type = 'button';
      botao.setAttribute('data-chamado', String(c.id));
      botao.textContent = 'Abrir conversa';
      linha.appendChild(texto);
      linha.appendChild(botao);
      return linha;
    }
    async function carregarChamados() {
      var lista = $('supChamados');
      if (!lista) return;
      definir('supChamadosEstado', TEXTOS.CARREGANDO);
      var r = await acoes.listarChamados(1);
      if (r && r.status === 401) { sessaoEncerrada(); return; }
      var m = modelo.lista(r);
      if (m === null) { definir('supChamadosEstado', TEXTOS.FALHA_LISTA); return; }
      lista.textContent = '';
      m.itens.forEach(function (c) { lista.appendChild(linhaDoChamado(c)); });
      definir('supChamadosEstado', m.itens.length === 0 ? TEXTOS.SEM_CHAMADOS : '');
    }

    // ─── Conversa do chamado (janela de bate-papo vinculada ao protocolo) ─────────────────────────────────────────
    // Só UMA conversa aberta por vez; a sondagem roda só com a janela aberta, uma requisição em voo, pausada com a aba
    // oculta, e NUNCA toca no que está sendo digitado (só acrescenta mensagens novas pelo id).
    var conversa = { id: null, ultimoId: 0, timer: null, emVoo: false, situacao: null, vazio: null };
    var guardasConversa = {};
    function guardaDaConversa(id) {
      if (!guardasConversa[id]) guardasConversa[id] = criarGuardaDeChave();
      return guardasConversa[id];
    }

    function bolhaDaMensagem(m) {
      var minha = m.autor === 'SOLICITANTE';
      var bloco = doc.createElement('div');
      bloco.className = 'notice';
      bloco.setAttribute('data-mensagem', String(m.id));
      bloco.setAttribute('data-autor', m.autor);
      bloco.style.marginLeft = minha ? '12%' : '0';
      bloco.style.marginRight = minha ? '0' : '12%';
      var quem = doc.createElement('strong');
      quem.textContent = (minha ? TEXTOS.REMETENTE_VOCE : TEXTOS.REMETENTE_SUPORTE) + ' · ' + formatarData(m.criadoEm);
      var corpo = doc.createElement('p');
      corpo.textContent = m.texto;
      corpo.style.whiteSpace = 'pre-wrap';
      corpo.style.marginTop = '6px';
      bloco.appendChild(quem);
      bloco.appendChild(corpo);
      return bloco;
    }
    /** Acrescenta só o que ainda não está na tela (ordem estável por id). Devolve quantas entraram. */
    function anexarMensagens(mensagens) {
      var area = $('supConversa');
      if (!area) return 0;
      var n = 0;
      mensagens.forEach(function (m) {
        if (m.id <= conversa.ultimoId) return;
        if (conversa.vazio) conversa.vazio.style.display = 'none';
        area.appendChild(bolhaDaMensagem(m));
        conversa.ultimoId = m.id;
        n += 1;
      });
      return n;
    }
    function aplicarSituacaoDaConversa(situacao, inicial) {
      var acabouDeEncerrar = conversa.situacao !== null && conversa.situacao !== 'ENCERRADO' && situacao === 'ENCERRADO';
      conversa.situacao = situacao;
      definir('supDetSituacao', SITUACOES[situacao] || situacao);
      var fechada = situacao === 'ENCERRADO';
      var campo = $('supConversaTexto');
      var botao = $('supConversaEnviar');
      if (campo) campo.disabled = fechada;
      if (botao) botao.disabled = fechada || enviando;
      if (fechada) definir('supConversaMsg', acabouDeEncerrar ? TEXTOS.CONVERSA_ENCERRADA_AGORA : TEXTOS.CONVERSA_ENCERRADA);
      else if (inicial) definir('supConversaMsg', '');
    }
    function pararSondagem() {
      if (conversa.timer !== null) { global.clearTimeout(conversa.timer); conversa.timer = null; }
    }
    function agendarSondagem() {
      pararSondagem();
      if (conversa.id === null || encerrada || conversa.situacao === 'ENCERRADO') return;
      conversa.timer = global.setTimeout(sondar, INTERVALO_CONVERSA_MS);
    }
    async function sondar() {
      conversa.timer = null;
      if (conversa.id === null || encerrada) return;
      if ((doc.visibilityState && doc.visibilityState === 'hidden') || conversa.emVoo) { agendarSondagem(); return; }
      var id = conversa.id;
      conversa.emVoo = true;
      var r = null;
      try { r = await acoes.novasMensagens(id, conversa.ultimoId); } catch (e) { r = null; } finally { conversa.emVoo = false; }
      if (conversa.id !== id || encerrada) return;
      if (r && r.status === 401) { sessaoEncerrada(); return; }
      var m = modelo.novas(r);
      if (m === null) { definir('supConversaMsg', TEXTOS.CONVERSA_FALHA_ATUALIZAR); agendarSondagem(); return; }
      var chegaram = anexarMensagens(m.mensagens);
      var msg = $('supConversaMsg');
      if (chegaram > 0 || (msg && msg.textContent === TEXTOS.CONVERSA_FALHA_ATUALIZAR)) definir('supConversaMsg', '');
      aplicarSituacaoDaConversa(m.situacao, false);
      agendarSondagem();
    }
    function encerrarConversa() {
      pararSondagem();
      var estavaAberta = conversa.id !== null;
      conversa = { id: null, ultimoId: 0, timer: null, emVoo: false, situacao: null, vazio: null };
      // Ao fechar, a lista é relida: o servidor é quem diz o que ainda está por ler.
      if (estavaAberta && !encerrada) carregarChamados();
    }

    async function verChamado(id) {
      var r = await acoes.detalharChamado(id);
      if (r && r.status === 401) { sessaoEncerrada(); return; }
      var m = modelo.detalhe(r);
      if (m === null) { aviso(TEXTOS.FALHA_DETALHE); return; }
      aviso('');
      // O servidor acabou de marcar a conversa como lida: o indicador do menu é reconsultado na hora.
      if (global.EpiSuporteNotificacoes && typeof global.EpiSuporteNotificacoes.atualizarAgora === 'function') global.EpiSuporteNotificacoes.atualizarAgora();
      pararSondagem();
      conversa = { id: m.chamado.id, ultimoId: 0, timer: null, emVoo: false, situacao: null, vazio: null };
      definir('supDetProtocolo', m.chamado.protocolo);
      definir('supDetAssunto', m.chamado.assunto);
      var cat = CATEGORIAS.filter(function (c) { return c[0] === m.chamado.categoria; })[0];
      definir('supDetMeta', (cat ? cat[1] + ' · ' : '') + 'aberto em ' + formatarData(m.chamado.criadoEm));
      definir('supDetDescricao', m.chamado.descricao);
      var area = $('supConversa');
      area.textContent = '';
      var vazio = doc.createElement('p');
      vazio.textContent = TEXTOS.SEM_MENSAGENS;
      area.appendChild(vazio);
      conversa.vazio = vazio;
      anexarMensagens(m.mensagens);
      var historico = $('supDetHistorico');
      historico.textContent = '';
      m.historico.forEach(function (x) {
        var li = doc.createElement('li');
        li.textContent = (SITUACOES[x.para] || x.para) + ' · ' + formatarData(x.criadoEm);
        historico.appendChild(li);
      });
      var campo = $('supConversaTexto');
      if (campo) campo.value = '';
      erroDoCampo('supConversaTexto', '');
      aplicarSituacaoDaConversa(m.chamado.situacao, true);
      abrirModal('supDetalheModal');
      agendarSondagem();
    }

    async function enviarMensagemDaConversa() {
      if (enviando || encerrada || conversa.id === null || conversa.situacao === 'ENCERRADO') return;
      var id = conversa.id;
      var texto = formulario.normalizar($('supConversaTexto').value);
      if (!textoValido(texto, LIMITES.texto)) { erroDoCampo('supConversaTexto', MSG.texto); return; }
      erroDoCampo('supConversaTexto', '');
      ocupado(true);
      definir('supConversaMsg', TEXTOS.ENVIANDO);
      var corpo = { texto: texto, chaveIdempotencia: guardaDaConversa(id).para(JSON.stringify([texto])) };
      var r;
      try { r = await acoes.enviarMensagem(id, corpo); } finally { ocupado(false); }
      if (encerrada || conversa.id !== id) return;
      var enviada = r && r.ok && r.dados ? modelo.mensagem(r.dados.mensagem) : null;
      if (enviada !== null) {
        guardaDaConversa(id).descartar();
        $('supConversaTexto').value = '';
        anexarMensagens([enviada]);
        if (ehTexto(r.dados.situacao)) aplicarSituacaoDaConversa(r.dados.situacao, false);
        definir('supConversaMsg', r.dados.repetido === true ? TEXTOS.MENSAGEM_REPETIDA : TEXTOS.MENSAGEM_ENVIADA);
        return;
      }
      if (r && r.status === 409 && r.codigo === 'CHAMADO_ENCERRADO') { aplicarSituacaoDaConversa('ENCERRADO', false); return; }
      var e = erros.daEscrita(r, null);
      if (e.sessao) { sessaoEncerrada(); return; }
      if (e.descartarChave) guardaDaConversa(id).descartar();
      if (e.campos && e.campos.texto) erroDoCampo('supConversaTexto', e.campos.texto);
      definir('supConversaMsg', e.aviso || TEXTOS.CORRIJA);
    }

    // Formulários.
    function valoresChamado() {
      return { assunto: $('supChamadoAssunto').value, categoria: $('supChamadoCategoria').value, descricao: $('supChamadoDescricao').value };
    }
    function valoresContato() {
      return { assunto: $('supContatoAssunto').value, mensagem: $('supContatoMensagem').value };
    }
    function limparErros(ids) { ids.forEach(function (id) { erroDoCampo(id, ''); }); }

    function abrirChamadoForm() {
      limparErros(['supChamadoAssunto', 'supChamadoCategoria', 'supChamadoDescricao']);
      definir('supChamadoMsg', '');
      abrirModal('supChamadoModal');
      var campo = $('supChamadoAssunto');
      if (campo && campo.focus) campo.focus();
    }
    function abrirContatoForm(canal) {
      if (!Object.prototype.hasOwnProperty.call(CANAIS, canal)) return;
      canalAtual = canal;
      limparErros(['supContatoAssunto', 'supContatoMensagem']);
      definir('supContatoTitulo', canal === 'sst' ? 'Contatar SST' : 'Solicitar apoio ao Almoxarifado');
      definir('supContatoMsg', canais[canal] === false ? TEXTOS.SEM_DESTINATARIO[CANAIS[canal]] : '');
      abrirModal('supContatoModal');
      var campo = $('supContatoAssunto');
      if (campo && campo.focus) campo.focus();
    }

    async function enviarChamado() {
      if (enviando || encerrada) return;
      var v = valoresChamado();
      var ruins = formulario.validarChamado(v);
      limparErros(['supChamadoAssunto', 'supChamadoCategoria', 'supChamadoDescricao']);
      if (Object.keys(ruins).length > 0) {
        erroDoCampo('supChamadoAssunto', ruins.assunto);
        erroDoCampo('supChamadoCategoria', ruins.categoria);
        erroDoCampo('supChamadoDescricao', ruins.descricao);
        definir('supChamadoMsg', TEXTOS.CORRIJA);
        return;
      }
      ocupado(true);
      definir('supChamadoMsg', TEXTOS.ENVIANDO);
      var corpo = {
        assunto: formulario.normalizar(v.assunto), categoria: v.categoria, descricao: formulario.normalizar(v.descricao),
        chaveIdempotencia: guardas.chamado.para(formulario.impressao(v)),
      };
      var r;
      try { r = await acoes.abrirChamado(corpo); } finally { ocupado(false); }
      if (encerrada) return;
      if (r && r.ok && r.dados && r.dados.chamado && ehTexto(r.dados.chamado.protocolo)) {
        guardas.chamado.descartar();
        $('supChamadoDescricao').value = '';
        $('supChamadoAssunto').value = '';
        fecharModal();
        aviso(r.dados.repetido === true ? TEXTOS.CHAMADO_REPETIDO(r.dados.chamado.protocolo) : TEXTOS.CHAMADO_ABERTO(r.dados.chamado.protocolo));
        await carregarChamados();
        return;
      }
      var e = erros.daEscrita(r, null);
      if (e.sessao) { sessaoEncerrada(); return; }
      if (e.descartarChave) guardas.chamado.descartar();
      if (e.campos) {
        erroDoCampo('supChamadoAssunto', e.campos.assunto);
        erroDoCampo('supChamadoCategoria', e.campos.categoria);
        erroDoCampo('supChamadoDescricao', e.campos.descricao);
      }
      definir('supChamadoMsg', e.aviso || TEXTOS.CORRIJA);
    }

    async function enviarContato() {
      if (enviando || encerrada || canalAtual === null) return;
      var canal = canalAtual;
      var v = valoresContato();
      var ruins = formulario.validarContato(v);
      limparErros(['supContatoAssunto', 'supContatoMensagem']);
      if (Object.keys(ruins).length > 0) {
        erroDoCampo('supContatoAssunto', ruins.assunto);
        erroDoCampo('supContatoMensagem', ruins.mensagem);
        definir('supContatoMsg', TEXTOS.CORRIJA);
        return;
      }
      ocupado(true);
      definir('supContatoMsg', TEXTOS.ENVIANDO);
      var corpo = {
        assunto: formulario.normalizar(v.assunto), mensagem: formulario.normalizar(v.mensagem),
        chaveIdempotencia: guardas[canal].para(formulario.impressao(v)),
      };
      var r;
      try { r = await acoes.enviarContato(canal, corpo); } finally { ocupado(false); }
      if (encerrada) return;
      var m = modelo.contato(r);
      if (m !== null) {
        guardas[canal].descartar();
        $('supContatoAssunto').value = '';
        $('supContatoMensagem').value = '';
        fecharModal();
        aviso(textoDoContato(canal, m));
        return;
      }
      var e = erros.daEscrita(r, canal);
      if (e.sessao) { sessaoEncerrada(); return; }
      if (e.descartarChave) guardas[canal].descartar();
      if (e.campos) {
        erroDoCampo('supContatoAssunto', e.campos.assunto);
        erroDoCampo('supContatoMensagem', e.campos.mensagem || e.campos.descricao);
      }
      definir('supContatoMsg', e.aviso || TEXTOS.CORRIJA);
    }

    function ligar() {
      var porId = function (id, evento, fn) { var el = $(id); if (el) el.addEventListener(evento, fn); };
      porId('supAbrirChamado', 'click', abrirChamadoForm);
      porId('supContatarAlmoxarifado', 'click', function () { abrirContatoForm('almoxarifado'); });
      porId('supContatarSst', 'click', function () { abrirContatoForm('sst'); });
      porId('supChamadoEnviar', 'click', enviarChamado);
      porId('supContatoEnviar', 'click', enviarContato);
      porId('supConversaEnviar', 'click', enviarMensagemDaConversa);
      Array.prototype.forEach.call(doc.querySelectorAll('[data-fechar-modal]'), function (b) { b.addEventListener('click', fecharModal); });
      var lista = $('supChamados');
      if (lista) {
        lista.addEventListener('click', function (ev) {
          var alvo = ev.target && ev.target.closest ? ev.target.closest('[data-chamado]') : null;
          if (alvo) verChamado(Number(alvo.getAttribute('data-chamado')));
        });
      }
      doc.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') fecharModal(); });
    }

    return {
      iniciar: async function () {
        ligar();
        await Promise.all([carregarCanais(), carregarChamados()]);
      },
      encerrar: function () { encerrada = true; pararSondagem(); fecharModal(); },
      enviarMensagemDaConversa: enviarMensagemDaConversa,
      sondarAgora: sondar,
      conversaAberta: function () { return conversa.id; },
      abrirChamadoForm: abrirChamadoForm,
      abrirContatoForm: abrirContatoForm,
      enviarChamado: enviarChamado,
      enviarContato: enviarContato,
      verChamado: verChamado,
      estado: function () { return { enviando: enviando, encerrada: encerrada, modal: modalAtual }; },
    };
  }

  global.EpiSuporte = {
    CAMINHO: CAMINHO,
    CANAIS: CANAIS,
    CATEGORIAS: CATEGORIAS,
    SITUACOES: SITUACOES,
    LIMITES: LIMITES,
    TEXTOS: TEXTOS,
    acoes: acoes,
    modelo: modelo,
    formulario: formulario,
    erros: erros,
    novaChave: novaChave,
    criarGuardaDeChave: criarGuardaDeChave,
    textoDoContato: textoDoContato,
    criarTela: criarTela,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.EpiSuporte;
})(typeof window !== 'undefined' ? window : globalThis);
