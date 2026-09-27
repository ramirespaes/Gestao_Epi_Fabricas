'use strict';

const { exigirDataOperacional } = require('../utils/data-operacional');
const { escaparCoringasLike } = require('../utils/like');

/**
 * Leitura do estoque por lote. Toda consulta filtra pela empresa e liga o
 * lote ao material pela chave (empresa_id, id).
 *
 * A situação do CA é derivada na leitura, nunca gravada. $1 é sempre a
 * empresa, $2 a data operacional e $3 os dias de alerta: não uso
 * CURRENT_DATE, porque o fuso do banco não é o de São Paulo.
 */

const VALIDADES = Object.freeze(['ok', 'expiring', 'expired']);

const JUNCAO = `FROM estoque_lotes l
       JOIN materiais m ON m.empresa_id = l.empresa_id AND m.id = l.material_id`;

// CA vence no fim do dia da validade. Material que dispensa CA nunca é
// classificado por validade, mesmo que o lote tenha um CA informado.
const SITUACAO_CA = `CASE
         WHEN NOT m.exige_ca THEN 'NAO_EXIGE_CA'
         WHEN l.ca_validade IS NULL THEN 'SEM_CA'
         WHEN l.ca_validade < $2::date THEN 'VENCIDO'
         WHEN l.ca_validade = $2::date THEN 'VENCE_HOJE'
         WHEN l.ca_validade <= $2::date + $3::int THEN 'A_VENCER'
         ELSE 'VALIDO'
       END`;

// Bloqueado é o saldo que não pode gerar nova entrega.
const BLOQUEADO = `CASE
         WHEN m.exige_ca AND (l.ca_validade IS NULL OR l.ca_validade < $2::date) THEN l.saldo
         ELSE 0
       END`;

// Lotes dos materiais ativos, inclusive os zerados: eles não somam nada, mas
// mantêm na lista o tamanho que esgotou.
const LOTES_ATIVOS = `lotes AS (
     SELECT l.material_id, l.tamanho, l.saldo, l.ca_validade,
            ${BLOQUEADO} AS bloqueado,
            ${SITUACAO_CA} AS situacao
       ${JUNCAO}
      WHERE l.empresa_id = $1
        AND m.ativo
   )`;

// Um item de Itens Disponíveis é o par material × tamanho. A validade do par
// é a pior entre os lotes com saldo que exigem CA.
const PARES = `pares AS (
     SELECT material_id, tamanho,
            sum(saldo)::bigint AS fisico,
            sum(bloqueado)::bigint AS bloqueado,
            min(ca_validade) FILTER (WHERE saldo > 0 AND situacao NOT IN ('NAO_EXIGE_CA', 'SEM_CA')) AS ca_validade,
            CASE
              WHEN bool_or(saldo > 0 AND situacao = 'VENCIDO') THEN 'expired'
              WHEN bool_or(saldo > 0 AND situacao IN ('VENCE_HOJE', 'A_VENCER')) THEN 'expiring'
              WHEN bool_or(saldo > 0 AND situacao = 'VALIDO') THEN 'ok'
              ELSE 'sem-validade'
            END AS validade
       FROM lotes
      GROUP BY material_id, tamanho
   )`;

const FILTRO_PARES = `FROM pares p
       JOIN materiais m ON m.empresa_id = $1 AND m.id = p.material_id
      WHERE ($4::text IS NULL OR m.categoria = $4::text)
        AND ($5::text IS NULL OR m.tipo = $5::text)
        AND ($6::text IS NULL OR p.tamanho = $6::text)
        AND ($7::text IS NULL OR p.validade = $7::text)`;

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError(`identificador de ${nome} inválido`);
  }
}

function exigirReferencia({ hoje, diasAlerta } = {}) {
  exigirDataOperacional(hoje);
  if (!Number.isInteger(diasAlerta) || diasAlerta < 1) {
    throw new TypeError('prazo de alerta da validade do CA inválido');
  }
}

function exigirTextoFiltro(valor, nome) {
  if (valor !== null && valor !== undefined && typeof valor !== 'string') {
    throw new TypeError(`filtro ${nome} deve ser texto ou null`);
  }
}

function exigirFiltros(filtros) {
  exigirReferencia(filtros);
  exigirTextoFiltro(filtros.categoria, 'categoria');
  exigirTextoFiltro(filtros.tipo, 'tipo');
  exigirTextoFiltro(filtros.tamanho, 'tamanho');
  if (filtros.validade !== null && filtros.validade !== undefined && !VALIDADES.includes(filtros.validade)) {
    throw new TypeError('filtro de validade inválido');
  }
}

