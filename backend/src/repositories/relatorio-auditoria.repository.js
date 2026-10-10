'use strict';

const sqlPosicao = require('./sql/posicao-estoque');

/**
 * Relatório — Auditoria (12K-D5). Só leitura, sempre filtrada pela empresa ($1).
 *
 *  - Solicitações aprovadas não atendidas: APROVADA e APROVADA_PARCIAL com quantidade aprovada ainda não entregue
 *    (aprovada menos a soma das entregas ligadas ao item, a mesma derivação da posição de estoque).
 *  - Trilha: logs_auditoria, sem contexto nem dados (só o que a tela mostra).
 *
 * A busca de texto não diferencia maiúsculas nem acentos; os curingas digitados são escapados no serviço.
 */

const SEM = (c) => `translate(lower(${c}), 'áàâãäéèêëíìîïóòôõöúùûüç', 'aaaaaeeeeiiiiooooouuuuc')`;
const HOJE = "(now() AT TIME ZONE 'America/Sao_Paulo')::date";

// ─── Solicitações aprovadas não atendidas ───────────────────────────

// Uma linha por solicitação com algum item aprovado ainda pendente. Os JOINs usam as peças da definição única da demanda.
const DEMANDA = { item: 'i', solicitacao: 's', funcionario: 'f', material: 'm', entregue: 'ent' };
const PENDENTE = sqlPosicao.pendenteDoItem(DEMANDA);

// $1 empresa, $2 padrão do funcionário, $3 padrão do EPI, $4 status ('AGUARDANDO_ENTREGA' | 'PARCIALMENTE_ATENDIDA').
const ITENS_PENDENTES = `itens_pendentes AS (
    SELECT s.id AS solicitacao_id, i.id AS item_id, m.nome AS material, i.tamanho,
           (${PENDENTE})::int AS pendente, COALESCE(ent.entregue, 0)::int AS entregue
      FROM solicitacoes_epi_itens i
      JOIN solicitacoes_epi s ON s.empresa_id = i.empresa_id AND s.id = i.solicitacao_id AND ${sqlPosicao.statusAtendiveis({ solicitacao: 's' })}
      JOIN materiais m ON m.empresa_id = i.empresa_id AND m.id = i.material_id
      ${sqlPosicao.entregueDoItem({ item: 'i', entregue: 'ent' })}
     WHERE i.empresa_id = $1 AND i.decisao = 'APROVADO' AND ${sqlPosicao.itemComPendente(DEMANDA)}
  )`;

const BASE_SOLICITACOES = `
  WITH ${ITENS_PENDENTES},
  resumo AS (
    SELECT s.id, s.numero, s.funcionario_id, s.decidida_em, s.decidida_por, s.status AS status_solicitacao,
           CASE WHEN EXISTS (
                  SELECT 1 FROM solicitacoes_epi_itens x
                  JOIN entregas_epi_itens ex ON ex.empresa_id = x.empresa_id AND ex.solicitacao_item_id = x.id
                 WHERE x.empresa_id = s.empresa_id AND x.solicitacao_id = s.id)
                THEN 'PARCIALMENTE_ATENDIDA' ELSE 'AGUARDANDO_ENTREGA' END AS status
      FROM solicitacoes_epi s
     WHERE s.empresa_id = $1 AND EXISTS (SELECT 1 FROM itens_pendentes p WHERE p.solicitacao_id = s.id)
  )`;

const FILTRO_SOLICITACOES = `
  FROM resumo r
  JOIN funcionarios f ON f.empresa_id = $1 AND f.id = r.funcionario_id
  LEFT JOIN usuarios u ON u.empresa_id = $1 AND u.id = r.decidida_por
 WHERE ($2::text IS NULL OR ${SEM('f.nome')} LIKE $2 ESCAPE '\\' OR lower(f.matricula) LIKE $2 ESCAPE '\\')
   AND ($3::text IS NULL OR EXISTS (
         SELECT 1 FROM itens_pendentes p WHERE p.solicitacao_id = r.id AND ${SEM('p.material')} LIKE $3 ESCAPE '\\'))
   AND ($4::text IS NULL OR r.status = $4::text)`;

const ORDEM_SOLICITACOES = Object.freeze({
  pedido: 'r.numero',
  funcionario: 'lower(f.nome)',
  dataAprovacao: 'r.decidida_em',
  aprovadoPor: "lower(coalesce(u.nome, ''))",
  diasEmFila: 'r.decidida_em',
  status: 'r.status',
});

const parametrosSolicitacoes = (empresaId, f) => [empresaId, f.padraoFuncionario, f.padraoItem, f.status];

