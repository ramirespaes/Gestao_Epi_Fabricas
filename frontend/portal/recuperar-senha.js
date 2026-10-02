(function () {
  'use strict';

  /**
   * Pedido do link de redefinição de senha do Portal (Bloco 11F), sem sessão.
   * Mesma disciplina do login: o envio só sai com um token da verificação de
   * segurança (Turnstile, action própria da recuperação) em memória, e cada
   * token vale para uma tentativa (EpiPortal.recuperacao.solicitar).
   *
   * A confirmação é sempre a mesma quando o servidor aceita o pedido: a tela
   * não diz se a conta existe nem se algo foi enviado, e nunca repete o
   * e-mail digitado.
   */

  window.EpiHttp.configurar({ baseUrl: window.SAFEWORK_PORTAL_API_BASE_URL });
  var Portal = window.EpiPortal;
  var Ciclo = window.EpiSenhaCiclo;

  var form = document.getElementById('form-recuperacao');
  var campoEmail = document.getElementById('email');
  var botao = document.getElementById('botao-enviar');
  var mensagem = document.getElementById('mensagem');
  var areaVerificacao = document.getElementById('verificacao');
  var confirmacao = document.getElementById('confirmacao');

  var verificacao = null;
  var enviando = false;
  var mensagemDaVerificacao = false;

  function mostrar(texto, classe) {
    mensagem.textContent = texto || '';
    mensagem.className = 'mensagem ' + (classe || '');
    mensagemDaVerificacao = false;
  }
  function mostrarDaVerificacao(texto, classe) {
    mostrar(texto, classe);
    mensagemDaVerificacao = true;
  }
  function atualizarBotao() { botao.disabled = enviando || !verificacao || !verificacao.temToken(); }

  function aoMudarVerificacao(estado) {
    if (estado === 'erro') {
      mostrarDaVerificacao(Portal.mensagens.VERIFICACAO_ERRO, 'erro');
    } else if (estado === 'expirado') {
      mostrarDaVerificacao(Portal.mensagens.VERIFICACAO_EXPIRADA, 'info');
    } else if (estado === 'pronto' && mensagemDaVerificacao) {
      // Só apago o aviso da própria verificação; um erro do pedido continua visível.
      mostrar('');
    }
    atualizarBotao();
  }

  function mensagemDoPedido(resposta) {
    if (resposta.codigo === 'VERIFICACAO_SEGURANCA_INVALIDA' || resposta.codigo === 'VERIFICACAO_SEGURANCA_INDISPONIVEL') {
      return Portal.mensagens.deErro(resposta);
    }
    return Ciclo.mensagemDeErro(resposta);
  }

  atualizarBotao();

  Portal.acoes.configuracaoVerificacaoRecuperacao().then(function (r) {
    if (!r.ok || !r.dados) {
      aoMudarVerificacao('erro');
      return;
    }
    verificacao = Portal.verificacao.criar({
      turnstile: window.turnstile,
      elemento: areaVerificacao,
      siteKey: r.dados.siteKey,
      action: r.dados.action,
      aoMudar: aoMudarVerificacao,
    });
    verificacao.iniciar();
  }).catch(function () { aoMudarVerificacao('erro'); });

  form.addEventListener('submit', function (evento) {
    evento.preventDefault();
    if (enviando) return;
    if (!verificacao || !verificacao.temToken()) {
      mostrarDaVerificacao(Ciclo.MENSAGENS.VERIFICACAO_PENDENTE, 'info');
      return;
    }
    var email = campoEmail.value.trim();
    if (email === '') {
      mostrar(Ciclo.MENSAGENS.EMAIL_VAZIO, 'erro');
      return;
    }
    mostrar('');
    enviando = true;
    atualizarBotao();

    Portal.recuperacao.solicitar({ email: email }, verificacao).then(function (r) {
      enviando = false;
      if (r.ok) {
        campoEmail.value = '';
        form.hidden = true;
        confirmacao.hidden = false;
        return;
      }
      mostrar(mensagemDoPedido(r), 'erro');
      atualizarBotao();
    }).catch(function () {
      enviando = false;
      mostrar(Ciclo.MENSAGENS.REDE, 'erro');
      atualizarBotao();
    });
  });
})();
