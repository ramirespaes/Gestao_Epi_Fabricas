'use strict';

const { z } = require('zod');
const {
  idParametro, textoCurto, dataCalendario, inteiroQuery, LIMITES,
} = require('./campos.schema');

/**
 * Schemas das rotas de estoque por lote (Bloco 9). Só estrutura e formato —
 * existência do material e do lote, e o saldo suficiente para a baixa, são
 * do serviço.
 *
 * Campos que aceitam null usam `.nullable()`, não `z.union([campo, z.null()])`:
 * o union explícito faz o Zod 4 reportar `invalid_union` quando o conteúdo
 * da string é inválido (mensagem/código genéricos em vez do código
 * específico do campo) — mesma correção aplicada em material.schema.js.
 */

// estoque_lotes.tamanho VARCHAR(20) (migration 042).
const TAMANHO_MAXIMO = 20;

const tamanho = textoCurto(TAMANHO_MAXIMO, 'TAMANHO_INVALIDO', 'Tamanho inválido');

// Quantidades são INTEGER (int4): sem este teto, uma quantidade maior
// chegaria ao PostgreSQL e estouraria como erro não tratado (500).
const quantidade = z.number().int().positive().max(LIMITES.INTEGER_MAXIMO);

const paramsComId = z.strictObject({ id: idParametro });

const lotes = { params: paramsComId };

// Limites de estoque_lotes e estoque_operacoes (migration 042).
const CA_NUMERO_MAXIMO = 20;
const JUSTIFICATIVA_MAXIMA = 500;
const MOTIVOS_BAIXA = Object.freeze(['CA_VENCIDO', 'AVARIA', 'DESCARTE', 'PERDA', 'AJUSTE_INVENTARIO', 'DEVOLUCAO_FORNECEDOR', 'OUTRO']);

const caNumero = textoCurto(CA_NUMERO_MAXIMO, 'CA_NUMERO_INVALIDO', 'Número do CA inválido');
const caValidade = dataCalendario('CA_VALIDADE_INVALIDA', 'Data de validade do CA inválida');
const justificativa = textoCurto(JUSTIFICATIVA_MAXIMA, 'JUSTIFICATIVA_INVALIDA', 'Justificativa inválida');
// O PostgreSQL compara UUID sem caixa; eu guardo uma forma só, para a trava da chave também ser uma só.
const chaveIdempotencia = z.uuid().transform((valor) => valor.toLowerCase());

// Toda entrada nova traz CA e validade. Não há campo para dispensar o CA.
// O tamanho pode faltar aqui: quem decide se ele é exigido é o material.
const entrada = {
  params: paramsComId,
  body: z.strictObject({
    tamanho: tamanho.nullable().optional(),
    quantidade,
    caNumero,
    caValidade,
    chaveIdempotencia,
  }),
};

const baixa = {
  params: z.strictObject({ loteId: idParametro }),
  body: z.strictObject({
    quantidade,
    motivo: z.enum(MOTIVOS_BAIXA),
    justificativa: justificativa.nullable().optional(),
    chaveIdempotencia,
  }).superRefine((corpo, ctx) => {
    if (corpo.motivo === 'OUTRO' && !corpo.justificativa) {
      ctx.addIssue({
        code: 'custom', path: ['justificativa'], message: 'Justificativa obrigatória para o motivo OUTRO', params: { codigo: 'JUSTIFICATIVA_OBRIGATORIA' },
      });
    }
  }),
};

// E7 — validade de estoque. Situações do CA por lote, mais o grupo que o
// Dashboard chama de "a vencer" (vence hoje ou a vencer). Fora da lista: 400.
const SITUACOES_VALIDADE = Object.freeze(['VENCIDO', 'VENCE_HOJE', 'A_VENCER', 'VENCIMENTO_PROXIMO', 'VALIDO', 'SEM_CA', 'NAO_EXIGE_CA']);
const BUSCA_VALIDADE_MAXIMA = 100;
const LIMITE_VALIDADE_PADRAO = 50;

const validade = {
  query: z.strictObject({
    situacao: z.enum(SITUACOES_VALIDADE).optional(),
    busca: textoCurto(BUSCA_VALIDADE_MAXIMA, 'BUSCA_INVALIDA', 'Termo de busca inválido').optional(),
    pagina: inteiroQuery(1, LIMITES.PAGINA_MAXIMA).default(1),
    limite: inteiroQuery(1, LIMITES.LIMITE_MAXIMO).default(LIMITE_VALIDADE_PADRAO),
  }),
};

// E8 — operações de estoque: histórico só de leitura. O período é em dias de
// São Paulo e a ordem é fixa no servidor; nenhum outro parâmetro é aceito.
const TIPOS_OPERACAO = Object.freeze(['SALDO_INICIAL', 'ENTRADA', 'BAIXA']);
const BUSCA_OPERACOES_MAXIMA = 100;
const LIMITE_OPERACOES_PADRAO = 50;

const operacoes = {
  query: z.strictObject({
    tipo: z.enum(TIPOS_OPERACAO).optional(),
    de: dataCalendario('DATA_INVALIDA', 'Data inicial inválida').optional(),
    ate: dataCalendario('DATA_INVALIDA', 'Data final inválida').optional(),
    busca: textoCurto(BUSCA_OPERACOES_MAXIMA, 'BUSCA_INVALIDA', 'Termo de busca inválido').optional(),
    pagina: inteiroQuery(1, LIMITES.PAGINA_MAXIMA).default(1),
    limite: inteiroQuery(1, LIMITES.LIMITE_MAXIMO).default(LIMITE_OPERACOES_PADRAO),
  }).superRefine((q, ctx) => {
    if (q.de && q.ate && q.de > q.ate) {
      ctx.addIssue({
        code: 'custom', path: ['ate'], message: 'A data final precisa ser igual ou posterior à inicial', params: { codigo: 'PERIODO_INVERTIDO' },
      });
    }
  }),
};

module.exports = {
  lotes, entrada, baixa, validade, operacoes, MOTIVOS_BAIXA, SITUACOES_VALIDADE, LIMITE_VALIDADE_PADRAO,
  TIPOS_OPERACAO, LIMITE_OPERACOES_PADRAO, TAMANHO_MAXIMO, CA_NUMERO_MAXIMO, JUSTIFICATIVA_MAXIMA,
};