const paramsFiltro = (empresaId, f) => [
  empresaId, f.hoje, f.diasAlerta, f.categoria ?? null, f.tipo ?? null, f.tamanho ?? null, f.validade ?? null,
];

async function listarPorMaterial(executor, empresaId, materialId, referencia) {
  exigirId(empresaId, 'empresa');
  exigirId(materialId, 'material');
  exigirReferencia(referencia);
  const { rows } = await executor.query(
    `SELECT l.id, l.material_id, l.tamanho, l.ca_numero, to_char(l.ca_validade, 'YYYY-MM-DD') AS ca_validade, l.origem,
            l.quantidade_entrada, l.quantidade_baixada, l.quantidade_entregue, l.saldo,
            ${BLOQUEADO} AS bloqueado,
            ${SITUACAO_CA} AS situacao_ca
       ${JUNCAO}
      WHERE l.empresa_id = $1
        AND l.material_id = $4
        AND l.saldo > 0
      ORDER BY l.tamanho, l.ca_validade NULLS LAST, l.id`,
    [empresaId, referencia.hoje, referencia.diasAlerta, materialId],
  );
  return rows.map((l) => ({
    loteId: l.id,
    materialId: l.material_id,
    tamanho: l.tamanho,
    caNumero: l.ca_numero,
    caValidade: l.ca_validade,
    origem: l.origem,
    quantidadeEntrada: l.quantidade_entrada,
    quantidadeBaixada: l.quantidade_baixada,
    quantidadeEntregue: l.quantidade_entregue,
    fisico: l.saldo,
    bloqueado: l.bloqueado,
    disponivel: l.saldo - l.bloqueado,
    situacaoCa: l.situacao_ca,
  }));
}

async function listarDisponiveis(executor, empresaId, filtros = {}) {
  exigirId(empresaId, 'empresa');
  exigirFiltros(filtros);
  const { pagina = 1, limite = 50 } = filtros;
  if (!Number.isInteger(pagina) || pagina < 1) throw new TypeError('página inválida');
  if (!Number.isInteger(limite) || limite < 1) throw new TypeError('limite inválido');

  const { rows } = await executor.query(
    `WITH ${LOTES_ATIVOS}, ${PARES}
     SELECT m.id AS material_id, m.nome AS material, m.codigo_interno, m.categoria, m.tipo, p.tamanho,
            p.fisico, p.bloqueado, m.unidade, m.estoque_minimo,
            to_char(p.ca_validade, 'YYYY-MM-DD') AS ca_validade, p.validade
       ${FILTRO_PARES}
      ORDER BY lower(m.nome), m.id, p.tamanho
      LIMIT $8 OFFSET $9`,
    [...paramsFiltro(empresaId, filtros), limite, (pagina - 1) * limite],
  );

  return rows.map((l) => {
    const fisico = Number(l.fisico);
    const bloqueado = Number(l.bloqueado);
    return {
      materialId: l.material_id,
      material: l.material,
      codigoInterno: l.codigo_interno ?? null,
      categoria: l.categoria ?? null,
      tipo: l.tipo ?? null,
      tamanho: l.tamanho,
      saldo: fisico,
      bloqueado,
      disponivel: fisico - bloqueado,
      unidade: l.unidade,
      estoqueMinimo: l.estoque_minimo,
      caValidade: l.ca_validade ?? null,
      validade: l.validade,
    };
  });
}

async function contarDisponiveis(executor, empresaId, filtros = {}) {
  exigirId(empresaId, 'empresa');
  exigirFiltros(filtros);
  const { rows } = await executor.query(
    `WITH ${LOTES_ATIVOS}, ${PARES}
     SELECT count(*)::int AS total ${FILTRO_PARES}`,
    paramsFiltro(empresaId, filtros),
  );
  return rows[0] ? rows[0].total : 0;
}

async function listarFiltrosDisponiveis(executor, empresaId) {
  exigirId(empresaId, 'empresa');
  const { rows } = await executor.query(
    `SELECT array_agg(DISTINCT m.categoria ORDER BY m.categoria) FILTER (WHERE m.categoria IS NOT NULL) AS categorias,
            array_agg(DISTINCT m.tipo ORDER BY m.tipo) FILTER (WHERE m.tipo IS NOT NULL) AS tipos,
            array_agg(DISTINCT l.tamanho ORDER BY l.tamanho) FILTER (WHERE l.tamanho IS NOT NULL) AS tamanhos
       ${JUNCAO}
      WHERE l.empresa_id = $1 AND m.ativo`,
    [empresaId],
  );
  const l = rows[0] || {};
  return { categorias: l.categorias || [], tipos: l.tipos || [], tamanhos: l.tamanhos || [] };
}

