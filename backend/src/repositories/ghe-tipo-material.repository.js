'use strict';

/**
 * Repositório do vínculo GHE × tipo de material (ghe_tipos_material, migration 083). Executor por parâmetro, nenhuma
 * regra de negócio, empresa_id sempre no filtro. A unicidade (uq_ghe_tipos_material) e as FKs compostas de mesma
 * empresa são do banco; o INSERT usa ON CONFLICT DO NOTHING para o serviço tratar a corrida sem erro.
 */

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError(`${nome} inválido`);
  }
}

function exigirClassificacao(valor) {
  if (valor !== 'OBRIGATORIO' && valor !== 'NAO_OBRIGATORIO') {
    throw new TypeError('classificação inválida');
  }
}

const mapear = (l) => (l === undefined ? null : {
  grupoHomogeneoId: l.grupo_homogeneo_id, tipoMaterialId: l.tipo_material_id, classificacao: l.classificacao,
});

/** Tipos ativos da empresa e os inativos que já estão ligados a este GHE, com a classificação (null se não ligado). */
async function listarMatriz(executor, empresaId, gheId) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(gheId, 'identificador de GHE');

  const { rows } = await executor.query(
    `SELECT t.id, t.nome, t.grupo, t.grupo_protecao, t.ativo, gt.classificacao
       FROM tipos_material t
       LEFT JOIN ghe_tipos_material gt
         ON gt.empresa_id = t.empresa_id AND gt.tipo_material_id = t.id AND gt.grupo_homogeneo_id = $2
      WHERE t.empresa_id = $1
        AND (t.ativo OR gt.id IS NOT NULL)
      ORDER BY t.grupo, t.grupo_protecao, lower(t.nome), t.id`,
    [empresaId, gheId],
  );

  return rows.map((l) => ({
    id: l.id,
    nome: l.nome,
    grupo: l.grupo,
    grupoProtecao: l.grupo_protecao,
    ativo: l.ativo,
    vinculado: l.classificacao !== null,
    classificacao: l.classificacao,
  }));
}

/** Vínculo existente, travado com FOR UPDATE (dentro de transação). */
async function buscarParaAtualizacao(executor, { empresaId, gheId, tipoId }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(gheId, 'identificador de GHE');
  exigirId(tipoId, 'identificador de tipo');

  const { rows } = await executor.query(
    `SELECT grupo_homogeneo_id, tipo_material_id, classificacao FROM ghe_tipos_material
      WHERE empresa_id = $1 AND grupo_homogeneo_id = $2 AND tipo_material_id = $3 FOR UPDATE`,
    [empresaId, gheId, tipoId],
  );
  return mapear(rows[0]);
}

/** Cria o vínculo; devolve null se outro já o criou (o serviço relê o existente). */
async function inserirSeAusente(executor, { empresaId, gheId, tipoId, classificacao }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(gheId, 'identificador de GHE');
  exigirId(tipoId, 'identificador de tipo');
  exigirClassificacao(classificacao);

  const { rows } = await executor.query(
    `INSERT INTO ghe_tipos_material (empresa_id, grupo_homogeneo_id, tipo_material_id, classificacao)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (empresa_id, grupo_homogeneo_id, tipo_material_id) DO NOTHING
     RETURNING grupo_homogeneo_id, tipo_material_id, classificacao`,
    [empresaId, gheId, tipoId, classificacao],
  );
  return mapear(rows[0]);
}

async function atualizarClassificacao(executor, { empresaId, gheId, tipoId, classificacao }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(gheId, 'identificador de GHE');
  exigirId(tipoId, 'identificador de tipo');
  exigirClassificacao(classificacao);

  const { rows } = await executor.query(
    `UPDATE ghe_tipos_material SET classificacao = $4
      WHERE empresa_id = $1 AND grupo_homogeneo_id = $2 AND tipo_material_id = $3
      RETURNING grupo_homogeneo_id, tipo_material_id, classificacao`,
    [empresaId, gheId, tipoId, classificacao],
  );
  return mapear(rows[0]);
}

/** Remove só esta relação; devolve o que foi removido (para a auditoria) ou null se não existia. */
async function remover(executor, { empresaId, gheId, tipoId }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(gheId, 'identificador de GHE');
  exigirId(tipoId, 'identificador de tipo');

  const { rows } = await executor.query(
    `DELETE FROM ghe_tipos_material
      WHERE empresa_id = $1 AND grupo_homogeneo_id = $2 AND tipo_material_id = $3
      RETURNING grupo_homogeneo_id, tipo_material_id, classificacao`,
    [empresaId, gheId, tipoId],
  );
  return mapear(rows[0]);
}

module.exports = { listarMatriz, buscarParaAtualizacao, inserirSeAusente, atualizarClassificacao, remover };
