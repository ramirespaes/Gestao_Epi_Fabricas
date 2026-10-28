'use strict';

/**
 * Privacidade e LGPD (Bloco A1): só contagens agregadas da PRÓPRIA empresa. Nenhuma consulta devolve nome, CPF, matrícula,
 * e-mail ou qualquer dado individual; o filtro de empresa nunca é opcional.
 */

function exigirEmpresa(empresaId) {
  if (!Number.isInteger(empresaId) || empresaId <= 0) {
    throw new TypeError('identificador de empresa inválido');
  }
}

/**
 * Titulares cujos dados pessoais o sistema trata para a empresa: funcionários (cadastro operacional, por situação da 084) e
 * usuários (contas de acesso vinculadas à empresa).
 */
async function contarTitulares(executor, empresaId) {
  exigirEmpresa(empresaId);
  const funcionarios = await executor.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE situacao = 'ATIVO')::int AS ativos,
            count(*) FILTER (WHERE situacao = 'AFASTADO')::int AS afastados,
            count(*) FILTER (WHERE situacao = 'INATIVO')::int AS inativos
       FROM funcionarios WHERE empresa_id = $1`,
    [empresaId],
  );
  const usuarios = await executor.query(
    'SELECT count(*)::int AS total, count(*) FILTER (WHERE ativo)::int AS ativos FROM usuarios WHERE empresa_id = $1',
    [empresaId],
  );
  const f = funcionarios.rows[0];
  const u = usuarios.rows[0];
  return {
    funcionarios: { total: f.total, ativos: f.ativos, afastados: f.afastados, inativos: f.inativos },
    usuarios: { total: u.total, ativos: u.ativos },
  };
}

/** Razão social e CNPJ da empresa (a controladora dos dados), ou null se não existir. */
async function buscarControladora(executor, empresaId) {
  exigirEmpresa(empresaId);
  const { rows } = await executor.query('SELECT nome, cnpj FROM empresas WHERE id = $1', [empresaId]);
  return rows.length === 0 ? null : { razaoSocial: rows[0].nome, cnpj: rows[0].cnpj };
}

module.exports = { contarTitulares, buscarControladora };
