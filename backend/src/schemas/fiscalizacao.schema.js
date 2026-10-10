'use strict';

const { z } = require('zod');
const { textoCurto, dataCalendario, idParametro, paginacaoQuery } = require('./campos.schema');
const { ESCOPOS } = require('../repositories/fiscalizacao-modulos.repository');

/**
 * Relatório — Fiscalização (12K-D6): entrada estrita. A empresa, o usuário, o status, os hashes, o caminho e a versão do formato
 * nunca vêm do cliente. O período (inversão e limite de 366 dias) e a regra "Outra exige observação" também são conferidos no
 * serviço, que é a autoridade; aqui só o formato.
 */

const FINALIDADES = Object.freeze(['FISCALIZACAO_TRABALHO', 'AUDITORIA_CLIENTE', 'AUDITORIA_INTERNA', 'SOLICITACAO_JURIDICA_DOCUMENTAL', 'OUTRA']);
const OBSERVACAO_MAXIMO = 500;

const camposDoPedido = {
  periodoInicio: dataCalendario('DATA_INVALIDA', 'Data inicial inválida'),
  periodoFim: dataCalendario('DATA_INVALIDA', 'Data final inválida'),
  finalidade: z.enum(FINALIDADES),
  observacao: textoCurto(OBSERVACAO_MAXIMO, 'OBSERVACAO_INVALIDA', 'Observação inválida').optional(),
  escopos: z.array(z.enum(ESCOPOS)).min(1).max(ESCOPOS.length),
};

const regrasDoPedido = (corpo, ctx) => {
  if (new Set(corpo.escopos).size !== corpo.escopos.length) {
    ctx.addIssue({ code: 'custom', path: ['escopos'], message: 'Módulo repetido', params: { codigo: 'ESCOPO_REPETIDO' } });
  }
  if (corpo.finalidade === 'OUTRA' && corpo.observacao === undefined) {
    ctx.addIssue({ code: 'custom', path: ['observacao'], message: 'Observação obrigatória para a finalidade Outra', params: { codigo: 'OBSERVACAO_OBRIGATORIA' } });
  }
};

const previa = { body: z.strictObject(camposDoPedido).superRefine(regrasDoPedido) };

const gerar = {
  body: z.strictObject({
    ...camposDoPedido,
    chaveIdempotencia: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
  }).superRefine(regrasDoPedido),
};

const listar = { query: z.strictObject({ ...paginacaoQuery }) };
const porId = { params: z.strictObject({ id: idParametro }) };

module.exports = { FINALIDADES, previa, gerar, listar, porId };
