'use strict';

const sqlPosicao = require('./sql/posicao-estoque');

/**
 * Atendimento Token — leitura das solicitações EM ABERTO de um funcionário (Etapa G). Só leitura, sempre por empresa e por funcionário,
 * sem trava. É a única definição de "item em aberto" do Token: a consulta do tablet e a prevenção de duplicidade do pedido usam esta mesma
 * função, para nunca divergirem.
 *
 * Item em aberto = item cuja quantidade ainda está pendente:
 *   - solicitação PENDENTE: o item (ainda sem decisão) vale pela quantidade solicitada;
 *   - solicitação APROVADA ou APROVADA_PARCIAL: o item APROVADO cuja aprovada excede a entregue (entregue derivada das entregas ligadas
 *     ao item, migration 066, pelos fragmentos únicos de sql/posicao-estoque.js); item REPROVADO e item inteiramente entregue ficam fora.
 * ENTREGUE, CANCELADA, REPROVADA e ENCERRADA nunca entram. Pedidos internos e do Autoatendimento entram igualmente. Nenhuma regra nova de
 * estoque, reserva ou cobertura: a cobertura continua sendo a da 12G-6, lida pelo serviço.
 */

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) throw new TypeError(`${nome} inválido`);
}

const DEMANDA = { item: 'i', solicitacao: 's', funcionario: 'f', material: 'm', entregue: 'e' };

/**
 * Itens em aberto do funcionário, na ordem de solicitação e de item.
 * @returns {Promise<Array<{ itemId, solicitacaoId, status, materialId, tamanho, quantidadeSolicitada, decisao, quantidadeAprovada, quantidadeEntregue }>>}
 */
async function listarItensEmAberto(executor, { empresaId, funcionarioId }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(funcionarioId, 'identificador de funcionário');
  const { rows } = await executor.query(
    `SELECT i.id AS item_id, i.solicitacao_id, s.status, i.material_id, i.tamanho, i.quantidade, i.decisao, i.quantidade_aprovada,
            COALESCE(e.entregue, 0)::bigint AS entregue
       FROM solicitacoes_epi s
       JOIN solicitacoes_epi_itens i ON i.empresa_id = s.empresa_id AND i.solicitacao_id = s.id
       ${sqlPosicao.entregueDoItem(DEMANDA)}
      WHERE s.empresa_id = $1 AND s.funcionario_id = $2
        AND (s.status = 'PENDENTE'
             OR (s.status IN ('APROVADA', 'APROVADA_PARCIAL') AND i.decisao = 'APROVADO' AND ${sqlPosicao.itemComPendente(DEMANDA)}))
      ORDER BY i.solicitacao_id, i.id`,
    [empresaId, funcionarioId],
  );
  return rows.map((l) => ({
    itemId: l.item_id,
    solicitacaoId: l.solicitacao_id,
    status: l.status,
    materialId: l.material_id,
    tamanho: l.tamanho,
    quantidadeSolicitada: l.quantidade,
    decisao: l.decisao,
    quantidadeAprovada: l.quantidade_aprovada,
    quantidadeEntregue: Number(l.entregue),
  }));
}

/** Nome dos materiais (somente o que a consulta mostra), sempre pela empresa. */
async function nomesDosMateriais(executor, { empresaId, materialIds }) {
  exigirId(empresaId, 'identificador de empresa');
  if (!Array.isArray(materialIds)) throw new TypeError('lista de materiais inválida');
  for (const id of materialIds) exigirId(id, 'identificador de material');
  if (materialIds.length === 0) return new Map();
  const { rows } = await executor.query('SELECT id, nome FROM materiais WHERE empresa_id = $1 AND id = ANY($2::int[])', [empresaId, materialIds]);
  return new Map(rows.map((m) => [m.id, m.nome]));
}

module.exports = { listarItensEmAberto, nomesDosMateriais };
