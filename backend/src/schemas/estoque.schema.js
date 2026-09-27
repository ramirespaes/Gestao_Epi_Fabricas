'use strict';

const { z } = require('zod');
const {
  idParametro, textoCurto, dataCalendario, LIMITES,
} = require('./campos.schema');

/**
 * Schemas das rotas de estoque por tamanho (Bloco 9, Etapa A). Só
 * estrutura e formato — existência do material, do saldo, e a validação
 * de quantidade suficiente para saída são do serviço.
 *
 * `motivo` usa `.nullable()`, não `z.union([motivo, z.null()])`: o union
 * explícito faz o Zod 4 reportar `invalid_union` quando o conteúdo da
 * string é inválido (mensagem/código genéricos em vez do código específico
 * do campo) — mesma correção pós-auditoria aplicada em material.schema.js.
 */

// estoque_tamanhos.tamanho VARCHAR(20) — mesmo teto da migration 008.
const TAMANHO_MAXIMO = 20;
const MOTIVO_MAXIMO = 200;

const tamanho = textoCurto(TAMANHO_MAXIMO, 'TAMANHO_INVALIDO', 'Tamanho inválido');
const motivo = textoCurto(MOTIVO_MAXIMO, 'MOTIVO_INVALIDO', 'Motivo inválido');

// estoque_tamanhos.quantidade é INTEGER (int4, migration 008): sem este
// teto, uma quantidade maior chegaria ao PostgreSQL e estouraria como erro
// não tratado (500) — correção pós-auditoria de 23/09/2026.
const quantidade = z.number().int().positive().max(LIMITES.INTEGER_MAXIMO);

const paramsComId = z.strictObject({ id: idParametro });

const consultar = { params: paramsComId };

const movimentar = {
  params: paramsComId,
  body: z.strictObject({
    tamanho,
    tipo: z.enum(['ENTRADA', 'SAIDA']),
    quantidade,
    motivo: motivo.nullable().optional(),
  }),
};

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

module.exports = {
  consultar, movimentar, entrada, baixa, MOTIVOS_BAIXA, TAMANHO_MAXIMO, CA_NUMERO_MAXIMO, JUSTIFICATIVA_MAXIMA,
};
