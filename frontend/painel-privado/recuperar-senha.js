(function () {
  'use strict';

  /**
   * Pedido do link de redefinição de senha do Painel Privado (Bloco 11F), sem
   * sessão e sem Turnstile. A confirmação é sempre a mesma quando o servidor
   * aceita o pedido: a tela não diz se a conta existe nem se algo foi
   * enviado, e nunca repete o e-mail digitado.
   */

  window.EpiHttp.configurar({ baseUrl: window.SAFEWORK_PLATAFORMA_API_BASE_URL });
  var Ciclo = window.EpiSenhaCiclo;

  var form = document.getElementById('form-recuperacao');
  var campoEmail = document.getElementById('email');
  var botao = document.getElementById('botao-enviar');
  var mensagem = document.getElementById('mensagem');
  var confirmacao = document.getElementById('confirmacao');

  var enviando = false;

  function mostrar(texto) {
    mensagem.textContent = texto || '';
    mensagem.className = texto ? 'mensagem erro' : 'mensagem';
  }
  function falhar(texto) {
    enviando = false;
    botao.disabled = false;
    mostrar(texto);
  }

  form.addEventListener('submit', function (evento) {
    evento.preventDefault();
    if (enviando) return;
    var email = campoEmail.value.trim();
    if (email === '') {
      mostrar(Ciclo.MENSAGENS.EMAIL_VAZIO);
      return;
    }
    mostrar('');
    enviando = true;
    botao.disabled = true;

    window.EpiHttp.requisitar('POST', '/auth/recuperacao-senha/solicitar', { corpo: { email: email } }).then(function (r) {
      if (r.ok) {
        enviando = false;
        campoEmail.value = '';
        form.hidden = true;
        confirmacao.hidden = false;
        return;
      }
      falhar(Ciclo.mensagemDeErro(r));
    }).catch(function () {
      falhar(Ciclo.MENSAGENS.REDE);
    });
  });
})();
