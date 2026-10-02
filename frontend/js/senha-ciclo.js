(function (global) {
  'use strict';

  /**
   * EpiSenhaCiclo — parte comum das páginas públicas do ciclo de senha, no
   * Portal do Cliente e no Painel Privado: as mensagens, a tradução dos erros
   * do servidor e a página de redefinição pelo link.
   *
   * O TOKEN DO LINK chega no FRAGMENTO (#token=...), que o navegador não
   * envia a servidor nenhum. É lido uma vez, sai da barra de endereço no mesmo
   * instante, fica só na closure da página e só vai ao servidor no corpo JSON
   * do POST. Nunca vai à URL, ao DOM, a cookie ou a armazenamento do
   * navegador. Link ausente, incompleto ou com outro parâmetro não chama a
   * API.
   *
   * Tudo o que vem do servidor entra na tela por textContent. As senhas saem
   * dos campos a cada envio, deu certo ou não.
   */

  var TOKEN = /^[A-Za-z0-9_-]{43}$/;

  var MENSAGENS = {
    REDE: 'Não foi possível falar com o servidor. Verifique sua conexão.',
    MUITAS: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.',
    GENERICA: 'Não foi possível concluir. Tente novamente em instantes.',
    DADOS_INVALIDOS: 'Dados inválidos. Revise os campos e tente novamente.',
    SENHA_IGUAL: 'A nova senha deve ser diferente da senha atual.',
    SENHA_ATUAL: 'Senha atual incorreta. Confira e tente de novo.',
    SENHA_VAZIA: 'Informe a nova senha.',
    SENHA_ATUAL_VAZIA: 'Informe a senha atual.',
    CONFIRMACAO: 'A confirmação não confere com a nova senha. Digite as duas de novo.',
    EMAIL_VAZIO: 'Informe o e-mail.',
    VERIFICACAO_PENDENTE: 'Aguarde a verificação de segurança para continuar.',
  };

  /** Só as mensagens que o servidor já escolheu mostrar: regra violada, sem o valor recebido. */
  function detalhesDe(resposta) {
    if (!Array.isArray(resposta.detalhes)) return '';
    var textos = [];
    resposta.detalhes.forEach(function (d) {
      if (d && typeof d.mensagem === 'string' && d.mensagem !== '' && textos.indexOf(d.mensagem) === -1) textos.push(d.mensagem);
    });
    return textos.join(' ');
  }

  /** Texto para a pessoa a partir do envelope de erro do EpiHttp. Nunca devolve o texto bruto do servidor, salvo a regra de senha violada. */
  function mensagemDeErro(resposta) {
    if (!resposta || resposta.status === 0) return MENSAGENS.REDE;
    if (resposta.status === 429) return MENSAGENS.MUITAS;
    if (resposta.status === 401 && resposta.codigo === 'SENHA_ATUAL_INVALIDA') return MENSAGENS.SENHA_ATUAL;
    if (resposta.status === 400) {
      if (resposta.codigo === 'SENHA_IGUAL_A_ATUAL') return MENSAGENS.SENHA_IGUAL;
      if (resposta.codigo === 'VALIDACAO') return detalhesDe(resposta) || MENSAGENS.DADOS_INVALIDOS;
    }
    return MENSAGENS.GENERICA;
  }

  /**
   * Lê o token do fragmento e retira o fragmento da barra de endereço antes de
   * qualquer rede. Devolve '' se não há token no formato esperado.
   */
  function lerTokenDoFragmento(janela, documento) {
    var fragmento = String((janela.location && janela.location.hash) || '').replace(/^#/, '');
    var token = new URLSearchParams(fragmento).get('token') || '';
    if (fragmento !== '' && janela.history && typeof janela.history.replaceState === 'function') {
      janela.history.replaceState(null, documento.title, janela.location.pathname + janela.location.search);
    }
    return TOKEN.test(token) ? token : '';
  }

  /**
   * Página de redefinição pelo link. `caminho` é o POST da redefinição, relativo
   * à base da API do portal que carrega a página.
   *
   * @param {{janela: Window, documento: Document, caminho: string}} opcoes
   */
  function iniciarRedefinicao(opcoes) {
    var janela = opcoes.janela;
    var documento = opcoes.documento;
    var http = janela.EpiHttp;
    var el = function (id) { return documento.getElementById(id); };

    var form = el('form-redefinicao');
    var campoSenha = el('senha');
    var campoConfirmacao = el('senha-confirmacao');
    var botao = el('botao-redefinir');
    var mensagem = el('mensagem');

    var token = lerTokenDoFragmento(janela, documento);
    var enviando = false;
    var concluido = false;

    function mostrar(texto) {
      mensagem.textContent = texto || '';
      mensagem.className = texto ? 'mensagem erro' : 'mensagem';
    }

    function mostrarEstado(nome) {
      form.hidden = nome !== 'FORMULARIO';
      el('link-invalido').hidden = nome !== 'INVALIDO';
      el('sucesso').hidden = nome !== 'SUCESSO';
    }

    function limparCampos() {
      campoSenha.value = '';
      campoConfirmacao.value = '';
    }

    function falhar(texto) {
      enviando = false;
      botao.disabled = false;
      mostrar(texto);
      campoSenha.focus();
    }

    function aoEnviar(evento) {
      evento.preventDefault();
      if (enviando || concluido || token === '') return;
      var senha = campoSenha.value;
      var confirmacao = campoConfirmacao.value;
      limparCampos();
      if (senha === '') {
        mostrar(MENSAGENS.SENHA_VAZIA);
        return;
      }
      if (senha !== confirmacao) {
        mostrar(MENSAGENS.CONFIRMACAO);
        return;
      }
      mostrar('');
      enviando = true;
      botao.disabled = true;
      http.requisitar('POST', opcoes.caminho, { corpo: { token: token, novaSenha: senha } }).then(function (r) {
        if (r.ok) {
          enviando = false;
          concluido = true;
          token = '';
          mostrarEstado('SUCESSO');
          return;
        }
        if (r.status === 400 && r.codigo === 'REDEFINICAO_INVALIDA') {
          enviando = false;
          token = '';
          mostrarEstado('INVALIDO');
          return;
        }
        falhar(mensagemDeErro(r));
      }).catch(function () {
        falhar(MENSAGENS.REDE);
      });
    }

    form.addEventListener('submit', aoEnviar);

    if (token === '') {
      mostrarEstado('INVALIDO');
      return;
    }
    mostrarEstado('FORMULARIO');
    campoSenha.focus();
  }

  global.EpiSenhaCiclo = {
    MENSAGENS: MENSAGENS,
    mensagemDeErro: mensagemDeErro,
    lerTokenDoFragmento: lerTokenDoFragmento,
    iniciarRedefinicao: iniciarRedefinicao,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.EpiSenhaCiclo;
  }
})(typeof window !== 'undefined' ? window : globalThis);
