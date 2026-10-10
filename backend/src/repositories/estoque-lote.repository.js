'use strict';

const { exigirDataOperacional } = require('../utils/data-operacional');
const { escaparCoringasLike } = require('../utils/like');
const sqlPosicao = require('./sql/posicao-estoque');
const classificacao = require('../utils/classificacao-material');

/**
 * Leitura do estoque por lote. Toda consulta filtra pela empresa e liga o
 * lote ao material pela chave (empresa_id, id).
 *
 * A situação do CA é derivada na leitura, nunca gravada. $1 é sempre a
 * empresa, $2 a data operacional e $3 os dias de alerta: não uso
 * CURRENT_DATE, porque o fuso do banco não é o de São Paulo.
 */

const JUNCAO = `FROM estoque_lotes l
       JOIN materiais m ON m.empresa_id = l.empresa_id AND m.id = l.material_id`;

// A definição de "utilizável" e da situação do CA é única (sql/posicao-estoque.js):
// aqui só digo quais são os meus aliases e parâmetros ($2 a data, $3 os dias de alerta).
const LOTE = { lote: 'l', material: 'm', hoje: '$2' };

// CA vence no fim do dia da validade. Material que dispensa CA nunca é
// classificado por validade, mesmo que o lote tenha um CA informado.
const SITUACAO_CA = sqlPosicao.situacaoCa({ ...LOTE, diasAlerta: '$3' });

// Bloqueado é o saldo que não pode gerar nova entrega.
const BLOQUEADO = sqlPosicao.saldoBloqueado(LOTE);

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

// Os itens de Itens Disponíveis (par material × tamanho) saem da posição de estoque
// (posicao-estoque.repository), a única definição de "utilizável"; aqui ficam só os filtros.
async function listarFiltrosDisponiveis(executor, empresaId) {
  exigirId(empresaId, 'empresa');
  const { rows } = await executor.query(
    `SELECT (SELECT array_agg(c ORDER BY c) FROM (
              SELECT DISTINCT ${classificacao.SQL.grupoEfetivo('m')} AS c ${JUNCAO} WHERE l.empresa_id = $1 AND m.ativo AND m.categoria IS NOT NULL
              UNION SELECT 'Outros' WHERE EXISTS (SELECT 1 ${JUNCAO} WHERE l.empresa_id = $1 AND m.ativo AND m.categoria = 'Outros')) x
             WHERE c IS NOT NULL) AS categorias,
            array_agg(DISTINCT m.tipo ORDER BY m.tipo) FILTER (WHERE m.tipo IS NOT NULL) AS tipos,
            array_agg(DISTINCT l.tamanho ORDER BY l.tamanho) FILTER (WHERE l.tamanho IS NOT NULL) AS tamanhos
       ${JUNCAO}
      WHERE l.empresa_id = $1 AND m.ativo`,
    [empresaId],
  );
  const l = rows[0] || {};
  return { categorias: l.categorias || [], tipos: l.tipos || [], tamanhos: l.tamanhos || [] };
}

// Indicadores de validade do dashboard: CA vencido e a vencer usam o recorte da
// Validade de estoque (lote com saldo, de material ativo ou inativo), para os dois
// números baterem. Lote zerado não entra. Os números de estoque do dashboard (físico
// utilizável, saldo livre, comprometido, sem cobertura, abaixo do mínimo) não saem
// daqui: vêm da posição por par, a mesma de Itens Disponíveis (posicao-estoque.repository).
async function resumirIndicadores(executor, empresaId, referencia) {
  exigirId(empresaId, 'empresa');
  exigirReferencia(referencia);
  const { rows } = await executor.query(
    `WITH ${LOTES_VALIDADE}
     SELECT (SELECT count(*) FROM validade WHERE situacao = 'VENCIDO')::int AS ca_vencido,
            (SELECT count(*) FROM validade WHERE situacao IN ('VENCE_HOJE', 'A_VENCER'))::int AS ca_a_vencer`,
    [empresaId, referencia.hoje, referencia.diasAlerta],
  );
  const r = rows[0];
  return { caVencido: r.ca_vencido, caAVencer: r.ca_a_vencer };
}

// E7 — validade de estoque. A unidade é o lote com saldo físico, de material
// ativo ou inativo: inativar o cadastro não faz o estoque desaparecer (E9).
// O Dashboard conta CA vencido e a vencer com este mesmo recorte. $4 é a
// situação pedida, ou o grupo VENCIMENTO_PROXIMO, e $5 a busca já escapada,
// em nome ou CA.
const SITUACOES_LOTE = Object.freeze(['VENCIDO', 'VENCE_HOJE', 'A_VENCER', 'VENCIMENTO_PROXIMO', 'VALIDO', 'SEM_CA', 'NAO_EXIGE_CA']);

const LOTES_VALIDADE = `validade AS (
     SELECT l.id, l.material_id, m.nome, m.codigo_interno, m.categoria, ${classificacao.SQL.grupoEfetivo('m')} AS grupo, m.tipo, m.ativo AS material_ativo, l.tamanho, l.ca_numero,
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
     SELECT id, material_id, nome, codigo_interno, categoria, grupo, tipo, material_ativo, tamanho, ca_numero,
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
    grupo: l.grupo ?? null, // valor efetivo de exibição do Grupo (classificacao-material.SQL.grupoEfetivo)
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
  listarFiltrosDisponiveis,
  resumirIndicadores,
  listarValidade,
  contarValidade,
  resumirValidade,
  SITUACOES_LOTE,
};
