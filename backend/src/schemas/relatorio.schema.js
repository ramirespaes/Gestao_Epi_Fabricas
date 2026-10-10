'use strict';

const { z } = require('zod');
const { textoCurto, dataCalendario, paginacaoQuery } = require('./campos.schema');
const estoqueRepo = require('../repositories/relatorio-estoque.repository');
const entregasRepo = require('../repositories/relatorio-entregas.repository');

const BUSCA = 100;
const texto = () => textoCurto(BUSCA, 'BUSCA_INVALIDA', 'Termo de busca inválido').optional();
const direcao = z.enum(['asc', 'desc']).optional();
const ordemDe = (lista) => z.enum(lista).optional();

const periodo = (q, ctx) => {
  if (q.de && q.ate && q.de > q.ate) {
    ctx.addIssue({ code: 'custom', path: ['ate'], message: 'A data final precisa ser igual ou posterior à inicial', params: { codigo: 'PERIODO_INVERTIDO' } });
  }
};

const estoque = {
  query: z.strictObject({
    busca: texto(),
    status: z.enum(['SEM_ESTOQUE', 'EM_ALERTA', 'DISPONIVEL']).optional(),
    ordem: ordemDe(estoqueRepo.ORDENS),
    direcao,
    ...paginacaoQuery,
  }),
};

const base = {
  funcionario: texto(), setor: texto(), item: texto(), direcao, ...paginacaoQuery,
};

const proximoVencimento = {
  query: z.strictObject({ ...base, faixa: z.enum(['0-10', '11-20', '21-30']).optional(), ordem: ordemDe(entregasRepo.ORDENS) }),
};

const vencidos = {
  query: z.strictObject({ ...base, ordem: ordemDe(entregasRepo.ORDENS) }),
};

const entregues = {
  query: z.strictObject({
    ...base,
    de: dataCalendario('DATA_INVALIDA', 'Data inicial inválida').optional(),
    ate: dataCalendario('DATA_INVALIDA', 'Data final inválida').optional(),
    ordem: ordemDe(entregasRepo.ORDENS),
  }).superRefine(periodo),
};

module.exports = { estoque, proximoVencimento, vencidos, entregues };
