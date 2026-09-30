'use strict';

/**
 * Fichas de EPI (fichas_epi, migration 058): uma por trabalhador na empresa,
 * criada na primeira entrega. Só INSERT e leitura; a ficha não muda nem
 * some. Toda consulta filtra pela empresa.
 */

const PROJECAO = 'id, empresa_id, numero, funcionario_id, criada_em';

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError(`${nome} inválido`);
  }
}

const mapear = (linha) => (linha === undefined ? null : {
  id: linha.id,
  empresaId: linha.empresa_id,
  numero: linha.numero,
  funcionarioId: linha.funcionario_id,
  criadaEm: linha.criada_em,
});

async function buscarPorId(executor, empresaId, id) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(id, 'identificador de ficha');
  const { rows } = await executor.query(`SELECT ${PROJECAO} FROM fichas_epi WHERE empresa_id = $1 AND id = $2`, [empresaId, id]);
  return mapear(rows[0]);
}

async function buscarPorFuncionario(executor, empresaId, funcionarioId) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(funcionarioId, 'identificador de funcionário');
  const { rows } = await executor.query(
    `SELECT ${PROJECAO} FROM fichas_epi WHERE empresa_id = $1 AND funcionario_id = $2`,
    [empresaId, funcionarioId],
  );
  return mapear(rows[0]);
}

/** Cria a ficha com o número já reservado em fichas_epi_numeracao, na mesma transação. */
async function criar(executor, { empresaId, funcionarioId, numero }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(funcionarioId, 'identificador de funcionário');
  exigirId(numero, 'número da ficha');
  const { rows } = await executor.query(
    `INSERT INTO fichas_epi (empresa_id, numero, funcionario_id) VALUES ($1, $2, $3) RETURNING ${PROJECAO}`,
    [empresaId, numero, funcionarioId],
  );
  return mapear(rows[0]);
}

module.exports = { buscarPorId, buscarPorFuncionario, criar };
