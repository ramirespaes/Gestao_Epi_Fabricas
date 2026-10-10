'use strict';

const { z } = require('zod');
const { textoCurto, dataCalendario, paginacaoQuery } = require('./campos.schema');
const repo = require('../repositories/relatorio-auditoria.repository');

const BUSCA = 100;
const texto = () => textoCurto(BUSCA, 'BUSCA_INVALIDA', 'Termo de busca inválido').optional();
const direcao = z.enum(['asc', 'desc']).optional();
const ordemDe = (lista) => z.enum(lista).optional();

const periodoInvertido = (q, ctx) => {
  if (q.de && q.ate && q.de > q.ate) {
    ctx.addIssue({ code: 'custom', path: ['ate'], message: 'A data final precisa ser igual ou posterior à inicial', params: { codigo: 'PERIODO_INVERTIDO' } });
  }
};

const indicadores = { query: z.strictObject({}) };

// Não existe "Atrasado": não há prazo (SLA) oficial decidido.
const solicitacoesNaoAtendidas = {
  query: z.strictObject({
    funcionario: texto(),
    item: texto(),
    status: z.enum(['AGUARDANDO_ENTREGA', 'PARCIALMENTE_ATENDIDA']).optional(),
    ordem: ordemDe(repo.ORDEM_SOLICITACOES),
    direcao,
    ...paginacaoQuery,
  }),
};

// Itens reprovados pela SST (um por linha de item). Período = dia da decisão. Setor fica de fora: a solicitação não guarda
// o setor do trabalhador no momento (só o cadastro atual, que não pode reconstruir o histórico).
const solicitacoesReprovadas = {
  query: z.strictObject({
    funcionario: texto(),
    item: texto(),
    de: dataCalendario('DATA_INVALIDA', 'Data inicial inválida').optional(),
    ate: dataCalendario('DATA_INVALIDA', 'Data final inválida').optional(),
    ordem: ordemDe(repo.ORDEM_REPROVADOS),
    direcao,
    ...paginacaoQuery,
  }).superRefine(periodoInvertido),
};

// Lotes com CA vencido e saldo (modal do card). Só paginação.
const caVencidos = { query: z.strictObject({ ...paginacaoQuery }) };

const log = {
  query: z.strictObject({
    de: dataCalendario('DATA_INVALIDA', 'Data inicial inválida').optional(),
    ate: dataCalendario('DATA_INVALIDA', 'Data final inválida').optional(),
    usuario: texto(),
    acao: texto(),
    busca: texto(),
    ordem: ordemDe(repo.ORDEM_LOG),
    direcao,
    ...paginacaoQuery,
  }).superRefine(periodoInvertido),
};

module.exports = { indicadores, solicitacoesNaoAtendidas, solicitacoesReprovadas, caVencidos, log };
