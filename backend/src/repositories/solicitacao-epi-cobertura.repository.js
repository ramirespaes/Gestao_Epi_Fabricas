'use strict';

const { exigirDataOperacional } = require('../utils/data-operacional');
const { parOrdenados, chaveDoTamanho } = require('../utils/lock-par-estoque');

/**
 * Posição de estoque e cobertura FIFO das solicitações aprovadas. A reserva é
 * lógica e derivada, por empresa, material e tamanho: nada é gravado, e a
 * cobertura muda sozinha com a entrada, a baixa, a entrega, a validade do CA,
 * a inativação e o cancelamento.
 *
 *   U = físico utilizável: saldo dos lotes de material ativo, menos o que o CA
 *       ausente ou vencido bloqueia (como no dashboard), na data operacional
 *       recebida; não uso CURRENT_DATE, porque o fuso do banco não é o de São
 *       Paulo.
 *   D = demanda aprovada pendente: quantidade aprovada dos itens APROVADOS de
 *       solicitações APROVADA ou APROVADA_PARCIAL, de trabalhador e material
 *       ativos. A suspensão por inativação é derivada: o status persistido não
 *       muda e a solicitação volta à fila quando reativada. Até a integração
 *       da entrega (12C) nada foi entregue por solicitação, então a pendente
 *       é a aprovada; a entrega já concluída sai porque a solicitação vira
 *       ENTREGUE.
 *   C = min(U, D)   L = max(0, U − D)   G = max(0, D − U)
 *
 * Tamanho ausente é o texto vazio nas comparações (o mesmo COALESCE dos
 * índices); como o banco recusa tamanho vazio, não colide com tamanho real.
 * A fila é FIFO por empresa, material e tamanho, em decidida_em, solicitação
 * e item: a mais antiga consome o físico primeiro. Leitura pura.
 */

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError(`${nome} inválido`);
  }
}

// Fila das demandas atendíveis, com a soma da demanda anterior no mesmo par.
const FILA = `fila AS (
     SELECT i.id AS item_id, i.solicitacao_id, i.material_id, i.tamanho, i.quantidade_aprovada AS pendente, s.decidida_em,
            COALESCE(sum(i.quantidade_aprovada) OVER (
              PARTITION BY i.material_id, COALESCE(i.tamanho, '')
              ORDER BY s.decidida_em, s.id, i.id
              ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS acumulado_anterior
       FROM solicitacoes_epi s
       JOIN solicitacoes_epi_itens i ON i.empresa_id = s.empresa_id AND i.solicitacao_id = s.id
       JOIN funcionarios f ON f.empresa_id = s.empresa_id AND f.id = s.funcionario_id
       JOIN materiais m ON m.empresa_id = i.empresa_id AND m.id = i.material_id
      WHERE s.empresa_id = $1
        AND s.status IN ('APROVADA', 'APROVADA_PARCIAL')
        AND i.decisao = 'APROVADO'
        AND f.ativo
        AND m.ativo
        AND ($3::int IS NULL OR (i.material_id, COALESCE(i.tamanho, '')) IN (
              SELECT a.material_id, COALESCE(a.tamanho, '')
                FROM solicitacoes_epi_itens a
               WHERE a.empresa_id = $1 AND a.solicitacao_id = $3))
   )`;

// U de cada par que aparece na fila.
const FISICO_DA_FILA = `fisico AS (
     SELECT fl.material_id, COALESCE(fl.tamanho, '') AS tamanho_chave,
            COALESCE(sum(CASE WHEN m.exige_ca AND (l.ca_validade IS NULL OR l.ca_validade < $2::date) THEN 0 ELSE l.saldo END), 0)::bigint AS fisico_utilizavel
       FROM (SELECT DISTINCT material_id, tamanho FROM fila) fl
       JOIN materiais m ON m.empresa_id = $1 AND m.id = fl.material_id AND m.ativo
       LEFT JOIN estoque_lotes l ON l.empresa_id = $1 AND l.material_id = fl.material_id
        AND COALESCE(l.tamanho, '') = COALESCE(fl.tamanho, '') AND l.saldo > 0
      GROUP BY fl.material_id, COALESCE(fl.tamanho, '')
   )`;

/**
 * A fila FIFO de itens aprovados da empresa, cada um com a quantidade
 * pendente, a demanda anterior no par, o físico utilizável do par e a parte
 * coberta. Com `solicitacaoId`, só os itens dessa solicitação, mas a cobertura
 * é calculada contra a fila inteira dos seus pares: as mais antigas consomem
 * primeiro.
 */
