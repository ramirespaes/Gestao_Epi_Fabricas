'use strict';

const autorizacao = require('../middleware/autorizacao');

/**
 * Autorização da exportação do Histórico de Funcionários (pacote J; a rota de exportação do pacote I é obrigada a usá-la).
 *
 * Exportar exige DUAS permissões efetivas, cada uma pela mesma avaliação do middleware e de GET /auth/permissoes
 * (perfil → grupo → exceção individual; na ação, o bloqueio individual é a última palavra; MASTER pelo perfil):
 *   - visualizar: employeeHistory.visualizar;
 *   - exportar: a ação EXPORTAR_HISTORICO_FUNCIONARIOS (085).
 * O toggle ligado na tela não basta: só `permitido` autoriza. O contexto é SEMPRE o da sessão validada.
 */

const RECURSO_HISTORICO = 'employeeHistory';
const ACAO_EXPORTAR_HISTORICO = 'EXPORTAR_HISTORICO_FUNCIONARIOS';

/**
 * @param {{query: Function}} executor
 * @param {{empresaId: number, usuarioId: number, perfil: string}} contexto
 * @returns {Promise<{visualizar: boolean, exportar: boolean, permitido: boolean}>}
 */
async function avaliar(executor, { empresaId, usuarioId, perfil }) {
  const contexto = { empresaId, usuarioId, perfil };
  const recurso = await autorizacao.avaliarPermissaoRecurso(executor, contexto, RECURSO_HISTORICO);
  const visualizar = recurso.visualizar === true;
  const exportar = (await autorizacao.avaliarPermissaoAcao(executor, contexto, ACAO_EXPORTAR_HISTORICO)) === true;
  return { visualizar, exportar, permitido: visualizar && exportar };
}

module.exports = { avaliar, ACAO_EXPORTAR_HISTORICO, RECURSO_HISTORICO };
