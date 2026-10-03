'use strict';

/**
 * Itens da solicitação de EPI (solicitacoes_epi_itens, migration 065). O
 * pedido do item entra uma vez na criação e não muda; a decisão entra por
 * UPDATE, uma única vez por item. A coerência entre decisão, quantidade e
 * justificativa, e entre os itens e o cabeçalho, é do banco: aqui só validação
 * de tipos. Toda consulta filtra pela empresa.
 */

const MOTIVOS = Object.freeze(['ADMISSAO', 'SUBSTITUICAO_PRAZO', 'DESGASTE_DANO', 'PERDA_EXTRAVIO', 'OUTRO']);
const DECISOES = Object.freeze(['APROVADO', 'REPROVADO']);
const INTEGER_MAXIMO = 2147483647;
const TAMANHO_MAXIMO = 20;
const JUSTIFICATIVA_MAXIMA = 500;

const COLUNAS = Object.freeze([
  'id', 'empresa_id', 'solicitacao_id', 'material_id', 'tamanho', 'quantidade', 'motivo', 'justificativa',
  'previsto_no_ghe', 'decisao', 'quantidade_aprovada', 'justificativa_decisao',
]);
const COLUNAS_ITEM = COLUNAS.join(', ');
const COLUNAS_RETORNO = COLUNAS.map((coluna) => `i.${coluna}`).join(', ');

// A entregue de um item é a soma das entregas ligadas a ele (066); a única definição está aqui.
const ENTREGUE_DO_ITEM = `LEFT JOIN LATERAL (
         SELECT COALESCE(sum(ei.quantidade), 0)::bigint AS quantidade_entregue
           FROM entregas_epi_itens ei
          WHERE ei.empresa_id = i.empresa_id AND ei.solicitacao_item_id = i.id
       ) e ON true`;

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError(`${nome} inválido`);
  }
}

// Conta caracteres, como char_length no banco, não unidades UTF-16.
function exigirTextoOpcional(valor, nome, maximo) {
  if (valor === null) return;
  if (typeof valor !== 'string' || valor.length === 0 || Array.from(valor).length > maximo) {
    throw new TypeError(`${nome} inválido`);
  }
}

const mapear = (l) => ({
  id: l.id,
  empresaId: l.empresa_id,
  solicitacaoId: l.solicitacao_id,
  materialId: l.material_id,
  tamanho: l.tamanho,
  quantidade: l.quantidade,
  motivo: l.motivo,
  justificativa: l.justificativa,
  previstoNoGhe: l.previsto_no_ghe,
  decisao: l.decisao,
  quantidadeAprovada: l.quantidade_aprovada,
  justificativaDecisao: l.justificativa_decisao,
});

/** Grava um item sem decisão. Só dentro da transação que cria o cabeçalho. */
async function criar(executor, {
  empresaId, solicitacaoId, materialId, tamanho = null, quantidade, motivo, justificativa = null, previstoNoGhe,
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(solicitacaoId, 'identificador de solicitação');
  exigirId(materialId, 'identificador de material');
  exigirTextoOpcional(tamanho, 'tamanho', TAMANHO_MAXIMO);
  if (!Number.isInteger(quantidade) || quantidade <= 0 || quantidade > INTEGER_MAXIMO) throw new TypeError('quantidade inválida');
  if (!MOTIVOS.includes(motivo)) throw new TypeError('motivo inválido');
  exigirTextoOpcional(justificativa, 'justificativa', JUSTIFICATIVA_MAXIMA);
  if (typeof previstoNoGhe !== 'boolean') throw new TypeError('previsão no GHE inválida');

  const { rows } = await executor.query(
    `INSERT INTO solicitacoes_epi_itens
       (empresa_id, solicitacao_id, material_id, tamanho, quantidade, motivo, justificativa, previsto_no_ghe)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${COLUNAS_ITEM}`,
    [empresaId, solicitacaoId, materialId, tamanho, quantidade, motivo, justificativa, previstoNoGhe],
  );
  return mapear(rows[0]);
}

/** Os itens da solicitação da empresa, em ordem de id. */
async function listarPorSolicitacao(executor, empresaId, solicitacaoId) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(solicitacaoId, 'identificador de solicitação');
  const { rows } = await executor.query(
    `SELECT ${COLUNAS_ITEM} FROM solicitacoes_epi_itens WHERE empresa_id = $1 AND solicitacao_id = $2 ORDER BY id`,
    [empresaId, solicitacaoId],
  );
  return rows.map(mapear);
}

