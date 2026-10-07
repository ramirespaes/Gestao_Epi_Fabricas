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
  EMAIL_ALTERADO: 'EMAIL_ALTERADO',
  CONVITE_USUARIO: 'CONVITE_USUARIO',
  CONVITE_MASTER: 'CONVITE_MASTER',
  DISPONIBILIDADE_ESTOQUE_ENTREGA: 'DISPONIBILIDADE_ESTOQUE_ENTREGA',
  FALTA_ESTOQUE_ENTREGA: 'FALTA_ESTOQUE_ENTREGA',
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

function exigirPositivo(valor, nome, minimo = 1) {
  if (!Number.isInteger(valor) || valor < minimo) {
    throw new TypeError(`${nome} inválido`);
  }
  return valor;
}

function exigirLista(valor, nome) {
  if (!Array.isArray(valor) || valor.length === 0) {
    throw new TypeError(`${nome} inválida`);
  }
  return valor;
}

const linkOpcional = (link) => (link === null || link === undefined ? null : exigirLink(link));
const unidades = (n, singular, plural) => `${n} ${n === 1 ? singular : plural}`;

function epiComTamanho(material, tamanho) {
  const nome = textoSimples(material, 150);
  return tamanho === null || tamanho === undefined ? nome : `${nome}, tamanho ${textoSimples(tamanho, 20)}`;
}

// O aviso automático é agregado: só estes campos, e nenhum de trabalhador ou de pedido individual.
const CAMPOS_DISPONIBILIDADE = Object.freeze(['empresa', 'pares', 'restantes', 'link']);
const CAMPOS_PAR = Object.freeze(['material', 'tamanho', 'quantidade', 'pedidos']);

function exigirSoCampos(objeto, permitidos, nome) {
  if (objeto === null || typeof objeto !== 'object' || Object.keys(objeto).some((k) => !permitidos.includes(k))) {
    throw new TypeError(`${nome} fora do contrato`);
  }
}

function disponibilidadeEstoqueEntrega(dados) {
  exigirSoCampos(dados, CAMPOS_DISPONIBILIDADE, 'aviso de disponibilidade');
  const {
    empresa, pares, restantes = 0, link = null,
  } = dados;
  const paragrafos = [`Há EPIs de solicitações aprovadas disponíveis para entrega na empresa ${textoSimples(empresa, 150)}, conferidos agora:`];
  for (const par of exigirLista(pares, 'lista de EPIs')) {
    exigirSoCampos(par, CAMPOS_PAR, 'linha do aviso');
    const quantidade = exigirPositivo(par.quantidade, 'quantidade');
    const pedidos = exigirPositivo(par.pedidos, 'pedidos');
    paragrafos.push(`${epiComTamanho(par.material, par.tamanho)}: ${unidades(quantidade, 'unidade disponível', 'unidades disponíveis')} para ${unidades(pedidos, 'pedido', 'pedidos')}`);
  }
  if (exigirPositivo(restantes, 'restantes', 0) > 0) {
    paragrafos.push(`E mais ${restantes} EPIs e tamanhos disponíveis; a lista completa está na tela Entregas por solicitação.`);
  }
  const cta = linkOpcional(link);
  return {
    assunto: 'EPIs disponíveis para entrega — SafeWork Engenharia',
    estrutura: {
      titulo: 'EPIs disponíveis para entrega',
      preheader: 'Há EPIs disponíveis para solicitações aprovadas.',
      paragrafos,
      cta: cta === null ? null : { rotulo: 'Abrir Entregas por solicitação', link: cta },
      notas: [
        'Este é um resumo da situação atual. Quem recebe, qual pedido e qual item entregar estão na tela Entregas por solicitação.',
        'As quantidades foram conferidas no envio e podem mudar até a entrega: confira na tela antes de entregar.',
        'Você recebe este aviso porque integra a Segurança do Trabalho e pode realizar entregas nesta empresa.',
      ],
    },
  };
}

function faltaEstoqueEntrega({
  empresa, numero, itens, link = null,
}) {
  const paragrafos = [
    `Uma solicitação de EPI aprovada aguarda estoque para ser entregue na empresa ${textoSimples(empresa, 150)}.`,
    `Pedido nº ${exigirPositivo(numero, 'número do pedido')}`,
  ];
  for (const item of exigirLista(itens, 'lista de itens')) {
    const pendente = exigirPositivo(item.pendente, 'pendente');
    const semCobertura = exigirPositivo(item.semCobertura, 'sem cobertura');
    if (semCobertura > pendente) throw new TypeError('sem cobertura maior que o pendente');
    paragrafos.push(`${epiComTamanho(item.material, item.tamanho)}: ${unidades(pendente, 'pendente', 'pendentes')}, ${semCobertura} sem cobertura`);
  }
  const cta = linkOpcional(link);
  return {
    assunto: 'Falta de estoque para entrega de EPI — SafeWork Engenharia',
    estrutura: {
      titulo: 'Falta de estoque para entrega',
      preheader: 'Uma solicitação aprovada aguarda estoque.',
      paragrafos,
      cta: cta === null ? null : { rotulo: 'Abrir Materiais', link: cta },
      notas: [
        'Registre a entrada no estoque assim que o material chegar: quem entrega é avisado quando houver estoque.',
        'Você recebe este alerta porque pode movimentar o estoque nesta empresa.',
      ],
    },
  };
}

/**
 * Configurações: aviso de segurança ao endereço ANTIGO quando o e-mail de
 * acesso muda. Só no Portal do Cliente (o Painel Privado não troca e-mail por
 * aqui); sem link, sem token, sem o endereço novo — o template recusa
 * qualquer campo além do escopo.
 */
function emailAlterado(dados, { suporte }) {
  exigirSoCampos(dados, ['escopo'], 'e-mail alterado');
  if (dados.escopo !== 'PORTAL') {
    throw new TypeError('escopo inválido');
  }
  const portal = exigirPortal(dados.escopo);
  return {
    assunto: `O e-mail de acesso da sua conta foi alterado — ${portal}`,
    estrutura: {
      titulo: 'E-mail de acesso alterado',
      preheader: 'O e-mail de acesso da sua conta foi alterado.',
      paragrafos: [
        'O e-mail de acesso da sua conta acabou de ser alterado e os demais acessos foram encerrados. Este endereço deixou de valer para entrar.',
      ],
      notas: [`Se você não reconhece esta alteração, fale com o suporte: ${suporte}`],
    },
  };
}

const MONTADORES = Object.freeze({
  RECUPERACAO_SENHA: recuperacaoSenha,
  SENHA_ALTERADA: senhaAlterada,
  EMAIL_ALTERADO: emailAlterado,
  CONVITE_USUARIO: conviteUsuario,
  CONVITE_MASTER: conviteMaster,
  DISPONIBILIDADE_ESTOQUE_ENTREGA: disponibilidadeEstoqueEntrega,
  FALTA_ESTOQUE_ENTREGA: faltaEstoqueEntrega,
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
