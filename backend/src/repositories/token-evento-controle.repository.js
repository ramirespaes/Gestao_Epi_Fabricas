'use strict';

/**
 * Eventos de recusa que um cliente externo consegue provocar em volume (REDE_RECUSADA, REUSO_CREDENCIAL) entram com SUPRESSÃO:
 * no máximo um por (tablet, tipo) dentro da janela, decidido sob advisory lock de 64 bits próprio da chave, para que requisições
 * simultâneas não furem a janela. O evento não guarda valor algum (a tabela nem tem coluna para isso).
 *
 * Usa transação curta e própria: a recusa que o originou não escreve nada.
 */

const TIPOS_SUPRIMIVEIS = Object.freeze(['REDE_RECUSADA', 'REUSO_CREDENCIAL']);

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) throw new TypeError(`${nome} inválido`);
}

/** true se registrou, false se havia evento do mesmo tipo dentro da janela. */
async function registrarSuprimido(pool, { empresaId, dispositivoId, tipo, janelaSegundos }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(dispositivoId, 'identificador de dispositivo');
  if (!TIPOS_SUPRIMIVEIS.includes(tipo)) throw new TypeError('tipo de evento não suprimível');
  if (!Number.isInteger(janelaSegundos) || janelaSegundos <= 0) throw new TypeError('janela inválida');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`token-evento:${dispositivoId}:${tipo}`]);
      const { rowCount } = await client.query(
        `INSERT INTO token_dispositivo_eventos (empresa_id, dispositivo_id, tipo)
         SELECT $1::int, $2::int, $3::varchar
          WHERE NOT EXISTS (
            SELECT 1 FROM token_dispositivo_eventos
             WHERE empresa_id = $1 AND dispositivo_id = $2 AND tipo = $3 AND ocorrido_em > now() - make_interval(secs => $4::int))`,
        [empresaId, dispositivoId, tipo, janelaSegundos],
      );
      await client.query('COMMIT');
      return rowCount === 1;
    } catch (erro) {
      await client.query('ROLLBACK');
      throw erro;
    }
  } finally {
    client.release();
  }
}

module.exports = { TIPOS_SUPRIMIVEIS, registrarSuprimido };
