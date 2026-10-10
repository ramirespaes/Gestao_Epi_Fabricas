'use strict';

const sqlPosicao = require('./sql/posicao-estoque');

// Uma linha por lote de material ativo; o total do material e o "disponível" são o saldo UTILIZÁVEL da regra oficial
// (CA ausente ou vencido em material que exige CA bloqueia o lote). $2 é sempre a data operacional.
const LOTE = { lote: 'l', material: 'm', hoje: '$2' };
const UTILIZAVEL = sqlPosicao.fisicoUtilizavel(LOTE);
const SITUACAO_CA = sqlPosicao.situacaoCa({ ...LOTE, diasAlerta: '$3' });

// Usa $1 (empresa) e $2 (data).
const TOTAIS = `totais AS (
  SELECT m.id, m.nome, m.tipo, m.estoque_minimo, coalesce(sum(${UTILIZAVEL}), 0)::int AS saldo_total
    FROM materiais m
    LEFT JOIN estoque_lotes l ON l.empresa_id = m.empresa_id AND l.material_id = m.id
   WHERE m.empresa_id = $1 AND m.ativo
   GROUP BY m.id
)`;

const STATUS = `CASE WHEN t.saldo_total = 0 THEN 'SEM_ESTOQUE' WHEN t.saldo_total <= t.estoque_minimo THEN 'EM_ALERTA' ELSE 'DISPONIVEL' END`;

const SEM = (c) => `translate(lower(${c}), 'áàâãäéèêëíìîïóòôõöúùûüç', 'aaaaaeeeeiiiiooooouuuuc')`;

// pBusca e pStatus são os placeholders de cada query, para a numeração ficar consecutiva.
const filtro = (pBusca, pStatus) => `FROM estoque_lotes l
  JOIN totais t ON t.id = l.material_id
  JOIN materiais m ON m.empresa_id = l.empresa_id AND m.id = l.material_id
 WHERE l.empresa_id = $1
   AND (${pBusca}::text IS NULL OR ${SEM('t.nome')} LIKE ${pBusca} ESCAPE '\\' OR ${SEM("coalesce(t.tipo, '')")} LIKE ${pBusca} ESCAPE '\\'
        OR lower(coalesce(l.ca_numero, '')) LIKE ${pBusca} ESCAPE '\\')
   AND (${pStatus}::text IS NULL OR ${STATUS} = ${pStatus}::text)`;

const COLUNAS_ORDEM = Object.freeze({
  material: 'lower(t.nome)',
  tipo: "lower(coalesce(t.tipo, ''))",
  ca: "coalesce(l.ca_numero, '')",
  lote: 'l.id',
  dataEntrada: 'l.criado_em',
  quantidadeEntrada: 'l.quantidade_entrada',
  disponivel: UTILIZAVEL,
  estoqueMinimo: 't.estoque_minimo',
  status: `CASE ${STATUS} WHEN 'SEM_ESTOQUE' THEN 1 WHEN 'EM_ALERTA' THEN 2 ELSE 3 END`,
});

// $1 empresa, $2 hoje
async function indicadores(executor, empresaId, { hoje }) {
  const { rows } = await executor.query(
    `WITH ${TOTAIS}
     SELECT count(*)::int AS cadastrados,
            count(*) FILTER (WHERE saldo_total > 0)::int AS com_estoque,
            count(*) FILTER (WHERE saldo_total <= estoque_minimo)::int AS em_alerta
       FROM totais`,
    [empresaId, hoje],
  );
  const r = rows[0];
  return { itensCadastrados: r.cadastrados, comEstoqueDisponivel: r.com_estoque, emAlerta: r.em_alerta };
}

