'use strict';

const { exigirDataOperacional } = require('../utils/data-operacional');
const { parOrdenados, chaveDoTamanho } = require('../utils/lock-par-estoque');
const sqlPosicao = require('./sql/posicao-estoque');

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
 *   D = demanda aprovada pendente: a quantidade aprovada dos itens APROVADOS
 *       de solicitações APROVADA ou APROVADA_PARCIAL, de trabalhador e material
 *       ativos, MENOS o que já foi entregue. A entregue de um item é a soma das
 *       entregas ligadas a ele (entregas_epi_itens.solicitacao_item_id, 066),
 *       de qualquer lote e de qualquer ato; nada é lido de coluna de contador.
 *       Item inteiramente entregue sai da fila, e a solicitação fechada
 *       (ENTREGUE) já não tem status atendível. A suspensão por inativação é
 *       derivada: o status persistido não muda e a solicitação volta à fila
 *       quando reativada. A entrega DIRETA não tem vínculo e só baixa o físico.
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

// A definição de "utilizável" e da demanda pendente é única (sql/posicao-estoque.js):
// aqui só digo os meus aliases e parâmetros. $1 é a empresa, $2 a data operacional e
// $3 a solicitação (ou null).
const ITEM = { item: 'i', solicitacao: 's', funcionario: 'f', material: 'm', entregue: 'e' };
const LOTE = { lote: 'l', material: 'm', hoje: '$2' };

// Fila das demandas atendíveis, com a soma da demanda anterior no mesmo par.
// O pendente é a aprovada menos o entregue derivado; o item sem pendente não
// entra, e por isso a janela soma só o que ainda falta entregar. `restricaoDosPares`
// diz quais pares entram na fila (a empresa inteira ou só os das solicitações pedidas);
// a janela, a ordem e a regra de atendível são as mesmas em qualquer caso.
const filaDe = (restricaoDosPares) => `fila AS (
     SELECT i.id AS item_id, i.solicitacao_id, i.material_id, i.tamanho, ${sqlPosicao.pendenteDoItem(ITEM)} AS pendente, s.decidida_em,
            COALESCE(sum(${sqlPosicao.pendenteDoItem(ITEM)}) OVER (
              PARTITION BY i.material_id, COALESCE(i.tamanho, '')
              ORDER BY s.decidida_em, s.id, i.id
              ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS acumulado_anterior
       FROM solicitacoes_epi s
       JOIN solicitacoes_epi_itens i ON i.empresa_id = s.empresa_id AND i.solicitacao_id = s.id
       JOIN funcionarios f ON f.empresa_id = s.empresa_id AND f.id = s.funcionario_id
       JOIN materiais m ON m.empresa_id = i.empresa_id AND m.id = i.material_id
       ${sqlPosicao.entregueDoItem(ITEM)}
      WHERE s.empresa_id = $1
        AND ${sqlPosicao.statusAtendiveis(ITEM)}
        AND i.decisao = 'APROVADO'
        AND ${sqlPosicao.itemComPendente(ITEM)}
        AND f.ativo
        AND m.ativo
        AND ${restricaoDosPares}
   )`;

const PARES_DE_UMA = `($3::int IS NULL OR (i.material_id, COALESCE(i.tamanho, '')) IN (
              SELECT a.material_id, COALESCE(a.tamanho, '')
                FROM solicitacoes_epi_itens a
               WHERE a.empresa_id = $1 AND a.solicitacao_id = $3))`;
const PARES_DE_VARIAS = `((i.material_id, COALESCE(i.tamanho, '')) IN (
              SELECT a.material_id, COALESCE(a.tamanho, '')
                FROM solicitacoes_epi_itens a
               WHERE a.empresa_id = $1 AND a.solicitacao_id = ANY($3::int[])))`;

