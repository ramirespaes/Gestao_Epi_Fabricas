'use strict';

/**
 * Leituras da Central Administrativa do Atendimento Token (Etapa H). Executor por parâmetro, nenhuma regra de negócio, toda consulta
 * filtra pela empresa da sessão. Nada daqui devolve credencial, hash ou código de ativação, e nada escreve.
 */

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) throw new TypeError(`${nome} inválido`);
}

const iso = (data) => (data instanceof Date ? data.toISOString() : null);

/**
 * Contagens administrativas dos dispositivos da empresa. A situação é DERIVADA dos carimbos, como na projeção da Etapa B (revogado
 * precede): REVOGADO se `revogado_em`; senão ATIVO se `ativado_em`; senão PENDENTE. Os três são exclusivos e somam `cadastrados`.
 */
async function contarDispositivos(executor, empresaId) {
  exigirId(empresaId, 'identificador de empresa');
  const { rows: [r] } = await executor.query(
    `SELECT count(*)::int AS cadastrados,
            count(*) FILTER (WHERE revogado_em IS NULL AND ativado_em IS NOT NULL)::int AS ativos,
            count(*) FILTER (WHERE revogado_em IS NULL AND ativado_em IS NULL)::int AS pendentes,
            count(*) FILTER (WHERE revogado_em IS NOT NULL)::int AS revogados
       FROM token_dispositivos WHERE empresa_id = $1`,
    [empresaId],
  );
  return { cadastrados: r.cadastrados, ativos: r.ativos, pendentes: r.pendentes, revogados: r.revogados };
}

/** Ativações PENDENTES de verdade: não usadas, não canceladas e não vencidas pelo relógio do banco (a vencida não conta). */
async function contarAtivacoesPendentes(executor, empresaId) {
  exigirId(empresaId, 'identificador de empresa');
  const { rows: [r] } = await executor.query(
    'SELECT count(*)::int AS n FROM token_ativacoes WHERE empresa_id = $1 AND usado_em IS NULL AND cancelado_em IS NULL AND expira_em > now()',
    [empresaId],
  );
  return r.n;
}

/** O dispositivo existe NESTA empresa? (outra empresa e inexistente são indistinguíveis). */
async function dispositivoExiste(executor, empresaId, id) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(id, 'identificador de dispositivo');
  const { rows } = await executor.query('SELECT 1 FROM token_dispositivos WHERE empresa_id = $1 AND id = $2', [empresaId, id]);
  return rows.length > 0;
}

/**
 * A ativação MAIS RECENTE do dispositivo (criado_em e id decrescentes), só com os carimbos. Nunca o hash do código, nem quem a gerou.
 * `vencida` usa o relógio do banco, o mesmo do consumo do código pelo tablet.
 */
async function ativacaoMaisRecente(executor, empresaId, dispositivoId) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(dispositivoId, 'identificador de dispositivo');
  const { rows } = await executor.query(
    `SELECT criado_em, expira_em, usado_em, cancelado_em, (expira_em <= now()) AS vencida
       FROM token_ativacoes WHERE empresa_id = $1 AND dispositivo_id = $2
      ORDER BY criado_em DESC, id DESC LIMIT 1`,
    [empresaId, dispositivoId],
  );
  if (rows.length === 0) return null;
  const l = rows[0];
  return { geradaEm: iso(l.criado_em), expiraEm: iso(l.expira_em), usadaEm: iso(l.usado_em), canceladaEm: iso(l.cancelado_em), vencida: l.vencida === true };
}

/** O funcionário da empresa e a sua situação (só o necessário para decidir se a prévia vale). */
async function funcionarioDaEmpresa(executor, empresaId, funcionarioId) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(funcionarioId, 'identificador de funcionário');
  const { rows } = await executor.query('SELECT id, (situacao = \'ATIVO\') AS ativo FROM funcionarios WHERE empresa_id = $1 AND id = $2', [empresaId, funcionarioId]);
  return rows[0] === undefined ? null : { id: rows[0].id, ativo: rows[0].ativo === true };
}

/**
 * GHE ATUAL do funcionário para a conferência da prévia (K7): código (nulo no GHE anterior à 083), descrição (o `nome`, como o sistema
 * a exibe) e situação. `null` quando o funcionário não tem GHE. Só leitura; roda no mesmo instantâneo do catálogo, que parte do mesmo
 * `funcionarios.grupo_homogeneo_id`. Não altera `token-catalogo.repository` (baseline E).
 */
async function gheDoFuncionario(executor, empresaId, funcionarioId) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(funcionarioId, 'identificador de funcionário');
  const { rows } = await executor.query(
    `SELECT g.codigo, g.nome AS descricao, g.ativo
       FROM funcionarios f
       JOIN grupos_homogeneos_exposicao g ON g.empresa_id = f.empresa_id AND g.id = f.grupo_homogeneo_id
      WHERE f.empresa_id = $1 AND f.id = $2`,
    [empresaId, funcionarioId],
  );
  return rows[0] === undefined ? null : { codigo: rows[0].codigo ?? null, descricao: rows[0].descricao, ativo: rows[0].ativo === true };
}

module.exports = { contarDispositivos, contarAtivacoesPendentes, dispositivoExiste, ativacaoMaisRecente, funcionarioDaEmpresa, gheDoFuncionario };
