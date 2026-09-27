(function (global) {
  'use strict';

  /**
   * Aceite do convite de usuário (Bloco 9, parte F) — página pública, sem
   * sessão. O token chega no FRAGMENTO (#token=...), que o navegador não
   * envia a servidor nenhum; é lido uma vez, fica só nesta closure e sai
   * da barra de endereço. Ao backend vai apenas no corpo JSON (POST).
   *
   * Tudo o que vem do servidor entra na tela por textContent. As senhas
   * saem dos campos a cada envio, deu certo ou não.
   */

  var TOKEN = /^[A-Za-z0-9_-]{43}$/;

  function iniciar(janela, documento) {
    var U = janela.EpiUsuarios;
    janela.EpiHttp.configurar({ baseUrl: janela.SAFEWORK_PORTAL_API_BASE_URL });
    var el = function (id) { return documento.getElementById(id); };

    var fragmento = String((janela.location && janela.location.hash) || '').replace(/^#/, '');
    var token = new URLSearchParams(fragmento).get('token') || '';
    if (janela.history && typeof janela.history.replaceState === 'function') {
      janela.history.replaceState(null, documento.title, janela.location.pathname + janela.location.search);
    }

    var contaNova = false;

    function mensagem(texto) {
      el('mensagem').textContent = texto || '';
      el('mensagem').className = texto ? 'mensagem erro' : 'mensagem';
    }

    function mostrarConvite(d) {
      el('empresa').textContent = d.empresa && d.empresa.razaoSocial ? d.empresa.razaoSocial : '';
      el('email').textContent = d.emailConvite || '';
      el('nomeConvite').textContent = d.nome || '';
      el('tipoConta').textContent = U.texto.perfil(d.perfil);
      contaNova = d.identidadeExistente !== true;
      if (contaNova) {
        el('instrucao').textContent = 'Crie a senha da sua conta: pelo menos 12 caracteres, sem termos óbvios.';
        el('rotuloSenha').textContent = 'Nova senha';
        el('senha').setAttribute('autocomplete', 'new-password');
        el('blocoConfirmacao').style.display = '';
      } else {
        el('instrucao').textContent = 'Você já tem conta no SafeWork com este e-mail. Confirme a sua senha atual para receber o acesso a esta empresa.';
        el('rotuloSenha').textContent = 'Senha atual';
        el('senha').setAttribute('autocomplete', 'current-password');
        el('blocoConfirmacao').style.display = 'none';
      }
      el('formAceite').style.display = 'block';
    }

    function aceitar(evento) {
      evento.preventDefault();
      var senha = el('senha').value;
      var confirmacao = el('senhaConfirmacao').value;
      el('senha').value = '';
      el('senhaConfirmacao').value = '';
      mensagem('');
      if (!senha) {
        mensagem('Informe a senha.');
        return undefined;
      }
      if (contaNova && senha !== confirmacao) {
        mensagem('A confirmação não confere com a senha. Digite as duas de novo.');
        return undefined;
      }
      el('botaoAceitar').disabled = true;
      return U.acoes.aceitarConvite(token, senha).then(function (r) {
        if (!r.ok) {
          mensagem(U.mensagens.erroAceite(r));
          el('botaoAceitar').disabled = false;
          return;
        }
        var d = r.dados || {};
        el('formAceite').style.display = 'none';
        el('empresaOk').textContent = d.empresa && d.empresa.razaoSocial ? d.empresa.razaoSocial : 'a empresa';
        el('sucesso').style.display = 'block';
      }).catch(function () {
        mensagem('Não foi possível falar com o servidor. Verifique a conexão.');
        el('botaoAceitar').disabled = false;
      });
    }

    el('formAceite').addEventListener('submit', aceitar);

    if (!TOKEN.test(token)) {
      el('carregando').style.display = 'none';
      mensagem('Link de convite incompleto. Abra o link exatamente como você o recebeu.');
      return Promise.resolve();
    }

    return U.acoes.consultarConvite(token).then(function (r) {
      el('carregando').style.display = 'none';
      if (!r.ok) {
        mensagem(U.mensagens.erroAceite(r));
        return;
      }
      mostrarConvite(r.dados || {});
    }).catch(function () {
      el('carregando').style.display = 'none';
      mensagem('Não foi possível falar com o servidor. Verifique a conexão.');
    });
  }

  var api = { iniciar: iniciar };
  global.EpiAceiteConvite = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    iniciar(global, global.document);
  }
})(typeof window !== 'undefined' ? window : globalThis);
