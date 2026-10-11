'use strict';

/**
 * Exportações do Histórico de Funcionários já feitas pelo usuário na janela, contadas na própria auditoria
 * (FUNCIONARIO_HISTORICO_EXPORTADO). Lido no banco, vale para qualquer número de instâncias da API; quem chama
 * serializa a conferência com o registro por advisory lock do usuário.
 */
async function contarRecentes(executor, {
  empresaId, usuarioId, acao, janelaSegundos,
}) {
  for (const [v, nome] of [[empresaId, 'empresa'], [usuarioId, 'usuário']]) {
    if (!Number.isInteger(v) || v <= 0) throw new TypeError(`identificador de ${nome} inválido`);
  }
  if (!Number.isInteger(janelaSegundos) || janelaSegundos < 1 || janelaSegundos > 3600) throw new TypeError('janela em segundos inválida');
  const { rows } = await executor.query(
    `SELECT count(*)::int AS total
       FROM logs_auditoria
      WHERE empresa_id = $1 AND usuario_id = $2 AND acao = $3
        AND criado_em > clock_timestamp() - make_interval(secs => $4)`,
    [empresaId, usuarioId, acao, janelaSegundos],
  );
  return rows[0].total;
}

module.exports = { contarRecentes };
