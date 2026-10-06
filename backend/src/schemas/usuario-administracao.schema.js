'use strict';

const { z } = require('zod');
const {
  LIMITES, idParametro, idCorpo, inteiroQuery, textoCurto, email, senhaEntrada, cpfComDigitosVerificadores, codigoCatalogo,
} = require('./campos.schema');
const { normalizarIp } = require('../utils/ip');

/**
 * Administração de usuários da empresa (Bloco 9, parte F). Query e corpo
 * estritos: empresa, identidade, e-mail, senha, situação e grupo nunca
 * chegam por aqui. A empresa vem sempre da sessão; qualquer outra chave é
 * CAMPO_NAO_PERMITIDO.
 *
 * O e-mail não é editável (decisão D4): ele é a identidade global da
 * pessoa, compartilhada com as outras empresas em que ela trabalha.
 *
 * O perfil do usuário-alvo viaja como `tipoConta` (o rótulo da tela). A
 * chave `perfil` num corpo é campo de autoridade de quem age: o navegador
 * não a envia (js/api-http.js) e aqui ela é recusada como qualquer extra.
 */

const PERFIS = Object.freeze(['MASTER', 'ADMINISTRADOR', 'SUPERVISOR', 'USUARIO']);
const SITUACOES = Object.freeze(['ATIVO', 'INATIVO']);
// Só os nomes públicos da ordenação; o SQL de cada um fica fixo no repositório.
const ORDENS = Object.freeze(['nome', 'nome_desc', 'perfil', 'situacao', 'recentes']);
const BUSCA_MAXIMA = 100;
const NOME_MAXIMO = 150;

const nome = textoCurto(NOME_MAXIMO, 'NOME_INVALIDO', 'Nome inválido');
const perfil = z.enum(PERFIS);
const paramsComId = z.strictObject({ id: idParametro });

const listar = {
  query: z.strictObject({
    busca: textoCurto(BUSCA_MAXIMA, 'BUSCA_INVALIDA', 'Termo de busca inválido').optional(),
    situacao: z.enum(SITUACOES).optional(),
    perfil: perfil.optional(),
    ordem: z.enum(ORDENS).default('nome'),
    pagina: inteiroQuery(1, LIMITES.PAGINA_MAXIMA).default(1),
    limite: inteiroQuery(1, LIMITES.LIMITE_MAXIMO).default(LIMITES.LIMITE_PADRAO),
  }),
};

const buscar = { params: paramsComId };

const semCorpo = z.strictObject({});
const inativar = { params: paramsComId, body: semCorpo };
const reativar = { params: paramsComId, body: semCorpo };

// Criação direta (Gestão de Usuários): e-mail é o login real da identidade e
// a senha é PROVISÓRIA (troca obrigatória no primeiro acesso, 074). A
// política completa é do serviço; aqui só vazio e tamanho de entrada.
//
// Usuário ADMINISTRATIVO (decisão de 05/10/2026; migrations 075–077): CPF
// (dígitos verificadores conferidos, saída canônica), matrícula e setor são
// obrigatórios; horário de trabalho (HH:MM, os dois lados), IPs permitidos
// (IPv4/IPv6, canônicos, até IPS_MAXIMO) e grupo de acesso são opcionais. A
// confirmação da senha é da tela e nunca chega aqui; existência de grupo,
// unicidade de CPF e matrícula são do serviço.
const MATRICULA_MAXIMO = 30;
const SETOR_MAXIMO = 100;
const IPS_MAXIMO = 20;
const HORA_HH_MM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

function issue(ctx, codigo, message) {
  ctx.addIssue({ code: 'custom', message, params: { codigo } });
  return z.NEVER;
}
const hora = z.string().transform((valor, ctx) => (HORA_HH_MM.test(valor) ? valor : issue(ctx, 'HORARIO_INVALIDO', 'Horário inválido (use HH:MM)')));
const ipPermitido = z.string().transform((valor, ctx) => normalizarIp(valor) ?? issue(ctx, 'IP_INVALIDO', 'Endereço IP inválido'));

