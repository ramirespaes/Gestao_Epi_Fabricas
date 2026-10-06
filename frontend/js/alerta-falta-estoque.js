(function (global) {
  'use strict';

  /**
   * EpiAlertaFaltaEstoque — o "Gerar alerta" da tela Entregas por solicitação
   * (Bloco 12, 12G-6): alerta MANUAL de falta de estoque do pedido aberto no
   * detalhe, para quem movimenta o estoque (o servidor escolhe quem e suprime
   * o clique repetido). Não é o aviso automático de disponibilidade.
   *
   *   POST /alertas-estoque/falta  { solicitacaoId }   (REALIZAR_ENTREGA)
   *
   * O botão só aparece para quem tem REALIZAR_ENTREGA e só funciona com um
   * pedido aprovado aberto que tenha item aguardando estoque (o pendente
   * acima do que a fila do servidor cobre; item suspenso não conta). O
   * resultado vai só para o aviso do alerta: a entrega não é tocada. Texto por
   * textContent; nada no armazenamento do navegador.
   */

  var ROTA = '/alertas-estoque/falta';
  var STATUS_ATIVOS = ['APROVADA', 'APROVADA_PARCIAL'];
  var DICA_SEM_PEDIDO = 'Abra um pedido com item aguardando estoque para gerar o alerta.';
  var DICA_PRONTO = 'Avisa quem movimenta o estoque sobre a falta deste pedido.';

  var TEXTOS = {
    ALERTA_FALTA_RECENTE: 'Você já enviou um alerta deste pedido há pouco. Aguarde antes de enviar outro.',
    ALERTA_SEM_DESTINATARIO: 'Nenhum usuário com permissão para movimentar o estoque tem e-mail para receber o alerta.',
    ALERTA_NAO_ENVIADO: 'Não foi possível enviar o alerta agora. Tente novamente mais tarde.',
    SEM_FALTA_DE_ESTOQUE: 'Este pedido não tem item aguardando estoque. Atualize o detalhe para ver a situação atual.',
    SOLICITACAO_NAO_ENTREGAVEL: 'Este pedido não está mais aprovado para entrega. Atualize a lista.',
    SOLICITACAO_NAO_ENCONTRADA: 'Solicitação não encontrada. Atualize a lista.',
    PERMISSAO_NEGADA: 'Você não tem a autorização "Realizar entrega" para gerar o alerta.',
  };
  // As mesmas da tela de Entregas.
  var CORES_AVISO = {
    erro: 'background:var(--error-container);color:var(--error);border-color:rgba(255,59,48,0.2)',
    sucesso: 'background:rgba(52,199,89,0.10);color:#1A7A35;border-color:rgba(52,199,89,0.25)',
  };

  function http() {
    if (!global.EpiHttp) throw new Error('EpiHttp não carregado: inclua js/api-http.js antes de js/alerta-falta-estoque.js');
    return global.EpiHttp;
  }
  function S() { return global.EpiSolicitacoesEpi; }
  function R() { return global.EpiEntregasSolicitacao.rascunho; }

  var acoes = {
    alertar: function (solicitacaoId) {
      if (typeof solicitacaoId !== 'number' || Math.floor(solicitacaoId) !== solicitacaoId || solicitacaoId <= 0) throw new TypeError('identificador de solicitação inválido');
      return http().requisitar('POST', ROTA, { corpo: { solicitacaoId: solicitacaoId } });
    },
  };

  /** Algum item aprovado com pendente acima da cobertura medida pelo servidor (o suspenso não tem cobertura). */
  function temFalta(dados) {
    if (!dados || !dados.solicitacao || STATUS_ATIVOS.indexOf(dados.solicitacao.status) === -1 || !Array.isArray(dados.itens)) return false;
    return dados.itens.some(function (item) {
      return item.decisao === 'APROVADO' && item.situacao !== 'SUSPENSA' && !!item.cobertura && Number.isInteger(item.cobertura.coberta)
        && R().pendente(item) > R().disponivelAgora(item);
    });
  }

  function textoDoResultado(r, numero) {
    if (r.ok) {
      var n = r.dados && r.dados.alerta ? r.dados.alerta.destinatarios : 0;
      return 'Alerta de falta do pedido nº ' + numero + ' enviado a ' + n + (n === 1 ? ' pessoa que movimenta o estoque.' : ' pessoas que movimentam o estoque.');
    }
    if (r.status > 0 && Object.prototype.hasOwnProperty.call(TEXTOS, r.codigo)) return TEXTOS[r.codigo];
    if (r.status === 403) return TEXTOS.PERMISSAO_NEGADA;
    return S().mensagens.deErro(r);
  }

  /**
   * @param {{capacidades: object, botao: object, aviso: object, aoSessaoEncerrada: Function, documento?: object}} o
   */
  function criar(o) {
    var doc = o.documento || global.document;
    var botao = o.botao;
    var caixa = o.aviso;
    var pode = !!o.capacidades && o.capacidades.entregar === true;
    var estado = { dados: null, enviando: false, encerrada: false, avisoDe: null };

    function mostrarAviso(tipo, texto, solicitacaoId) {
      caixa.textContent = '';
      estado.avisoDe = texto ? solicitacaoId : null;
      if (!texto) { caixa.style.display = 'none'; return; }
      var div = doc.createElement('div');
      div.setAttribute('class', 'notice');
      div.setAttribute('style', CORES_AVISO[tipo]);
      div.setAttribute('role', tipo === 'erro' ? 'alert' : 'status');
      div.textContent = texto;
      caixa.appendChild(div);
      caixa.style.display = '';
    }

    function desenhar() {
      botao.style.display = pode && !estado.encerrada ? '' : 'none';
      var pronto = pode && !estado.encerrada && !estado.enviando && temFalta(estado.dados);
      botao.disabled = !pronto;
      botao.setAttribute('title', pronto ? DICA_PRONTO : DICA_SEM_PEDIDO);
    }

    /** O detalhe aberto mudou (ou fechou): `dados` é o do servidor, ou null. */
    function atualizar(dados) {
      if (estado.encerrada) return;
      estado.dados = dados || null;
      var id = estado.dados ? estado.dados.solicitacao.id : null;
      if (estado.avisoDe !== null && estado.avisoDe !== id) mostrarAviso(null, '');
      desenhar();
    }

    function gerar() {
      if (estado.encerrada || estado.enviando || !pode || !temFalta(estado.dados)) return Promise.resolve();
      var s = estado.dados.solicitacao;
      estado.enviando = true;
      mostrarAviso(null, '');
      desenhar();
      return acoes.alertar(s.id).then(function (r) {
        estado.enviando = false;
        if (estado.encerrada) return;
        if (S().mensagens.exigeNovoLogin(r)) {
          o.aoSessaoEncerrada();
          return;
        }
        mostrarAviso(r.ok ? 'sucesso' : 'erro', textoDoResultado(r, s.numero), s.id);
        desenhar();
      });
    }

    function encerrar() {
      estado.encerrada = true;
      estado.dados = null;
      mostrarAviso(null, '');
      desenhar();
    }

    botao.addEventListener('click', gerar);
    desenhar();
    return { atualizar: atualizar, encerrar: encerrar, gerar: gerar };
  }

  global.EpiAlertaFaltaEstoque = {
    acoes: acoes, temFalta: temFalta, criar: criar, TEXTOS: TEXTOS,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.EpiAlertaFaltaEstoque;
  }
})(typeof window !== 'undefined' ? window : globalThis);
