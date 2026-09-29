(function () {
  'use strict';

  /**
   * Login do Painel Privado. A senha abre uma etapa de MFA, nunca o painel:
   * a tela mostra a etapa que o servidor informar e só navega depois de a
   * sessão existir. O endereço da API vem de config.js.
   */

  var http = window.EpiHttp;
  var mfa = window.SafeworkMfa;
  http.configurar({ baseUrl: window.SAFEWORK_PLATAFORMA_API_BASE_URL });

  var el = function (id) { return document.getElementById(id); };
  var campoEmail = el('email');
  var campoSenha = el('senha');
  var campoVerificacao = el('codigo-verificacao');
  var campoRecuperacao = el('codigo-recuperacao');
  var campoLiberacao = el('codigo-liberacao');
  var campoCadastro = el('codigo-cadastro');
  var botaoNovoQr = el('botao-novo-qr');
  var botaoEntrarNovamente = el('botao-entrar-novamente');

  var TITULOS = {
    LOGIN: 'Entrar',
    VERIFICACAO: 'Verificação em duas etapas',
    RECUPERACAO: 'Código de recuperação',
    LIBERACAO: 'Código de liberação',
    CADASTRO: 'Cadastrar autenticador',
    RECADASTRO: 'Cadastrar novo autenticador',
    CODIGOS: 'Códigos de recuperação',
    ENCERRADA: 'Etapa encerrada',
  };

  var tela = mfa.criarTela({
    titulo: el('titulo-etapa'),
    mensagem: el('mensagem'),
    etapas: {
      LOGIN: el('form-login'),
      VERIFICACAO: el('etapa-verificacao'),
      RECUPERACAO: el('etapa-recuperacao'),
      LIBERACAO: el('etapa-liberacao'),
      CADASTRO: el('etapa-cadastro'),
      CODIGOS: el('etapa-codigos'),
      ENCERRADA: el('etapa-encerrada'),
    },
  });

  var fila = mfa.criarFila(http, [
    'botao-entrar', 'botao-verificar', 'botao-usar-recuperacao', 'botao-voltar-verificacao', 'botao-recuperar', 'botao-voltar-recuperacao',
    'botao-liberar', 'botao-voltar-liberacao', 'botao-confirmar-cadastro', 'botao-novo-qr', 'botao-voltar-cadastro', 'botao-entrar-novamente',
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
    aoSalvar: function () { window.location.href = 'painel.html'; },
  });

  var ETAPA_NAO_ENCERRADA = 'Não foi possível encerrar esta etapa no servidor. Ela pode continuar aberta. Verifique a conexão e tente de novo.';

  // CADASTRO no primeiro cadastro, RECUPERACAO no recadastro: decide o título.
  var tipoDoCadastro = 'CADASTRO';

  function limparSensiveis() {
    [campoSenha, campoVerificacao, campoRecuperacao, campoLiberacao, campoCadastro].forEach(function (campo) { campo.value = ''; });
    cadastro.limpar();
    codigos.limpar();
  }

  function mostrarLogin() {
    limparSensiveis();
    tela.mostrar('LOGIN', TITULOS.LOGIN, campoEmail);
  }

  function mostrarCadastro(tipo, material) {
    tipoDoCadastro = tipo;
    campoCadastro.value = '';
    var titulo = tipo === 'RECUPERACAO' ? TITULOS.RECADASTRO : TITULOS.CADASTRO;
    if (mfa.cadastroValido(material)) {
      cadastro.mostrar(material);
      tela.mostrar('CADASTRO', titulo, campoCadastro);
      return;
    }
    // Página recarregada no meio do cadastro: o QR anterior não volta.
    cadastro.limpar();
    tela.mostrar('CADASTRO', titulo, botaoNovoQr);
    tela.avisar('Gere um novo QR Code para continuar.', 'info');
  }

  /** @returns {boolean} se a etapa informada pelo servidor é desta tela. */
  function abrirEtapa(etapa, material) {
    if (etapa === 'VERIFICACAO') tela.mostrar('VERIFICACAO', TITULOS.VERIFICACAO, campoVerificacao);
    else if (etapa === 'LIBERACAO') tela.mostrar('LIBERACAO', TITULOS.LIBERACAO, campoLiberacao);
    else if (etapa === 'CADASTRO' || etapa === 'RECUPERACAO') mostrarCadastro(etapa, material);
    else return false;
    return true;
  }

  function encerrar(mensagem) {
    limparSensiveis();
    tela.mostrar('ENCERRADA', TITULOS.ENCERRADA, botaoEntrarNovamente);
    tela.avisar(mensagem, 'erro');
  }

  function tratarErro(resposta, campo) {
    var erro = mfa.classificar(resposta);
    campo.value = '';
    if (erro.tipo === 'DESAFIO' || erro.tipo === 'SESSAO' || erro.tipo === 'REINICIOS_ESGOTADOS' || erro.tipo === 'JA_ATIVO') {
      encerrar(erro.tipo === 'SESSAO' ? mfa.MENSAGENS.DESAFIO : erro.mensagem);
      return;
    }
    if (erro.tipo === 'CADASTRO_EXPIRADO') {
      cadastro.limpar();
      tela.avisar(erro.mensagem, 'erro');
      botaoNovoQr.focus();
      return;
    }
    tela.avisar(erro.mensagem, 'erro');
    campo.focus();
  }

  // Sem a confirmação do servidor o desafio pode continuar aberto: a tela não volta ao login como se ele tivesse acabado.
  function voltarAoLogin() {
    fila.requisitar('POST', '/auth/logout').then(function (resposta) {
      if (resposta === null) return;
      if (!resposta.ok) {
        tela.avisar(resposta.status === 429 ? mfa.MENSAGENS.AGUARDE : ETAPA_NAO_ENCERRADA, 'erro');
        return;
      }
      mostrarLogin();
    });
  }

  function consultarEstado() {
    mostrarLogin();
    fila.requisitar('GET', '/auth/mfa/estado').then(function (resposta) {
      if (resposta && resposta.ok && resposta.dados) abrirEtapa(resposta.dados.etapa, null);
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

  function exigirTotp(campo) {
    if (mfa.codigoTotpValido(campo.value)) return true;
    tela.avisar(mfa.MENSAGENS.CODIGO_INCOMPLETO, 'erro');
    campo.focus();
    return false;
  }

  function exigirTexto(campo) {
    if (campo.value.trim() !== '') return true;
    tela.avisar(mfa.MENSAGENS.CAMPO_VAZIO, 'erro');
    campo.focus();
    return false;
  }

  [campoVerificacao, campoCadastro].forEach(mfa.prepararCampoTotp);

  aoEnviar('form-login', function () {
    tela.avisar('');
    fila.requisitar('POST', '/auth/login', { email: campoEmail.value, senha: campoSenha.value }).then(function (resposta) {
      campoSenha.value = '';
      if (!resposta.ok) {
        // Falha de login: a mensagem pública do servidor já é genérica.
        tela.avisar(resposta.status === 0 ? mfa.MENSAGENS.REDE : (resposta.mensagem || mfa.MENSAGENS.GENERICA), 'erro');
        campoSenha.focus();
        return;
      }
      if (!resposta.dados || !abrirEtapa(resposta.dados.etapa, null)) tela.avisar(mfa.MENSAGENS.INESPERADA, 'erro');
    });
  });

  aoEnviar('etapa-verificacao', function () {
    if (!exigirTotp(campoVerificacao)) return;
    fila.requisitar('POST', '/auth/mfa/verificar', { codigo: campoVerificacao.value }).then(function (resposta) {
      if (!resposta.ok) {
        tratarErro(resposta, campoVerificacao);
        return;
      }
      limparSensiveis();
      window.location.href = 'painel.html';
    });
  });

  aoClicar('botao-usar-recuperacao', function () {
    campoVerificacao.value = '';
    tela.mostrar('RECUPERACAO', TITULOS.RECUPERACAO, campoRecuperacao);
  });

  aoClicar('botao-voltar-recuperacao', function () {
    campoRecuperacao.value = '';
    tela.mostrar('VERIFICACAO', TITULOS.VERIFICACAO, campoVerificacao);
  });

  function enviarCodigoDeEntrada(campo, caminho, nomeNoCorpo) {
    if (!exigirTexto(campo)) return;
    var corpo = {};
    corpo[nomeNoCorpo] = campo.value.trim();
    fila.requisitar('POST', caminho, corpo).then(function (resposta) {
      if (!resposta.ok) {
        tratarErro(resposta, campo);
        return;
      }
      campo.value = '';
      var dados = resposta.dados || {};
      if ((dados.etapa === 'CADASTRO' || dados.etapa === 'RECUPERACAO') && mfa.cadastroValido(dados.cadastro)) {
        mostrarCadastro(dados.etapa, dados.cadastro);
        return;
      }
      tela.avisar(mfa.MENSAGENS.INESPERADA, 'erro');
    });
  }

  aoEnviar('etapa-recuperacao', function () { enviarCodigoDeEntrada(campoRecuperacao, '/auth/mfa/recuperacao', 'codigoRecuperacao'); });
  aoEnviar('etapa-liberacao', function () { enviarCodigoDeEntrada(campoLiberacao, '/auth/mfa/liberacao', 'codigoLiberacao'); });

  aoEnviar('etapa-cadastro', function () {
    if (!exigirTotp(campoCadastro)) return;
    fila.requisitar('POST', '/auth/mfa/cadastro/confirmar', { codigo: campoCadastro.value }).then(function (resposta) {
      if (!resposta.ok) {
        tratarErro(resposta, campoCadastro);
        return;
      }
      campoCadastro.value = '';
      var lista = resposta.dados && resposta.dados.codigosRecuperacao;
      if (!mfa.codigosValidos(lista)) {
        tela.avisar(mfa.MENSAGENS.INESPERADA, 'erro');
        return;
      }
      cadastro.limpar();
      tela.mostrar('CODIGOS', TITULOS.CODIGOS, el('botao-copiar-codigos'));
      codigos.mostrar(lista);
    });
  });

  aoClicar('botao-novo-qr', function () {
    fila.requisitar('POST', '/auth/mfa/cadastro/reiniciar', {}).then(function (resposta) {
      if (!resposta.ok) {
        tratarErro(resposta, campoCadastro);
        return;
      }
      var dados = resposta.dados || {};
      if (mfa.cadastroValido(dados.cadastro)) mostrarCadastro(dados.etapa === 'RECUPERACAO' ? 'RECUPERACAO' : tipoDoCadastro, dados.cadastro);
      else tela.avisar(mfa.MENSAGENS.INESPERADA, 'erro');
    });
  });

  ['botao-voltar-verificacao', 'botao-voltar-liberacao', 'botao-voltar-cadastro', 'botao-entrar-novamente'].forEach(function (id) {
    aoClicar(id, voltarAoLogin);
  });

  consultarEstado();

  // Página restaurada pelo navegador: o DOM antigo volta sem recarregar.
  window.addEventListener('pageshow', function (evento) {
    if (evento && evento.persisted) consultarEstado();
  });
})();
