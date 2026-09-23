'use strict';

const { z } = require('zod');
const {
  idParametro, booleanoQuery, paginacaoQuery, textoCurto, dataCalendario, LIMITES,
} = require('./campos.schema');

/**
 * Schemas das rotas de materiais (Bloco 9, Etapa A). Só estrutura e
 * formato, sem contexto: não consultam banco, não conhecem empresa nem
 * autorização, e não decidem nada de negócio — existência do material e
 * validação de domínio (ex.: prazo de uso positivo) são do serviço.
 *
 * `strictObject` em todo corpo rejeita qualquer campo não declarado com
 * 400 antes do controller — é assim que `id`, `empresaId`, `ativo` e
 * `criadoEm` ficam fora do alcance da API. `ativo` não é aceito em corpo
 * nenhum: inativar e reativar têm rotas próprias, mesmo padrão de
 * grupo-acesso.schema.js.
 *
 * Campos opcionais (`tipo`, `fabricante`, `caNumero`, `caValidade`,
 * `prazoUsoDias`) aceitam `null` explícito, que o serviço interpreta como
 * "limpar o campo"; ausente significa "não mexer" em alterar() — mesmo
 * contrato de `descricao` em grupo-acesso.schema.js.
 */

// materiais.nome VARCHAR(150), tipo/fabricante VARCHAR(100), ca_numero VARCHAR(20),
// unidade VARCHAR(20) — mesmos tetos da migration 007.
const NOME_MAXIMO = 150;
const TIPO_MAXIMO = 100;
const FABRICANTE_MAXIMO = 100;
const CA_NUMERO_MAXIMO = 20;
const UNIDADE_MAXIMA = 20;
const BUSCA_MAXIMA = 100;

const nome = textoCurto(NOME_MAXIMO, 'NOME_INVALIDO', 'Nome do material inválido');
const tipo = textoCurto(TIPO_MAXIMO, 'TIPO_INVALIDO', 'Tipo inválido');
const fabricante = textoCurto(FABRICANTE_MAXIMO, 'FABRICANTE_INVALIDO', 'Fabricante inválido');
const caNumero = textoCurto(CA_NUMERO_MAXIMO, 'CA_NUMERO_INVALIDO', 'Número do CA inválido');
const unidade = textoCurto(UNIDADE_MAXIMA, 'UNIDADE_INVALIDA', 'Unidade inválida');
const busca = textoCurto(BUSCA_MAXIMA, 'BUSCA_INVALIDA', 'Termo de busca inválido');

/**
 * Data no formato ISO (YYYY-MM-DD) com verificação estrita de calendário —
 * mês 1-12, dia dentro do teto real do mês, bissexto pela regra completa,
 * ano mínimo 1 (auditorias v1 e v2 da Etapa A). A regra vive em
 * campos.schema.js (`dataCalendario`) desde a Etapa B, quando
 * `dataNascimento` de funcionário passou a precisar dela; aqui só se fixa o
 * código de erro deste campo, preservado: CA_VALIDADE_INVALIDA.
 */
const caValidade = dataCalendario('CA_VALIDADE_INVALIDA', 'Data de validade do CA inválida');

// prazo_uso_dias e estoque_minimo: number nativo do Zod já produz
// TAMANHO_MINIMO/TIPO_INVALIDO/CAMPO_OBRIGATORIO em validar.js sem
// precisar de transform custom. .max(INTEGER_MAXIMO): as duas colunas são
// INTEGER (int4) no banco (migration 007) — sem este teto, um valor maior
// chegaria ao PostgreSQL e estouraria como erro não tratado (500) em vez
// de um 400 de validação (correção pós-auditoria de 23/09/2026).
const prazoUsoDias = z.number().int().positive().max(LIMITES.INTEGER_MAXIMO);
const estoqueMinimo = z.number().int().nonnegative().max(LIMITES.INTEGER_MAXIMO);

const paramsComId = z.strictObject({ id: idParametro });

const criar = {
  body: z.strictObject({
    nome,
    tipo: tipo.nullable().optional(),
    fabricante: fabricante.nullable().optional(),
    caNumero: caNumero.nullable().optional(),
    caValidade: caValidade.nullable().optional(),
    prazoUsoDias: prazoUsoDias.nullable().optional(),
    unidade: unidade.optional(),
    estoqueMinimo: estoqueMinimo.optional(),
  }),
};

const listar = {
  query: z.strictObject({
    ...paginacaoQuery,
    // Ausente lista ativos E inativos; true/false filtram explicitamente.
    ativo: booleanoQuery.optional(),
    busca: busca.optional(),
  }),
};

const buscar = { params: paramsComId };

const alterar = {
  params: paramsComId,
  body: z.strictObject({
    nome: nome.optional(),
    tipo: tipo.nullable().optional(),
    fabricante: fabricante.nullable().optional(),
    caNumero: caNumero.nullable().optional(),
    caValidade: caValidade.nullable().optional(),
    prazoUsoDias: prazoUsoDias.nullable().optional(),
    unidade: unidade.optional(),
    estoqueMinimo: estoqueMinimo.optional(),
  }),
};

// Sem dado de negócio nenhum: mesma proteção contra fonte de autoridade
// forjada (ativo, empresaId, atorId) já aplicada em criar()/alterar().
const semCorpo = z.strictObject({});

const inativar = { params: paramsComId, body: semCorpo };
const reativar = { params: paramsComId, body: semCorpo };

module.exports = { criar, listar, buscar, alterar, inativar, reativar };
