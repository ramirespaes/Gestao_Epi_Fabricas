(function () {
  'use strict';

  /**
   * Aceite do convite do MASTER (Pacote 3) — página PÚBLICA: nenhuma sessão
   * (nem administrativa, nem empresarial); a autoridade é o token da URL.
   * Consulta o convite antes de mostrar o formulário, para exibir o
   * caminho certo: identidade nova (definir senha) ou existente (confirmar
   * a senha atual). O aceite NÃO faz login: o login global é o Pacote 4.
   */

  window.EpiHttp.configurar({ baseUrl: window.SAFEWORK_PLATAFORMA_API_BASE_URL });
  var Http = window.EpiHttp;
  var el = function (id) { return document.getElementById(id); };
  // SIGILO DO TOKEN: ele chega no FRAGMENTO (#token=...), que o navegador
  // nunca envia ao servidor. É lido uma vez, guardado só nesta closure e
  // REMOVIDO da barra de endereço (histórico/atalhos não o guardam). Ao
  // backend vai apenas em corpo JSON (POST) — EpiHttp registra método e
  // caminho, nunca o corpo. <meta name="referrer" content="no-referrer">
  // impede que a URL desta página vaze em Referer.
  var fragmento = (window.location.hash || '').replace(/^#/, '');
  var token = new URLSearchParams(fragmento).get('token') || '';
  if (window.history && typeof window.history.replaceState === 'function') {
    window.history.replaceState(null, document.title, window.location.pathname + window.location.search);
  }

  function mensagem(texto, classe) { el('mensagem').textContent = texto || ''; el('mensagem').className = 'mensagem ' + (classe || ''); }

  if (!token) {
    el('carregando').style.display = 'none';
    mensagem('Link de convite incompleto.', 'erro');
    return;
  }

  Http.requisitar('POST', '/convite-master/consultar', { corpo: { token: token } }).then(function (r) {
    el('carregando').style.display = 'none';
    if (!r.ok) { mensagem(r.mensagem, 'erro'); return; }
    el('empresa').textContent = r.dados.empresa ? r.dados.empresa.razaoSocial : '';
    el('email').textContent = r.dados.emailConvite;
    if (r.dados.identidadeExistente) {
      el('instrucao').textContent = 'Já existe uma conta com este e-mail. Confirme sua senha atual para vincular esta empresa a ela.';
      el('rotulo-senha').textContent = 'Senha atual';
      el('senha').autocomplete = 'current-password';
    } else {
      el('instrucao').textContent = 'Defina a senha da sua conta (mínimo de 12 caracteres, sem termos óbvios).';
      el('rotulo-senha').textContent = 'Nova senha';
      el('senha').autocomplete = 'new-password';
    }
    el('form-aceite').style.display = 'block';
  }).catch(function () { el('carregando').style.display = 'none'; mensagem('Não foi possível falar com o servidor.', 'erro'); });

  el('form-aceite').addEventListener('submit', function (ev) {
    ev.preventDefault();
    el('botao').disabled = true;
    mensagem('');
    Http.requisitar('POST', '/convite-master/aceitar', { corpo: { token: token, nome: el('nome').value, senha: el('senha').value } }).then(function (r) {
      if (!r.ok) {
        var detalhe = r.detalhes && r.detalhes[0] ? ' ' + r.detalhes[0].mensagem : '';
        mensagem(r.mensagem + detalhe, 'erro');
        el('botao').disabled = false;
        return;
      }
      el('form-aceite').style.display = 'none';
      el('empresa-ok').textContent = r.dados.empresa.razaoSocial || ('empresa #' + r.dados.empresa.id);
      el('sucesso').style.display = 'block';
    }).catch(function () { mensagem('Não foi possível falar com o servidor.', 'erro'); el('botao').disabled = false; });
  });
})();
