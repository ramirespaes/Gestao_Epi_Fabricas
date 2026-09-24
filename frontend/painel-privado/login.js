(function () {
  'use strict';

  /**
   * Login do Painel Privado da plataforma (Autenticação Global — Pacote 2,
   * item 4: "primeira tela funcional"). Reaproveita EpiHttp (js/api-http.js)
   * como transporte — mesmo cliente HTTP genérico já usado pelo frontend
   * empresarial, apontado para o prefixo /api/plataforma, com
   * credentials:'include' para que o navegador anexe o cookie
   * administrativo (nome próprio, nunca o cookie empresarial).
   *
   * Sem CNPJ: o corpo enviado é só { email, senha } — o login administrativo
   * não depende de nenhuma empresa cadastrada.
   *
   * ENDEREÇO DA API: nunca hardcoded aqui — vem de config.js
   * (SAFEWORK_PLATAFORMA_API_BASE_URL), que resolve localhost em
   * desenvolvimento e a própria origem da página em produção (correção
   * final do Pacote 2, item 5).
   */

  window.EpiHttp.configurar({ baseUrl: window.SAFEWORK_PLATAFORMA_API_BASE_URL });

  var form = document.getElementById('form-login');
  var campoEmail = document.getElementById('email');
  var campoSenha = document.getElementById('senha');
  var botao = document.getElementById('botao-entrar');
  var mensagem = document.getElementById('mensagem');

  function mostrarErro(texto) {
    mensagem.textContent = texto;
  }

  form.addEventListener('submit', function (evento) {
    evento.preventDefault();
    mostrarErro('');
    botao.disabled = true;

    window.EpiHttp.requisitar('POST', '/auth/login', {
      corpo: { email: campoEmail.value, senha: campoSenha.value },
    }).then(function (resposta) {
      if (resposta.ok) {
        window.location.href = 'painel.html';
        return;
      }
      // Mensagem já é a versão pública e genérica (nunca ecoa e-mail/senha).
      mostrarErro(resposta.mensagem || 'Não foi possível entrar. Tente novamente.');
      botao.disabled = false;
    }).catch(function () {
      mostrarErro('Não foi possível falar com o servidor. Verifique sua conexão.');
      botao.disabled = false;
    });
  });
})();
