'use strict';

const { z } = require('zod');
const {
  LIMITES, inteiroQuery, idParametro, idCorpo, textoCurto, paginacaoQuery,
} = require('./campos.schema');
const { confirmacao, chaveIdempotencia } = require('./entrega-epi.schema');
const itemRepo = require('../repositories/solicitacao-epi-item.repository');
const solicitacaoRepo = require('../repositories/solicitacao-epi.repository');
const { LIMITE_ITENS } = require('../services/solicitacao-epi.service');
const { LIMITE_ITENS: LIMITE_ITENS_ENTREGA } = require('../services/entrega-solicitacao.service');

/**
 * Solicitação de EPI pela camada HTTP: consultas (12F-1) e escrita (12F-2).
 * Query, params e corpo estritos: empresa, solicitante, decisor, encerrador e
 * responsável vêm exclusivamente da sessão, e o que o servidor deriva (GHE,
 * previsão no GHE, status, instantes, hashes) nunca vem do cliente; qualquer
 * chave fora das declaradas é recusada. Só formato: o serviço revalida tudo.
 * Listas e limites vêm dos repositórios e dos serviços, sem segunda versão. O
 * filtro de trabalhador usa o nome do contrato existente, `funcionarioId`.
 */

// Os mesmos status do banco (065 e 068) e do repositório das listas.
const STATUS = Object.freeze(['PENDENTE', 'APROVADA', 'APROVADA_PARCIAL', 'REPROVADA', 'CANCELADA', 'ENTREGUE', 'ENCERRADA']);
const { MOTIVOS, DECISOES } = itemRepo;
const CARACTERE_CONTROLE = /\p{Cc}/u;

function issue(ctx, codigo, message) {
  ctx.addIssue({ code: 'custom', message, params: { codigo } });
  return z.NEVER;
}

const quantidade = z.number().int().positive().max(LIMITES.INTEGER_MAXIMO);
const justificativaDoItem = textoCurto(itemRepo.JUSTIFICATIVA_MAXIMA, 'JUSTIFICATIVA_INVALIDA', 'Justificativa inválida');
const justificativaDaSolicitacao = textoCurto(solicitacaoRepo.JUSTIFICATIVA_MAXIMA, 'JUSTIFICATIVA_INVALIDA', 'Justificativa inválida');
const porId = z.strictObject({ id: idParametro });

const minhas = {
  query: z.strictObject({
    status: z.enum(STATUS).optional(),
    ...paginacaoQuery,
  }),
};

const fila = { query: z.strictObject({ ...paginacaoQuery }) };

const entregaveis = {
  query: z.strictObject({
    funcionarioId: inteiroQuery(1, LIMITES.ID_MAXIMO).optional(),
    ...paginacaoQuery,
  }),
};

const detalhe = {
  params: porId,
  query: z.strictObject({}),
};

// ── Escrita (12F-2) ─────────────────────────────────────────────────

// Fora do GHE o solicitante não justifica: a justificativa técnica é da SST, na aprovação.
const itemDaSolicitacao = z.strictObject({
  materialId: idCorpo,
  tamanho: textoCurto(itemRepo.TAMANHO_MAXIMO, 'TAMANHO_INVALIDO', 'Tamanho inválido').nullable().optional(),
  quantidade,
  motivo: z.enum(MOTIVOS),
  justificativa: justificativaDoItem.nullable().optional(),
}).superRefine((i, ctx) => {
  if (i.motivo === 'OUTRO' && !i.justificativa) {
    ctx.addIssue({ code: 'custom', path: ['justificativa'], message: 'Justificativa obrigatória para o motivo OUTRO', params: { codigo: 'JUSTIFICATIVA_OBRIGATORIA' } });
  }
});

const criar = {
  body: z.strictObject({
    funcionarioId: idCorpo,
    itens: z.array(itemDaSolicitacao).min(1).max(LIMITE_ITENS),
    observacao: textoCurto(solicitacaoRepo.OBSERVACAO_MAXIMA, 'OBSERVACAO_INVALIDA', 'Observação inválida').nullable().optional(),
    chaveIdempotencia,
  }),
};

const cancelar = {
  params: porId,
  body: z.strictObject({ justificativa: justificativaDaSolicitacao.nullable().optional() }),
};

const decisaoDoItem = z.strictObject({
  itemId: idCorpo,
  decisao: z.enum(DECISOES),
  quantidadeAprovada: z.number().int().min(0).max(LIMITES.INTEGER_MAXIMO).nullable().optional(),
  justificativa: justificativaDoItem.nullable().optional(),
});

const decidir = {
  params: porId,
  body: z.strictObject({ decisoes: z.array(decisaoDoItem).min(1).max(LIMITE_ITENS) }),
};

// Só espaço em branco (inclusive o de Unicode) não é justificativa: o mesmo código do serviço.
const justificativaDoEncerramento = z.string().transform((valor, ctx) => {
  const texto = valor.trim().normalize('NFC');
  if (texto === '') return issue(ctx, 'JUSTIFICATIVA_OBRIGATORIA', 'Justificativa obrigatória');
  if (Array.from(texto).length > solicitacaoRepo.JUSTIFICATIVA_MAXIMA || CARACTERE_CONTROLE.test(texto)) {
    return issue(ctx, 'JUSTIFICATIVA_INVALIDA', 'Justificativa inválida');
  }
  return texto;
});

const encerrar = {
  params: porId,
  body: z.strictObject({ justificativa: justificativaDoEncerramento }),
};

// O item da entrega aponta o item da solicitação, o lote e a quantidade; o resto vem da solicitação.
const itemDaEntrega = z.strictObject({ solicitacaoItemId: idCorpo, loteId: idCorpo, quantidade });

const entregar = {
  params: porId,
  body: z.strictObject({
    itens: z.array(itemDaEntrega).min(1).max(LIMITE_ITENS_ENTREGA),
    confirmacao,
    chaveIdempotencia,
  }).superRefine((corpo, ctx) => {
    if (new Set(corpo.itens.map((i) => i.loteId)).size !== corpo.itens.length) {
      ctx.addIssue({ code: 'custom', path: ['itens'], message: 'Cada lote aparece uma vez só na entrega', params: { codigo: 'LOTE_REPETIDO' } });
    }
  }),
};

module.exports = {
  minhas, fila, entregaveis, detalhe, criar, cancelar, decidir, encerrar, entregar, STATUS, MOTIVOS, DECISOES,
};
