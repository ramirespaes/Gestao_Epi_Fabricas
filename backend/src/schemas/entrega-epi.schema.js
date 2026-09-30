'use strict';

const { z } = require('zod');
const {
  idParametro, idCorpo, textoCurto, dataCalendario, inteiroQuery, booleanoQuery, paginacaoQuery, cpfComDigitosVerificadores, LIMITES,
} = require('./campos.schema');
const { MOTIVOS, JUSTIFICATIVA_MAXIMA } = require('../repositories/entrega-epi-item.repository');
const { MODOS, DECLARACAO_VERSAO_FORMATO } = require('../repositories/entrega-epi-confirmacao.repository');
const { LIMITE_ITENS, normalizarTracos, declaracaoValida } = require('../services/entrega-epi.service');

/**
 * Schemas das rotas da entrega de EPI (10E) e da ficha (10F). Estritos e só
 * de formato: o serviço transacional revalida tudo (defesa em profundidade).
 * Listas e limites vêm do serviço e dos repositórios, para não existir uma
 * segunda versão. O cliente nunca envia empresa, ator, instantes, snapshots
 * ou hashes: qualquer chave fora das declaradas é recusada.
 */

const BUSCA_MAXIMA = 100;

function issue(ctx, codigo, message) {
  ctx.addIssue({ code: 'custom', message, params: { codigo } });
  return z.NEVER;
}

const quantidade = z.number().int().positive().max(LIMITES.INTEGER_MAXIMO);
const justificativa = textoCurto(JUSTIFICATIVA_MAXIMA, 'JUSTIFICATIVA_INVALIDA', 'Justificativa inválida');
const chaveIdempotencia = z.uuid().transform((valor) => valor.toLowerCase());

const item = z.strictObject({
  materialId: idCorpo,
  loteId: idCorpo,
  quantidade,
  motivo: z.enum(MOTIVOS),
  justificativa: justificativa.nullable().optional(),
  justificativaForaGhe: justificativa.nullable().optional(),
}).superRefine((i, ctx) => {
  if (i.motivo === 'OUTRO' && !i.justificativa) {
    ctx.addIssue({ code: 'custom', path: ['justificativa'], message: 'Justificativa obrigatória para o motivo OUTRO', params: { codigo: 'JUSTIFICATIVA_OBRIGATORIA' } });
  }
});

// A mesma normalização do serviço: qualquer estrutura fora do esperado é um erro só.
const tracos = z.unknown().transform((valor, ctx) => normalizarTracos(valor) ?? issue(ctx, 'TRACOS_INVALIDOS', 'Traços inválidos'));
const declaracaoVersao = z.string().transform((valor, ctx) => (DECLARACAO_VERSAO_FORMATO.test(valor) ? valor : issue(ctx, 'FORMATO_INVALIDO', 'Formato inválido')));
const declaracaoTexto = z.string().transform((valor, ctx) => (declaracaoValida(valor) ? valor : issue(ctx, 'DECLARACAO_INVALIDA', 'Texto da declaração inválido')));

const confirmacao = z.strictObject({
  modo: z.enum(MODOS),
  tracos: tracos.nullable().optional(),
  declaracaoVersao,
  declaracaoTexto,
}).superRefine((c, ctx) => {
  const semTracos = c.tracos === null || c.tracos === undefined;
  if (c.modo === 'DESENHO' && semTracos) {
    ctx.addIssue({ code: 'custom', path: ['tracos'], message: 'A assinatura desenhada precisa dos traços', params: { codigo: 'TRACOS_OBRIGATORIOS' } });
  }
  if (c.modo !== 'DESENHO' && !semTracos) {
    ctx.addIssue({ code: 'custom', path: ['tracos'], message: 'O aceite presencial não tem traços', params: { codigo: 'TRACOS_NAO_SE_APLICAM' } });
  }
});

const registrar = {
  body: z.strictObject({
    funcionarioId: idCorpo,
    itens: z.array(item).min(1).max(LIMITE_ITENS),
    confirmacao,
    chaveIdempotencia,
  }).superRefine((corpo, ctx) => {
    const lotes = new Set(corpo.itens.map((i) => i.loteId));
    if (lotes.size !== corpo.itens.length) {
      ctx.addIssue({ code: 'custom', path: ['itens'], message: 'Cada lote aparece uma vez só na entrega', params: { codigo: 'LOTE_REPETIDO' } });
    }
  }),
};

// ── Contexto para realizar a entrega ────────────────────────────────

const contexto = { params: z.strictObject({ funcionarioId: idParametro }) };

const contextoMateriais = {
  params: contexto.params,
  query: z.strictObject({
    busca: textoCurto(BUSCA_MAXIMA, 'BUSCA_INVALIDA', 'Termo de busca inválido').optional(),
    previstoNoGhe: booleanoQuery.optional(),
    ...paginacaoQuery,
  }),
};

const contextoLotes = { params: z.strictObject({ funcionarioId: idParametro, materialId: idParametro }) };

// ── Ficha e histórico (10F) ─────────────────────────────────────────

const periodo = (q, ctx) => {
  if (q.de && q.ate && q.de > q.ate) {
    ctx.addIssue({ code: 'custom', path: ['ate'], message: 'A data final precisa ser igual ou posterior à inicial', params: { codigo: 'PERIODO_INVERTIDO' } });
  }
};

const fichas = {
  query: z.strictObject({
    busca: textoCurto(BUSCA_MAXIMA, 'BUSCA_INVALIDA', 'Termo de busca inválido').optional(),
    numero: inteiroQuery(1, LIMITES.INTEGER_MAXIMO).optional(),
    funcionarioId: inteiroQuery(1, LIMITES.ID_MAXIMO).optional(),
    materialId: inteiroQuery(1, LIMITES.ID_MAXIMO).optional(),
    ativo: booleanoQuery.optional(),
    de: dataCalendario('DATA_INVALIDA', 'Data inicial inválida').optional(),
    ate: dataCalendario('DATA_INVALIDA', 'Data final inválida').optional(),
    ...paginacaoQuery,
  }).superRefine(periodo),
};

// CPF só no corpo, nunca na URL (mesma regra de funcionário).
const consultaCpf = { body: z.strictObject({ cpf: cpfComDigitosVerificadores }) };

const porId = { params: z.strictObject({ id: idParametro }) };

const fichaEntregas = {
  params: porId.params,
  query: z.strictObject({
    de: dataCalendario('DATA_INVALIDA', 'Data inicial inválida').optional(),
    ate: dataCalendario('DATA_INVALIDA', 'Data final inválida').optional(),
    ...paginacaoQuery,
  }).superRefine(periodo),
};

module.exports = {
  registrar, contexto, contextoMateriais, contextoLotes, fichas, consultaCpf, porId, fichaEntregas, BUSCA_MAXIMA,
};
