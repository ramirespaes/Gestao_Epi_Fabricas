(function () {
  'use strict';

  /**
   * Segurança da conta: trocar o autenticador, gerar novos códigos de
   * recuperação e trocar a senha. As duas primeiras encerram todas as sessões
   * no servidor e não criam outra: depois dos códigos, só resta o login. A
   * troca de senha mantém esta sessão e o servidor encerra as outras; ela
   * pede só o TOTP, nunca um código de recuperação.
   */

  var http = window.EpiHttp;
  var mfa = window.SafeworkMfa;
  http.configurar({ baseUrl: window.SAFEWORK_PLATAFORMA_API_BASE_URL });

  var el = function (id) { return document.getElementById(id); };
  var conteudo = el('conteudo');
  var campoSenha = el('senha-atual');
  var campoAtual = el('codigo-atual');
  var campoCadastro = el('codigo-cadastro');
  var campoTrocaAtual = el('troca-senha-atual');
  var campoTrocaNova = el('troca-senha-nova');
  var campoTrocaConfirmacao = el('troca-senha-confirmacao');
  var campoTrocaCodigo = el('troca-codigo');

  var OPERACOES = {
    SUBSTITUICAO: { titulo: 'Trocar autenticador', caminho: '/auth/mfa/substituicao/iniciar' },
    REGENERACAO: { titulo: 'Novos códigos de recuperação', caminho: '/auth/mfa/recuperacao/regenerar' },
  };
  var SESSAO_ENCERRADA = 'Sua sessão foi encerrada. Salve os códigos e entre novamente.';
  var RECOMECAR = 'Esta etapa expirou ou não é mais válida. Comece de novo.';
  var GUARDE_OS_CODIGOS = 'Guarde os códigos de recuperação e marque a confirmação antes de sair.';
  var SENHA_ALTERADA = 'Senha alterada. Esta sessão continua ativa; as outras foram encerradas.';
  var CONFIRMACAO_DIFERENTE = 'A confirmação não confere com a nova senha. Digite as duas de novo.';
  var SENHA_IGUAL = 'A nova senha deve ser diferente da senha atual.';
  var DADOS_INVALIDOS = 'Dados inválidos. Revise os campos e tente novamente.';
  var operacao = null;

  var tela = mfa.criarTela({
    titulo: el('titulo-etapa'),
    mensagem: el('mensagem'),
    etapas: {
      MENU: el('etapa-menu'),
      REAUTENTICACAO: el('etapa-reautenticacao'),
      SENHA: el('etapa-senha'),
      CADASTRO: el('etapa-cadastro'),
      CODIGOS: el('etapa-codigos'),
    },
  });

  var fila = mfa.criarFila(http, [
    'sair', 'botao-trocar-autenticador', 'botao-gerar-codigos', 'botao-trocar-senha', 'botao-reautenticar', 'botao-voltar-reautenticacao',
    'botao-confirmar-troca-senha', 'botao-voltar-troca-senha', 'botao-confirmar-cadastro', 'botao-voltar-cadastro',
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

  function limparCamposDaTroca() {
    [campoTrocaAtual, campoTrocaNova, campoTrocaConfirmacao, campoTrocaCodigo].forEach(function (campo) { campo.value = ''; });
  }

  function limparSensiveis() {
    [campoSenha, campoAtual, campoCadastro].forEach(function (campo) { campo.value = ''; });
    limparCamposDaTroca();
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

  function abrirTrocaDeSenha() {
    limparCamposDaTroca();
    tela.mostrar('SENHA', 'Trocar senha', campoTrocaAtual);
  }

  /** Só as regras de senha que o servidor escolheu mostrar, sem o valor recebido; o resto segue para o classificador do MFA. */
  function mensagemDaSenha(resposta) {
    if (resposta.status !== 400) return null;
    if (resposta.codigo === 'SENHA_IGUAL_A_ATUAL') return SENHA_IGUAL;
    if (resposta.codigo !== 'VALIDACAO') return null;
    var textos = [];
    (Array.isArray(resposta.detalhes) ? resposta.detalhes : []).forEach(function (d) {
      if (d && typeof d.mensagem === 'string' && d.mensagem !== '' && textos.indexOf(d.mensagem) === -1) textos.push(d.mensagem);
    });
    return textos.length > 0 ? textos.join(' ') : DADOS_INVALIDOS;
  }

  [campoAtual, campoCadastro, campoTrocaCodigo].forEach(mfa.prepararCampoTotp);

  aoClicar('botao-trocar-autenticador', function () { abrirReautenticacao('SUBSTITUICAO'); });
  aoClicar('botao-gerar-codigos', function () { abrirReautenticacao('REGENERACAO'); });
  aoClicar('botao-trocar-senha', abrirTrocaDeSenha);
  aoClicar('botao-voltar-troca-senha', function () { mostrarMenu(); });
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

  aoEnviar('etapa-senha', function () {
    if (campoTrocaAtual.value === '' || campoTrocaNova.value === '') {
      tela.avisar(mfa.MENSAGENS.CAMPO_VAZIO, 'erro');
      (campoTrocaAtual.value === '' ? campoTrocaAtual : campoTrocaNova).focus();
      return;
    }
    if (campoTrocaNova.value !== campoTrocaConfirmacao.value) {
      tela.avisar(CONFIRMACAO_DIFERENTE, 'erro');
      campoTrocaConfirmacao.focus();
      return;
    }
    if (!mfa.codigoTotpValido(campoTrocaCodigo.value)) {
      tela.avisar(mfa.MENSAGENS.CODIGO_INCOMPLETO, 'erro');
      campoTrocaCodigo.focus();
      return;
    }
    var corpo = { senhaAtual: campoTrocaAtual.value, novaSenha: campoTrocaNova.value, codigo: campoTrocaCodigo.value };
    fila.requisitar('POST', '/auth/senha', corpo).then(function (resposta) {
      limparCamposDaTroca();
      if (resposta.ok) {
        mostrarMenu();
        tela.avisar(SENHA_ALTERADA, 'info');
        return;
      }
      // Validação e senha igual à atual têm mensagem própria: o classificador do MFA as chamaria de "código inválido".
      var propria = mensagemDaSenha(resposta);
      if (propria !== null) {
        tela.avisar(propria, 'erro');
        campoTrocaAtual.focus();
        return;
      }
      var erro = mfa.classificar(resposta);
      if (erro.tipo === 'SESSAO') {
        irParaLogin();
        return;
      }
      tela.avisar(erro.mensagem, 'erro');
      campoTrocaAtual.focus();
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

  // Os códigos só existem nesta tela: sair sem a confirmação os apagaria sem aviso.
  function podeSair() {
    if (fila.pendente()) return false;
    if (el('lista-codigos').firstChild && !el('confirmo-codigos').checked) {
      tela.avisar(GUARDE_OS_CODIGOS, 'erro');
      return false;
    }
    return true;
  }

  window.SafeworkSair.ligar({
    botao: el('sair'),
    requisitar: function () { return fila.requisitar('POST', '/auth/logout'); },
    permitir: podeSair,
    aoIniciar: function () { tela.avisar(''); },
    aoFalhar: function (mensagem) { tela.avisar(mensagem, 'erro'); },
    // irParaLogin limpa e oculta a tela antes de navegar.
    aoConcluir: irParaLogin,
  });

  confirmarSessao();

  // Página restaurada pelo navegador: o DOM antigo volta sem recarregar.
  window.addEventListener('pageshow', function (evento) {
    if (evento && evento.persisted) confirmarSessao();
  });
})();
