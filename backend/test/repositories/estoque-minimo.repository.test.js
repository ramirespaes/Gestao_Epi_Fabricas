'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * Repository dos mínimos por tamanho (estoque_minimos, migration 067), sem
 * PostgreSQL real. Executor por parâmetro; toda consulta filtra pela empresa;
 * nenhuma regra de negócio. O mínimo padrão continua em materiais.estoque_minimo
 * e é o que vale quando o tamanho não tem linha própria; uma linha com mínimo 0
 * é valor próprio e prevalece sobre o padrão.
 */

const repo = () => exigirModulo('src/repositories/estoque-minimo.repository');

const EMPRESA = 42;
const MATERIAL = 30;

function executorFalso(linhas = [], { rowCount = linhas.length } = {}) {
  const chamadas = [];
  return {
    chamadas,
    query: async (texto, valores) => {
      chamadas.push({ texto, valores });
      return { rows: linhas, rowCount };
    },
  };
}

const linha = (extra = {}) => ({
  tamanho: 'P', minimo: 10, criado_em: new Date('2026-10-02T12:00:00Z'), atualizado_em: new Date('2026-10-02T12:30:00Z'), ...extra,
});

describe('listarPorMaterial', () => {
  test('lê só da empresa e do material, ordenado por tamanho, e devolve o contrato público', async () => {
    const executor = executorFalso([linha({ tamanho: 'G', minimo: 15 }), linha()]);
    const r = await repo().listarPorMaterial(executor, EMPRESA, MATERIAL);
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /FROM estoque_minimos/);
    assert.match(texto, /WHERE empresa_id = \$1 AND material_id = \$2/);
    assert.match(texto, /ORDER BY tamanho/);
    assert.doesNotMatch(texto, /\b(INSERT|UPDATE|DELETE)\b/i);
    assert.deepEqual(valores, [EMPRESA, MATERIAL]);
    assert.deepEqual(r.map((x) => [x.tamanho, x.minimo]), [['G', 15], ['P', 10]]);
    assert.deepEqual(Object.keys(r[0]).sort(), ['atualizadoEm', 'criadoEm', 'minimo', 'tamanho']);
  });

  test('identificadores inválidos são erro de programação, antes de consultar', async () => {
    const executor = executorFalso();
    for (const [e, m] of [[0, 1], [1, 0], [-1, 1], [1.5, 1], ['1', 1], [1, null]]) {
      await assert.rejects(() => repo().listarPorMaterial(executor, e, m), TypeError, JSON.stringify([e, m]));
    }
    assert.equal(executor.chamadas.length, 0);
  });
});

describe('buscar', () => {
  test('um par exato (empresa, material, tamanho); sem linha, null', async () => {
    const achou = executorFalso([linha()]);
    const r = await repo().buscar(achou, EMPRESA, MATERIAL, 'P');
    assert.match(achou.chamadas[0].texto, /WHERE empresa_id = \$1 AND material_id = \$2 AND tamanho = \$3/);
    assert.deepEqual(achou.chamadas[0].valores, [EMPRESA, MATERIAL, 'P']);
    assert.deepEqual([r.tamanho, r.minimo], ['P', 10]);
    assert.equal(await repo().buscar(executorFalso([]), EMPRESA, MATERIAL, 'P'), null);
  });

  test('tamanho fora da forma canônica (vazio, com espaço nas pontas, acima de 20, não texto) é erro de programação', async () => {
    const executor = executorFalso();
    for (const tamanho of ['', ' P', 'P ', 'X'.repeat(21), null, undefined, 7]) {
      await assert.rejects(() => repo().buscar(executor, EMPRESA, MATERIAL, tamanho), TypeError, String(tamanho));
    }
    assert.equal(executor.chamadas.length, 0);
  });
});

