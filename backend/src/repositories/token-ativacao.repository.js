'use strict';

/**
 * Códigos de ativação do tablet (token_ativacoes, migration 086). Só o SHA-256 do código existe no banco; a situação
 * (pendente, usada, cancelada, expirada) é DERIVADA dos carimbos. Todo instante usa o relógio do BANCO (now()), nunca o da
 * aplicação. A validade de 10 minutos é o teto da própria constraint (expira_em <= criado_em + 10 min).
 *
 * Executor por parâmetro; nenhuma regra de negócio aqui. Quem decide é o serviço, sob a trava da linha do dispositivo.
 */

const VALIDADE_MINUTOS = 10;
const HASH = /^[0-9a-f]{64}$/;

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) throw new TypeError(`${nome} inválido`);
}
function exigirHash(valor) {
  if (typeof valor !== 'string' || !HASH.test(valor)) throw new TypeError('hash inválido');
}

/** Cancela a ativação pendente do tablet (inclusive a expirada que ainda ocupa o índice único parcial). */
async function cancelarPendentes(executor, empresaId, dispositivoId) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(dispositivoId, 'identificador de dispositivo');
  // clock_timestamp(), não now(): now() é o início da transação, que pode ser anterior à criação da ativação que uma
  // transação concorrente acabou de confirmar (violaria cancelado_em >= criado_em).
  const { rowCount } = await executor.query(
    'UPDATE token_ativacoes SET cancelado_em = clock_timestamp() WHERE empresa_id = $1 AND dispositivo_id = $2 AND usado_em IS NULL AND cancelado_em IS NULL',
    [empresaId, dispositivoId],
  );
  return rowCount;
}

async function inserir(executor, { empresaId, dispositivoId, codigoHash, criadoPor }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(dispositivoId, 'identificador de dispositivo');
  exigirId(criadoPor, 'identificador de usuário');
  exigirHash(codigoHash);
  // criado_em e expira_em do MESMO instante real (clock_timestamp), então a validade é de fato de 10 minutos a partir de agora.
  const { rows } = await executor.query(
    `WITH instante AS (SELECT clock_timestamp() AS agora)
     INSERT INTO token_ativacoes (empresa_id, dispositivo_id, codigo_hash, criado_por, criado_em, expira_em)
     SELECT $1, $2, $3, $4, agora, agora + make_interval(mins => $5::int) FROM instante
     RETURNING id, expira_em`,
    [empresaId, dispositivoId, codigoHash, criadoPor, VALIDADE_MINUTOS],
  );
  return rows[0];
}

/** Leitura SEM trava, só para descobrir o tablet (e então travá-lo antes da ativação, na mesma ordem da geração). */
async function buscarPorHash(executor, codigoHash) {
  exigirHash(codigoHash);
  const { rows } = await executor.query('SELECT id, empresa_id, dispositivo_id FROM token_ativacoes WHERE codigo_hash = $1', [codigoHash]);
  return rows[0] ?? null;
}

/** Leitura COM trava da ativação; `valida` é decidida pelo relógio do banco (pendente e não expirada). */
async function buscarPorHashTravando(executor, codigoHash) {
  exigirHash(codigoHash);
  const { rows } = await executor.query(
    `SELECT id, empresa_id, dispositivo_id, (usado_em IS NULL AND cancelado_em IS NULL AND expira_em > clock_timestamp()) AS valida
       FROM token_ativacoes WHERE codigo_hash = $1 FOR UPDATE`,
    [codigoHash],
  );
  return rows[0] ?? null;
}

async function marcarUsada(executor, id) {
  exigirId(id, 'identificador de ativação');
  const { rowCount } = await executor.query(
    'UPDATE token_ativacoes SET usado_em = clock_timestamp() WHERE id = $1 AND usado_em IS NULL AND cancelado_em IS NULL AND expira_em > clock_timestamp()',
    [id],
  );
  return rowCount === 1;
}

module.exports = { VALIDADE_MINUTOS, cancelarPendentes, inserir, buscarPorHash, buscarPorHashTravando, marcarUsada };
