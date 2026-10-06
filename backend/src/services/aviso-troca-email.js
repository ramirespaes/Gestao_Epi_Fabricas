'use strict';

const entregaRecuperacao = require('./entrega-recuperacao-senha.service');

/**
 * Aviso de segurança ao e-mail ANTIGO quando o e-mail de acesso é alterado
 * (Configurações), chamado só depois do COMMIT. Mesmo contrato de
 * aviso-troca-senha.js: nada do que acontecer aqui volta para quem chama, e
 * o registro técnico leva só o escopo, o tipo e o código do erro — nunca o
 * endereço, a senha ou a mensagem do erro.
 */

const NOME_ERRO_FORMATO = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
const CODIGO_FORMATO = /^[A-Za-z0-9_.]{1,40}$/;

function registrarFalha(escopo, erro) {
  const nome = erro && erro.constructor && erro.constructor.name;
  const registro = { evento: 'aviso_falhou', escopo, erro: typeof nome === 'string' && NOME_ERRO_FORMATO.test(nome) ? nome : 'Error' };
  if (erro && typeof erro.code === 'string' && CODIGO_FORMATO.test(erro.code)) {
    registro.codigo = erro.code;
  }
  console.error('[troca-email]', registro);
}

function avisarTrocaEmail({ escopo, email }) {
  try {
    const retorno = entregaRecuperacao.enfileirarAvisoEmailAlterado({ escopo, email });
    if (retorno && typeof retorno.then === 'function') {
      retorno.then(undefined, (erro) => registrarFalha(escopo, erro));
    }
  } catch (erro) {
    registrarFalha(escopo, erro);
  }
}

module.exports = { avisarTrocaEmail };
