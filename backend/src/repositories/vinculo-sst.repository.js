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
const LIMITE_MAXIMO = 100;
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

/**
 * Página de vínculos da empresa, do mais novo ao mais antigo, com nome, perfil
 * e situação do usuário (ligado pela chave composta). Única leitura deste
 * repositório que toca `usuarios`, e só nessas três colunas: nunca e-mail,
 * hash de senha nem CPF.
 */
async function listarComUsuario(executor, empresaId, { pagina, limite }) {
  exigirId(empresaId, 'identificador de empresa');
  if (!Number.isInteger(pagina) || pagina < 1) throw new TypeError('página inválida');
  if (!Number.isInteger(limite) || limite < 1 || limite > LIMITE_MAXIMO) throw new TypeError('limite inválido');
  const { rows } = await executor.query(
    `SELECT v.usuario_id, v.concedido_por, v.concedido_em, v.motivo,
            u.nome AS usuario_nome, u.perfil AS usuario_perfil, u.ativo AS usuario_ativo
       FROM vinculo_sst v
       JOIN usuarios u ON u.empresa_id = v.empresa_id AND u.id = v.usuario_id
      WHERE v.empresa_id = $1
      ORDER BY v.concedido_em DESC, v.usuario_id DESC
      LIMIT $2 OFFSET $3`,
    [empresaId, limite, (pagina - 1) * limite],
  );
  return rows.map((l) => ({
    usuarioId: l.usuario_id,
    concedidoPor: l.concedido_por,
    concedidoEm: l.concedido_em,
    motivo: l.motivo,
    usuario: { nome: l.usuario_nome, perfil: l.usuario_perfil, ativo: l.usuario_ativo },
  }));
}

async function contar(executor, empresaId) {
  exigirId(empresaId, 'identificador de empresa');
  const { rows } = await executor.query('SELECT count(*)::int AS total FROM vinculo_sst WHERE empresa_id = $1', [empresaId]);
  return Number(rows[0].total);
}

module.exports = {
  MOTIVO_MAXIMO, LIMITE_MAXIMO, inserir, remover, buscarPorUsuario, listarPorEmpresa, listarComUsuario, contar,
};