async function listarCobertura(executor, empresaId, { hoje, solicitacaoId = null } = {}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirDataOperacional(hoje);
  if (solicitacaoId !== null) exigirId(solicitacaoId, 'identificador de solicitação');

  const { rows } = await executor.query(
    `WITH ${FILA},
     ${FISICO_DA_FILA}
     SELECT fl.item_id, fl.solicitacao_id, fl.material_id, fl.tamanho, fl.decidida_em, fl.pendente, fl.acumulado_anterior,
            fi.fisico_utilizavel,
            LEAST(fl.pendente, GREATEST(0, fi.fisico_utilizavel - fl.acumulado_anterior)) AS coberta
       FROM fila fl
       JOIN fisico fi ON fi.material_id = fl.material_id AND fi.tamanho_chave = COALESCE(fl.tamanho, '')
      WHERE ($3::int IS NULL OR fl.solicitacao_id = $3)
      ORDER BY fl.decidida_em, fl.solicitacao_id, fl.item_id`,
    [empresaId, hoje, solicitacaoId],
  );
  return rows.map((l) => {
    const pendente = Number(l.pendente);
    const coberta = Number(l.coberta);
    return {
      itemId: l.item_id,
      solicitacaoId: l.solicitacao_id,
      materialId: l.material_id,
      tamanho: l.tamanho,
      decididaEm: l.decidida_em,
      quantidadePendente: pendente,
      acumuladoAnterior: Number(l.acumulado_anterior),
      fisicoUtilizavel: Number(l.fisico_utilizavel),
      coberta,
      semCobertura: pendente - coberta,
    };
  });
}

const POSICAO_ZERADA = Object.freeze({ fisico_utilizavel: 0, demanda_pendente: 0, comprometido: 0, saldo_livre: 0, sem_cobertura: 0 });

/**
 * U, D, C, L e G de cada par pedido (sem repetição, em ordem canônica). Par
 * sem lote e sem demanda volta com zeros. L e G nunca ficam negativos, e C
 * nunca passa de U nem de D.
 */
async function lerPosicoes(executor, empresaId, pares, { hoje } = {}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirDataOperacional(hoje);
  const ordenados = parOrdenados(pares);
  if (ordenados.length === 0) return [];

  const { rows } = await executor.query(
    `WITH pares AS (
       SELECT p.material_id, p.tamanho_chave
         FROM unnest($3::int[], $4::text[]) AS p(material_id, tamanho_chave)
     ),
     fisico AS (
       SELECT p.material_id, p.tamanho_chave,
              COALESCE(sum(CASE WHEN m.exige_ca AND (l.ca_validade IS NULL OR l.ca_validade < $2::date) THEN 0 ELSE l.saldo END), 0)::bigint AS fisico_utilizavel
         FROM pares p
         LEFT JOIN materiais m ON m.empresa_id = $1 AND m.id = p.material_id AND m.ativo
         LEFT JOIN estoque_lotes l ON l.empresa_id = $1 AND l.material_id = m.id
          AND COALESCE(l.tamanho, '') = p.tamanho_chave AND l.saldo > 0
        GROUP BY p.material_id, p.tamanho_chave
     ),
     demanda AS (
       SELECT p.material_id, p.tamanho_chave, sum(i.quantidade_aprovada)::bigint AS demanda_pendente
         FROM pares p
         JOIN solicitacoes_epi_itens i ON i.empresa_id = $1 AND i.material_id = p.material_id
          AND COALESCE(i.tamanho, '') = p.tamanho_chave AND i.decisao = 'APROVADO'
         JOIN solicitacoes_epi s ON s.empresa_id = i.empresa_id AND s.id = i.solicitacao_id
          AND s.status IN ('APROVADA', 'APROVADA_PARCIAL')
         JOIN funcionarios f ON f.empresa_id = s.empresa_id AND f.id = s.funcionario_id AND f.ativo
         JOIN materiais m ON m.empresa_id = i.empresa_id AND m.id = i.material_id AND m.ativo
        GROUP BY p.material_id, p.tamanho_chave
     ),
     posicao AS (
       SELECT fi.material_id, fi.tamanho_chave, fi.fisico_utilizavel, COALESCE(de.demanda_pendente, 0) AS demanda_pendente
         FROM fisico fi
         LEFT JOIN demanda de ON de.material_id = fi.material_id AND de.tamanho_chave = fi.tamanho_chave
     )
     SELECT material_id, tamanho_chave, fisico_utilizavel, demanda_pendente,
            LEAST(fisico_utilizavel, demanda_pendente) AS comprometido,
            GREATEST(0, fisico_utilizavel - demanda_pendente) AS saldo_livre,
            GREATEST(0, demanda_pendente - fisico_utilizavel) AS sem_cobertura
       FROM posicao`,
    [empresaId, hoje, ordenados.map((p) => p.materialId), ordenados.map((p) => chaveDoTamanho(p.tamanho))],
  );

  const porPar = new Map(rows.map((l) => [`${l.material_id}\n${l.tamanho_chave}`, l]));
  return ordenados.map((par) => {
    const l = porPar.get(`${par.materialId}\n${chaveDoTamanho(par.tamanho)}`) ?? POSICAO_ZERADA;
    return {
      materialId: par.materialId,
      tamanho: par.tamanho,
      fisicoUtilizavel: Number(l.fisico_utilizavel),
      demandaPendente: Number(l.demanda_pendente),
      comprometido: Number(l.comprometido),
      saldoLivre: Number(l.saldo_livre),
      semCobertura: Number(l.sem_cobertura),
    };
  });
}

module.exports = { listarCobertura, lerPosicoes };
