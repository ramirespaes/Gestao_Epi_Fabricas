'use strict';

const { textoSimples } = require('../escapar');
const { emailConfig } = require('../../config/email');
const { montar } = require('./layout');

/**
 * Templates transacionais oficiais. Cada tipo recebe dados já validados pela
 * entrega e devolve { assunto, texto, html }. Os assuntos são constantes da
 * aplicação: nenhum dado do usuário entra num cabeçalho.
 */

const TIPOS = Object.freeze({
  RECUPERACAO_SENHA: 'RECUPERACAO_SENHA',
  SENHA_ALTERADA: 'SENHA_ALTERADA',
  CONVITE_USUARIO: 'CONVITE_USUARIO',
  CONVITE_MASTER: 'CONVITE_MASTER',
});

const PORTAIS = Object.freeze({ PORTAL: 'Portal do Cliente', PLATAFORMA: 'Painel Privado' });

const ACESSOS_ENCERRADOS = Object.freeze({
  REDEFINICAO: 'os acessos abertos foram encerrados',
  TROCA: 'os demais acessos foram encerrados',
});

const PERFIS = Object.freeze({ MASTER: 'Master', ADMINISTRADOR: 'Administrador', SUPERVISOR: 'Supervisor', USUARIO: 'Usuário' });

const ASSUNTO_CONVITE_USUARIO = 'Convite para acessar o Portal do Cliente — SafeWork Engenharia';
const ASSUNTO_CONVITE_MASTER = 'Convite para administrar sua empresa no SafeWork Engenharia';

const REGEX_LINK = /^https?:\/\/\S+$/;

const partes = (data) => Object.fromEntries(
  new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(data).map((p) => [p.type, p.value]),
);

function validade(expiraEm) {
  if (!(expiraEm instanceof Date) || Number.isNaN(expiraEm.getTime())) {
    throw new TypeError('validade inválida');
  }
  const p = partes(expiraEm);
  return `${p.day}/${p.month}/${p.year} às ${p.hour}:${p.minute} (horário de Brasília)`;
}

function exigirLink(link) {
  if (typeof link !== 'string' || !REGEX_LINK.test(link)) {
    throw new TypeError('link inválido');
  }
  return link;
}

function exigirPortal(escopo) {
  if (typeof escopo !== 'string' || !Object.hasOwn(PORTAIS, escopo)) {
    throw new TypeError('escopo inválido');
  }
  return PORTAIS[escopo];
}

function exigirPerfil(perfil) {
  if (typeof perfil !== 'string' || !Object.hasOwn(PERFIS, perfil)) {
    throw new TypeError('perfil inválido');
  }
  return PERFIS[perfil];
}

function recuperacaoSenha({ escopo, link, expiraEm }) {
  const portal = exigirPortal(escopo);
  return {
    assunto: `Redefinição de senha — ${portal}`,
    estrutura: {
      titulo: 'Redefinição de senha',
      preheader: 'Use o link para criar uma nova senha.',
      paragrafos: [
        `Recebemos um pedido para redefinir a senha da sua conta no ${portal}.`,
        `Este link só pode ser usado uma vez e vale até ${validade(expiraEm)}.`,
      ],
      cta: { rotulo: 'Criar nova senha', link: exigirLink(link) },
      notas: ['Se você não fez este pedido, ignore esta mensagem: a sua senha continua a mesma.'],
    },
  };
}

function senhaAlterada({ escopo, origem }, { suporte }) {
  const portal = exigirPortal(escopo);
  if (typeof origem !== 'string' || !Object.hasOwn(ACESSOS_ENCERRADOS, origem)) {
    throw new TypeError('origem inválida');
  }
  return {
    assunto: `Sua senha foi alterada — ${portal}`,
    estrutura: {
      titulo: 'Senha alterada',
      preheader: 'A senha da sua conta foi alterada.',
      paragrafos: [`A senha da sua conta acabou de ser alterada e ${ACESSOS_ENCERRADOS[origem]}.`],
      notas: [`Se você não reconhece esta alteração, fale com o suporte: ${suporte}`],
    },
  };
}

function conviteUsuario({ link, expiraEm, empresa, nome, perfil, reenvio = false }) {
  const rotuloPerfil = exigirPerfil(perfil);
  const paragrafos = [
    `Olá, ${textoSimples(nome, 100)}.`,
    `Você foi convidado(a) para acessar o Portal do Cliente da empresa ${textoSimples(empresa, 150)} no SafeWork, com o perfil ${rotuloPerfil}.`,
  ];
  if (reenvio) paragrafos.push('Este é um novo convite: o convite anterior deixou de valer.');
  paragrafos.push(`Este link só pode ser usado uma vez e vale até ${validade(expiraEm)}.`);
  return {
    assunto: reenvio ? `Novo convite para acessar o Portal do Cliente — SafeWork Engenharia` : ASSUNTO_CONVITE_USUARIO,
    estrutura: {
      titulo: reenvio ? 'Novo convite de acesso' : 'Convite de acesso',
      preheader: 'Aceite o convite para acessar o SafeWork.',
      paragrafos,
      cta: { rotulo: 'Aceitar convite', link: exigirLink(link) },
      notas: ['Se você não esperava este convite, ignore esta mensagem.'],
    },
  };
}

function conviteMaster({ link, expiraEm, empresa, reenvio = false }) {
  const paragrafos = [`Você foi convidado(a) para ser o primeiro administrador (MASTER) da empresa ${textoSimples(empresa, 150)} no SafeWork.`];
  if (reenvio) paragrafos.push('Este é um novo convite: o convite anterior deixou de valer.');
  paragrafos.push(`Este link só pode ser usado uma vez e vale até ${validade(expiraEm)}.`);
  return {
    assunto: reenvio ? 'Novo convite para administrar sua empresa no SafeWork Engenharia' : ASSUNTO_CONVITE_MASTER,
    estrutura: {
      titulo: reenvio ? 'Novo convite para administrar sua empresa' : 'Convite para administrar sua empresa',
      preheader: 'Aceite o convite para administrar sua empresa no SafeWork.',
      paragrafos,
      cta: { rotulo: 'Aceitar convite', link: exigirLink(link) },
      notas: ['Se você não esperava este convite, ignore esta mensagem.'],
    },
  };
}

const MONTADORES = Object.freeze({
  RECUPERACAO_SENHA: recuperacaoSenha,
  SENHA_ALTERADA: senhaAlterada,
  CONVITE_USUARIO: conviteUsuario,
  CONVITE_MASTER: conviteMaster,
});

/**
 * @param {string} tipo um dos TIPOS
 * @param {object} dados dados do tipo, já validados
 * @param {{suporte?: string}} [opcoes]
 * @returns {{assunto: string, texto: string, html: string}}
 */
function renderizar(tipo, dados, { suporte = emailConfig.suporte } = {}) {
  if (typeof tipo !== 'string' || !Object.hasOwn(MONTADORES, tipo)) {
    throw new TypeError('tipo de e-mail inválido');
  }
  const { assunto, estrutura } = MONTADORES[tipo](dados, { suporte });
  return { assunto, ...montar({ ...estrutura, suporte }) };
}

module.exports = { TIPOS, renderizar };