describe('definir (upsert)', () => {
  test('INSERT com ON CONFLICT (empresa_id, material_id, tamanho) convencional, só do mínimo, devolvendo se a linha foi criada', async () => {
    const executor = executorFalso([linha({ criado: true })]);
    const r = await repo().definir(executor, EMPRESA, { materialId: MATERIAL, tamanho: 'P', minimo: 10 });
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /INSERT INTO estoque_minimos \(empresa_id, material_id, tamanho, minimo\)/);
    assert.match(texto, /ON CONFLICT \(empresa_id, material_id, tamanho\) DO UPDATE SET minimo = EXCLUDED\.minimo/);
    assert.doesNotMatch(texto, /COALESCE\(tamanho/);
    assert.match(texto, /RETURNING/);
    assert.deepEqual(valores, [EMPRESA, MATERIAL, 'P', 10]);
    assert.deepEqual([r.tamanho, r.minimo, r.criado], ['P', 10, true]);
  });

  test('mínimo zero é válido (valor próprio); negativo, não inteiro e acima do INTEGER são erro de programação', async () => {
    const executor = executorFalso([linha({ minimo: 0, criado: false })]);
    assert.equal((await repo().definir(executor, EMPRESA, { materialId: MATERIAL, tamanho: 'P', minimo: 0 })).minimo, 0);
    for (const minimo of [-1, 1.5, '10', null, undefined, 2147483648, Number.NaN]) {
      await assert.rejects(() => repo().definir(executor, EMPRESA, { materialId: MATERIAL, tamanho: 'P', minimo }), TypeError, String(minimo));
    }
    assert.equal(executor.chamadas.length, 1);
  });

  test('empresa, material e tamanho inválidos são recusados antes de consultar', async () => {
    const executor = executorFalso();
    for (const dados of [{ materialId: 0, tamanho: 'P', minimo: 1 }, { materialId: MATERIAL, tamanho: '', minimo: 1 }, { materialId: MATERIAL, tamanho: null, minimo: 1 }]) {
      await assert.rejects(() => repo().definir(executor, EMPRESA, dados), TypeError);
    }
    await assert.rejects(() => repo().definir(executor, 0, { materialId: MATERIAL, tamanho: 'P', minimo: 1 }), TypeError);
    assert.equal(executor.chamadas.length, 0);
  });
});

describe('remover', () => {
  test('DELETE do par exato na empresa; devolve se havia linha', async () => {
    const apagou = executorFalso([], { rowCount: 1 });
    assert.equal(await repo().remover(apagou, EMPRESA, MATERIAL, 'P'), true);
    assert.match(apagou.chamadas[0].texto, /^DELETE FROM estoque_minimos\s+WHERE empresa_id = \$1 AND material_id = \$2 AND tamanho = \$3/);
    assert.deepEqual(apagou.chamadas[0].valores, [EMPRESA, MATERIAL, 'P']);
    assert.equal(await repo().remover(executorFalso([], { rowCount: 0 }), EMPRESA, MATERIAL, 'P'), false);
  });

  test('tamanho inválido é erro de programação', async () => {
    await assert.rejects(() => repo().remover(executorFalso(), EMPRESA, MATERIAL, ' P'), TypeError);
  });
});

// Responde em sequência: cada consulta recebe a resposta seguinte da fila.
function executorRoteirizado(respostas) {
  const chamadas = [];
  const fila = [...respostas];
  return {
    chamadas,
    query: async (texto, valores) => {
      chamadas.push({ texto, valores });
      if (fila.length === 0) throw new Error('consulta fora do roteiro');
      const { rows = [], rowCount = rows.length } = fila.shift();
      return { rows, rowCount };
    },
  };
}