async function listarSolicitacoesNaoAtendidas(executor, empresaId, filtros, { ordem, direcao, pagina, limite }) {
  const coluna = ORDEM_SOLICITACOES[ordem];
  if (!coluna) throw new TypeError('ordenação do relatório inválida');
  // Dias em fila cresce quando a aprovação é mais antiga: a ordem pelos dias é a inversa da data.
  const sentido = (ordem === 'diasEmFila' ? direcao !== 'desc' : direcao === 'desc') ? 'DESC' : 'ASC';
  const { rows } = await executor.query(
    `${BASE_SOLICITACOES}
     SELECT r.id AS solicitacao_id, r.numero, f.nome AS trabalhador_nome, r.status, r.status_solicitacao,
            to_char(r.decidida_em AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS aprovado_em,
            u.nome AS aprovado_por,
            (${HOJE} - (r.decidida_em AT TIME ZONE 'America/Sao_Paulo')::date)::int AS dias_em_fila,
            (SELECT coalesce(json_agg(json_build_object('material', p.material, 'tamanho', p.tamanho, 'pendente', p.pendente) ORDER BY p.item_id), '[]'::json)
               FROM itens_pendentes p WHERE p.solicitacao_id = r.id) AS itens
       ${FILTRO_SOLICITACOES}
      ORDER BY ${coluna} ${sentido}, r.id DESC
      LIMIT $5 OFFSET $6`,
    [...parametrosSolicitacoes(empresaId, filtros), limite, (pagina - 1) * limite],
  );
  return rows.map((r) => ({
    solicitacaoId: r.solicitacao_id,
    numero: r.numero,
    trabalhador: { nome: r.trabalhador_nome },
    itens: r.itens,
    aprovadoEm: r.aprovado_em,
    aprovadoPor: { nome: r.aprovado_por },
    diasEmFila: r.dias_em_fila,
    status: r.status,
    statusSolicitacao: r.status_solicitacao,
  }));
}

async function contarSolicitacoesNaoAtendidas(executor, empresaId, filtros) {
  const { rows } = await executor.query(
    `${BASE_SOLICITACOES} SELECT count(*)::int AS total ${FILTRO_SOLICITACOES}`,
    parametrosSolicitacoes(empresaId, filtros),
  );
  return rows[0].total;
}

// ─── Itens aprovados com entrega pendente (card "Entregas pendentes") ───────────────

// Conta ITENS (uma linha de item aprovado com restante a entregar = 1), nunca unidades, com o mesmo critério de inclusão
// da tabela de solicitações pendentes (a CTE é a mesma).
async function contarItensPendentes(executor, empresaId) {
  const { rows } = await executor.query(`WITH ${ITENS_PENDENTES} SELECT count(*)::int AS total FROM itens_pendentes`, [empresaId]);
  return rows[0].total;
}

// ─── Itens reprovados pela Segurança do Trabalho ────────────────────

// Uma linha por ITEM com decisao = 'REPROVADO', em qualquer status da solicitação (o histórico não desaparece). O motivo é
// solicitacoes_epi_itens.justificativa_decisao (obrigatório por CHECK na reprovação); quem decidiu e quando vêm da
// solicitação (decisão única e atômica de todos os itens). $1 empresa, $2 de, $3 até (dia da decisão em São Paulo),
// $4 padrão do funcionário, $5 padrão do item.
const DIA_DA_DECISAO = "(s.decidida_em AT TIME ZONE 'America/Sao_Paulo')::date";
const FILTRO_REPROVADOS = `
  FROM solicitacoes_epi_itens i
  JOIN solicitacoes_epi s ON s.empresa_id = i.empresa_id AND s.id = i.solicitacao_id
  JOIN funcionarios f ON f.empresa_id = s.empresa_id AND f.id = s.funcionario_id
  JOIN materiais m ON m.empresa_id = i.empresa_id AND m.id = i.material_id
  LEFT JOIN usuarios u ON u.empresa_id = s.empresa_id AND u.id = s.decidida_por
 WHERE i.empresa_id = $1 AND i.decisao = 'REPROVADO'
   AND ($2::date IS NULL OR ${DIA_DA_DECISAO} >= $2::date)
   AND ($3::date IS NULL OR ${DIA_DA_DECISAO} <= $3::date)
   AND ($4::text IS NULL OR ${SEM('f.nome')} LIKE $4 ESCAPE '\\' OR lower(f.matricula) LIKE $4 ESCAPE '\\')
   AND ($5::text IS NULL OR ${SEM('m.nome')} LIKE $5 ESCAPE '\\')`;

