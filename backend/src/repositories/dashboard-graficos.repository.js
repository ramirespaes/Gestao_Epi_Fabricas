'use strict';

const { DE, FILTRO, parametros } = require('./relatorio-entregas.repository');

/**
 * Consultas dos gráficos do Dashboard (12I), somente leitura.
 *
 * Setores: funcionários ATIVOS da empresa cuja DATA DE CADASTRO (criado_em, levada ao dia civil de São Paulo) cai no período. É o que o
 * cadastro registra: a importação em lote grava o instante da importação e não há data histórica de "ativo em" — por isso o gráfico se
 * apresenta como "ativos cadastrados no período", nunca como reconstrução histórica. O setor é texto livre: agrupa-se pela forma
 * normalizada (minúsculas, sem espaços nas pontas); nulo e vazio formam um grupo só (setor null); o rótulo é a grafia mais frequente
 * do grupo (mode), estável entre consultas.
 *
 * Produtos: o top N e a série por dia/mês saem do MESMO FROM, WHERE e parâmetros do relatório "EPIs entregues"
 * (relatorio-entregas.repository): a população é a do relatório, por data operacional (São Paulo). Agrupa por material_id (produto,
 * nunca categoria ou tipo); o nome é o do snapshot da entrega mais recente do produto; a quantidade é i.quantidade.
 */

const SP = "'America/Sao_Paulo'";
const CHAVES = Object.freeze({ DIA: "to_char(e.data_operacional, 'YYYY-MM-DD')", MES: "to_char(e.data_operacional, 'YYYY-MM')" });

function exigirEmpresa(empresaId) {
  if (!Number.isInteger(empresaId) || empresaId <= 0) throw new TypeError('identificador de empresa inválido');
}

async function contarAtivosPorSetor(executor, empresaId, { de, ate }) {
  exigirEmpresa(empresaId);
  const { rows } = await executor.query(
    `SELECT mode() WITHIN GROUP (ORDER BY btrim(setor)) FILTER (WHERE btrim(setor) <> '') AS setor, count(*)::int AS quantidade
       FROM funcionarios
      WHERE empresa_id = $1
        AND ativo = true
        AND (criado_em AT TIME ZONE ${SP})::date >= $2::date
        AND (criado_em AT TIME ZONE ${SP})::date <= $3::date
      GROUP BY nullif(lower(btrim(setor)), '')
      ORDER BY quantidade DESC, min(lower(btrim(setor))) ASC NULLS LAST`,
    [empresaId, de, ate],
  );
  return rows.map((r) => ({ setor: r.setor ?? null, quantidade: Number(r.quantidade) }));
}

async function topProdutosEntregues(executor, empresaId, filtros, { limite }) {
  exigirEmpresa(empresaId);
  const { rows } = await executor.query(
    `SELECT i.material_id, (array_agg(i.material_nome ORDER BY e.entregue_em DESC, i.id DESC))[1] AS nome, sum(i.quantidade)::int AS total
     ${DE} ${FILTRO}
     GROUP BY i.material_id
     ORDER BY total DESC, i.material_id ASC
     LIMIT $9`,
    [...parametros(empresaId, filtros), limite],
  );
  return rows.map((r) => ({ materialId: Number(r.material_id), nome: r.nome, total: Number(r.total) }));
}

async function seriePorProduto(executor, empresaId, filtros, { materialIds, agrupamento }) {
  exigirEmpresa(empresaId);
  const chave = CHAVES[agrupamento];
  if (!chave) throw new TypeError('agrupamento do gráfico inválido');
  if (!Array.isArray(materialIds)) throw new TypeError('materiais inválidos');
  if (materialIds.length === 0) return [];
  const { rows } = await executor.query(
    `SELECT i.material_id, ${chave} AS chave, sum(i.quantidade)::int AS quantidade
     ${DE} ${FILTRO}
       AND i.material_id = ANY($9::int[])
     GROUP BY i.material_id, ${chave}`,
    [...parametros(empresaId, filtros), materialIds],
  );
  return rows.map((r) => ({ materialId: Number(r.material_id), chave: r.chave, quantidade: Number(r.quantidade) }));
}

module.exports = { contarAtivosPorSetor, topProdutosEntregues, seriePorProduto };
