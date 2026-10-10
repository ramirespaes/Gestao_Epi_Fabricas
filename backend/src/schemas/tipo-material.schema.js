'use strict';

const { z } = require('zod');
const { idParametro, booleanoQuery, paginacaoQuery, textoCurto } = require('./campos.schema');
const classificacao = require('../utils/classificacao-material');

/**
 * Schemas das rotas do catálogo de tipos (classificação V2). Só formato: o serviço revalida grupo, proteção e nome
 * (fonte única em utils/classificacao-material.js). strictObject: empresa, ator, `ativo` e `origem` nunca vêm do cliente.
 */

const NOME_MAXIMO = 100;
const BUSCA_MAXIMA = 100;

function issue(ctx, codigo, message) {
  ctx.addIssue({ code: 'custom', message, params: { codigo } });
  return z.NEVER;
}

const grupo = z.string().transform((v, ctx) => (classificacao.GRUPOS_CATALOGO.includes(v) ? v : issue(ctx, 'GRUPO_INVALIDO', 'Grupo inválido')));
const grupoProtecao = z.string().transform((v, ctx) => (classificacao.GRUPOS_PROTECAO.includes(v) ? v : issue(ctx, 'GRUPO_PROTECAO_INVALIDO', 'Grupo de proteção inválido')));
// Quebras de linha e espaços repetidos são normalizados (não recusados); o serviço confere controle, tamanho e "Outros".
const nome = z.string().max(NOME_MAXIMO * 4).transform((v, ctx) => {
  const n = classificacao.normalizarNomeTipo(v);
  return n.length > 0 && Array.from(n).length <= NOME_MAXIMO ? n : issue(ctx, 'NOME_INVALIDO', 'Nome do tipo inválido');
});

const listar = {
  query: z.strictObject({
    ...paginacaoQuery,
    grupo: grupo.optional(),
    grupoProtecao: grupoProtecao.optional(),
    ativo: booleanoQuery.optional(),
    busca: textoCurto(BUSCA_MAXIMA, 'BUSCA_INVALIDA', 'Termo de busca inválido').optional(),
  }),
};

const criar = { body: z.strictObject({ grupo, grupoProtecao, nome }) };

const estado = { params: z.strictObject({ id: idParametro }), body: z.strictObject({}) };

module.exports = { listar, criar, inativar: estado, reativar: estado };
