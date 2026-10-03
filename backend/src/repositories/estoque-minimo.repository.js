'use strict';

/**
 * Mínimos de estoque por tamanho (estoque_minimos, migration 067). Executor
 * por parâmetro, toda consulta filtra pela empresa, nenhuma regra de negócio.
 *
 * O mínimo padrão é materiais.estoque_minimo e vale para o tamanho sem linha
 * própria. A linha própria prevalece, inclusive com mínimo 0 (este tamanho não
 * tem mínimo). Material que não exige tamanho não tem linha: a tabela o recusa
 * (gatilho da 067, erro do PostgreSQL propagado sem tradução) e o mínimo dele é
 * o padrão do cadastro. É configuração: nada aqui toma trava de par.
 */

const TAMANHO_MAXIMO = 20;
const INTEGER_MAXIMO = 2147483647;

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError(`identificador de ${nome} inválido`);
  }
}

// A forma canônica dos lotes: texto de 1 a 20 caracteres, sem espaço nas pontas.
function exigirTamanho(tamanho) {
  if (typeof tamanho !== 'string' || tamanho.length === 0 || tamanho !== tamanho.trim() || Array.from(tamanho).length > TAMANHO_MAXIMO) {
    throw new TypeError('tamanho inválido');
  }
}

function exigirMinimo(minimo) {
  if (!Number.isInteger(minimo) || minimo < 0 || minimo > INTEGER_MAXIMO) {
    throw new TypeError('mínimo inválido');
  }
}

const mapear = (l) => ({
  tamanho: l.tamanho, minimo: l.minimo, criadoEm: l.criado_em, atualizadoEm: l.atualizado_em,
});

/** Os mínimos próprios do material, por tamanho. */
async function listarPorMaterial(executor, empresaId, materialId) {
  exigirId(empresaId, 'empresa');
  exigirId(materialId, 'material');
  const { rows } = await executor.query(
    `SELECT tamanho, minimo, criado_em, atualizado_em
       FROM estoque_minimos
      WHERE empresa_id = $1 AND material_id = $2
      ORDER BY tamanho`,
    [empresaId, materialId],
  );
  return rows.map(mapear);
}

/** O mínimo próprio de um tamanho, ou null. */
async function buscar(executor, empresaId, materialId, tamanho) {
  exigirId(empresaId, 'empresa');
  exigirId(materialId, 'material');
  exigirTamanho(tamanho);
  const { rows } = await executor.query(
    `SELECT tamanho, minimo, criado_em, atualizado_em
       FROM estoque_minimos
      WHERE empresa_id = $1 AND material_id = $2 AND tamanho = $3`,
    [empresaId, materialId, tamanho],
  );
  return rows[0] ? mapear(rows[0]) : null;
}

/** Cria ou atualiza o mínimo próprio do tamanho; `criado` diz se a linha é nova. */
async function definir(executor, empresaId, { materialId, tamanho, minimo }) {
  exigirId(empresaId, 'empresa');
  exigirId(materialId, 'material');
  exigirTamanho(tamanho);
  exigirMinimo(minimo);
  const { rows } = await executor.query(
    `INSERT INTO estoque_minimos (empresa_id, material_id, tamanho, minimo)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (empresa_id, material_id, tamanho) DO UPDATE SET minimo = EXCLUDED.minimo
     RETURNING tamanho, minimo, criado_em, atualizado_em, (xmax = 0) AS criado`,
    [empresaId, materialId, tamanho, minimo],
  );
  return { ...mapear(rows[0]), criado: rows[0].criado === true };
}

// Cada volta perde a corrida para um DELETE concorrente: poucas bastam, e o limite impede o laço infinito.
const TENTATIVAS_GRAVAR = 5;

/**
 * Grava o mínimo próprio do tamanho e diz o que havia antes: `criado` (a linha
 * é nova), `alterado` (o valor mudou de verdade) e `minimoAnterior` (null se
 * não havia linha). Gravar o mesmo valor não escreve nada. Sem lock de
 * estoque: o INSERT ... ON CONFLICT DO NOTHING espera quem criou a linha
 * primeiro, e a linha existente é lida com FOR UPDATE, então dois PUTs do mesmo
 * par terminam num estado só e cada um enxerga o valor que de fato substituiu.
 */
