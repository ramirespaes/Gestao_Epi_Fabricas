'use strict';

const auditoriaRepo = require('../repositories/auditoria.repository');
const { parOrdenados } = require('../utils/lock-par-estoque');
const { OPERACOES, JANELA_SUPRESSAO_SEGUNDOS, chaveDoEvento, lockDaSupressao } = require('../utils/supressao-auditoria');
const { chaveDoPar, ehMotivoDiscricionario, ehRecusaPorSaldoLivre } = require('./saldo-livre');

/**
 * Auditoria secundária da recusa por SALDO_LIVRE_INSUFICIENTE. Só roda DEPOIS
 * do ROLLBACK da operação principal, em transação própria, uma por par, na
 * ordem canônica dos pares. Cada par é serializado por advisory lock de
 * namespace próprio (nunca o do par de estoque) e só é registrado se o mesmo
 * ator não tiver registro igual dentro da janela; sem a trava, duas recusas
 * simultâneas veriam "nada recente" e gravariam as duas.
 *
 * Só ids, quantidades e valores estruturados vão para o registro: nunca
 * confirmação, assinatura, justificativa, observação, dispositivo ou corpo. A
 * falha desta auditoria nunca vira sucesso nem troca o erro do domínio: vai
 * para o registro técnico, sem mensagem original nem payload.
 */

const ACAO = 'SALDO_LIVRE_INSUFICIENTE';
const ETIQUETA_FALHA = '[auditoria-recusa]';
const EVENTO_FALHA = 'auditoria_recusa_saldo_livre_falhou';

const registrarFalhaPadrao = (etiqueta, campos) => { console.error(etiqueta, campos); };

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) throw new TypeError(`identificador de ${nome} inválido`);
}

function motivoDaFalha(erro) {
  if (typeof erro?.code === 'string' && erro.code.length > 0) return erro.code;
  return typeof erro?.name === 'string' && erro.name.length > 0 ? erro.name : 'Error';
}

function contextoDoPar({ operacao, loteId, motivo }, recusa) {
  const contexto = { operacao, materialId: recusa.materialId, tamanho: recusa.tamanho };
  if (operacao === 'BAIXA') {
    contexto.loteId = loteId;
    contexto.motivo = motivo;
  }
  contexto.quantidadeSolicitada = recusa.quantidadeSolicitada;
  contexto.fisicoUtilizavel = recusa.fisicoUtilizavel;
  contexto.demandaPendente = recusa.demandaPendente;
  contexto.comprometido = recusa.comprometido;
  contexto.saldoLivre = recusa.saldoLivre;
  return contexto;
}

async function registrarDoPar(pool, {
  empresaId, atorId, ip, janelaSegundos, evento, contexto,
}) {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    await cliente.query('SELECT pg_advisory_xact_lock($1::bigint)', [lockDaSupressao(empresaId, atorId, evento)]);
    const jaRegistrada = await auditoriaRepo.existeRecente(cliente, {
      empresaId, usuarioId: atorId, acao: ACAO, referencia: evento, janelaSegundos,
    });
    if (!jaRegistrada) {
      await auditoriaRepo.registrar(cliente, {
        empresaId, usuarioId: atorId, acao: ACAO, referencia: evento, ip: ip ?? null, contexto,
      });
    }
    await cliente.query('COMMIT');
  } catch (erro) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw erro;
  } finally {
    cliente.release();
  }
}

/**
 * @param {{connect: Function}} pool
 * @param {{empresaId: number, atorId: number, ip?: string|null, recusa: {operacao: string, recusas: object[], loteId?: number|null, motivo?: string|null}}} dados
 * @param {{janelaSegundos?: number, registrarFalha?: Function}} [opcoes] só para testes
 * @returns {Promise<void>} nunca lança por falha de infraestrutura; só por entrada inválida
 */
async function registrarRecusaPorSaldoLivre(pool, {
  empresaId, atorId, ip = null, recusa,
}, { janelaSegundos = JANELA_SUPRESSAO_SEGUNDOS, registrarFalha = registrarFalhaPadrao } = {}) {
  exigirId(empresaId, 'empresa');
  exigirId(atorId, 'ator');
  const { operacao, recusas, loteId = null, motivo = null } = recusa;
  if (!OPERACOES.includes(operacao)) throw new TypeError('operação inválida');
  if (operacao === 'BAIXA') {
    exigirId(loteId, 'lote');
    if (!ehMotivoDiscricionario(motivo)) throw new TypeError('motivo de baixa inválido');
  }

  const porPar = new Map();
  for (const item of recusas) {
    chaveDoEvento(operacao, item.materialId, item.tamanho);
    porPar.set(chaveDoPar(item.materialId, item.tamanho), item);
  }
  const ordenados = parOrdenados([...porPar.values()].map(({ materialId, tamanho }) => ({ materialId, tamanho })));

  for (const par of ordenados) {
    const item = porPar.get(chaveDoPar(par.materialId, par.tamanho));
    try {
      await registrarDoPar(pool, {
        empresaId,
        atorId,
        ip,
        janelaSegundos,
        evento: chaveDoEvento(operacao, par.materialId, par.tamanho),
        contexto: contextoDoPar({ operacao, loteId, motivo }, item),
      });
    } catch (erro) {
      registrarFalha(ETIQUETA_FALHA, { evento: EVENTO_FALHA, operacao, motivo: motivoDaFalha(erro) });
    }
  }
}

/**
 * Chamada pelos serviços depois do ROLLBACK, com o erro que a operação lançou:
 * se for a recusa por saldo livre, audita; qualquer outro erro passa sem efeito.
 * Falha de qualquer natureza aqui nunca substitui o erro do domínio.
 */
async function auditarRecusaDoErro(pool, { empresaId, atorId, ip }, erro) {
  if (!ehRecusaPorSaldoLivre(erro)) return;
  try {
    await module.exports.registrarRecusaPorSaldoLivre(pool, {
      empresaId, atorId, ip, recusa: erro.recusa,
    });
  } catch (falha) {
    registrarFalhaPadrao(ETIQUETA_FALHA, { evento: EVENTO_FALHA, operacao: erro.recusa.operacao, motivo: motivoDaFalha(falha) });
  }
}

module.exports = { registrarRecusaPorSaldoLivre, auditarRecusaDoErro };
