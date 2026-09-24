(function () {
  'use strict';

  /**
   * "Selecione sua empresa" (Pacote 4). A lista vem SEMPRE do servidor
   * (GET /auth/global/me): só empresas com vínculo ativo desta identidade e
   * empresa ativa. A escolha é revalidada no backend; um 403 aqui significa
   * que a empresa deixou de estar disponível entre a listagem e o clique —
   * a lista é recarregada, nunca se tenta outra coisa.
   *
   * Também atende "Trocar de empresa": se já houver uma empresa ativa, ela
   * aparece marcada; escolher outra revoga a sessão empresarial anterior no
   * servidor (na mesma transação que cria a nova) e a página de início é
   * recarregada do zero — nada da empresa anterior é transportado.
   */

  window.EpiHttp.configurar({ baseUrl: window.SAFEWORK_PORTAL_API_BASE_URL });
  var Portal = window.EpiPortal;
  var el = function (id) { return document.getElementById(id); };

  function mostrar(texto, classe) { var m = el('mensagem'); m.textContent = texto || ''; m.className = 'mensagem ' + (classe || ''); }
  function ir(destino) { window.location.href = Portal.decisao.pagina(destino); }

  function carregar(aviso) {
    Portal.acoes.sessao().then(function (r) {
      el('carregando').classList.add('oculto');
      if (!r.ok) {
        if (r.status === 401) { ir('login'); return; }
        el('selecao').classList.remove('oculto');
        mostrar(Portal.mensagens.deErro(r), 'erro');
        return;
      }
      var dados = r.dados;
      el('identificacao').textContent = dados.identidade.email;
      el('botao-sair').classList.remove('oculto');

      if (dados.empresas.length === 0) {
        el('selecao').classList.add('oculto');
        el('sem-empresa').classList.remove('oculto');
        el('mensagem-sem-empresa').textContent = Portal.mensagens.SEM_EMPRESA;
        return;
      }

      var atual = dados.contexto ? dados.contexto.empresa.id : null;
      el('lista-empresas').innerHTML = Portal.render.listaEmpresas(dados.empresas, atual);
      el('selecao').classList.remove('oculto');
      mostrar(aviso || '', aviso ? 'erro' : '');
    }).catch(function () {
      el('carregando').classList.add('oculto');
      el('selecao').classList.remove('oculto');
      mostrar('Não foi possível falar com o servidor. Verifique sua conexão.', 'erro');
    });
  }

  el('lista-empresas').addEventListener('click', function (evento) {
    var botao = evento.target.closest('button[data-empresa-id]');
    if (!botao) return;
    var id = Number(botao.getAttribute('data-empresa-id'));
    var todos = el('lista-empresas').querySelectorAll('button');
    Array.prototype.forEach.call(todos, function (b) { b.disabled = true; });
    mostrar('');

    Portal.acoes.selecionar(id).then(function (r) {
      if (r.ok) { ir('inicio'); return; }
      if (r.status === 401) { ir('login'); return; }
      carregar(Portal.mensagens.deErro(r));
    }).catch(function () {
      Array.prototype.forEach.call(todos, function (b) { b.disabled = false; });
      mostrar('Não foi possível falar com o servidor. Verifique sua conexão.', 'erro');
    });
  });

  el('botao-sair').addEventListener('click', function () {
    el('botao-sair').disabled = true;
    Portal.acoes.sairCompletamente().then(function () { ir('login'); }).catch(function () { ir('login'); });
  });

  carregar();
})();