async function gravar(executor, empresaId, { materialId, tamanho, minimo }) {
  exigirId(empresaId, 'empresa');
  exigirId(materialId, 'material');
  exigirTamanho(tamanho);
  exigirMinimo(minimo);
  for (let tentativa = 0; tentativa < TENTATIVAS_GRAVAR; tentativa += 1) {
    const inserida = await executor.query(
      `INSERT INTO estoque_minimos (empresa_id, material_id, tamanho, minimo)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (empresa_id, material_id, tamanho) DO NOTHING
       RETURNING minimo`,
      [empresaId, materialId, tamanho, minimo],
    );
    if (inserida.rows.length > 0) {
      return {
        criado: true, alterado: true, minimoAnterior: null, minimo: inserida.rows[0].minimo,
      };
    }
    const atual = await executor.query(
      `SELECT minimo
         FROM estoque_minimos
        WHERE empresa_id = $1 AND material_id = $2 AND tamanho = $3
        FOR UPDATE`,
      [empresaId, materialId, tamanho],
    );
    if (atual.rows.length > 0) {
      const minimoAnterior = atual.rows[0].minimo;
      if (minimoAnterior === minimo) {
        return {
          criado: false, alterado: false, minimoAnterior, minimo,
        };
      }
      await executor.query(
        `UPDATE estoque_minimos
            SET minimo = $4
          WHERE empresa_id = $1 AND material_id = $2 AND tamanho = $3`,
        [empresaId, materialId, tamanho, minimo],
      );
      return {
        criado: false, alterado: true, minimoAnterior, minimo,
      };
    }
  }
  throw new Error('concorrência: não foi possível gravar o mínimo do tamanho');
}

/** Remove o mínimo próprio e devolve o valor que havia (zero próprio incluído); sem linha, não removeu nada. */
async function removerComAnterior(executor, empresaId, materialId, tamanho) {
  exigirId(empresaId, 'empresa');
  exigirId(materialId, 'material');
  exigirTamanho(tamanho);
  const { rows } = await executor.query(
    `DELETE FROM estoque_minimos
      WHERE empresa_id = $1 AND material_id = $2 AND tamanho = $3
      RETURNING minimo`,
    [empresaId, materialId, tamanho],
  );
  return rows.length > 0 ? { removido: true, minimoAnterior: rows[0].minimo } : { removido: false, minimoAnterior: null };
}

/** Remove o mínimo próprio: o tamanho volta a herdar o padrão. Diz se havia linha. */
async function remover(executor, empresaId, materialId, tamanho) {
  exigirId(empresaId, 'empresa');
  exigirId(materialId, 'material');
  exigirTamanho(tamanho);
  const resultado = await executor.query(
    `DELETE FROM estoque_minimos
      WHERE empresa_id = $1 AND material_id = $2 AND tamanho = $3`,
    [empresaId, materialId, tamanho],
  );
  return resultado.rowCount > 0;
}

/** O material tem algum mínimo próprio? A troca da exigência de tamanho depende disso. */
async function possuiOverrides(executor, empresaId, materialId) {
  exigirId(empresaId, 'empresa');
  exigirId(materialId, 'material');
  const { rows } = await executor.query(
    `SELECT EXISTS (
       SELECT 1 FROM estoque_minimos WHERE empresa_id = $1 AND material_id = $2
     ) AS existe`,
    [empresaId, materialId],
  );
  return rows[0].existe;
}

/**
 * O mínimo que vale para um par: o próprio (mesmo 0) ou o padrão do material.
 * Tamanho null é o material sem tamanho: vale o padrão. Null se o material não
 * existe na empresa.
 */
async function buscarEfetivo(executor, empresaId, materialId, tamanho) {
  exigirId(empresaId, 'empresa');
  exigirId(materialId, 'material');
  if (tamanho !== null) exigirTamanho(tamanho);
  const { rows } = await executor.query(
    `SELECT m.estoque_minimo AS padrao, em.minimo AS proprio
       FROM materiais m
       LEFT JOIN estoque_minimos em ON em.empresa_id = m.empresa_id AND em.material_id = m.id AND em.tamanho = $3
      WHERE m.empresa_id = $1 AND m.id = $2`,
    [empresaId, materialId, tamanho],
  );
  if (rows.length === 0) return null;
  const { proprio, padrao } = rows[0];
  return proprio === null || proprio === undefined
    ? { minimo: Number(padrao), origem: 'PADRAO' }
    : { minimo: Number(proprio), origem: 'PROPRIO' };
}

module.exports = {
  TAMANHO_MAXIMO, listarPorMaterial, buscar, definir, gravar, remover, removerComAnterior, possuiOverrides, buscarEfetivo,
};