const ORDEM_REPROVADOS = Object.freeze({
  pedido: 's.numero',
  funcionario: 'lower(f.nome)',
  item: 'lower(m.nome)',
  quantidade: 'i.quantidade',
  dataReprovacao: 's.decidida_em',
  reprovadoPor: "lower(coalesce(u.nome, ''))",
});

const parametrosReprovados = (empresaId, f) => [empresaId, f.de, f.ate, f.padraoFuncionario, f.padraoItem];

async function listarReprovados(executor, empresaId, filtros, { ordem, direcao, pagina, limite }) {
  const coluna = ORDEM_REPROVADOS[ordem];
  if (!coluna) throw new TypeError('ordenação do relatório inválida');
  const sentido = direcao === 'desc' ? 'DESC' : 'ASC';
  const { rows } = await executor.query(
    `SELECT i.id AS item_id, s.id AS solicitacao_id, s.numero, f.nome AS trabalhador_nome, m.nome AS material, i.tamanho, i.quantidade,
            to_char(${DIA_DA_DECISAO}, 'YYYY-MM-DD') AS reprovado_em, u.nome AS reprovado_por, i.justificativa_decisao AS motivo
       ${FILTRO_REPROVADOS}
      ORDER BY ${coluna} ${sentido}, i.id ${sentido}
      LIMIT $6 OFFSET $7`,
    [...parametrosReprovados(empresaId, filtros), limite, (pagina - 1) * limite],
  );
  return rows.map((r) => ({
    itemId: r.item_id,
    solicitacaoId: r.solicitacao_id,
    numero: r.numero,
    trabalhador: { nome: r.trabalhador_nome },
    item: { material: r.material, tamanho: r.tamanho },
    quantidade: r.quantidade,
    reprovadoEm: r.reprovado_em,
    reprovadoPor: { nome: r.reprovado_por },
    motivo: r.motivo,
    status: 'REPROVADO',
  }));
}

async function contarReprovados(executor, empresaId, filtros) {
  const { rows } = await executor.query(`SELECT count(*)::int AS total ${FILTRO_REPROVADOS}`, parametrosReprovados(empresaId, filtros));
  return rows[0].total;
}

/** O card: todos os itens reprovados da empresa, sem filtro, por linha de item (nunca unidades). */
async function contarItensReprovados(executor, empresaId) {
  return contarReprovados(executor, empresaId, { de: null, ate: null, padraoFuncionario: null, padraoItem: null });
}

// ─── Trilha de ações ────────────────────────────────────────────────

// $1 empresa, $2 de, $3 até (datas de São Paulo, ambas inclusivas), $4 padrão do usuário (nome), $5 padrão da ação,
// $6 padrão da referência.
const FILTRO_LOG = `
  FROM logs_auditoria l
  LEFT JOIN usuarios u ON u.empresa_id = l.empresa_id AND u.id = l.usuario_id
 WHERE l.empresa_id = $1
   AND l.criado_em >= ($2::date)::timestamp AT TIME ZONE 'America/Sao_Paulo'
   AND l.criado_em < (($3::date) + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo'
   AND ($4::text IS NULL OR ${SEM("coalesce(u.nome, '')")} LIKE $4 ESCAPE '\\')
   AND ($5::text IS NULL OR lower(l.acao) LIKE $5 ESCAPE '\\')
   AND ($6::text IS NULL OR lower(coalesce(l.referencia, '')) LIKE $6 ESCAPE '\\')`;

const ORDEM_LOG = Object.freeze({
  dataHora: 'l.criado_em',
  usuario: "lower(coalesce(u.nome, ''))",
  acao: 'l.acao',
});

const parametrosLog = (empresaId, f) => [empresaId, f.de, f.ate, f.padraoUsuario, f.padraoAcao, f.padraoReferencia];

async function listarLog(executor, empresaId, filtros, { ordem, direcao, pagina, limite }) {
  const coluna = ORDEM_LOG[ordem];
  if (!coluna) throw new TypeError('ordenação do relatório inválida');
  const { rows } = await executor.query(
    `SELECT l.id, l.criado_em, l.usuario_id, u.nome AS usuario_nome, l.perfil_ator, l.acao, l.referencia, l.ip, l.dispositivo
       ${FILTRO_LOG}
      ORDER BY ${coluna} ${direcao === 'desc' ? 'DESC' : 'ASC'}, l.id ${direcao === 'desc' ? 'DESC' : 'ASC'}
      LIMIT $7 OFFSET $8`,
    [...parametrosLog(empresaId, filtros), limite, (pagina - 1) * limite],
  );
  return rows.map((r) => ({
    id: String(r.id),
    criadoEm: r.criado_em,
    usuarioId: r.usuario_id,
    usuarioNome: r.usuario_nome,
    perfilAtor: r.perfil_ator,
    acao: r.acao,
    referencia: r.referencia,
    ip: r.ip,
    dispositivo: r.dispositivo,
  }));
}

