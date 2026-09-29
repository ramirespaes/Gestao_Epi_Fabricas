(function (global) {
  'use strict';

  /**
   * Sair do Painel Privado. O cookie de sessão é HttpOnly: só o servidor o
   * revoga e remove. A página só limpa o conteúdo e vai ao login depois de
   * o servidor confirmar; sem confirmação ela continua como estava, avisa
   * que a sessão continua ativa e deixa tentar de novo.
   */

  var MENSAGENS = {
    REDE: 'Não foi possível encerrar a sessão: o servidor não respondeu. A sessão continua ativa. Verifique a conexão e clique em Sair de novo.',
    AGUARDE: 'Não foi possível encerrar a sessão agora: muitas requisições. A sessão continua ativa. Aguarde um momento e clique em Sair de novo.',
    FALHA: 'Não foi possível encerrar a sessão. A sessão continua ativa. Clique em Sair de novo.',
  };

  function mensagemDe(resposta) {
    if (!resposta || resposta.status === 0) return MENSAGENS.REDE;
    return resposta.status === 429 ? MENSAGENS.AGUARDE : MENSAGENS.FALHA;
  }

  /**
   * opcoes: botao; requisitar(), que devolve a Promise da resposta do
   * logout; permitir(), opcional, que pode recusar a saída; aoIniciar(),
   * aoFalhar(mensagem) e aoConcluir().
   */
  function ligar(opcoes) {
    var emAndamento = false;

    function falhar(resposta) {
      emAndamento = false;
      opcoes.botao.disabled = false;
      opcoes.aoFalhar(mensagemDe(resposta));
    }

    opcoes.botao.addEventListener('click', function () {
      if (emAndamento || (opcoes.permitir && !opcoes.permitir())) return;
      emAndamento = true;
      opcoes.botao.disabled = true;
      opcoes.aoIniciar();
      opcoes.requisitar().then(function (resposta) {
        // Só 2xx confirma: 403 e 429 saem antes de o servidor encerrar qualquer coisa.
        if (resposta && resposta.ok) opcoes.aoConcluir();
        else falhar(resposta);
      }, function () { falhar(null); });
    });
  }

  global.SafeworkSair = { ligar: ligar, MENSAGENS: MENSAGENS };
})(typeof window !== 'undefined' ? window : globalThis);
