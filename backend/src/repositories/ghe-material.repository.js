'use strict';

const sqlPrevisto = require('./sql/previsto-ghe');

/**
 * Repositório da matriz GHE × EPI (ghe_materiais, migration 041). Bloco 9,
 * Etapa C, Parte C5.
 *
 * Mesmo padrão dos demais repositórios: executor por parâmetro, validação
 * de formato via exigir*, nenhuma regra de negócio (GHE/material ativos são
 * decididos no serviço) e nenhuma decisão de autorização (recurso
 * `employeeGroups`, nas rotas). Propaga violações do PostgreSQL sem
 * traduzir — notadamente `uq_ghe_materiais` (vínculo duplicado) e as FKs
 * compostas de mesma empresa.
 *
 * empresaId é sempre o filtro de isolamento e nunca é opcional.
 */

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError(`${nome} inválido`);
  }
}

/**
 * Materiais da empresa para a matriz de um GHE, com `vinculado`. Entram os
 * ATIVOS e, além deles, os inativos que já estão vinculados (um vínculo
 * existente continua visível — e removível — depois da inativação).
 * Ordenados por nome sem diferenciar maiúsculas.
 *
 * O GHE associa o material, não um CA: o CA real é o do lote, conhecido na
 * entrega. As colunas antigas de CA do cadastro não são lidas.
 */
async function listarMatriz(executor, empresaId, gheId) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(gheId, 'identificador de GHE');

  const { rows } = await executor.query(
    `SELECT m.id, m.nome, m.tipo, m.categoria, m.codigo_interno, m.prazo_uso_dias, m.unidade, m.ativo,
            (gm.id IS NOT NULL) AS vinculado
       FROM materiais m
       LEFT JOIN ghe_materiais gm
         ON gm.empresa_id = m.empresa_id AND gm.material_id = m.id AND gm.grupo_homogeneo_id = $2
      WHERE m.empresa_id = $1
        AND (m.ativo OR gm.id IS NOT NULL)
      ORDER BY lower(m.nome), m.id`,
    [empresaId, gheId],
  );

  return rows.map((l) => ({
    id: l.id,
    nome: l.nome,
    tipo: l.tipo,
    categoria: l.categoria ?? null,
    codigoInterno: l.codigo_interno ?? null,
    prazoUsoDias: l.prazo_uso_dias,
    unidade: l.unidade,
    ativo: l.ativo,
    vinculado: l.vinculado,
  }));
}

async function inserir(executor, { empresaId, gheId, materialId }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(gheId, 'identificador de GHE');
  exigirId(materialId, 'identificador de material');

  const { rows } = await executor.query(
    `INSERT INTO ghe_materiais (empresa_id, grupo_homogeneo_id, material_id)
     VALUES ($1, $2, $3)
     RETURNING grupo_homogeneo_id, material_id, criado_em`,
    [empresaId, gheId, materialId],
  );

  return { grupoHomogeneoId: rows[0].grupo_homogeneo_id, materialId: rows[0].material_id, criadoEm: rows[0].criado_em };
}

/**
 * Dos materiais informados, os ids PREVISTOS no GHE pela regra efetiva (vínculo direto OU vínculo do tipo do material),
 * para decidir previsto_no_ghe ao criar a solicitação e ao registrar a entrega. A regra é a mesma dos contextos: vem do
 * fragmento único de sql/previsto-ghe.js. Não filtra por material ativo (quem chama já validou os materiais).
 */
async function listarMaterialIdsPrevistos(executor, empresaId, gheId, materialIds) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(gheId, 'identificador de GHE');
  if (!Array.isArray(materialIds) || !materialIds.every((id) => Number.isInteger(id) && id > 0)) {
    throw new TypeError('materialIds inválido');
  }
  if (materialIds.length === 0) return [];

  const { rows } = await executor.query(
    `SELECT m.id FROM materiais m
      WHERE m.empresa_id = $1 AND m.id = ANY($3::int[]) AND ${sqlPrevisto.previstoNoGhe({ material: 'm', ghe: '$2' })}
      ORDER BY m.id`,
    [empresaId, gheId, materialIds],
  );
  return rows.map((l) => l.id);
}

/** Ids dos materiais com vínculo DIRETO ao GHE (ghe_materiais). Não é a regra de previsto: veja listarMaterialIdsPrevistos. */
async function listarMaterialIdsVinculados(executor, empresaId, gheId) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(gheId, 'identificador de GHE');

  const { rows } = await executor.query(
    'SELECT material_id FROM ghe_materiais WHERE empresa_id = $1 AND grupo_homogeneo_id = $2 ORDER BY material_id',
    [empresaId, gheId],
  );
  return rows.map((l) => l.material_id);
}

/** @returns {Promise<boolean>} true se havia vínculo e ele foi removido */
async function remover(executor, { empresaId, gheId, materialId }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(gheId, 'identificador de GHE');
  exigirId(materialId, 'identificador de material');

  const { rowCount } = await executor.query(
    'DELETE FROM ghe_materiais WHERE empresa_id = $1 AND grupo_homogeneo_id = $2 AND material_id = $3',
    [empresaId, gheId, materialId],
  );

  return rowCount === 1;
}

module.exports = { listarMatriz, listarMaterialIdsVinculados, listarMaterialIdsPrevistos, inserir, remover };
