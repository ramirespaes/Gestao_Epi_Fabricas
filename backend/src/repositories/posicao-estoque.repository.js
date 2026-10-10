'use strict';

const { exigirDataOperacional } = require('../utils/data-operacional');
const { escaparCoringasLike } = require('../utils/like');
const sqlPosicao = require('./sql/posicao-estoque');
const classificacao = require('../utils/classificacao-material');

// Grupo efetivo de exibição (082): a categoria, ou a descrição quando o grupo é "Outros" — regra única do catálogo.
const GRUPO_EFETIVO = classificacao.SQL.grupoEfetivo('m');

/**
 * A posição de estoque de TODOS os pares (empresa, material, tamanho) da
 * empresa, só leitura (12D-1). Por par:
 *   U = físico utilizável, D = demanda aprovada pendente,
 *   C = min(U, D) comprometido, L = max(0, U − D) saldo livre,
 *   G = max(0, D − U) demanda sem cobertura,
 *   mínimo efetivo = o próprio do tamanho (estoque_minimos, mesmo 0) ou, sem
 *   linha própria, o padrão materiais.estoque_minimo (origem PROPRIO ou PADRAO),
 *   déficit = max(0, mínimo − L), necessidade = G + déficit,
 *   abaixo do mínimo = mínimo > 0 e L < mínimo. O mínimo é sempre comparado com
 *   o saldo livre, nunca com o físico.
 *
 * O UNIVERSO é a união de: pares com lote (inclusive esgotado, para o tamanho
 * que acabou continuar na lista), pares com demanda pendente, pares com mínimo
 * próprio e o par (material, sem tamanho) do material ativo que não usa tamanho
 * e tem mínimo padrão > 0. Só material ATIVO entra. Assim U = 0 com D > 0, e
 * mínimo próprio sem lote nem demanda, também aparecem.
 *
 * A definição de utilizável e de demanda é a única de sql/posicao-estoque.js,
 * a mesma de lerPosicoes e da cobertura FIFO (as leituras das escritas).
 * Cada consulta declara o seu contrato de parâmetros e o passa aos fragmentos;
 * não há `$n` herdado de lugar nenhum.
 */

const VALIDADES = Object.freeze(['ok', 'expiring', 'expired']);
const SITUACOES = Object.freeze(['SEM_ESTOQUE', 'ABAIXO_MINIMO', 'COM_COMPROMETIDO', 'SEM_COBERTURA', 'COM_NECESSIDADE']);
const LIMITE_MAXIMO = 1000;

// Contratos de parâmetros: $1 empresa, $2 data operacional, $3 dias de alerta do CA (só na lista).
const LOTE = { lote: 'l', material: 'm', hoje: '$2' };
const ITEM = { item: 'i', solicitacao: 's', funcionario: 'f', material: 'm', entregue: 'e' };

/**
 * As CTEs até a posição derivada, comuns à lista, ao resumo e à posição de um
 * material. `comValidade` acrescenta a validade do CA do par (a pior entre os
 * lotes com saldo), que só a lista usa e que exige o parâmetro $3. Na lista, os
 * filtros de cadastro e de validade ($4 a $8) entram cedo, onde o material e os
 * lotes do par estão à mão; o filtro de situação ($9), que depende da posição,
 * entra depois. `porMaterial` restringe cada fonte a um material ($3, que nesse
 * caso é o material e não os dias de alerta), já nas leituras, para não somar a
 * empresa inteira só para devolver um material.
 */
