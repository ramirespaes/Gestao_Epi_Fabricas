'use strict';

/**
 * Grade de tamanhos do material (migration 070, Bloco 12, 12G-8).
 *
 * A grade diz quais tamanhos são válidos para o produto; nunca é deduzida dos
 * lotes. Aqui só há leitura e a troca da grade inteira: quem decide se a troca
 * pode acontecer é o serviço de materiais, com o material travado. Sempre por
 * empresa; o executor vem de quem chama.
 */

const TAMANHO_MAXIMO = 20;
const LIMITE_GRADE = 50;

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError(`${nome} inválido`);
  }
}

/** A grade do material, na ordem de exibição; [] é material sem grade. */
async function listarPorMaterial(executor, empresaId, materialId) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(materialId, 'identificador de material');
  const { rows } = await executor.query(
    'SELECT tamanho FROM material_tamanhos WHERE empresa_id = $1 AND material_id = $2 ORDER BY ordem',
    [empresaId, materialId],
  );
  return rows.map((r) => r.tamanho);
}

/** As grades de vários materiais numa leitura só: Map(id → tamanhos), [] para quem não tem. */
async function listarPorMateriais(executor, empresaId, materialIds) {
  exigirId(empresaId, 'identificador de empresa');
  if (!Array.isArray(materialIds)) throw new TypeError('lista de materiais inválida');
  materialIds.forEach((id) => exigirId(id, 'identificador de material'));
  const grades = new Map(materialIds.map((id) => [id, []]));
  if (materialIds.length === 0) return grades;
  const { rows } = await executor.query(
    `SELECT material_id, tamanho FROM material_tamanhos
      WHERE empresa_id = $1 AND material_id = ANY($2::int[])
      ORDER BY material_id, ordem`,
    [empresaId, materialIds],
  );
  for (const r of rows) grades.get(r.material_id).push(r.tamanho);
  return grades;
}

/** Troca a grade inteira pela informada, na ordem dela; [] apaga a grade. */
async function substituir(executor, empresaId, materialId, tamanhos) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(materialId, 'identificador de material');
  if (!Array.isArray(tamanhos) || tamanhos.length > LIMITE_GRADE || tamanhos.some((t) => typeof t !== 'string')) {
    throw new TypeError('grade inválida');
  }
  await executor.query('DELETE FROM material_tamanhos WHERE empresa_id = $1 AND material_id = $2', [empresaId, materialId]);
  if (tamanhos.length === 0) return;
  await executor.query(
    `INSERT INTO material_tamanhos (empresa_id, material_id, tamanho, ordem)
     SELECT $1, $2, g.tamanho, g.ordem::smallint
       FROM unnest($3::text[]) WITH ORDINALITY AS g(tamanho, ordem)`,
    [empresaId, materialId, tamanhos],
  );
}

/**
 * Tamanhos do material que algo ainda usa: lote com saldo, mínimo próprio ou
 * item de solicitação em aberto (pendente ou aprovada, item não reprovado).
 * Lote zerado é histórico e não conta.
 */
async function listarEmUso(executor, empresaId, materialId) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(materialId, 'identificador de material');
  const { rows } = await executor.query(
    `SELECT l.tamanho FROM estoque_lotes l
      WHERE l.empresa_id = $1 AND l.material_id = $2 AND l.tamanho IS NOT NULL AND l.saldo > 0
     UNION
     SELECT m.tamanho FROM estoque_minimos m
      WHERE m.empresa_id = $1 AND m.material_id = $2
     UNION
     SELECT i.tamanho FROM solicitacoes_epi_itens i
       JOIN solicitacoes_epi s ON s.empresa_id = i.empresa_id AND s.id = i.solicitacao_id
      WHERE i.empresa_id = $1 AND i.material_id = $2 AND i.tamanho IS NOT NULL
        AND s.status IN ('PENDENTE', 'APROVADA', 'APROVADA_PARCIAL')
        AND i.decisao IS DISTINCT FROM 'REPROVADO'`,
    [empresaId, materialId],
  );
  return rows.map((r) => r.tamanho);
}

module.exports = {
  TAMANHO_MAXIMO, LIMITE_GRADE, listarPorMaterial, listarPorMateriais, substituir, listarEmUso,
};