/**
 * Os itens da solicitação com a quantidade entregue de cada um, em ordem de
 * id. A entregue é derivada: a soma das entregas ligadas ao item (066), de
 * qualquer lote e de qualquer ato; a entrega DIRETA não conta, porque não tem
 * vínculo. Nada é lido de coluna de contador. O pendente é a aprovada menos
 * a entregue, e o banco garante que a entregue nunca passa da aprovada.
 */
async function listarPorSolicitacaoComEntregue(executor, empresaId, solicitacaoId) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(solicitacaoId, 'identificador de solicitação');
  const { rows } = await executor.query(
    `SELECT ${COLUNAS_RETORNO}, e.quantidade_entregue
       FROM solicitacoes_epi_itens i
       ${ENTREGUE_DO_ITEM}
      WHERE i.empresa_id = $1 AND i.solicitacao_id = $2
      ORDER BY i.id`,
    [empresaId, solicitacaoId],
  );
  // bigint chega como texto no pg.
  return rows.map((l) => ({ ...mapear(l), quantidadeEntregue: Number(l.quantidade_entregue) }));
}

/**
 * Como listarPorSolicitacaoComEntregue, para várias solicitações da empresa
 * numa consulta só (as listagens da 12E-1), em ordem de solicitação e de id.
 * Lista vazia volta vazia sem consultar.
 */
async function listarPorSolicitacoesComEntregue(executor, empresaId, solicitacaoIds) {
  exigirId(empresaId, 'identificador de empresa');
  if (!Array.isArray(solicitacaoIds)) throw new TypeError('lista de solicitações inválida');
  for (const id of solicitacaoIds) exigirId(id, 'identificador de solicitação');
  if (solicitacaoIds.length === 0) return [];
  const { rows } = await executor.query(
    `SELECT ${COLUNAS_RETORNO}, e.quantidade_entregue
       FROM solicitacoes_epi_itens i
       ${ENTREGUE_DO_ITEM}
      WHERE i.empresa_id = $1 AND i.solicitacao_id = ANY($2::int[])
      ORDER BY i.solicitacao_id, i.id`,
    [empresaId, solicitacaoIds],
  );
  return rows.map((l) => ({ ...mapear(l), quantidadeEntregue: Number(l.quantidade_entregue) }));
}

function validarDecisoes(decisoes) {
  if (!Array.isArray(decisoes) || decisoes.length === 0) throw new TypeError('lista de decisões inválida');
  const vistos = new Set();
  for (const decisao of decisoes) {
    exigirId(decisao?.itemId, 'identificador de item');
    if (vistos.has(decisao.itemId)) throw new TypeError('item repetido nas decisões');
    vistos.add(decisao.itemId);
    if (!DECISOES.includes(decisao.decisao)) throw new TypeError('decisão inválida');
    if (!Number.isInteger(decisao.quantidadeAprovada) || decisao.quantidadeAprovada < 0 || decisao.quantidadeAprovada > INTEGER_MAXIMO) {
      throw new TypeError('quantidade aprovada inválida');
    }
    exigirTextoOpcional(decisao.justificativa ?? null, 'justificativa', JUSTIFICATIVA_MAXIMA);
  }
}

/**
 * Decide todos os itens numa instrução só, apenas os da solicitação da
 * empresa que ainda não têm decisão. Devolve as linhas realmente atualizadas,
 * por id: quem chama compara a contagem com a esperada. O cabeçalho é
 * atualizado na mesma transação, e o banco confere no COMMIT que os dois
 * batem. Só dentro de transação.
 */
async function decidirTodos(executor, empresaId, solicitacaoId, decisoes) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(solicitacaoId, 'identificador de solicitação');
  validarDecisoes(decisoes);
  const { rows } = await executor.query(
    `UPDATE solicitacoes_epi_itens AS i
        SET decisao = d.decisao, quantidade_aprovada = d.quantidade_aprovada, justificativa_decisao = d.justificativa
       FROM unnest($3::int[], $4::text[], $5::int[], $6::text[]) AS d(item_id, decisao, quantidade_aprovada, justificativa)
      WHERE i.empresa_id = $1 AND i.solicitacao_id = $2 AND i.id = d.item_id AND i.decisao IS NULL
      RETURNING ${COLUNAS_RETORNO}`,
    [
      empresaId,
      solicitacaoId,
      decisoes.map((d) => d.itemId),
      decisoes.map((d) => d.decisao),
      decisoes.map((d) => d.quantidadeAprovada),
      decisoes.map((d) => d.justificativa ?? null),
    ],
  );
  return rows.map(mapear).sort((a, b) => a.id - b.id);
}

module.exports = {
  MOTIVOS, DECISOES, TAMANHO_MAXIMO, JUSTIFICATIVA_MAXIMA, criar, listarPorSolicitacao, listarPorSolicitacaoComEntregue, listarPorSolicitacoesComEntregue, decidirTodos,
};
