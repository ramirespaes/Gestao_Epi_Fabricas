(function (global) {
  'use strict';

  /**
   * Partes comuns das telas de MFA do Painel Privado (login e segurança da
   * conta). Segredos recebidos do servidor (URI, chave manual e códigos de
   * recuperação) vivem só no DOM da etapa que os mostra e somem com ela:
   * nada é guardado no navegador nem repetido em mensagens.
   */

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var MARGEM_QR = 4; // zona de silêncio exigida pelo padrão, em módulos
  var QUANTIDADE_CODIGOS = 10;
  var CODIGO_TOTP = /^[0-9]{6}$/;

  var MENSAGENS = {
    REDE: 'Não foi possível falar com o servidor. Verifique sua conexão.',
    INESPERADA: 'Resposta inesperada do servidor. Tente novamente.',
    GENERICA: 'Não foi possível concluir. Tente novamente.',
    CODIGO: 'Código inválido. Confira e tente de novo.',
    CODIGO_INCOMPLETO: 'Digite os 6 dígitos do código.',
    CAMPO_VAZIO: 'Preencha o campo para continuar.',
    REAUTENTICACAO: 'Senha ou código inválidos.',
    AGUARDE: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.',
    INDISPONIVEL: 'Verificação em duas etapas indisponível no momento. Tente novamente em instantes.',
    DESAFIO: 'Esta etapa expirou ou não é mais válida. Entre novamente.',
    CADASTRO_EXPIRADO: 'O cadastro do autenticador expirou. Gere um novo QR Code.',
    REINICIOS_ESGOTADOS: 'Limite de novos QR Codes atingido. Entre novamente com a senha.',
    JA_ATIVO: 'Este administrador já tem o autenticador ativo. Entre novamente.',
    SESSAO: 'Sua sessão expirou. Entre novamente.',
    CHAVE_COPIADA: 'Chave copiada.',
    CODIGOS_COPIADOS: 'Códigos copiados. Guarde-os em local seguro.',
    COPIA_FALHOU: 'Não foi possível copiar. Copie manualmente.',
  };

  var POR_CODIGO = {
    MFA_CODIGO_INVALIDO: 'CODIGO',
    REAUTENTICACAO_INVALIDA: 'REAUTENTICACAO',
    DESAFIO_INVALIDO: 'DESAFIO',
    MFA_CADASTRO_EXPIRADO: 'CADASTRO_EXPIRADO',
    MFA_CADASTRO_REINICIOS_ESGOTADOS: 'REINICIOS_ESGOTADOS',
    MFA_JA_ATIVO: 'JA_ATIVO',
    MFA_INDISPONIVEL: 'INDISPONIVEL',
    RESPOSTA_INVALIDA: 'INESPERADA',
  };

  /**
   * Traduz uma resposta de erro num tipo que a tela sabe tratar e numa
   * mensagem fixa. O texto vindo do servidor não é exibido.
   *
   * @returns {{tipo: string, mensagem: string}}
   */
  function classificar(resposta) {
    var tipo = POR_CODIGO[resposta.codigo];
    if (!tipo) {
      if (resposta.status === 0) tipo = 'REDE';
      else if (resposta.status === 429) tipo = 'AGUARDE';
      else if (resposta.status === 401) tipo = 'SESSAO';
      else if (resposta.status === 400) tipo = 'CODIGO';
      else tipo = 'GENERICA';
    }
    return { tipo: tipo, mensagem: MENSAGENS[tipo] };
  }

  /** O código TOTP é texto: zeros à esquerda fazem parte dele. */
  function soDigitos(texto) {
    return String(texto).replace(/[^0-9]/g, '').slice(0, 6);
  }

  function codigoTotpValido(texto) {
    return CODIGO_TOTP.test(texto);
  }

  /** Campo de TOTP: aceita colagem com espaços ou hífens e descarta o resto. */
  function prepararCampoTotp(campo) {
    campo.addEventListener('input', function () {
      var limpo = soDigitos(campo.value);
      if (limpo !== campo.value) campo.value = limpo;
    });
    campo.addEventListener('paste', function (evento) {
      if (!evento.clipboardData) return;
      evento.preventDefault();
      campo.value = soDigitos(evento.clipboardData.getData('text'));
    });
  }

  function cadastroValido(cadastro) {
    return Boolean(cadastro)
      && typeof cadastro.uri === 'string' && cadastro.uri.indexOf('otpauth://') === 0
      && typeof cadastro.chaveManual === 'string' && cadastro.chaveManual.length > 0;
  }

  function codigosValidos(codigos) {
    return Array.isArray(codigos) && codigos.length === QUANTIDADE_CODIGOS
      && codigos.every(function (c) { return typeof c === 'string' && c.length > 0; });
  }

  function esvaziar(elemento) {
    while (elemento.firstChild) elemento.removeChild(elemento.firstChild);
  }

  /**
   * Desenha o QR da URI como SVG, nó a nó. A URI só passa pela biblioteca
   * local; o desenho leva apenas coordenadas.
   */
  function desenharQr(container, uri) {
    esvaziar(container);
    var qr = global.qrcode(0, 'M');
    qr.addData(uri, 'Byte');
    qr.make();

    var n = qr.getModuleCount();
    var lado = n + 2 * MARGEM_QR;
    var d = '';
    for (var linha = 0; linha < n; linha += 1) {
      var coluna = 0;
      while (coluna < n) {
        if (!qr.isDark(linha, coluna)) {
          coluna += 1;
          continue;
        }
        var inicio = coluna;
        while (coluna < n && qr.isDark(linha, coluna)) coluna += 1;
        var largura = coluna - inicio;
        d += 'M' + (inicio + MARGEM_QR) + ' ' + (linha + MARGEM_QR) + 'h' + largura + 'v1h-' + largura + 'z';
      }
    }

    var svg = global.document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + lado + ' ' + lado);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'QR Code para o aplicativo autenticador');
    svg.setAttribute('shape-rendering', 'crispEdges');
    var fundo = global.document.createElementNS(SVG_NS, 'rect');
    fundo.setAttribute('width', String(lado));
    fundo.setAttribute('height', String(lado));
    fundo.setAttribute('fill', '#ffffff');
    var modulos = global.document.createElementNS(SVG_NS, 'path');
    modulos.setAttribute('d', d);
    modulos.setAttribute('fill', '#000000');
    svg.appendChild(fundo);
    svg.appendChild(modulos);
    container.appendChild(svg);
  }

  function copiar(texto) {
    var area = global.navigator && global.navigator.clipboard;
    if (!area || typeof area.writeText !== 'function') return Promise.resolve(false);
    return area.writeText(texto).then(function () { return true; }, function () { return false; });
  }

  /**
   * Uma etapa visível por vez. `etapas` liga o nome ao elemento.
   */
  function criarTela(opcoes) {
    var etapas = opcoes.etapas;
    var atual = null;

    function avisar(texto, tipo) {
      opcoes.mensagem.className = texto ? 'mensagem ' + (tipo || 'erro') : 'mensagem';
      opcoes.mensagem.textContent = texto || '';
    }

    function mostrar(nome, titulo, foco) {
      Object.keys(etapas).forEach(function (chave) { etapas[chave].hidden = chave !== nome; });
      atual = nome;
      opcoes.titulo.textContent = titulo;
      avisar('');
      (foco || opcoes.titulo).focus();
    }

    return { mostrar: mostrar, avisar: avisar, atual: function () { return atual; } };
  }

  /**
   * Uma requisição por vez: enquanto uma está pendente, os botões ficam
   * desabilitados e novos pedidos são ignorados (devolvem null).
   */
  function criarFila(http, botoes) {
    var pendente = false;

    function bloquear(sim) {
      pendente = sim;
      botoes.forEach(function (botao) { botao.disabled = sim; });
    }

    function requisitar(metodo, caminho, corpo) {
      if (pendente) return Promise.resolve(null);
      bloquear(true);
      var opcoes = corpo === undefined ? undefined : { corpo: corpo };
      return http.requisitar(metodo, caminho, opcoes).then(function (resposta) {
        bloquear(false);
        return resposta;
      }, function () {
        bloquear(false);
        return { ok: false, status: 0, dados: null, codigo: 'FALHA_DE_REDE' };
      });
    }

    return { requisitar: requisitar, pendente: function () { return pendente; } };
  }

  /** QR e chave manual do cadastro. A cópia lê a chave da própria tela. */
  function criarCadastro(opcoes) {
    function limpar() {
      esvaziar(opcoes.qr);
      opcoes.chave.textContent = '';
      opcoes.material.hidden = true;
    }

    function mostrar(cadastro) {
      desenharQr(opcoes.qr, cadastro.uri);
      opcoes.chave.textContent = cadastro.chaveManual;
      opcoes.material.hidden = false;
    }

    opcoes.botaoCopiar.addEventListener('click', function () {
      copiar(opcoes.chave.textContent).then(function (copiou) {
        opcoes.avisar(copiou ? MENSAGENS.CHAVE_COPIADA : MENSAGENS.COPIA_FALHOU, copiou ? 'info' : 'erro');
      });
    });

    return { mostrar: mostrar, limpar: limpar };
  }

  /**
   * Códigos de recuperação: existem só nesta tela. Sair exige a confirmação
   * de que foram salvos; fechar ou recarregar antes disso pede confirmação.
   */
  function criarCodigos(opcoes) {
    function aoFechar(evento) {
      evento.preventDefault();
      evento.returnValue = '';
    }

    function limpar() {
      esvaziar(opcoes.lista);
      opcoes.confirmacao.checked = false;
      opcoes.botaoSalvos.disabled = true;
      global.removeEventListener('beforeunload', aoFechar);
    }

    function mostrar(codigos) {
      limpar();
      codigos.forEach(function (codigo) {
        var item = global.document.createElement('li');
        item.textContent = codigo;
        opcoes.lista.appendChild(item);
      });
      global.addEventListener('beforeunload', aoFechar);
    }

    opcoes.confirmacao.addEventListener('change', function () {
      opcoes.botaoSalvos.disabled = !opcoes.confirmacao.checked;
    });

    opcoes.botaoCopiar.addEventListener('click', function () {
      var texto = opcoes.lista.children ? Array.prototype.map.call(opcoes.lista.children, function (item) { return item.textContent; }).join('\n') : '';
      copiar(texto).then(function (copiou) {
        opcoes.avisar(copiou ? MENSAGENS.CODIGOS_COPIADOS : MENSAGENS.COPIA_FALHOU, copiou ? 'info' : 'erro');
      });
    });

    opcoes.botaoSalvos.addEventListener('click', function () {
      if (!opcoes.confirmacao.checked) return;
      limpar();
      opcoes.aoSalvar();
    });

    return { mostrar: mostrar, limpar: limpar };
  }

  global.SafeworkMfa = {
    MENSAGENS: MENSAGENS,
    classificar: classificar,
    soDigitos: soDigitos,
    codigoTotpValido: codigoTotpValido,
    prepararCampoTotp: prepararCampoTotp,
    cadastroValido: cadastroValido,
    codigosValidos: codigosValidos,
    criarTela: criarTela,
    criarFila: criarFila,
    criarCadastro: criarCadastro,
    criarCodigos: criarCodigos,
  };
})(typeof window !== 'undefined' ? window : globalThis);