const criar = {
  body: z.strictObject({
    nome,
    email,
    tipoConta: perfil,
    senhaProvisoria: senhaEntrada,
    cpf: cpfComDigitosVerificadores,
    matricula: textoCurto(MATRICULA_MAXIMO, 'MATRICULA_INVALIDA', 'Matrícula inválida'),
    setor: textoCurto(SETOR_MAXIMO, 'SETOR_INVALIDO', 'Setor inválido'),
    horarioTrabalho: z.strictObject({ inicio: hora, fim: hora }).nullable().optional(),
    ipsPermitidos: z.array(ipPermitido).max(IPS_MAXIMO).optional(),
    grupoAcessoId: idCorpo.optional(),
    // Duplicar usuário: outro usuário DA EMPRESA como modelo de acesso (camadas individuais; nunca dados pessoais).
    usuarioModeloId: idCorpo.optional(),
  }),
};

// Configurar permissões do usuário (camadas individuais). Recurso/ação são identificadores; existência e efeito real são do serviço.
const tri = z.union([z.boolean(), z.null()]).optional();
const permissoesRecurso = {
  params: z.strictObject({ id: idParametro, recurso: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,59}$/) }),
  body: z.strictObject({ visualizar: tri, criar: tri, editar: tri, excluir: tri })
    .refine((c) => ['visualizar', 'criar', 'editar', 'excluir'].some((o) => c[o] !== undefined), { message: 'Informe ao menos uma operação', params: { codigo: 'ALTERACAO_VAZIA' } }),
};
const permissoesAcao = {
  params: z.strictObject({ id: idParametro, codigo: codigoCatalogo(60, 'ACAO_INVALIDA', 'Ação inválida') }),
  body: z.strictObject({ estado: z.enum(['PADRAO', 'CONCEDIDA', 'BLOQUEADA']) }),
};
const acessoToggle = {
  params: z.strictObject({ id: idParametro, toggle: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,39}$/) }),
  body: z.strictObject({ ligado: z.boolean() }),
};
const permissoesCopiar ={ params: paramsComId, body: z.strictObject({ origemId: idCorpo }) };

// Alterar senha (contingência administrativa): só a NOVA SENHA PROVISÓRIA; a confirmação é da tela e a política é do serviço.
const redefinirSenha = { params: paramsComId, body: z.strictObject({ senhaProvisoria: senhaEntrada }) };

// Alterar usuário (Gestão de Usuários): só o que o fluxo normal pode mudar. NÃO existe `cpf` aqui (imutável: strictObject
// recusa), nem senha (ação própria). `horarioTrabalho: null` limpa, `ipsPermitidos: []` limpa (substitui a lista),
// `grupoAcessoId: null` retira o grupo. O e-mail é o login real da identidade.
const CAMPOS_ALTERAVEIS = ['nome', 'email', 'tipoConta', 'matricula', 'setor', 'horarioTrabalho', 'ipsPermitidos', 'grupoAcessoId'];
const alterar = {
  params: paramsComId,
  body: z.strictObject({
    nome: nome.optional(),
    email: email.optional(),
    tipoConta: perfil.optional(),
    matricula: textoCurto(MATRICULA_MAXIMO, 'MATRICULA_INVALIDA', 'Matrícula inválida').optional(),
    setor: textoCurto(SETOR_MAXIMO, 'SETOR_INVALIDO', 'Setor inválido').optional(),
    horarioTrabalho: z.strictObject({ inicio: hora, fim: hora }).nullable().optional(),
    ipsPermitidos: z.array(ipPermitido).max(IPS_MAXIMO).optional(),
    grupoAcessoId: idCorpo.nullable().optional(),
  }).refine((corpo) => CAMPOS_ALTERAVEIS.some((c) => corpo[c] !== undefined), {
    message: 'Informe ao menos um campo para alterar',
    params: { codigo: 'ALTERACAO_VAZIA' },
  }),
};

module.exports = {
  listar, buscar, criar, alterar, redefinirSenha, permissoesRecurso, permissoesAcao, acessoToggle, permissoesCopiar, inativar, reativar, PERFIS, SITUACOES, ORDENS, IPS_MAXIMO, MATRICULA_MAXIMO, SETOR_MAXIMO,
};
