(function () {
  'use strict';

  /**
   * Ambiente inicial autenticado (Pacote 4). Usuário e empresa exibidos
   * vêm do servidor (GET /auth/global/me, que só apresenta um contexto
   * empresarial válido E da mesma identidade). Sem contexto -> seleção de
   * empresa; sem sessão -> login.
   *
   *   TROCAR DE EMPRESA -> empresas.html (a sessão atual só é revogada
   *                        quando outra empresa é efetivamente escolhida)
   *   Sair da empresa   -> POST /auth/logout (mantém o login global) e
   *                        volta à seleção, sem pedir senha
   *   Sair              -> POST /auth/global/logout (encerra tudo)
   */

  window.EpiHttp.configurar({ baseUrl: window.SAFEWORK_PORTAL_API_BASE_URL });
  var Portal = window.EpiPortal;
  var el = function (id) { return document.getElementById(id); };
  function ir(destino) { window.location.href = Portal.decisao.pagina(destino); }

  Portal.acoes.sessao().then(function (r) {
    el('carregando').classList.add('oculto');
    var destino = Portal.decisao.destinoDaSessao(r);
    if (destino !== 'inicio') {
      if (!r.ok && r.status !== 401) {
        el('mensagem').textContent = Portal.mensagens.deErro(r);
        el('mensagem').className = 'mensagem erro';
        return;
      }
      ir(destino);
      return;
    }

    var ctx = r.dados.contexto;
    el('empresa-nome').textContent = ctx.empresa.nome;
    el('empresa-cnpj').textContent = 'CNPJ ' + Portal.render.formatarCnpj(ctx.empresa.cnpj);
    el('usuario-nome').textContent = ctx.usuario.nome;
    el('usuario-email').textContent = ctx.usuario.email;
    el('usuario-perfil').textContent = Portal.render.rotuloPerfil(ctx.usuario.perfil);
    el('empresa-ativa').textContent = ctx.empresa.nome;
    if (Portal.decisao.podeTrocar(r.dados)) el('botao-trocar').classList.remove('oculto');
    el('acoes').classList.remove('oculto');
    el('conteudo').classList.remove('oculto');

    // Bloco 9, Etapa C, Parte C1: os links dos módulos administrativos nascem
    // ocultos e só aparecem com a permissão efetiva desta empresa, calculada
    // pelo servidor. Falha na consulta: continuam ocultos (falha fechada).
    var links = document.querySelectorAll('a[data-pagina]');
    // Empresa, usuário e perfil exibidos nesta página precisam coincidir com
    // os da resposta (correção pós-auditoria da C1); senão, falha fechada.
    window.EpiPermissoes.carregar(window.EpiPermissoes.esperadoDoContexto(ctx)).then(function (p) {
      window.EpiPermissoes.aplicarMenu(p.ok ? p.permissoes : null, links);
      if (!p.ok) {
        el('modulos-mensagem').textContent = p.motivo === 'CONTEXTO_DIVERGENTE'
          ? window.EpiPermissoes.MENSAGENS.CONTEXTO_DIVERGENTE
          : window.EpiPermissoes.MENSAGENS.FALHA;
        el('modulos-mensagem').classList.remove('oculto');
      }
    }).catch(function () {
      window.EpiPermissoes.aplicarMenu(null, links);
    });
  }).catch(function () {
    el('carregando').classList.add('oculto');
    el('mensagem').textContent = 'Não foi possível falar com o servidor. Verifique sua conexão.';
    el('mensagem').className = 'mensagem erro';
  });

  el('botao-trocar').addEventListener('click', function () { ir('selecionar'); });

  el('botao-sair-empresa').addEventListener('click', function () {
    el('botao-sair-empresa').disabled = true;
    Portal.acoes.sairDaEmpresa().then(function () { ir('selecionar'); }).catch(function () { ir('selecionar'); });
  });

  el('botao-sair').addEventListener('click', function () {
    el('botao-sair').disabled = true;
    Portal.acoes.sairCompletamente().then(function () { ir('login'); }).catch(function () { ir('login'); });
  });
})();