// Indicadores do dashboard. Disponível e abaixo do mínimo são do material
// ativo, o que pode ser entregue e reposto; abaixo do mínimo só existe com
// mínimo configurado, e disponível 0 sem mínimo não é alerta. CA vencido e a
// vencer usam o recorte da Validade de estoque (lote com saldo, de material
// ativo ou inativo), para os dois números baterem. Lote zerado não entra.
async function resumirIndicadores(executor, empresaId, referencia) {
  exigirId(empresaId, 'empresa');
  exigirReferencia(referencia);
  const { rows } = await executor.query(
    `WITH ${LOTES_ATIVOS},
     ${LOTES_VALIDADE},
     pares AS (
       SELECT material_id, tamanho, sum(saldo - bloqueado) AS disponivel
         FROM lotes
        GROUP BY material_id, tamanho
     )
     SELECT (SELECT COALESCE(sum(saldo - bloqueado), 0) FROM lotes)::bigint AS disponivel,
            (SELECT count(*)
               FROM pares p
               JOIN materiais m ON m.empresa_id = $1 AND m.id = p.material_id
              WHERE m.estoque_minimo > 0 AND p.disponivel < m.estoque_minimo)::int AS abaixo_minimo,
            (SELECT count(*) FROM validade WHERE situacao = 'VENCIDO')::int AS ca_vencido,
            (SELECT count(*) FROM validade WHERE situacao IN ('VENCE_HOJE', 'A_VENCER'))::int AS ca_a_vencer`,
    [empresaId, referencia.hoje, referencia.diasAlerta],
  );
  const r = rows[0];
  return { disponivel: Number(r.disponivel), abaixoMinimo: r.abaixo_minimo, caVencido: r.ca_vencido, caAVencer: r.ca_a_vencer };
}

// E7 — validade de estoque. A unidade é o lote com saldo físico, de material
// ativo ou inativo: inativar o cadastro não faz o estoque desaparecer (E9).
// O Dashboard conta CA vencido e a vencer com este mesmo recorte. $4 é a
// situação pedida, ou o grupo VENCIMENTO_PROXIMO, e $5 a busca já escapada,
// em nome ou CA.
const SITUACOES_LOTE = Object.freeze(['VENCIDO', 'VENCE_HOJE', 'A_VENCER', 'VENCIMENTO_PROXIMO', 'VALIDO', 'SEM_CA', 'NAO_EXIGE_CA']);

const LOTES_VALIDADE = `validade AS (
     SELECT l.id, l.material_id, m.nome, m.codigo_interno, m.categoria, m.tipo, m.ativo AS material_ativo, l.tamanho, l.ca_numero,
            l.ca_validade, l.saldo, ${BLOQUEADO} AS bloqueado, ${SITUACAO_CA} AS situacao
       ${JUNCAO}
      WHERE l.empresa_id = $1
        AND l.saldo > 0
   )`;

const FILTRO_VALIDADE = `WHERE ($4::text IS NULL OR situacao = $4::text
            OR ($4::text = 'VENCIMENTO_PROXIMO' AND situacao IN ('VENCE_HOJE', 'A_VENCER')))
        AND ($5::text IS NULL OR nome ILIKE '%' || $5::text || '%' OR ca_numero ILIKE '%' || $5::text || '%')`;

// O que precisa de ação primeiro: vencido, sem CA, vence hoje, a vencer.
const ORDEM_VALIDADE = `CASE situacao WHEN 'VENCIDO' THEN 1 WHEN 'SEM_CA' THEN 2 WHEN 'VENCE_HOJE' THEN 3
                        WHEN 'A_VENCER' THEN 4 WHEN 'VALIDO' THEN 5 ELSE 6 END,
               ca_validade NULLS LAST, lower(nome), tamanho NULLS FIRST, id`;

function filtrosValidade(filtros = {}) {
  const situacao = filtros.situacao ?? null;
  if (situacao !== null && !SITUACOES_LOTE.includes(situacao)) {
    throw new TypeError('situação de validade inválida');
  }
  const busca = filtros.busca ?? null;
  if (busca !== null && (typeof busca !== 'string' || busca.length === 0)) {
    throw new TypeError('busca inválida');
  }
  return { situacao, busca: busca === null ? null : escaparCoringasLike(busca) };
}

