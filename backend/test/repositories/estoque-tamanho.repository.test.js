'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  listarPorMaterial,
  buscarPorMaterialTamanhoParaAtualizacao,
  criar,
  atualizarQuantidade,
  TAMANHO_MAXIMO_TAMANHO,
} = require('../../src/repositories/estoque-tamanho.repository');

/**
 * Contrato do repositório de saldos de estoque por tamanho (Bloco 9, Etapa
 * A). estoque_tamanhos não tem empresa_id própria — o isolamento vem do
 * JOIN com materiais, presente em toda consulta e verificado aqui pela
 * cláusula WHERE gerada.
 */

const EMPRESA_A = 4242;
const EMPRESA_B = 8888;
const MATERIAL = 30;

const executorFalso = (linhas = []) => {
  const chamadas = [];
  return {
    chamadas,
    query: async (texto, valores) => {
      chamadas.push({ texto, valores });
      return { rows: linhas, rowCount: linhas.length };
    },
  };
};

const linha = (extra = {}) => ({
  id: 100,
  material_id: MATERIAL,
  tamanho: '40',
  quantidade: 12,
  criado_em: new Date('2026-09-23T12:00:00Z'),
  atualizado_em: new Date('2026-09-23T12:00:00Z'),
  ...extra,
});

const mapeada = {
  id: 100,
  materialId: MATERIAL,
  tamanho: '40',
  quantidade: 12,
  criadoEm: new Date('2026-09-23T12:00:00Z'),
  atualizadoEm: new Date('2026-09-23T12:00:00Z'),
};

describe('listarPorMaterial', () => {
  test('faz JOIN com materiais filtrando por empresa_id, ordena por tamanho', async () => {
    const executor = executorFalso([linha(), linha({ id: 101, tamanho: '41', quantidade: 6 })]);

    const saldos = await listarPorMaterial(executor, EMPRESA_A, MATERIAL);

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /join\s+materiais/i);
    assert.match(texto, /m\.empresa_id\s*=\s*\$1/i);
    assert.match(texto, /et\.material_id\s*=\s*\$2/i);
    assert.match(texto, /order\s+by\s+et\.tamanho/i);
    assert.deepEqual(valores, [EMPRESA_A, MATERIAL]);
    assert.deepEqual(saldos, [mapeada, { ...mapeada, id: 101, tamanho: '41', quantidade: 6 }]);
  });

  test('material de outra empresa (isolamento) devolve lista vazia', async () => {
    assert.deepEqual(await listarPorMaterial(executorFalso([]), EMPRESA_B, MATERIAL), []);
  });

  test('recusa entrada inválida antes de consultar', async () => {
    const executor = executorFalso([]);
    await assert.rejects(() => listarPorMaterial(executor, 0, MATERIAL), /empresa/i);
    await assert.rejects(() => listarPorMaterial(executor, EMPRESA_A, 0), /material/i);
    assert.equal(executor.chamadas.length, 0);
  });
});

describe('buscarPorMaterialTamanhoParaAtualizacao', () => {
  test('filtra por empresa (JOIN), material e tamanho, com FOR UPDATE OF et', async () => {
    const executor = executorFalso([linha()]);

    const saldo = await buscarPorMaterialTamanhoParaAtualizacao(executor, EMPRESA_A, MATERIAL, '40');

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /et\.tamanho\s*=\s*\$3/i);
    assert.match(texto, /for\s+update\s+of\s+et/i);
    assert.deepEqual(valores, [EMPRESA_A, MATERIAL, '40']);
    assert.deepEqual(saldo, mapeada);
  });

  test('tamanho ainda não cadastrado devolve null', async () => {
    assert.equal(await buscarPorMaterialTamanhoParaAtualizacao(executorFalso([]), EMPRESA_A, MATERIAL, '99'), null);
  });

  test('recusa entrada inválida antes de consultar', async () => {
    const executor = executorFalso([]);
    await assert.rejects(() => buscarPorMaterialTamanhoParaAtualizacao(executor, 0, MATERIAL, '40'), /empresa/i);
    await assert.rejects(() => buscarPorMaterialTamanhoParaAtualizacao(executor, EMPRESA_A, 0, '40'), /material/i);
    await assert.rejects(() => buscarPorMaterialTamanhoParaAtualizacao(executor, EMPRESA_A, MATERIAL, ''), /tamanho/i);
    await assert.rejects(
      () => buscarPorMaterialTamanhoParaAtualizacao(executor, EMPRESA_A, MATERIAL, 'x'.repeat(TAMANHO_MAXIMO_TAMANHO + 1)),
      /tamanho/i,
    );
    assert.equal(executor.chamadas.length, 0);
  });
});