function posicaoDerivada({ comValidade, porMaterial = false }) {
  const noLote = porMaterial ? '\n          AND l.material_id = $3' : '';
  const naDemanda = porMaterial ? ' AND i.material_id = $3' : '';
  const noMinimo = porMaterial ? '\n          AND em.material_id = $3' : '';
  const noUniverso = porMaterial ? ' AND m.id = $3' : '';
  const validadeDosLotes = comValidade
    ? `,
            ${sqlPosicao.situacaoCa({ ...LOTE, diasAlerta: '$3' })} AS situacao, l.ca_validade`
    : '';
  const validadeDoPar = comValidade
    ? `,
            min(ca_validade) FILTER (WHERE saldo > 0 AND situacao NOT IN ('NAO_EXIGE_CA', 'SEM_CA')) AS ca_validade,
            CASE
              WHEN bool_or(saldo > 0 AND situacao = 'VENCIDO') THEN 'expired'
              WHEN bool_or(saldo > 0 AND situacao IN ('VENCE_HOJE', 'A_VENCER')) THEN 'expiring'
              WHEN bool_or(saldo > 0 AND situacao = 'VALIDO') THEN 'ok'
              ELSE 'sem-validade'
            END AS validade`
    : '';
  const validadeNaBase = comValidade ? `,
            lp.ca_validade, COALESCE(lp.validade, 'sem-validade') AS validade` : '';
  const filtrosDeCadastro = comValidade
    ? `
      WHERE ($4::text IS NULL OR ($4::text = 'Outros' AND m.categoria = 'Outros') OR ($4::text <> 'Outros' AND ${GRUPO_EFETIVO} = $4::text))
        AND ($5::text IS NULL OR m.tipo = $5::text)
        AND ($6::text IS NULL OR u.tamanho_chave = $6::text)
        AND ($7::text IS NULL OR lp.validade = $7::text)
        AND ($8::text IS NULL OR m.nome ILIKE '%' || $8::text || '%' OR m.codigo_interno ILIKE '%' || $8::text || '%')`
    : '';

  return `lotes AS (
       SELECT l.material_id, COALESCE(l.tamanho, '') AS tamanho_chave, l.saldo,
              ${sqlPosicao.saldoBloqueado(LOTE)} AS bloqueado,
              ${sqlPosicao.fisicoUtilizavel(LOTE)} AS fisico_utilizavel${validadeDosLotes}
         FROM estoque_lotes l
         JOIN materiais m ON m.empresa_id = l.empresa_id AND m.id = l.material_id
        WHERE l.empresa_id = $1 AND m.ativo${noLote}
     ),
     lotes_par AS (
       SELECT material_id, tamanho_chave,
              sum(saldo)::bigint AS saldo,
              sum(bloqueado)::bigint AS bloqueado,
              sum(fisico_utilizavel)::bigint AS fisico_utilizavel${validadeDoPar}
         FROM lotes
        GROUP BY material_id, tamanho_chave
     ),
     demanda_par AS (
       SELECT i.material_id, COALESCE(i.tamanho, '') AS tamanho_chave, sum(${sqlPosicao.pendenteDoItem(ITEM)})::bigint AS demanda_pendente
         FROM solicitacoes_epi_itens i
         ${sqlPosicao.fonteDaDemanda(ITEM)}
        WHERE i.empresa_id = $1 AND i.decisao = 'APROVADO'${naDemanda} AND ${sqlPosicao.itemComPendente(ITEM)}
        GROUP BY i.material_id, COALESCE(i.tamanho, '')
     ),
     minimo_par AS (
       SELECT em.material_id, em.tamanho AS tamanho_chave, em.minimo
         FROM estoque_minimos em
         JOIN materiais m ON m.empresa_id = em.empresa_id AND m.id = em.material_id AND m.ativo
        WHERE em.empresa_id = $1${noMinimo}
     ),
     universo AS (
       SELECT material_id, tamanho_chave FROM lotes_par
       UNION
       SELECT material_id, tamanho_chave FROM demanda_par
       UNION
       SELECT material_id, tamanho_chave FROM minimo_par
       UNION
       SELECT m.id, '' FROM materiais m WHERE m.empresa_id = $1 AND m.ativo${noUniverso} AND m.exige_tamanho = false AND m.estoque_minimo > 0
     ),
     base AS (
       SELECT u.material_id, u.tamanho_chave, m.nome, m.codigo_interno, m.categoria, ${GRUPO_EFETIVO} AS grupo, m.tipo, m.unidade,
              COALESCE(lp.saldo, 0) AS saldo,
              COALESCE(lp.bloqueado, 0) AS bloqueado,
              COALESCE(lp.fisico_utilizavel, 0) AS fisico_utilizavel,
              COALESCE(dp.demanda_pendente, 0) AS demanda_pendente,
              COALESCE(mp.minimo, m.estoque_minimo) AS minimo_efetivo,
              CASE WHEN mp.minimo IS NOT NULL THEN 'PROPRIO' ELSE 'PADRAO' END AS minimo_origem${validadeNaBase}
         FROM universo u
         JOIN materiais m ON m.empresa_id = $1 AND m.id = u.material_id
         LEFT JOIN lotes_par lp ON lp.material_id = u.material_id AND lp.tamanho_chave = u.tamanho_chave
         LEFT JOIN demanda_par dp ON dp.material_id = u.material_id AND dp.tamanho_chave = u.tamanho_chave
         LEFT JOIN minimo_par mp ON mp.material_id = u.material_id AND mp.tamanho_chave = u.tamanho_chave${filtrosDeCadastro}
     ),
     calculada AS (
       SELECT *,
              LEAST(fisico_utilizavel, demanda_pendente) AS comprometido,
              GREATEST(0, fisico_utilizavel - demanda_pendente) AS saldo_livre,
              GREATEST(0, demanda_pendente - fisico_utilizavel) AS sem_cobertura
         FROM base
     ),
     derivada AS (
       SELECT *,
              (minimo_efetivo > 0 AND saldo_livre < minimo_efetivo) AS abaixo_do_minimo,
              GREATEST(0, minimo_efetivo - saldo_livre) AS deficit,
              sem_cobertura + GREATEST(0, minimo_efetivo - saldo_livre) AS necessidade
         FROM calculada
     )`;
}

