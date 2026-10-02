'use strict';

const entregaRecuperacao = require('./entrega-recuperacao-senha.service');

/**
 * Aviso de senha alterada na troca autenticada, chamado só depois do COMMIT.
 * Nada do que acontecer aqui volta para quem chama: nem exceção, nem promessa
 * rejeitada sem tratamento. O registro técnico leva só o escopo, o tipo e o
 * código do erro; nunca e-mail, senha, token ou a mensagem do erro.
 */

const NOME_ERRO_FORMATO = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
const CODIGO_FORMATO = /^[A-Za-z0-9_.]{1,40}$/;

function registrarFalha(escopo, erro) {
  const nome = erro && erro.constructor && erro.constructor.name;
  const registro = { evento: 'entrega_falhou', escopo, erro: typeof nome === 'string' && NOME_ERRO_FORMATO.test(nome) ? nome : 'Error' };
  if (erro && typeof erro.code === 'string' && CODIGO_FORMATO.test(erro.code)) {
    registro.codigo = erro.code;
  }
  console.error('[troca-senha]', registro);
}

function avisarTroca({ escopo, email }) {
  try {
    const retorno = entregaRecuperacao.enfileirarAvisoSenhaAlterada({ escopo, email, origem: 'TROCA' });
    if (retorno && typeof retorno.then === 'function') {
      retorno.then(undefined, (erro) => registrarFalha(escopo, erro));
    }
  } catch (erro) {
    registrarFalha(escopo, erro);
  }
}

module.exports = { avisarTroca };