describe('gravar (12D-2): cria, atualiza ou não muda, e diz o que havia antes', () => {
  const dados = { materialId: MATERIAL, tamanho: 'M', minimo: 20 };

  test('par novo: INSERT ... ON CONFLICT DO NOTHING devolve a linha; criado, alterado e sem mínimo anterior', async () => {
    const executor = executorRoteirizado([{ rows: [{ minimo: 20 }] }]);
    const r = await repo().gravar(executor, EMPRESA, dados);
    assert.deepEqual(r, { criado: true, alterado: true, minimoAnterior: null, minimo: 20 });
    assert.equal(executor.chamadas.length, 1);
    assert.match(executor.chamadas[0].texto, /INSERT INTO estoque_minimos \(empresa_id, material_id, tamanho, minimo\)/);
    assert.match(executor.chamadas[0].texto, /ON CONFLICT \(empresa_id, material_id, tamanho\) DO NOTHING/);
    assert.match(executor.chamadas[0].texto, /RETURNING minimo/);
    assert.deepEqual(executor.chamadas[0].valores, [EMPRESA, MATERIAL, 'M', 20]);
  });

  test('par existente com valor diferente: trava a linha (FOR UPDATE), lê o anterior e atualiza só o mínimo, da empresa', async () => {
    const executor = executorRoteirizado([{ rows: [] }, { rows: [{ minimo: 10 }] }, { rows: [{ minimo: 20 }], rowCount: 1 }]);
    const r = await repo().gravar(executor, EMPRESA, dados);
    assert.deepEqual(r, { criado: false, alterado: true, minimoAnterior: 10, minimo: 20 });
    assert.match(executor.chamadas[1].texto, /SELECT minimo\s+FROM estoque_minimos\s+WHERE empresa_id = \$1 AND material_id = \$2 AND tamanho = \$3\s+FOR UPDATE/);
    assert.deepEqual(executor.chamadas[1].valores, [EMPRESA, MATERIAL, 'M']);
    assert.match(executor.chamadas[2].texto, /UPDATE estoque_minimos\s+SET minimo = \$4\s+WHERE empresa_id = \$1 AND material_id = \$2 AND tamanho = \$3/);
    assert.deepEqual(executor.chamadas[2].valores, [EMPRESA, MATERIAL, 'M', 20]);
  });

  test('par existente com o MESMO valor: nada é gravado (sem UPDATE), alterado falso', async () => {
    const executor = executorRoteirizado([{ rows: [] }, { rows: [{ minimo: 20 }] }]);
    const r = await repo().gravar(executor, EMPRESA, dados);
    assert.deepEqual(r, { criado: false, alterado: false, minimoAnterior: 20, minimo: 20 });
    assert.equal(executor.chamadas.length, 2);
    assert.ok(executor.chamadas.every((c) => !/^\s*UPDATE\b/.test(c.texto)), 'nenhum comando UPDATE (o FOR UPDATE do SELECT é só a trava da linha)');
  });

  test('o mínimo zero é um valor próprio como outro qualquer, inclusive para "não mudou"', async () => {
    const igual = executorRoteirizado([{ rows: [] }, { rows: [{ minimo: 0 }] }]);
    assert.deepEqual(await repo().gravar(igual, EMPRESA, { ...dados, minimo: 0 }), { criado: false, alterado: false, minimoAnterior: 0, minimo: 0 });
    const muda = executorRoteirizado([{ rows: [] }, { rows: [{ minimo: 0 }] }, { rows: [{ minimo: 5 }], rowCount: 1 }]);
    assert.deepEqual(await repo().gravar(muda, EMPRESA, { ...dados, minimo: 5 }), { criado: false, alterado: true, minimoAnterior: 0, minimo: 5 });
  });

  test('a linha some entre o conflito e a leitura (DELETE concorrente): tenta de novo e cria', async () => {
    const executor = executorRoteirizado([{ rows: [] }, { rows: [] }, { rows: [{ minimo: 20 }] }]);
    assert.deepEqual(await repo().gravar(executor, EMPRESA, dados), { criado: true, alterado: true, minimoAnterior: null, minimo: 20 });
  });

  test('se a linha continua aparecendo e sumindo, desiste com erro em vez de repetir sem fim', async () => {
    const executor = executorRoteirizado(Array.from({ length: 12 }, () => ({ rows: [] })));
    await assert.rejects(() => repo().gravar(executor, EMPRESA, dados), /concorrência/);
    assert.ok(executor.chamadas.length <= 12);
  });

  test('entrada inválida é erro de programação, antes de consultar', async () => {
    const executor = executorRoteirizado([]);
    for (const d of [{ ...dados, materialId: 0 }, { ...dados, tamanho: ' M' }, { ...dados, tamanho: '' }, { ...dados, minimo: -1 }, { ...dados, minimo: 1.5 }]) {
      await assert.rejects(() => repo().gravar(executor, EMPRESA, d), TypeError, JSON.stringify(d));
    }
    await assert.rejects(() => repo().gravar(executor, 0, dados), TypeError);
    assert.equal(executor.chamadas.length, 0);
  });
});

