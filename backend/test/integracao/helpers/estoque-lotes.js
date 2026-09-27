'use strict';

const crypto = require('node:crypto');

/**
 * Cria lotes e baixas direto no banco, para os testes de leitura do estoque.
 * Uso SALDO_INICIAL porque ele aceita lote sem CA e com CA já vencido; a
 * entrada operacional tem regras e testes próprios.
 */

async function comCliente(executor, fn) {
  if (typeof executor.connect !== 'function') return fn(executor);
  const cliente = await executor.connect();
  try {
    return await fn(cliente);
  } finally {
    cliente.release();
  }
}

async function inserirLote(executor, { empresaId, materialId, tamanho, quantidade, ca = null, validade = null }) {
  return comCliente(executor, async (c) => {
    await c.query('BEGIN');
    try {
      const { rows } = await c.query(
        `INSERT INTO estoque_lotes (empresa_id, material_id, tamanho, ca_numero, ca_validade, origem, quantidade_entrada)
         VALUES ($1, $2, $3, $4, $5, 'SALDO_INICIAL', $6) RETURNING id`,
        [empresaId, materialId, tamanho, ca, validade, quantidade],
      );
      await c.query(
        "INSERT INTO estoque_operacoes (empresa_id, lote_id, tipo, quantidade) VALUES ($1, $2, 'SALDO_INICIAL', $3)",
        [empresaId, rows[0].id, quantidade],
      );
      await c.query('COMMIT');
      return rows[0].id;
    } catch (erro) {
      await c.query('ROLLBACK');
      throw erro;
    }
  });
}

async function baixarLote(executor, { empresaId, loteId, quantidade, usuarioId, motivo = 'AVARIA' }) {
  await executor.query(
    `INSERT INTO estoque_operacoes (empresa_id, lote_id, tipo, quantidade, motivo, usuario_id, chave_idempotencia, requisicao_hash)
     VALUES ($1, $2, 'BAIXA', $3, $4, $5, $6, $7)`,
    [empresaId, loteId, quantidade, motivo, usuarioId, crypto.randomUUID(), 'f'.repeat(64)],
  );
}

function somarDias(dataIso, dias) {
  const d = new Date(`${dataIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

module.exports = { inserirLote, baixarLote, somarDias };
