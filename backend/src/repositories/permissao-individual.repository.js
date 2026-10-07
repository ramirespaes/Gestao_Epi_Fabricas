'use strict';

/**
 * Camadas INDIVIDUAIS de permissão do usuário (tabelas já existentes, sem
 * migration): exceções de recurso (usuario_permissoes_recurso, 022) e bloqueios
 * de ação (usuario_bloqueios, 011). As concessões de ação (usuario_autorizacoes,
 * 019/023) continuam no repositório e no serviço próprios. O que cada flag
 * significa para o cálculo efetivo é decisão de middleware/autorizacao.js:
 * este módulo só lê e grava, sempre com empresa e usuário explícitos.
 *
 * usuario_bloqueios não tem empresa_id: o isolamento vem do JOIN com usuarios
 * (empresa_id, id), exatamente como em permissao.repository.js.
 */

const FLAGS = Object.freeze({
  visualizar: 'pode_visualizar', criar: 'pode_criar', editar: 'pode_editar', excluir: 'pode_excluir',
});

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError(`${nome} inválido`);
  }
}

/** Todas as exceções de recurso do usuário: [{recurso, visualizar, criar, editar, excluir}] (true/false/null). */
async function listarRecursos(executor, empresaId, usuarioId) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(usuarioId, 'identificador de usuário');
  const { rows } = await executor.query(
    `SELECT recurso, pode_visualizar, pode_criar, pode_editar, pode_excluir
       FROM usuario_permissoes_recurso WHERE empresa_id = $1 AND usuario_id = $2 ORDER BY recurso`,
    [empresaId, usuarioId],
  );
  return rows.map((l) => ({
    recurso: l.recurso, visualizar: l.pode_visualizar, criar: l.pode_criar, editar: l.pode_editar, excluir: l.pode_excluir,
  }));
}

/**
 * Define as flags informadas (true/false/null) da exceção de recurso, mantendo
 * as demais. Sem nenhuma flag restante a linha é apagada (volta a herdar).
 * @returns {Promise<{recurso, visualizar, criar, editar, excluir}|null>} null quando não sobrou exceção.
 */