describe('removerComAnterior (12D-2)', () => {
  test('DELETE ... RETURNING minimo do par exato na empresa: removido, com o valor que havia', async () => {
    const executor = executorRoteirizado([{ rows: [{ minimo: 20 }], rowCount: 1 }]);
    assert.deepEqual(await repo().removerComAnterior(executor, EMPRESA, MATERIAL, 'M'), { removido: true, minimoAnterior: 20 });
    assert.match(executor.chamadas[0].texto, /^DELETE FROM estoque_minimos\s+WHERE empresa_id = \$1 AND material_id = \$2 AND tamanho = \$3\s+RETURNING minimo/);
    assert.deepEqual(executor.chamadas[0].valores, [EMPRESA, MATERIAL, 'M']);
  });

  test('o zero próprio também é devolvido como anterior (não vira "sem valor")', async () => {
    const executor = executorRoteirizado([{ rows: [{ minimo: 0 }], rowCount: 1 }]);
    assert.deepEqual(await repo().removerComAnterior(executor, EMPRESA, MATERIAL, 'M'), { removido: true, minimoAnterior: 0 });
  });

  test('sem linha: não removeu nada e não há anterior', async () => {
    const executor = executorRoteirizado([{ rows: [], rowCount: 0 }]);
    assert.deepEqual(await repo().removerComAnterior(executor, EMPRESA, MATERIAL, 'M'), { removido: false, minimoAnterior: null });
  });

  test('tamanho e identificadores inválidos são erro de programação', async () => {
    const executor = executorRoteirizado([]);
    await assert.rejects(() => repo().removerComAnterior(executor, EMPRESA, MATERIAL, ' M'), TypeError);
    await assert.rejects(() => repo().removerComAnterior(executor, 0, MATERIAL, 'M'), TypeError);
    await assert.rejects(() => repo().removerComAnterior(executor, EMPRESA, 0, 'M'), TypeError);
    assert.equal(executor.chamadas.length, 0);
  });
});

describe('possuiOverrides', () => {
  test('EXISTS por empresa e material, só leitura', async () => {
    const executor = executorFalso([{ existe: true }]);
    assert.equal(await repo().possuiOverrides(executor, EMPRESA, MATERIAL), true);
    assert.match(executor.chamadas[0].texto, /SELECT EXISTS \(\s*SELECT 1 FROM estoque_minimos WHERE empresa_id = \$1 AND material_id = \$2\s*\) AS existe/);
    assert.deepEqual(executor.chamadas[0].valores, [EMPRESA, MATERIAL]);
    assert.equal(await repo().possuiOverrides(executorFalso([{ existe: false }]), EMPRESA, MATERIAL), false);
  });
});

describe('buscarEfetivo — o mínimo que vale para um par', () => {
  const consulta = (proprio, padrao = 20) => executorFalso([{ proprio, padrao }]);

  test('com linha própria vale o próprio, com origem PROPRIO; sem linha, o padrão do material, com origem PADRAO', async () => {
    assert.deepEqual(await repo().buscarEfetivo(consulta(10), EMPRESA, MATERIAL, 'P'), { minimo: 10, origem: 'PROPRIO' });
    assert.deepEqual(await repo().buscarEfetivo(consulta(null), EMPRESA, MATERIAL, 'GG'), { minimo: 20, origem: 'PADRAO' });
  });

  test('o mínimo próprio 0 prevalece sobre o padrão: não é "herdar"', async () => {
    assert.deepEqual(await repo().buscarEfetivo(consulta(0, 20), EMPRESA, MATERIAL, 'P'), { minimo: 0, origem: 'PROPRIO' });
  });

  test('a consulta junta o material à linha pelo tamanho exato, sempre pela empresa', async () => {
    const executor = consulta(null);
    await repo().buscarEfetivo(executor, EMPRESA, MATERIAL, 'P');
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /FROM materiais m\s+LEFT JOIN estoque_minimos em ON em\.empresa_id = m\.empresa_id AND em\.material_id = m\.id AND em\.tamanho = \$3/);
    assert.match(texto, /WHERE m\.empresa_id = \$1 AND m\.id = \$2/);
    assert.deepEqual(valores, [EMPRESA, MATERIAL, 'P']);
  });

  test('material sem tamanho (tamanho null) usa o padrão do material, sem procurar linha', async () => {
    const executor = consulta(null, 7);
    assert.deepEqual(await repo().buscarEfetivo(executor, EMPRESA, MATERIAL, null), { minimo: 7, origem: 'PADRAO' });
    assert.deepEqual(executor.chamadas[0].valores, [EMPRESA, MATERIAL, null]);
  });

  test('material inexistente ou de outra empresa: null', async () => {
    assert.equal(await repo().buscarEfetivo(executorFalso([]), EMPRESA, MATERIAL, 'P'), null);
  });

  test('tamanho que não é null nem canônico é erro de programação', async () => {
    for (const tamanho of ['', ' P', undefined, 7]) {
      await assert.rejects(() => repo().buscarEfetivo(executorFalso(), EMPRESA, MATERIAL, tamanho), TypeError, String(tamanho));
    }
  });
});
