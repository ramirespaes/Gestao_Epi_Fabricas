'use strict';

/**
 * Administração do vínculo SST (vinculo_sst, migration 018). A existência da
 * linha é o vínculo: aqui só se insere, remove e lê, sempre pela empresa. Quem
 * pode fazê-lo e a auditoria são do serviço; as FKs compostas garantem no
 * banco que o usuário e quem concedeu são da mesma empresa. A leitura que a
 * camada de autorização usa (usuarioIntegraSst) continua em
 * permissao.repository.js.
 */

const MOTIVO_MAXIMO = 500;
const COLUNAS = 'usuario_id, empresa_id, concedido_por, concedido_em, motivo';

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError(`${nome} inválido`);
  }
}

const mapear = (l) => (l === undefined ? null : {
  usuarioId: l.usuario_id,
  empresaId: l.empresa_id,
  concedidoPor: l.concedido_por,
  concedidoEm: l.concedido_em,
  motivo: l.motivo,
});

/** Insere o vínculo; devolve null quando o usuário já tinha vínculo (nada inserido). */
async function inserir(executor, {
  empresaId, usuarioId, concedidoPor, motivo = null,
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(usuarioId, 'identificador de usuário');
  exigirId(concedidoPor, 'identificador de quem concedeu');
  // Conta caracteres, como char_length no banco.
  if (motivo !== null && (typeof motivo !== 'string' || motivo.length === 0 || Array.from(motivo).length > MOTIVO_MAXIMO)) {
    throw new TypeError('motivo inválido');
  }
  const { rows } = await executor.query(
    `INSERT INTO vinculo_sst (empresa_id, usuario_id, concedido_por, motivo)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (usuario_id) DO NOTHING
     RETURNING ${COLUNAS}`,
    [empresaId, usuarioId, concedidoPor, motivo],
  );
  return mapear(rows[0]);
}

/** Remove o vínculo do usuário na empresa e devolve a linha removida; null quando não havia. */
async function remover(executor, empresaId, usuarioId) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(usuarioId, 'identificador de usuário');
  const { rows } = await executor.query(
    `DELETE FROM vinculo_sst WHERE empresa_id = $1 AND usuario_id = $2
     RETURNING ${COLUNAS}`,
    [empresaId, usuarioId],
  );
  return mapear(rows[0]);
}

async function buscarPorUsuario(executor, empresaId, usuarioId) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(usuarioId, 'identificador de usuário');
  const { rows } = await executor.query(
    `SELECT ${COLUNAS} FROM vinculo_sst WHERE empresa_id = $1 AND usuario_id = $2`,
    [empresaId, usuarioId],
  );
  return mapear(rows[0]);
}

async function listarPorEmpresa(executor, empresaId) {
  exigirId(empresaId, 'identificador de empresa');
  const { rows } = await executor.query(
    `SELECT ${COLUNAS} FROM vinculo_sst WHERE empresa_id = $1
      ORDER BY usuario_id`,
    [empresaId],
  );
  return rows.map(mapear);
}

module.exports = { MOTIVO_MAXIMO, inserir, remover, buscarPorUsuario, listarPorEmpresa };
