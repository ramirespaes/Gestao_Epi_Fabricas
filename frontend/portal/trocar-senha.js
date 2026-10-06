(function () {
  'use strict';

  /**
   * Troca de senha do Portal com a sessão global em uso. O formulário só
   * aparece depois de o servidor confirmar a sessão (GET /auth/global/me); sem
   * sessão a pessoa vai ao login. Basta a sessão global: a troca não depende
   * de empresa selecionada.
   *
   * Dois 401 diferentes: a senha atual errada é uma resposta ao formulário e a
   * pessoa continua na página; a sessão inválida leva ao login. A confirmação
   * da senha nova é só da tela e nunca vai ao servidor. As senhas saem dos
   * campos a cada envio. Depois do sucesso a sessão atual continua valendo.
   */

  window.EpiHttp.configurar({ baseUrl: window.SAFEWORK_PORTAL_API_BASE_URL });
  var Portal = window.EpiPortal;
  var Ciclo = window.EpiSenhaCiclo;

  var el = function (id) { return document.getElementById(id); };
  var form = el('form-troca');
  var campoAtual = el('senha-atual');
  var campoNova = el('senha-nova');
  var campoConfirmacao = el('senha-confirmacao');
  var botao = el('botao-trocar');
  var mensagem = el('mensagem');

  var enviando = false;

  var AVISO_PROVISORIA = 'Você entrou com uma senha provisória. Defina uma nova senha para continuar usando o sistema.';

  function mostrar(texto) {
    mensagem.textContent = texto || '';
    mensagem.className = texto ? 'mensagem erro' : 'mensagem';
  }
  function avisar(texto) {
    mensagem.textContent = texto;
    mensagem.className = 'mensagem info';
  }
  function limparCampos() {
    campoAtual.value = '';
    campoNova.value = '';
    campoConfirmacao.value = '';
  }
  function irParaLogin() {
    limparCampos();
    form.hidden = true;
    window.location.href = Portal.decisao.pagina('login');
  }
  function falhar(texto) {
    enviando = false;
    botao.disabled = false;
    mostrar(texto);
    campoAtual.focus();
  }

  Portal.acoes.sessao().then(function (r) {
    el('carregando').hidden = true;
    if (r.ok) {
      form.hidden = false;
      if (r.dados && r.dados.identidade && r.dados.identidade.trocaSenhaObrigatoria === true) avisar(AVISO_PROVISORIA);
      campoAtual.focus();
      return;
    }
    if (r.status === 401) {
      irParaLogin();
      return;
    }
    mostrar(Portal.mensagens.deErro(r));
  }).catch(function () {
    el('carregando').hidden = true;
    mostrar(Ciclo.MENSAGENS.REDE);
  });

  form.addEventListener('submit', function (evento) {
    evento.preventDefault();
    if (enviando) return;
    var atual = campoAtual.value;
    var nova = campoNova.value;
    var confirmacao = campoConfirmacao.value;
    limparCampos();
    if (atual === '') {
      mostrar(Ciclo.MENSAGENS.SENHA_ATUAL_VAZIA);
      return;
    }
    if (nova === '') {
      mostrar(Ciclo.MENSAGENS.SENHA_VAZIA);
      return;
    }
    if (nova !== confirmacao) {
      mostrar(Ciclo.MENSAGENS.CONFIRMACAO);
      return;
    }
    mostrar('');
    enviando = true;
    botao.disabled = true;

    Portal.acoes.trocarSenha({ senhaAtual: atual, novaSenha: nova }).then(function (r) {
      if (r.ok) {
        enviando = false;
        form.hidden = true;
        el('sucesso').hidden = false;
        return;
      }
      if (r.status === 401 && r.codigo !== 'SENHA_ATUAL_INVALIDA') {
        irParaLogin();
        return;
      }
      falhar(Ciclo.mensagemDeErro(r));
    }).catch(function () {
      falhar(Ciclo.MENSAGENS.REDE);
    });
  });
})();
