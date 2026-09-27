(function () {
  'use strict';

  /**
   * Tela de login do Portal do Cliente (Pacote 4): só e-mail e senha.
   * Se o navegador já tiver uma sessão global válida (cookie HttpOnly, que
   * este código não lê), o servidor responde /me e a pessoa segue direto
   * para onde deve ir — nunca a partir de algo guardado no navegador.
   *
   * O envio só sai com um token da verificação de segurança (Turnstile) em
   * memória, e cada token vale para uma tentativa (EpiPortal.login.enviar).
   */

  window.EpiHttp.configurar({ baseUrl: window.SAFEWORK_PORTAL_API_BASE_URL });
  var Portal = window.EpiPortal;

  var form = document.getElementById('form-login');
  var campoEmail = document.getElementById('email');
  var campoSenha = document.getElementById('senha');
  var botao = document.getElementById('botao-entrar');
  var mensagem = document.getElementById('mensagem');
  var areaVerificacao = document.getElementById('verificacao');

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
  function ir(destino) { window.location.href = Portal.decisao.pagina(destino); }
  function atualizarBotao() { botao.disabled = enviando || !verificacao || !verificacao.temToken(); }

  function aoMudarVerificacao(estado) {
    if (estado === 'erro') {
      mostrarDaVerificacao(Portal.mensagens.VERIFICACAO_ERRO, 'erro');
    } else if (estado === 'expirado') {
      mostrarDaVerificacao(Portal.mensagens.VERIFICACAO_EXPIRADA, 'info');
    } else if (estado === 'pronto' && mensagemDaVerificacao) {
      // Só apago o aviso da própria verificação; um erro de login continua visível.
      mostrar('');
    }
    atualizarBotao();
  }

  atualizarBotao();

  Portal.acoes.sessao().then(function (r) {
    var destino = Portal.decisao.entradaDaSessao(r);
    if (destino !== 'login') ir(destino);
  }).catch(function () { /* sem sessão ou sem rede: permanece no login */ });

  Portal.acoes.configuracaoVerificacao().then(function (r) {
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
      mostrarDaVerificacao(Portal.mensagens.VERIFICACAO_PENDENTE, 'info');
      return;
    }
    mostrar('');
    enviando = true;
    atualizarBotao();
    var credenciais = { email: campoEmail.value, senha: campoSenha.value };
    campoSenha.value = '';

    Portal.login.enviar(credenciais, verificacao).then(function (r) {
      if (r.ok) {
        ir(Portal.decisao.entrada(r.dados));
        return;
      }
      enviando = false;
      // Mensagem pública e genérica do backend; nunca ecoa e-mail ou senha.
      mostrar(r.status === 401 ? Portal.mensagens.CREDENCIAIS : Portal.mensagens.deErro(r), 'erro');
      atualizarBotao();
      campoSenha.focus();
    }).catch(function () {
      enviando = false;
      mostrar('Não foi possível falar com o servidor. Verifique sua conexão.', 'erro');
      atualizarBotao();
    });
  });
})();
