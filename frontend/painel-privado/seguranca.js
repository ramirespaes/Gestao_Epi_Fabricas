(function () {
  'use strict';

  /**
   * Segurança da conta: trocar o autenticador e gerar novos códigos de
   * recuperação. As duas operações encerram todas as sessões no servidor e
   * não criam outra: depois dos códigos, só resta o login.
   */

  var http = window.EpiHttp;
  var mfa = window.SafeworkMfa;
  http.configurar({ baseUrl: window.SAFEWORK_PLATAFORMA_API_BASE_URL });

  var el = function (id) { return document.getElementById(id); };
  var conteudo = el('conteudo');
  var campoSenha = el('senha-atual');
  var campoAtual = el('codigo-atual');
  var campoCadastro = el('codigo-cadastro');

  var OPERACOES = {
    SUBSTITUICAO: { titulo: 'Trocar autenticador', caminho: '/auth/mfa/substituicao/iniciar' },
    REGENERACAO: { titulo: 'Novos códigos de recuperação', caminho: '/auth/mfa/recuperacao/regenerar' },
  };
  var SESSAO_ENCERRADA = 'Sua sessão foi encerrada. Salve os códigos e entre novamente.';
  var RECOMECAR = 'Esta etapa expirou ou não é mais válida. Comece de novo.';
  var operacao = null;

  var tela = mfa.criarTela({
    titulo: el('titulo-etapa'),
    mensagem: el('mensagem'),
    etapas: {
      MENU: el('etapa-menu'),
      REAUTENTICACAO: el('etapa-reautenticacao'),
      CADASTRO: el('etapa-cadastro'),
      CODIGOS: el('etapa-codigos'),
    },
  });

  var fila = mfa.criarFila(http, [
    'sair', 'botao-trocar-autenticador', 'botao-gerar-codigos', 'botao-reautenticar', 'botao-voltar-reautenticacao',
    'botao-confirmar-cadastro', 'botao-voltar-cadastro',
  ].map(el));

  var cadastro = mfa.criarCadastro({
    material: el('cadastro-material'),
    qr: el('cadastro-qr'),
    chave: el('cadastro-chave'),
    botaoCopiar: el('botao-copiar-chave'),
    avisar: tela.avisar,
  });

  var codigos = mfa.criarCodigos({
    lista: el('lista-codigos'),
    botaoCopiar: el('botao-copiar-codigos'),
    confirmacao: el('confirmo-codigos'),
    botaoSalvos: el('botao-codigos-salvos'),
    avisar: tela.avisar,
    aoSalvar: irParaLogin,
  });

  function limparSensiveis() {
    [campoSenha, campoAtual, campoCadastro].forEach(function (campo) { campo.value = ''; });
    cadastro.limpar();
    codigos.limpar();
  }

  function ocultar() {
    limparSensiveis();
    conteudo.hidden = true;
  }

  function irParaLogin() {
    ocultar();
    window.location.href = 'index.html';
  }

  function mostrarMenu(mensagem) {
    limparSensiveis();
    operacao = null;
    tela.mostrar('MENU', 'Segurança da conta', el('botao-trocar-autenticador'));
    if (mensagem) tela.avisar(mensagem, 'erro');
  }

  function mostrarCodigos(lista) {
    cadastro.limpar();
    tela.mostrar('CODIGOS', 'Códigos de recuperação', el('botao-copiar-codigos'));
    codigos.mostrar(lista);
    tela.avisar(SESSAO_ENCERRADA, 'info');
  }

  function confirmarSessao() {
    ocultar();
    fila.requisitar('GET', '/auth/me').then(function (resposta) {
      if (resposta === null) return;
      if (http.ehNaoAutenticado(resposta)) {
        irParaLogin();
        return;
      }
      if (!resposta.ok) {
        tela.avisar(mfa.classificar(resposta).mensagem, 'erro');
        return;
      }
      conteudo.hidden = false;
      mostrarMenu();
    });
  }

  function aoEnviar(id, acao) {
    el(id).addEventListener('submit', function (evento) {
      evento.preventDefault();
      if (!fila.pendente()) acao();
    });
  }

  function aoClicar(id, acao) {
    el(id).addEventListener('click', function () {
      if (!fila.pendente()) acao();
    });
  }

  function abrirReautenticacao(nome) {
    operacao = nome;
    campoSenha.value = '';
    campoAtual.value = '';
    tela.mostrar('REAUTENTICACAO', OPERACOES[nome].titulo, campoSenha);
  }

  [campoAtual, campoCadastro].forEach(mfa.prepararCampoTotp);

  aoClicar('botao-trocar-autenticador', function () { abrirReautenticacao('SUBSTITUICAO'); });
  aoClicar('botao-gerar-codigos', function () { abrirReautenticacao('REGENERACAO'); });
  aoClicar('botao-voltar-reautenticacao', function () { mostrarMenu(); });
  // Voltar não encerra a sessão: o desafio aberto expira sozinho no servidor.
  aoClicar('botao-voltar-cadastro', function () { mostrarMenu(); });

  aoEnviar('etapa-reautenticacao', function () {
    if (campoSenha.value === '') {
      tela.avisar(mfa.MENSAGENS.CAMPO_VAZIO, 'erro');
      campoSenha.focus();
      return;
    }
    if (!mfa.codigoTotpValido(campoAtual.value)) {
      tela.avisar(mfa.MENSAGENS.CODIGO_INCOMPLETO, 'erro');
      campoAtual.focus();
      return;
    }
    var pedida = operacao;
    fila.requisitar('POST', OPERACOES[pedida].caminho, { senha: campoSenha.value, codigo: campoAtual.value }).then(function (resposta) {
      campoSenha.value = '';
      campoAtual.value = '';
      if (!resposta.ok) {
        var erro = mfa.classificar(resposta);
        if (erro.tipo === 'SESSAO') {
          irParaLogin();
          return;
        }
        tela.avisar(erro.mensagem, 'erro');
        campoSenha.focus();
        return;
      }
      var dados = resposta.dados || {};
      if (pedida === 'REGENERACAO' && mfa.codigosValidos(dados.codigosRecuperacao)) {
        mostrarCodigos(dados.codigosRecuperacao);
        return;
      }
      if (pedida === 'SUBSTITUICAO' && mfa.cadastroValido(dados.cadastro)) {
        cadastro.mostrar(dados.cadastro);
        tela.mostrar('CADASTRO', 'Cadastrar novo autenticador', campoCadastro);
        return;
      }
      tela.avisar(mfa.MENSAGENS.INESPERADA, 'erro');
    });
  });

  aoEnviar('etapa-cadastro', function () {
    if (!mfa.codigoTotpValido(campoCadastro.value)) {
      tela.avisar(mfa.MENSAGENS.CODIGO_INCOMPLETO, 'erro');
      campoCadastro.focus();
      return;
    }
    fila.requisitar('POST', '/auth/mfa/substituicao/confirmar', { codigo: campoCadastro.value }).then(function (resposta) {
      campoCadastro.value = '';
      if (resposta.ok) {
        var lista = resposta.dados && resposta.dados.codigosRecuperacao;
        if (mfa.codigosValidos(lista)) mostrarCodigos(lista);
        else tela.avisar(mfa.MENSAGENS.INESPERADA, 'erro');
        return;
      }
      var erro = mfa.classificar(resposta);
      if (erro.tipo === 'SESSAO') {
        irParaLogin();
      } else if (erro.tipo === 'DESAFIO') {
        mostrarMenu(RECOMECAR);
      } else if (erro.tipo === 'CADASTRO_EXPIRADO' || erro.tipo === 'REINICIOS_ESGOTADOS' || erro.tipo === 'JA_ATIVO') {
        mostrarMenu(erro.tipo === 'CADASTRO_EXPIRADO' ? 'O cadastro do autenticador expirou. Comece de novo.' : erro.mensagem);
      } else {
        tela.avisar(erro.mensagem, 'erro');
        campoCadastro.focus();
      }
    });
  });

  aoClicar('sair', function () {
    ocultar();
    fila.requisitar('POST', '/auth/logout').then(irParaLogin);
  });

  confirmarSessao();

  // Página restaurada pelo navegador: o DOM antigo volta sem recarregar.
  window.addEventListener('pageshow', function (evento) {
    if (evento && evento.persisted) confirmarSessao();
  });
})();
