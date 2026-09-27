'use strict';

const { z } = require('zod');
const { LIMITES, idParametro, inteiroQuery, textoCurto } = require('./campos.schema');

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

const alterar = {
  params: paramsComId,
  body: z.strictObject({ nome: nome.optional(), tipoConta: perfil.optional() })
    .refine((corpo) => corpo.nome !== undefined || corpo.tipoConta !== undefined, {
      message: 'Informe o nome ou o tipo de conta',
      params: { codigo: 'ALTERACAO_VAZIA' },
    }),
};

const semCorpo = z.strictObject({});
const inativar = { params: paramsComId, body: semCorpo };
const reativar = { params: paramsComId, body: semCorpo };

module.exports = {
  listar, buscar, alterar, inativar, reativar, PERFIS, SITUACOES, ORDENS,
};