// U de cada par que aparece na fila.
const FISICO_DA_FILA = `fisico AS (
     SELECT fl.material_id, COALESCE(fl.tamanho, '') AS tamanho_chave,
            COALESCE(sum(${sqlPosicao.fisicoUtilizavel(LOTE)}), 0)::bigint AS fisico_utilizavel
       FROM (SELECT DISTINCT material_id, tamanho FROM fila) fl
       JOIN materiais m ON m.empresa_id = $1 AND m.id = fl.material_id AND m.ativo
       LEFT JOIN estoque_lotes l ON l.empresa_id = $1 AND l.material_id = fl.material_id
        AND COALESCE(l.tamanho, '') = COALESCE(fl.tamanho, '') AND l.saldo > 0
      GROUP BY fl.material_id, COALESCE(fl.tamanho, '')
   )`;

const consultaDaCobertura = (restricaoDosPares, filtroDasSolicitacoes) => `WITH ${filaDe(restricaoDosPares)},
     ${FISICO_DA_FILA}
     SELECT fl.item_id, fl.solicitacao_id, fl.material_id, fl.tamanho, fl.decidida_em, fl.pendente, fl.acumulado_anterior,
            fi.fisico_utilizavel,
            LEAST(fl.pendente, GREATEST(0, fi.fisico_utilizavel - fl.acumulado_anterior)) AS coberta
       FROM fila fl
       JOIN fisico fi ON fi.material_id = fl.material_id AND fi.tamanho_chave = COALESCE(fl.tamanho, '')
      WHERE ${filtroDasSolicitacoes}
      ORDER BY fl.decidida_em, fl.solicitacao_id, fl.item_id`;

const SQL_COBERTURA_DE_UMA = consultaDaCobertura(PARES_DE_UMA, '($3::int IS NULL OR fl.solicitacao_id = $3)');
const SQL_COBERTURA_DE_VARIAS = consultaDaCobertura(PARES_DE_VARIAS, 'fl.solicitacao_id = ANY($3::int[])');

function mapearCobertura(l) {
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
}

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

  const { rows } = await executor.query(SQL_COBERTURA_DE_UMA, [empresaId, hoje, solicitacaoId]);
  return rows.map(mapearCobertura);
}

/**
 * Como listarCobertura, para várias solicitações numa consulta só (as
 * listagens da 12E-1): devolve os itens delas, com a cobertura calculada
 * contra a fila inteira dos pares envolvidos. Lista vazia volta vazia sem
 * consultar.
 */
async function listarCoberturaDasSolicitacoes(executor, empresaId, { hoje, solicitacaoIds } = {}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirDataOperacional(hoje);
  if (!Array.isArray(solicitacaoIds)) throw new TypeError('lista de solicitações inválida');
  for (const id of solicitacaoIds) exigirId(id, 'identificador de solicitação');
  if (solicitacaoIds.length === 0) return [];

  const { rows } = await executor.query(SQL_COBERTURA_DE_VARIAS, [empresaId, hoje, solicitacaoIds]);
  return rows.map(mapearCobertura);
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
              COALESCE(sum(${sqlPosicao.fisicoUtilizavel(LOTE)}), 0)::bigint AS fisico_utilizavel
         FROM pares p
         LEFT JOIN materiais m ON m.empresa_id = $1 AND m.id = p.material_id AND m.ativo
         LEFT JOIN estoque_lotes l ON l.empresa_id = $1 AND l.material_id = m.id
          AND COALESCE(l.tamanho, '') = p.tamanho_chave AND l.saldo > 0
        GROUP BY p.material_id, p.tamanho_chave
     ),
     demanda AS (
       SELECT p.material_id, p.tamanho_chave, sum(${sqlPosicao.pendenteDoItem(ITEM)})::bigint AS demanda_pendente
         FROM pares p
         JOIN solicitacoes_epi_itens i ON i.empresa_id = $1 AND i.material_id = p.material_id
          AND COALESCE(i.tamanho, '') = p.tamanho_chave AND i.decisao = 'APROVADO'
         ${sqlPosicao.fonteDaDemanda(ITEM)}
        WHERE ${sqlPosicao.itemComPendente(ITEM)}
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

module.exports = { listarCobertura, listarCoberturaDasSolicitacoes, lerPosicoes };
