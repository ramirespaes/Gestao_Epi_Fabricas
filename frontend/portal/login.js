(function () {
  'use strict';

  /**
   * Tela de login do Portal do Cliente (Pacote 4): só e-mail e senha.
   * Se o navegador já tiver uma sessão global válida (cookie HttpOnly, que
   * este código não lê), o servidor responde /me e a pessoa segue direto
   * para onde deve ir — nunca a partir de algo guardado no navegador.
   */

  window.EpiHttp.configurar({ baseUrl: window.SAFEWORK_PORTAL_API_BASE_URL });
  var Portal = window.EpiPortal;

  var form = document.getElementById('form-login');
  var campoEmail = document.getElementById('email');
  var campoSenha = document.getElementById('senha');
  var botao = document.getElementById('botao-entrar');
  var mensagem = document.getElementById('mensagem');

  function mostrar(texto, classe) { mensagem.textContent = texto || ''; mensagem.className = 'mensagem ' + (classe || ''); }
  function ir(destino) { window.location.href = Portal.decisao.pagina(destino); }

  Portal.acoes.sessao().then(function (r) {
    var destino = Portal.decisao.destinoDaSessao(r);
    if (destino !== 'login') ir(destino);
  }).catch(function () { /* sem sessão ou sem rede: permanece no login */ });

  form.addEventListener('submit', function (evento) {
    evento.preventDefault();
    mostrar('');
    botao.disabled = true;
    var credenciais = { email: campoEmail.value, senha: campoSenha.value };
    campoSenha.value = '';

    Portal.acoes.entrar(credenciais).then(function (r) {
      if (r.ok) {
        ir(Portal.decisao.destino(r.dados));
        return;
      }
      // Mensagem pública e genérica do backend; nunca ecoa e-mail ou senha.
      mostrar(r.status === 401 ? Portal.mensagens.CREDENCIAIS : Portal.mensagens.deErro(r), 'erro');
      botao.disabled = false;
      campoSenha.focus();
    }).catch(function () {
      mostrar('Não foi possível falar com o servidor. Verifique sua conexão.', 'erro');
      botao.disabled = false;
    });
  });
})();