// $9 é a situação pedida (ou null): cada uma é um campo derivado da posição. $12 é
// "somente com necessidade" (12D-2) e vale junto com a situação, nunca no lugar dela.
const FILTRO_DE_SITUACAO = `WHERE ($9::text IS NULL
            OR ($9::text = 'SEM_ESTOQUE' AND fisico_utilizavel = 0)
            OR ($9::text = 'ABAIXO_MINIMO' AND abaixo_do_minimo)
            OR ($9::text = 'COM_COMPROMETIDO' AND comprometido > 0)
            OR ($9::text = 'SEM_COBERTURA' AND sem_cobertura > 0)
            OR ($9::text = 'COM_NECESSIDADE' AND necessidade > 0))
          AND ($12::boolean IS NOT TRUE OR necessidade > 0)`;

// A lista e o total saem de UMA consulta: o total vem da própria CTE do conjunto filtrado, e a página é
// ligada a ele por LEFT JOIN. Página além da última volta com uma linha só (o total e as colunas do item
// nulas), então o total nunca depende de a página ter linha.
const SQL_LISTAR = `WITH ${posicaoDerivada({ comValidade: true })},
     filtrada AS (
       SELECT * FROM derivada
        ${FILTRO_DE_SITUACAO}
     ),
     total AS (SELECT count(*)::int AS total FROM filtrada),
     pagina AS (
       SELECT * FROM filtrada
        ORDER BY lower(nome), material_id, tamanho_chave
        LIMIT $10 OFFSET $11
     )
     SELECT total.total, pagina.material_id, pagina.nome, pagina.codigo_interno, pagina.categoria, pagina.grupo, pagina.tipo, pagina.unidade,
            pagina.tamanho_chave, pagina.saldo, pagina.bloqueado, pagina.fisico_utilizavel, pagina.demanda_pendente,
            pagina.comprometido, pagina.saldo_livre, pagina.sem_cobertura, pagina.minimo_efetivo, pagina.minimo_origem,
            pagina.abaixo_do_minimo, pagina.deficit, pagina.necessidade,
            to_char(pagina.ca_validade, 'YYYY-MM-DD') AS ca_validade, pagina.validade
       FROM total
       LEFT JOIN pagina ON true
      ORDER BY lower(pagina.nome), pagina.material_id, pagina.tamanho_chave`;

