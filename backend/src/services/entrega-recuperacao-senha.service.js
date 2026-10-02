'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { emailConfig } = require('../config/email');
const { httpConfig } = require('../config/http');

/**
 * Entrega dos e-mails do ciclo de senha: o link de redefinição e o aviso de
 * senha alterada.
 *
 * Quem chama (recuperacao-senha.service e os services da troca de senha) só
 * enfileira, e sempre depois do COMMIT. As funções de enfileirar são síncronas e não devolvem promessa: a
 * resposta ao cliente nunca espera a entrega, para o tempo de resposta não
 * distinguir conta existente de inexistente.
 *
 * ENTREGA PÓS-COMMIT = BEST EFFORT. Não há fila durável nem reenvio: se o
 * processo cair depois do COMMIT e antes da entrega, a mensagem se perde e a
 * pessoa precisa solicitar de novo. Durabilidade e reenvio ficam para a
 * etapa do provedor real de e-mail.
 *
 * Sem provedor real, a mensagem é descartada (modo desativado) ou gravada
 * em arquivo, fora do repositório (modo arquivo, só desenvolvimento e
 * teste). O token vai só no fragmento do link (#token=), que o navegador
 * não envia a servidor algum. Nada aqui escreve token, link ou e-mail no
 * console; a falha de entrega registra só o tipo, o escopo e o código do erro.
 *
 * O remetente automático ainda não está definido, então a mensagem não
 * declara remetente. O endereço de suporte aparece só como contato.
 */

const SUPORTE = 'suporte@safeworkengenharia.com.br';
const CODIGO_SEGURO = /^[A-Za-z0-9_.]{1,40}$/;

const PAGINAS = Object.freeze({
  PORTAL: { origem: () => httpConfig.cors.origens[0], caminho: '/portal/redefinir-senha.html', nome: 'Portal do Cliente' },
  PLATAFORMA: { origem: () => httpConfig.plataforma.corsOrigens[0], caminho: '/painel-privado/redefinir-senha.html', nome: 'Painel Privado' },
});

function exigirEscopo(escopo) {
  if (typeof escopo !== 'string' || !Object.hasOwn(PAGINAS, escopo)) {
    throw new TypeError('escopo de entrega inválido');
  }
}

function exigirTexto(valor, nome) {
  if (typeof valor !== 'string' || valor.length === 0) {
    throw new TypeError(`${nome} inválido`);
  }
}

function montarLinkRedefinicao(escopo, token) {
  exigirEscopo(escopo);
  exigirTexto(token, 'token de redefinição');
  const pagina = PAGINAS[escopo];
  return `${pagina.origem()}${pagina.caminho}#token=${encodeURIComponent(token)}`;
}

function textoDaRedefinicao({ escopo, email, token, expiraEm }) {
  return [
    `Para: ${email}`,
    `Assunto: Redefinição de senha — ${PAGINAS[escopo].nome}`,
    '',
    'Recebemos um pedido para redefinir a senha da sua conta.',
    `O link abaixo só pode ser usado uma vez e vale até ${expiraEm.toISOString()}:`,
    '',
    montarLinkRedefinicao(escopo, token),
    '',
    'Se você não fez este pedido, ignore esta mensagem: a sua senha continua a mesma.',
    `Dúvidas: ${SUPORTE}`,
    '',
  ].join('\n');
}

// Na troca autenticada o acesso em uso continua: o texto fala só dos demais.
const ACESSOS_ENCERRADOS = Object.freeze({
  REDEFINICAO: 'os acessos abertos foram encerrados',
  TROCA: 'os demais acessos foram encerrados',
});

function textoDoAviso({ escopo, email, origem }) {
  return [
    `Para: ${email}`,
    `Assunto: Sua senha foi alterada — ${PAGINAS[escopo].nome}`,
    '',
    `A senha da sua conta acabou de ser alterada e ${ACESSOS_ENCERRADOS[origem]}.`,
    `Se você não reconhece esta alteração, fale com o suporte: ${SUPORTE}`,
    '',
  ].join('\n');
}

function criarEntrega({ config = emailConfig } = {}) {
  const pendentes = new Set();

  async function gravar(tipo, escopo, conteudo) {
    const { diretorio } = config.arquivo;
    await fs.mkdir(diretorio, { recursive: true, mode: 0o700 });
    const instante = new Date().toISOString().replace(/[-:.]/g, '');
    const nome = `${instante}-${tipo.toLowerCase()}-${escopo.toLowerCase()}-${crypto.randomBytes(6).toString('hex')}.txt`;
    await fs.writeFile(path.join(diretorio, nome), conteudo, { mode: 0o600, flag: 'wx' });
  }

  function despachar(tipo, escopo, conteudo) {
    if (config.modo !== 'arquivo') {
      return;
    }
    const tarefa = gravar(tipo, escopo, conteudo)
      .catch((erro) => {
        // O erro pode trazer o caminho e o conteúdo: só o código sai daqui.
        const codigo = erro && typeof erro.code === 'string' && CODIGO_SEGURO.test(erro.code) ? erro.code : 'DESCONHECIDO';
        console.error('[entrega-email]', { evento: 'entrega_falhou', tipo, escopo, codigo });
      })
      .finally(() => { pendentes.delete(tarefa); });
    pendentes.add(tarefa);
  }

  function enfileirarRedefinicao({ escopo, email, token, expiraEm }) {
    exigirEscopo(escopo);
    exigirTexto(email, 'destinatário');
    exigirTexto(token, 'token de redefinição');
    if (!(expiraEm instanceof Date) || Number.isNaN(expiraEm.getTime())) {
      throw new TypeError('validade do link inválida');
    }
    despachar('REDEFINICAO', escopo, textoDaRedefinicao({ escopo, email, token, expiraEm }));
  }

  function enfileirarAvisoSenhaAlterada({ escopo, email, origem = 'REDEFINICAO' }) {
    exigirEscopo(escopo);
    exigirTexto(email, 'destinatário');
    if (typeof origem !== 'string' || !Object.hasOwn(ACESSOS_ENCERRADOS, origem)) {
      throw new TypeError('origem do aviso inválida');
    }
    despachar('AVISO', escopo, textoDoAviso({ escopo, email, origem }));
  }

  /** Espera o que já foi enfileirado terminar. Para testes e encerramento do processo. */
  async function aguardarOciosidade() {
    while (pendentes.size > 0) {
      await Promise.allSettled([...pendentes]);
    }
  }

  return { enfileirarRedefinicao, enfileirarAvisoSenhaAlterada, aguardarOciosidade, montarLinkRedefinicao };
}

const padrao = criarEntrega();

module.exports = {
  enfileirarRedefinicao: padrao.enfileirarRedefinicao,
  enfileirarAvisoSenhaAlterada: padrao.enfileirarAvisoSenhaAlterada,
  aguardarOciosidade: padrao.aguardarOciosidade,
  montarLinkRedefinicao,
  criarEntrega,
};
