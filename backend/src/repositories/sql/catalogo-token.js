'use strict';

const sqlPrevisto = require('./previsto-ghe');

/**
 * Regras SQL do catálogo do Atendimento Token (Etapa E). Não altera `previsto-ghe.js` (regra compartilhada com pedido, entrega e relatórios).
 *
 * `autorizadoNoCatalogo` = o material está "previsto no GHE" pela definição única E, quando a autorização é só INDIRETA (por tipo),
 * o tipo do catálogo tem de estar ATIVO: tipo inativo não concede autorização nova no Totem (D-E3). O vínculo DIRETO (`ghe_materiais`)
 * vale independentemente do tipo. A empresa é conferida em toda correspondência (FKs compostas 041/083 são a última barreira).
 *
 * `tamanhosDoMaterial` = a MESMA expressão do contexto do pedido (12G-8): a grade explícita (070), na ordem cadastrada e inclusive o
 * tamanho sem estoque; no legado sem grade, os tamanhos distintos dos lotes. Nunca devolve quantidade. Duplicada de propósito (o
 * repositório do pedido não foi tocado); o teste E23 compara as duas e acusa qualquer divergência.
 *
 * Funções puras: recebem o alias do material e a referência ($n) do GHE, validados porque entram no texto do SQL.
 */

const ALIAS = /^[a-z][a-z0-9_]{0,30}$/;
const PARAMETRO = /^\$[1-9][0-9]{0,2}$/;

function exigirAlias(material) {
  if (typeof material !== 'string' || !ALIAS.test(material)) throw new TypeError('alias de material inválido');
}

function autorizadoNoCatalogo({ material, ghe }) {
  exigirAlias(material);
  if (typeof ghe !== 'string' || !PARAMETRO.test(ghe)) throw new TypeError('parâmetro do GHE inválido');
  return `(${sqlPrevisto.previstoNoGhe({ material, ghe })}
    AND (EXISTS (SELECT 1 FROM ghe_materiais gd
                  WHERE gd.empresa_id = ${material}.empresa_id AND gd.grupo_homogeneo_id = ${ghe}::int AND gd.material_id = ${material}.id)
         OR EXISTS (SELECT 1 FROM tipos_material tm
                     WHERE tm.empresa_id = ${material}.empresa_id AND tm.id = ${material}.tipo_material_id AND tm.ativo)))`;
}

function tamanhosDoMaterial({ material }) {
  exigirAlias(material);
  return `(CASE WHEN EXISTS (SELECT 1 FROM material_tamanhos mt WHERE mt.empresa_id = ${material}.empresa_id AND mt.material_id = ${material}.id)
    THEN ARRAY(SELECT mt.tamanho FROM material_tamanhos mt WHERE mt.empresa_id = ${material}.empresa_id AND mt.material_id = ${material}.id ORDER BY mt.ordem)
    ELSE ARRAY(SELECT DISTINCT l.tamanho FROM estoque_lotes l
      WHERE l.empresa_id = ${material}.empresa_id AND l.material_id = ${material}.id AND l.tamanho IS NOT NULL ORDER BY l.tamanho)
  END)`;
}

module.exports = { autorizadoNoCatalogo, tamanhosDoMaterial };
