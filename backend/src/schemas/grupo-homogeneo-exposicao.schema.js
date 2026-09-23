'use strict';

const { z } = require('zod');
const {
  idParametro, booleanoQuery, paginacaoQuery, textoCurto,
} = require('./campos.schema');

/**
 * Schemas das rotas de GHE (Bloco 9, Etapa B). Só formato; existência,
 * unicidade de nome e vínculos são do serviço. `strictObject` em todo
 * corpo; `ativo` nunca em corpo (inativar/reativar têm rotas próprias).
 * Opcionais com `.nullable()` (não `z.union`, ver correção da Etapa A).
 */

const NOME_MAXIMO = 150;
const SETOR_MAXIMO = 100;
const FUNCAO_MAXIMO = 100;
// descricao/riscos são TEXT no banco; teto de entrada da API.
const TEXTO_LONGO_MAXIMO = 2000;
const BUSCA_MAXIMA = 100;

const nome = textoCurto(NOME_MAXIMO, 'NOME_INVALIDO', 'Nome do GHE inválido');
const descricao = textoCurto(TEXTO_LONGO_MAXIMO, 'DESCRICAO_INVALIDA', 'Descrição inválida');
const setor = textoCurto(SETOR_MAXIMO, 'SETOR_INVALIDO', 'Setor inválido');
const funcao = textoCurto(FUNCAO_MAXIMO, 'FUNCAO_INVALIDA', 'Função inválida');
const riscos = textoCurto(TEXTO_LONGO_MAXIMO, 'RISCOS_INVALIDOS', 'Riscos inválidos');
const busca = textoCurto(BUSCA_MAXIMA, 'BUSCA_INVALIDA', 'Termo de busca inválido');

const paramsComId = z.strictObject({ id: idParametro });

const criar = {
  body: z.strictObject({
    nome,
    descricao: descricao.nullable().optional(),
    setor: setor.nullable().optional(),
    funcao: funcao.nullable().optional(),
    riscos: riscos.nullable().optional(),
  }),
};

const listar = {
  query: z.strictObject({ ...paginacaoQuery, ativo: booleanoQuery.optional(), busca: busca.optional() }),
};

const buscar = { params: paramsComId };

const alterar = {
  params: paramsComId,
  body: z.strictObject({
    nome: nome.optional(),
    descricao: descricao.nullable().optional(),
    setor: setor.nullable().optional(),
    funcao: funcao.nullable().optional(),
    riscos: riscos.nullable().optional(),
  }),
};

const semCorpo = z.strictObject({});
const inativar = { params: paramsComId, body: semCorpo };
const reativar = { params: paramsComId, body: semCorpo };

module.exports = { criar, listar, buscar, alterar, inativar, reativar };