async function definirRecurso(executor, {
  empresaId, usuarioId, recurso, flags, concedidoPor,
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(usuarioId, 'identificador de usuário');
  exigirId(concedidoPor, 'identificador de concedente');
  const atuais = (await listarRecursos(executor, empresaId, usuarioId)).find((r) => r.recurso === recurso) ?? {
    visualizar: null, criar: null, editar: null, excluir: null,
  };
  const novo = { ...atuais };
  for (const op of Object.keys(FLAGS)) {
    if (Object.hasOwn(flags, op)) {
      if (flags[op] !== null && typeof flags[op] !== 'boolean') throw new TypeError(`flag ${op} inválida`);
      novo[op] = flags[op];
    }
  }
  if (Object.keys(FLAGS).every((op) => novo[op] === null)) {
    await executor.query('DELETE FROM usuario_permissoes_recurso WHERE empresa_id = $1 AND usuario_id = $2 AND recurso = $3', [empresaId, usuarioId, recurso]);
    return null;
  }
  await executor.query(
    `INSERT INTO usuario_permissoes_recurso (empresa_id, usuario_id, recurso, pode_visualizar, pode_criar, pode_editar, pode_excluir, concedido_por)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (usuario_id, recurso) DO UPDATE
       SET pode_visualizar = EXCLUDED.pode_visualizar, pode_criar = EXCLUDED.pode_criar,
           pode_editar = EXCLUDED.pode_editar, pode_excluir = EXCLUDED.pode_excluir, concedido_por = EXCLUDED.concedido_por`,
    [empresaId, usuarioId, recurso, novo.visualizar, novo.criar, novo.editar, novo.excluir, concedidoPor],
  );
  return { recurso, ...novo };
}

/** Substitui TODAS as exceções de recurso do destino pelas da origem (mesma empresa). Devolve quantas ficaram. */
async function copiarRecursos(executor, {
  empresaId, origemId, destinoId, concedidoPor,
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(origemId, 'identificador de origem');
  exigirId(destinoId, 'identificador de destino');
  exigirId(concedidoPor, 'identificador de concedente');
  await executor.query('DELETE FROM usuario_permissoes_recurso WHERE empresa_id = $1 AND usuario_id = $2', [empresaId, destinoId]);
  const { rowCount } = await executor.query(
    `INSERT INTO usuario_permissoes_recurso (empresa_id, usuario_id, recurso, pode_visualizar, pode_criar, pode_editar, pode_excluir, concedido_por)
     SELECT empresa_id, $3, recurso, pode_visualizar, pode_criar, pode_editar, pode_excluir, $4
       FROM usuario_permissoes_recurso WHERE empresa_id = $1 AND usuario_id = $2`,
    [empresaId, origemId, destinoId, concedidoPor],
  );
  return rowCount;
}

/** Códigos de ação bloqueados para o usuário (da empresa informada). */
async function listarBloqueios(executor, empresaId, usuarioId) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(usuarioId, 'identificador de usuário');
  const { rows } = await executor.query(
    `SELECT ub.acao_codigo FROM usuario_bloqueios ub
       JOIN usuarios u ON u.id = ub.usuario_id AND u.empresa_id = $1
      WHERE ub.usuario_id = $2 ORDER BY ub.acao_codigo`,
    [empresaId, usuarioId],
  );
  return rows.map((l) => l.acao_codigo);
}

async function bloquear(executor, {
  empresaId, usuarioId, acaoCodigo, bloqueadoPor,
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(usuarioId, 'identificador de usuário');
  exigirId(bloqueadoPor, 'identificador de quem bloqueia');
  const { rowCount } = await executor.query(
    `INSERT INTO usuario_bloqueios (usuario_id, acao_codigo, bloqueado_por)
     SELECT u.id, $3, $4 FROM usuarios u WHERE u.empresa_id = $1 AND u.id = $2
     ON CONFLICT (usuario_id, acao_codigo) DO NOTHING`,
    [empresaId, usuarioId, acaoCodigo, bloqueadoPor],
  );
  return rowCount === 1;
}

async function desbloquear(executor, { empresaId, usuarioId, acaoCodigo }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(usuarioId, 'identificador de usuário');
  const { rowCount } = await executor.query(
    `DELETE FROM usuario_bloqueios ub USING usuarios u
      WHERE u.id = ub.usuario_id AND u.empresa_id = $1 AND ub.usuario_id = $2 AND ub.acao_codigo = $3`,
    [empresaId, usuarioId, acaoCodigo],
  );
  return rowCount === 1;
}

/** Substitui TODOS os bloqueios do destino pelos da origem. Devolve quantos ficaram. */
async function copiarBloqueios(executor, {
  empresaId, origemId, destinoId, bloqueadoPor,
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(origemId, 'identificador de origem');
  exigirId(destinoId, 'identificador de destino');
  exigirId(bloqueadoPor, 'identificador de quem bloqueia');
  await executor.query(
    `DELETE FROM usuario_bloqueios ub USING usuarios u
      WHERE u.id = ub.usuario_id AND u.empresa_id = $1 AND ub.usuario_id = $2`,
    [empresaId, destinoId],
  );
  const { rowCount } = await executor.query(
    `INSERT INTO usuario_bloqueios (usuario_id, acao_codigo, bloqueado_por)
     SELECT $3, ub.acao_codigo, $4 FROM usuario_bloqueios ub
       JOIN usuarios u ON u.id = ub.usuario_id AND u.empresa_id = $1
      WHERE ub.usuario_id = $2`,
    [empresaId, origemId, destinoId, bloqueadoPor],
  );
  return rowCount;
}

module.exports = {
  listarRecursos, definirRecurso, copiarRecursos, listarBloqueios, bloquear, desbloquear, copiarBloqueios,
};
