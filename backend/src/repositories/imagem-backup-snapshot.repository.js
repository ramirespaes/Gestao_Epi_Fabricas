'use strict';

/**
 * Exportação do snapshot do backup permanente da Biblioteca de Imagens (D-ORF-6, GREEN-SNAP-CORE-1). Executor por parâmetro (nunca o pool global), só
 * SQL e nenhuma regra: quem valida o identificador é o serviço. Pensado para rodar como PRIMEIRA consulta de uma transação REPEATABLE READ READ ONLY.
 */

/** Identificador do snapshot da transação corrente, como o banco o devolve (sem validar; linha ausente devolve undefined). */
async function exportarSnapshot(executor) {
  const { rows } = await executor.query('SELECT pg_export_snapshot() AS snapshot_id');
  return rows[0]?.snapshot_id;
}

module.exports = { exportarSnapshot };