describe('criar', () => {
  test('INSERT ... SELECT ... FROM materiais, filtrando por empresa_id — isolamento reforçado na própria escrita (correção pós-auditoria de 23/09/2026)', async () => {
    const executor = executorFalso([linha({ tamanho: '42', quantidade: 0 })]);

    const saldo = await criar(executor, { empresaId: EMPRESA_A, materialId: MATERIAL, tamanho: '42', quantidade: 0 });

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /insert\s+into\s+estoque_tamanhos/i);
    assert.match(texto, /from\s+materiais/i);
    assert.match(texto, /m\.empresa_id\s*=\s*\$1/i);
    assert.match(texto, /m\.id\s*=\s*\$2/i);
    assert.deepEqual(valores, [EMPRESA_A, MATERIAL, '42', 0]);
    assert.equal(saldo.tamanho, '42');
  });

  test('material de outra empresa: nenhuma linha é inserida, devolve null', async () => {
    const saldo = await criar(executorFalso([]), { empresaId: EMPRESA_B, materialId: MATERIAL, tamanho: '42', quantidade: 0 });
    assert.equal(saldo, null);
  });

  test('violação de UNIQUE (material_id, tamanho) propaga sem traduzir', async () => {
    const erro = Object.assign(new Error('duplicate key'), { code: '23505' });
    const executor = { query: async () => { throw erro; } };

    await assert.rejects(
      () => criar(executor, { empresaId: EMPRESA_A, materialId: MATERIAL, tamanho: '40', quantidade: 0 }),
      (e) => e === erro && e.code === '23505',
    );
  });

  test('recusa entrada inválida antes de consultar', async () => {
    const executor = executorFalso([]);
    await assert.rejects(() => criar(executor, { empresaId: 0, materialId: MATERIAL, tamanho: '40', quantidade: 0 }), /empresa/i);
    await assert.rejects(() => criar(executor, { empresaId: EMPRESA_A, materialId: 0, tamanho: '40', quantidade: 0 }), /material/i);
    await assert.rejects(() => criar(executor, { empresaId: EMPRESA_A, materialId: MATERIAL, tamanho: '', quantidade: 0 }), /tamanho/i);
    await assert.rejects(() => criar(executor, { empresaId: EMPRESA_A, materialId: MATERIAL, tamanho: '40', quantidade: -1 }), /quantidade/i);
    await assert.rejects(() => criar(executor, { empresaId: EMPRESA_A, materialId: MATERIAL, tamanho: '40', quantidade: 1.5 }), /quantidade/i);
    await assert.rejects(
      () => criar(executor, { empresaId: EMPRESA_A, materialId: MATERIAL, tamanho: '40', quantidade: 2147483648 }),
      /quantidade/i,
    );
    assert.equal(executor.chamadas.length, 0);
  });
});

describe('atualizarQuantidade', () => {
  test('UPDATE ... FROM materiais, filtrando por empresa_id — isolamento reforçado na própria escrita (correção pós-auditoria de 23/09/2026)', async () => {
    const executor = executorFalso([linha({ quantidade: 20 })]);

    const saldo = await atualizarQuantidade(executor, EMPRESA_A, 100, 20);

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /update\s+estoque_tamanhos/i);
    assert.match(texto, /from\s+materiais/i);
    assert.match(texto, /m\.empresa_id\s*=\s*\$1/i);
    assert.match(texto, /et\.id\s*=\s*\$2/i);
    assert.match(texto, /set\s+quantidade\s*=\s*\$3/i);
    assert.deepEqual(valores, [EMPRESA_A, 100, 20]);
    assert.equal(saldo.quantidade, 20);
  });

  test('saldo cujo material é de outra empresa: nenhuma linha é atualizada, devolve null', async () => {
    const saldo = await atualizarQuantidade(executorFalso([]), EMPRESA_B, 100, 20);
    assert.equal(saldo, null);
  });

  test('erro do PostgreSQL na própria UPDATE propaga sem traduzir', async () => {
    const erro = Object.assign(new Error('linha não encontrada para lock'), { code: '55P03' });
    const executor = { query: async () => { throw erro; } };

    await assert.rejects(
      () => atualizarQuantidade(executor, EMPRESA_A, 100, 5),
      (e) => e === erro && e.code === '55P03',
    );
  });

  test('recusa entrada inválida antes de consultar — a barreira de domínio de negativo é do serviço, esta é a defensiva do repositório', async () => {
    const executor = executorFalso([]);
    await assert.rejects(() => atualizarQuantidade(executor, 0, 100, 5), /empresa/i);
    await assert.rejects(() => atualizarQuantidade(executor, EMPRESA_A, 100, -1), /quantidade/i);
    await assert.rejects(() => atualizarQuantidade(executor, EMPRESA_A, 0, 5), /saldo/i);
    await assert.rejects(() => atualizarQuantidade(executor, EMPRESA_A, 100, 2147483648), /quantidade/i);
    assert.equal(executor.chamadas.length, 0);
  });
});