const SQL_RESUMIR = `WITH ${posicaoDerivada({ comValidade: false })}
     SELECT count(*)::int AS pares,
            COALESCE(sum(fisico_utilizavel), 0)::bigint AS fisico_utilizavel,
            COALESCE(sum(demanda_pendente), 0)::bigint AS demanda_pendente,
            COALESCE(sum(comprometido), 0)::bigint AS comprometido,
            COALESCE(sum(saldo_livre), 0)::bigint AS saldo_livre,
            COALESCE(sum(sem_cobertura), 0)::bigint AS sem_cobertura,
            count(*) FILTER (WHERE abaixo_do_minimo)::int AS pares_abaixo_do_minimo,
            COALESCE(sum(deficit), 0)::bigint AS deficit,
            COALESCE(sum(necessidade), 0)::bigint AS necessidade
       FROM derivada`;

// A posição de um material só ($3 é o material): o contexto da entrega mostra ao operador, por tamanho, só números agregados.
const SQL_DO_MATERIAL = `WITH ${posicaoDerivada({ comValidade: false, porMaterial: true })}
     SELECT tamanho_chave, fisico_utilizavel, comprometido, saldo_livre, sem_cobertura, minimo_efetivo, minimo_origem, abaixo_do_minimo
       FROM derivada
      ORDER BY tamanho_chave`;

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError(`${nome} inválido`);
  }
}

function exigirTextoOuNulo(valor, nome) {
  if (valor !== null && typeof valor !== 'string') {
    throw new TypeError(`filtro ${nome} deve ser texto ou null`);
  }
}

function exigirParametrosDaLista({
  hoje, diasAlerta, pagina, limite, categoria, tipo, tamanho, validade, busca, situacao, somenteComNecessidade,
}) {
  exigirDataOperacional(hoje);
  if (typeof somenteComNecessidade !== 'boolean') throw new TypeError('filtro somenteComNecessidade deve ser booleano');
  if (!Number.isInteger(diasAlerta) || diasAlerta < 1) throw new TypeError('prazo de alerta da validade do CA inválido');
  exigirId(pagina, 'página');
  if (!Number.isInteger(limite) || limite < 1 || limite > LIMITE_MAXIMO) throw new TypeError('limite inválido');
  exigirTextoOuNulo(categoria, 'categoria');
  exigirTextoOuNulo(tipo, 'tipo');
  exigirTextoOuNulo(tamanho, 'tamanho');
  if (validade !== null && !VALIDADES.includes(validade)) throw new TypeError('filtro de validade inválido');
  if (busca !== null && (typeof busca !== 'string' || busca.length === 0)) throw new TypeError('busca inválida');
  if (situacao !== null && !SITUACOES.includes(situacao)) throw new TypeError('filtro de situação inválido');
}

const numero = (valor) => Number(valor);

const mapearItem = (l) => ({
  materialId: l.material_id,
  material: l.nome,
  codigoInterno: l.codigo_interno ?? null,
  categoria: l.categoria ?? null,
  grupo: l.grupo ?? null,
  tipo: l.tipo ?? null,
  tamanho: l.tamanho_chave === '' ? null : l.tamanho_chave,
  unidade: l.unidade,
  saldo: numero(l.saldo),
  bloqueado: numero(l.bloqueado),
  fisicoUtilizavel: numero(l.fisico_utilizavel),
  demandaPendente: numero(l.demanda_pendente),
  comprometido: numero(l.comprometido),
  saldoLivre: numero(l.saldo_livre),
  semCobertura: numero(l.sem_cobertura),
  estoqueMinimo: numero(l.minimo_efetivo),
  minimoOrigem: l.minimo_origem,
  abaixoDoMinimo: l.abaixo_do_minimo === true,
  deficit: numero(l.deficit),
  necessidade: numero(l.necessidade),
  caValidade: l.ca_validade ?? null,
  validade: l.validade,
});

