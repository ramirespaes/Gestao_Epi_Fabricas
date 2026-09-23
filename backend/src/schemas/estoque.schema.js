'use strict';

const { z } = require('zod');
const { idParametro, textoCurto, LIMITES } = require('./campos.schema');

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

module.exports = { consultar, movimentar };
