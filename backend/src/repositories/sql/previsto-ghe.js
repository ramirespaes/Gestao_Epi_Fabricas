'use strict';

/**
 * Definição ÚNICA de "previsto no GHE" em SQL (evolução GHE / importação GHE-EPI, Incremento 4).
 *
 *   previsto = vínculo DIRETO do GHE com o material (ghe_materiais)
 *              OU o material tem tipo_material_id e esse tipo está ligado ao GHE (ghe_tipos_material).
 *
 * As duas classificações (OBRIGATORIO e NAO_OBRIGATORIO) contam igual: aqui ela é informativa. O vínculo existente
 * vale mesmo que o tipo ou o GHE tenham sido inativados depois: nada filtra por `ativo`. Material sem
 * tipo_material_id só fica previsto pelo vínculo direto (nada é inferido pelo nome). Toda correspondência compara
 * `empresa_id` com o do material, então vínculo de outra empresa nunca prevê nada (as FKs compostas das migrations
 * 041 e 083 são a última barreira).
 *
 * Função pura, sem dependências, no molde de sql/posicao-estoque.js: recebe o ALIAS do material e a REFERÊNCIA ($n)
 * do parâmetro que a consulta declarou para o id do GHE (que pode ser null: trabalhador sem GHE nunca é previsto).
 * Alias e referência vão direto para o texto do SQL, então são validados.
 */

const ALIAS = /^[a-z][a-z0-9_]{0,30}$/;
const PARAMETRO = /^\$[1-9][0-9]{0,2}$/;

function previstoNoGhe({ material, ghe }) {
  if (typeof material !== 'string' || !ALIAS.test(material)) {
    throw new TypeError('alias de material inválido');
  }
  if (typeof ghe !== 'string' || !PARAMETRO.test(ghe)) {
    throw new TypeError('parâmetro do GHE inválido');
  }
  return `(${ghe}::int IS NOT NULL AND (
    EXISTS (SELECT 1 FROM ghe_materiais gm
             WHERE gm.empresa_id = ${material}.empresa_id AND gm.grupo_homogeneo_id = ${ghe}::int AND gm.material_id = ${material}.id)
    OR (${material}.tipo_material_id IS NOT NULL AND EXISTS (SELECT 1 FROM ghe_tipos_material gt
             WHERE gt.empresa_id = ${material}.empresa_id AND gt.grupo_homogeneo_id = ${ghe}::int AND gt.tipo_material_id = ${material}.tipo_material_id))))`;
}

module.exports = { previstoNoGhe };