// $1 empresa, $2 hoje, $3 dias de alerta do CA
async function alertas(executor, empresaId, { hoje, diasAlerta }) {
  const { rows } = await executor.query(
    `WITH ${TOTAIS}
     SELECT 'SEM_ESTOQUE' AS tipo, t.id AS material_id, t.nome, t.tipo AS tipo_material, NULL::text AS ca_numero, NULL::text AS ca_situacao,
            t.saldo_total, t.estoque_minimo
       FROM totais t WHERE t.saldo_total = 0
     UNION ALL
     SELECT 'ABAIXO_MINIMO', t.id, t.nome, t.tipo, NULL::text, NULL::text, t.saldo_total, t.estoque_minimo
       FROM totais t WHERE t.saldo_total > 0 AND t.saldo_total <= t.estoque_minimo
     UNION ALL
     SELECT CASE x.situacao WHEN 'VENCIDO' THEN 'CA_VENCIDO' WHEN 'SEM_CA' THEN 'CA_AUSENTE' ELSE 'CA_PROXIMO' END,
            x.id, x.nome, x.tipo, x.ca_numero, x.situacao, x.saldo_total, x.estoque_minimo
       FROM (SELECT t.id, t.nome, t.tipo, l.ca_numero, ${SITUACAO_CA} AS situacao, t.saldo_total, t.estoque_minimo
               FROM totais t
               JOIN estoque_lotes l ON l.empresa_id = $1 AND l.material_id = t.id AND l.saldo > 0
               JOIN materiais m ON m.empresa_id = $1 AND m.id = t.id) x
      WHERE x.situacao IN ('VENCIDO', 'SEM_CA', 'VENCE_HOJE', 'A_VENCER')
     ORDER BY 1, 3, 5`,
    [empresaId, hoje, diasAlerta],
  );
  return rows.map((r) => ({
    tipo: r.tipo,
    materialId: r.material_id,
    material: r.nome,
    tipoMaterial: r.tipo_material,
    caNumero: r.ca_numero,
    situacaoCa: r.ca_situacao,
    saldoTotal: r.saldo_total,
    estoqueMinimo: r.estoque_minimo,
  }));
}

// $1 empresa, $2 hoje, $3 dias, $4 busca, $5 status, $6 limite, $7 offset
async function listarLotes(executor, empresaId, { hoje, diasAlerta }, {
  padraoBusca, status, ordem, direcao, pagina, limite,
}) {
  const coluna = COLUNAS_ORDEM[ordem];
  if (!coluna) throw new TypeError('ordenação do relatório inválida');
  const { rows } = await executor.query(
    `WITH ${TOTAIS}
     SELECT l.id, l.material_id, t.nome, t.tipo, l.tamanho, l.ca_numero, to_char(l.ca_validade, 'YYYY-MM-DD') AS ca_validade,
            ${SITUACAO_CA} AS situacao_ca,
            to_char(l.criado_em AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS data_entrada,
            l.quantidade_entrada, ${UTILIZAVEL} AS utilizavel, l.saldo AS saldo_fisico,
            t.estoque_minimo, t.saldo_total, ${STATUS} AS status
       ${filtro('$4', '$5')}
      ORDER BY ${coluna} ${direcao === 'desc' ? 'DESC' : 'ASC'}, l.criado_em DESC, l.id DESC
      LIMIT $6 OFFSET $7`,
    [empresaId, hoje, diasAlerta, padraoBusca, status, limite, (pagina - 1) * limite],
  );
  return rows.map((r) => ({
    loteId: r.id,
    materialId: r.material_id,
    material: r.nome,
    tipo: r.tipo,
    tamanho: r.tamanho,
    ca: { numero: r.ca_numero, validade: r.ca_validade, situacao: r.situacao_ca },
    dataEntrada: r.data_entrada,
    quantidadeEntrada: r.quantidade_entrada,
    disponivelNoLote: r.utilizavel,
    saldoFisicoNoLote: r.saldo_fisico,
    estoqueMinimo: r.estoque_minimo,
    saldoTotalMaterial: r.saldo_total,
    status: r.status,
  }));
}

// $1 empresa, $2 hoje, $3 busca, $4 status
async function contarLotes(executor, empresaId, { hoje }, { padraoBusca, status }) {
  const { rows } = await executor.query(
    `WITH ${TOTAIS} SELECT count(*)::int AS total ${filtro('$3', '$4')}`,
    [empresaId, hoje, padraoBusca, status],
  );
  return rows[0].total;
}

module.exports = { indicadores, alertas, listarLotes, contarLotes, ORDENS: Object.freeze(Object.keys(COLUNAS_ORDEM)) };