/**
 * Uma página da posição de todos os pares, em ordem de nome, material e
 * tamanho (sem tamanho primeiro), com o total do conjunto filtrado.
 *
 * @returns {Promise<{itens: object[], total: number}>}
 */
async function listarPosicoes(executor, empresaId, {
  hoje, diasAlerta, pagina, limite, categoria = null, tipo = null, tamanho = null, validade = null, busca = null, situacao = null, somenteComNecessidade = false,
} = {}) {
  exigirId(empresaId, 'empresa');
  exigirParametrosDaLista({
    hoje, diasAlerta, pagina, limite, categoria, tipo, tamanho, validade, busca, situacao, somenteComNecessidade,
  });

  const { rows } = await executor.query(SQL_LISTAR, [
    empresaId, hoje, diasAlerta, categoria, tipo, tamanho, validade, busca === null ? null : escaparCoringasLike(busca), situacao, limite, (pagina - 1) * limite,
    somenteComNecessidade,
  ]);
  if (rows.length === 0) {
    throw new Error('contrato da posição violado: a consulta não devolveu o total');
  }
  return { itens: rows.filter((l) => l.material_id !== null).map(mapearItem), total: numero(rows[0].total) };
}

/**
 * Os totais do mesmo universo, sem página: o que o Dashboard soma.
 *
 * @returns {Promise<{pares: number, fisicoUtilizavel: number, demandaPendente: number, comprometido: number, saldoLivre: number,
 *   semCobertura: number, paresAbaixoDoMinimo: number, deficit: number, necessidade: number}>}
 */
async function resumirPosicoes(executor, empresaId, { hoje } = {}) {
  exigirId(empresaId, 'empresa');
  exigirDataOperacional(hoje);
  const { rows: [r] } = await executor.query(SQL_RESUMIR, [empresaId, hoje]);
  return {
    pares: numero(r.pares),
    fisicoUtilizavel: numero(r.fisico_utilizavel),
    demandaPendente: numero(r.demanda_pendente),
    comprometido: numero(r.comprometido),
    saldoLivre: numero(r.saldo_livre),
    semCobertura: numero(r.sem_cobertura),
    paresAbaixoDoMinimo: numero(r.pares_abaixo_do_minimo),
    deficit: numero(r.deficit),
    necessidade: numero(r.necessidade),
  };
}

/**
 * A posição agregada dos pares de UM material (todos os tamanhos da posição,
 * inclusive o esgotado, o só com demanda e o só com mínimo próprio), do material
 * ativo: o que o operador vê ao escolher o lote de uma entrega direta. Só
 * números do par, nunca quais solicitações compõem a demanda.
 *
 * @returns {Promise<Array<{tamanho: string|null, fisicoUtilizavel: number, comprometido: number, saldoLivre: number,
 *   semCobertura: number, estoqueMinimo: number, minimoOrigem: string, abaixoDoMinimo: boolean}>>}
 */
async function listarPosicoesDoMaterial(executor, empresaId, materialId, { hoje } = {}) {
  exigirId(empresaId, 'empresa');
  exigirId(materialId, 'material');
  exigirDataOperacional(hoje);
  const { rows } = await executor.query(SQL_DO_MATERIAL, [empresaId, hoje, materialId]);
  return rows.map((l) => ({
    tamanho: l.tamanho_chave === '' ? null : l.tamanho_chave,
    fisicoUtilizavel: numero(l.fisico_utilizavel),
    comprometido: numero(l.comprometido),
    saldoLivre: numero(l.saldo_livre),
    semCobertura: numero(l.sem_cobertura),
    estoqueMinimo: numero(l.minimo_efetivo),
    minimoOrigem: l.minimo_origem,
    abaixoDoMinimo: l.abaixo_do_minimo === true,
  }));
}

module.exports = {
  listarPosicoes, listarPosicoesDoMaterial, resumirPosicoes, SITUACOES, VALIDADES, LIMITE_MAXIMO,
};
