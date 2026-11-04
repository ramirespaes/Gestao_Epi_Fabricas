'use strict';

/**
 * Backup permanente da Biblioteca de Imagens (D-ORF-6, P4): ORÇAMENTO DE BYTES de uma execução. Contabilidade pura em memória, sem disco, rede, ambiente ou relógio.
 *
 * Aritmética SEM ESTOURO: o saldo é mantido em BigInt e `reservar(n)` aceita só inteiro seguro >= 0; a comparação é `n > limite - usado` (nunca `usado + n`), então nenhuma soma de Number pode passar de 2^53. Uma reserva que não cabe NÃO consome
 * nada (tudo ou nada). O orçamento é uma contagem do que a execução PRODUZ (bytes aceitos para gravação), conservadora: a reserva acontece ANTES da escrita, então uma escrita que falhe depois não devolve o saldo.
 * O limite é sempre INFORMADO por quem configura (nenhum valor padrão, nenhum limite operacional inventado aqui). Só objetos produzidos por esta fábrica são reconhecidos (`ehOrcamentoDeBytes`).
 */

const orcamentosProduzidos = new WeakSet();
const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function criarOrcamentoDeBytes(opcoes) {
  if (!ehObjeto(opcoes) || Reflect.ownKeys(opcoes).length !== 1 || !Object.hasOwn(opcoes, 'totalBytes') || !Number.isSafeInteger(opcoes.totalBytes) || opcoes.totalBytes <= 0) {
    throw Object.assign(new TypeError('orçamento de bytes inválido'), { code: 'CONFIGURACAO_INVALIDA' });
  }
  const limite = BigInt(opcoes.totalBytes);
  let usado = 0n;
  const orcamento = Object.freeze({
    totalBytes: opcoes.totalBytes,
    /** Reserva `n` bytes (tudo ou nada). */
    reservar(n) {
      if (!Number.isSafeInteger(n) || n < 0) return Object.freeze({ ok: false, motivo: 'QUANTIDADE_INVALIDA' });
      const quero = BigInt(n);
      if (quero > limite - usado) return Object.freeze({ ok: false, motivo: 'LIMITE_TOTAL_EXCEDIDO' });
      usado += quero;
      return Object.freeze({ ok: true });
    },
    usado: () => Number(usado), // sempre <= limite <= Number.MAX_SAFE_INTEGER
    restante: () => Number(limite - usado),
  });
  orcamentosProduzidos.add(orcamento);
  return orcamento;
}

const ehOrcamentoDeBytes = (v) => v !== null && typeof v === 'object' && orcamentosProduzidos.has(v);

/** Falta de espaço ou de cota no sistema de arquivos (erros conhecidos do Node/POSIX). */
const ehFaltaDeEspaco = (falha) => falha !== null && typeof falha === 'object' && (falha.code === 'ENOSPC' || falha.code === 'EDQUOT');

module.exports = { criarOrcamentoDeBytes, ehOrcamentoDeBytes, ehFaltaDeEspaco };
