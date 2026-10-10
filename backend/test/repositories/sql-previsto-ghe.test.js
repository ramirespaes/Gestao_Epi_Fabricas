'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { previstoNoGhe } = require('../../src/repositories/sql/previsto-ghe');

describe('fragmento SQL de previsto no GHE (definição única)', () => {
  test('une o vínculo direto e o vínculo por tipo, sempre pela empresa do material, sem filtrar por ativo', () => {
    const sql = previstoNoGhe({ material: 'm', ghe: '$2' });
    assert.match(sql, /\$2::int IS NOT NULL/);
    assert.match(sql, /ghe_materiais gm/);
    assert.match(sql, /ghe_tipos_material gt/);
    assert.match(sql, /gm\.empresa_id = m\.empresa_id/);
    assert.match(sql, /gt\.empresa_id = m\.empresa_id/);
    assert.match(sql, /m\.tipo_material_id IS NOT NULL/);
    assert.match(sql, /gt\.tipo_material_id = m\.tipo_material_id/);
    assert.doesNotMatch(sql, /\bativo\b/i, 'tipo ou GHE inativos com vínculo existente continuam valendo');
  });

  test('usa o alias e o parâmetro informados, sem assumir $2', () => {
    const sql = previstoNoGhe({ material: 'mat', ghe: '$7' });
    assert.match(sql, /mat\.empresa_id/);
    assert.match(sql, /\$7::int/);
    assert.doesNotMatch(sql, /\$2/);
    assert.doesNotMatch(sql, /\bm\./);
  });

  test('alias e parâmetro entram no texto do SQL e por isso são validados', () => {
    for (const material of [undefined, '', 'M', '1m', 'm; DROP TABLE x', 'm.x', 'a'.repeat(40)]) {
      assert.throws(() => previstoNoGhe({ material, ghe: '$2' }), /alias/);
    }
    for (const ghe of [undefined, '', '2', '$0', '$2; --', '$1000', 'ghe']) {
      assert.throws(() => previstoNoGhe({ material: 'm', ghe }), /parâmetro/);
    }
  });
});
