(function () {
  'use strict';

  /**
   * Área administrativa protegida inicial (Autenticação Global — Pacote 2,
   * item 4). Ao carregar, confirma a sessão contra o servidor
   * (GET /api/plataforma/painel, atrás de exigirSessaoPlataforma) — nunca
   * assume autenticação a partir de algo guardado no navegador. Sessão
   * ausente/expirada/revogada redireciona para o login, sem expor nenhum
   * dado da área protegida antes da confirmação.
   */

  // Endereço da API resolvido por config.js (nunca hardcoded aqui) —
  // correção final do Pacote 2, item 5.
  window.EpiHttp.configurar({ baseUrl: window.SAFEWORK_PLATAFORMA_API_BASE_URL });

  var elCarregando = document.getElementById('carregando');
  var elErro = document.getElementById('erro');
  var elConteudo = document.getElementById('conteudo');
  var elEmail = document.getElementById('email-administrador');
  var botaoSair = document.getElementById('sair');

  function irParaLogin() {
    window.location.href = 'index.html';
  }

  window.EpiHttp.requisitar('GET', '/painel').then(function (resposta) {
    elCarregando.style.display = 'none';

    if (window.EpiHttp.ehNaoAutenticado(resposta)) {
      irParaLogin();
      return;
    }
    if (!resposta.ok) {
      elErro.textContent = resposta.mensagem || 'Não foi possível carregar o painel.';
      elErro.style.display = 'block';
      return;
    }

    elEmail.textContent = resposta.dados.administrador.email;
    elConteudo.style.display = 'block';
  }).catch(function () {
    elCarregando.style.display = 'none';
    elErro.textContent = 'Não foi possível falar com o servidor. Verifique sua conexão.';
    elErro.style.display = 'block';
  });

  botaoSair.addEventListener('click', function () {
    botaoSair.disabled = true;
    window.EpiHttp.requisitar('POST', '/auth/logout').then(function () {
      irParaLogin();
    }).catch(function () {
      // Logout é idempotente no servidor; mesmo numa falha de rede, o
      // usuário deve poder tentar novamente pela tela de login.
      irParaLogin();
    });
  });
})();