async function listarValidade(executor, empresaId, { hoje, diasAlerta, pagina, limite, ...filtros }) {
  exigirId(empresaId, 'empresa');
  exigirReferencia({ hoje, diasAlerta });
  exigirId(pagina, 'página');
  exigirId(limite, 'limite');
  const f = filtrosValidade(filtros);
  const { rows } = await executor.query(
    `WITH ${LOTES_VALIDADE}
     SELECT id, material_id, nome, codigo_interno, categoria, tipo, material_ativo, tamanho, ca_numero,
            to_char(ca_validade, 'YYYY-MM-DD') AS validade_ca, saldo, bloqueado, situacao
       FROM validade
       ${FILTRO_VALIDADE}
      ORDER BY ${ORDEM_VALIDADE}
      LIMIT $6 OFFSET $7`,
    [empresaId, hoje, diasAlerta, f.situacao, f.busca, limite, (pagina - 1) * limite],
  );
  return rows.map((l) => ({
    loteId: l.id,
    materialId: l.material_id,
    material: l.nome,
    codigoInterno: l.codigo_interno,
    categoria: l.categoria,
    tipo: l.tipo,
    materialAtivo: l.material_ativo,
    tamanho: l.tamanho,
    caNumero: l.ca_numero,
    caValidade: l.validade_ca,
    fisico: l.saldo,
    bloqueado: l.bloqueado,
    disponivel: l.saldo - l.bloqueado,
    situacaoCa: l.situacao,
  }));
}

async function contarValidade(executor, empresaId, { hoje, diasAlerta, ...filtros }) {
  exigirId(empresaId, 'empresa');
  exigirReferencia({ hoje, diasAlerta });
  const f = filtrosValidade(filtros);
  const { rows } = await executor.query(
    `WITH ${LOTES_VALIDADE}
     SELECT count(*)::int AS total FROM validade ${FILTRO_VALIDADE}`,
    [empresaId, hoje, diasAlerta, f.situacao, f.busca],
  );
  return rows[0].total;
}

// Indicadores do conjunto inteiro, sem filtro: vence hoje não é vencido, e
// bloqueado é o lote que não pode gerar nova entrega (vencido ou sem CA).
async function resumirValidade(executor, empresaId, referencia) {
  exigirId(empresaId, 'empresa');
  exigirReferencia(referencia);
  const { rows } = await executor.query(
    `WITH ${LOTES_VALIDADE}
     SELECT count(*)::int AS lotes,
            count(*) FILTER (WHERE situacao = 'VENCIDO')::int AS vencido,
            count(*) FILTER (WHERE situacao = 'VENCE_HOJE')::int AS vence_hoje,
            count(*) FILTER (WHERE situacao = 'A_VENCER')::int AS a_vencer,
            count(*) FILTER (WHERE situacao = 'VALIDO')::int AS valido,
            count(*) FILTER (WHERE situacao = 'SEM_CA')::int AS sem_ca,
            count(*) FILTER (WHERE situacao = 'NAO_EXIGE_CA')::int AS nao_exige_ca,
            count(*) FILTER (WHERE bloqueado > 0)::int AS bloqueados
       FROM validade`,
    [empresaId, referencia.hoje, referencia.diasAlerta],
  );
  const r = rows[0];
  return {
    lotes: r.lotes, vencido: r.vencido, venceHoje: r.vence_hoje, aVencer: r.a_vencer, valido: r.valido,
    semCa: r.sem_ca, naoExigeCa: r.nao_exige_ca, bloqueados: r.bloqueados,
  };
}

/**
 * Diz se o material tem lote com saldo que não combina com a nova exigência
 * de tamanho: com tamanho quando ela passa a false, sem tamanho quando passa
 * a true. Lote zerado é histórico e não conta.
 */
async function possuiSaldoIncompativel(executor, empresaId, materialId, novaExigencia) {
  exigirId(empresaId, 'empresa');
  exigirId(materialId, 'material');
  if (typeof novaExigencia !== 'boolean') {
    throw new TypeError('exigência de tamanho deve ser booleana');
  }
  const { rows } = await executor.query(
    `SELECT EXISTS (
       SELECT 1 FROM estoque_lotes
        WHERE empresa_id = $1 AND material_id = $2
          AND saldo > 0
          AND (tamanho IS NULL) = $3
     ) AS existe`,
    [empresaId, materialId, novaExigencia],
  );
  return rows[0].existe;
}

module.exports = {
  possuiSaldoIncompativel,
  listarPorMaterial,
  listarDisponiveis,
  contarDisponiveis,
  listarFiltrosDisponiveis,
  resumirIndicadores,
  listarValidade,
  contarValidade,
  resumirValidade,
  VALIDADES,
  SITUACOES_LOTE,
};