async function contarLog(executor, empresaId, filtros) {
  const { rows } = await executor.query(`SELECT count(*)::int AS total ${FILTRO_LOG}`, parametrosLog(empresaId, filtros));
  return rows[0].total;
}

// ─── Indicadores ────────────────────────────────────────────────────

async function contarLogsDosUltimosDias(executor, empresaId, dias) {
  const { rows } = await executor.query(
    "SELECT count(*)::int AS total FROM logs_auditoria WHERE empresa_id = $1 AND criado_em >= now() - make_interval(days => $2)",
    [empresaId, dias],
  );
  return rows[0].total;
}

// ─── Resolução de referências amigáveis (sempre por empresa, por tipo conhecido) ─────────────────

async function nomesDeSolicitacoes(executor, empresaId, ids) {
  if (!ids.length) return new Map();
  const { rows } = await executor.query(
    `SELECT s.id, s.numero, f.nome FROM solicitacoes_epi s
       JOIN funcionarios f ON f.empresa_id = s.empresa_id AND f.id = s.funcionario_id
      WHERE s.empresa_id = $1 AND s.id = ANY($2::int[])`,
    [empresaId, ids],
  );
  return new Map(rows.map((r) => [r.id, { numero: r.numero, nome: r.nome }]));
}

async function nomesDeEntregas(executor, empresaId, ids) {
  if (!ids.length) return new Map();
  const { rows } = await executor.query(
    `SELECT e.id, f.numero, e.trabalhador_nome AS nome FROM entregas_epi e
       JOIN fichas_epi f ON f.empresa_id = e.empresa_id AND f.id = e.ficha_id
      WHERE e.empresa_id = $1 AND e.id = ANY($2::int[])`,
    [empresaId, ids],
  );
  return new Map(rows.map((r) => [r.id, { numero: r.numero, nome: r.nome }]));
}

async function nomesDeLotes(executor, empresaId, ids) {
  if (!ids.length) return new Map();
  const { rows } = await executor.query(
    `SELECT l.id, m.nome FROM estoque_lotes l
       JOIN materiais m ON m.empresa_id = l.empresa_id AND m.id = l.material_id
      WHERE l.empresa_id = $1 AND l.id = ANY($2::int[])`,
    [empresaId, ids],
  );
  return new Map(rows.map((r) => [r.id, { nome: r.nome }]));
}

async function nomesDeMateriais(executor, empresaId, ids) {
  if (!ids.length) return new Map();
  const { rows } = await executor.query('SELECT id, nome FROM materiais WHERE empresa_id = $1 AND id = ANY($2::int[])', [empresaId, ids]);
  return new Map(rows.map((r) => [r.id, { nome: r.nome }]));
}

async function nomesDeFuncionarios(executor, empresaId, ids) {
  if (!ids.length) return new Map();
  const { rows } = await executor.query('SELECT id, nome FROM funcionarios WHERE empresa_id = $1 AND id = ANY($2::int[])', [empresaId, ids]);
  return new Map(rows.map((r) => [r.id, { nome: r.nome }]));
}

async function nomesDeUsuarios(executor, empresaId, ids) {
  if (!ids.length) return new Map();
  const { rows } = await executor.query('SELECT id, nome FROM usuarios WHERE empresa_id = $1 AND id = ANY($2::int[])', [empresaId, ids]);
  return new Map(rows.map((r) => [r.id, { nome: r.nome }]));
}

module.exports = {
  ORDEM_SOLICITACOES: Object.freeze(Object.keys(ORDEM_SOLICITACOES)),
  ORDEM_LOG: Object.freeze(Object.keys(ORDEM_LOG)),
  ORDEM_REPROVADOS: Object.freeze(Object.keys(ORDEM_REPROVADOS)),
  contarItensPendentes,
  listarReprovados,
  contarReprovados,
  contarItensReprovados,
  listarSolicitacoesNaoAtendidas,
  contarSolicitacoesNaoAtendidas,
  listarLog,
  contarLog,
  contarLogsDosUltimosDias,
  nomesDeSolicitacoes,
  nomesDeEntregas,
  nomesDeLotes,
  nomesDeMateriais,
  nomesDeFuncionarios,
  nomesDeUsuarios,
};
