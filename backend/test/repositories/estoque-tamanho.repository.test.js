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

// ═══════════════════════════════════════════════════════════════════
// Parte C3 — consulta agregada de itens disponíveis (somente leitura)
// ═══════════════════════════════════════════════════════════════════
describe('listarDisponiveis / contarDisponiveis / listarFiltrosDisponiveis — Parte C3', () => {
  const repo = require('../../src/repositories/estoque-tamanho.repository');
  const linhaAgregada = (extra = {}) => ({
    material_id: MATERIAL, material: 'Botina', codigo_interno: 'EPI-1', categoria: 'EPI', tipo: 'Sapatão / Botina',
    tamanho: '40', quantidade: 12, unidade: 'par', estoque_minimo: 5, ca_validade: '2027-01-31', validade: 'ok', ...extra,
  });

  test('listarDisponiveis: filtra por empresa (JOIN), só materiais ativos, filtros como parâmetros, paginação, e mapeia saldo = disponivel', async () => {
    const executor = executorFalso([linhaAgregada()]);
    const itens = await repo.listarDisponiveis(executor, EMPRESA_A, { categoria: 'EPI', tipo: 'Luva', tamanho: 'G', validade: 'expiring', pagina: 2, limite: 50, diasAlerta: 60 });
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /FROM\s+estoque_tamanhos\s+et\s+JOIN\s+materiais\s+m\s+ON\s+m\.id\s*=\s*et\.material_id/i);
    assert.match(texto, /m\.empresa_id\s*=\s*\$1/);
    assert.match(texto, /m\.ativo/);
    assert.match(texto, /LIMIT\s+\$\d+\s+OFFSET\s+\$\d+/i);
    assert.doesNotMatch(texto, /EPI|Luva/, 'nenhum valor de filtro concatenado no SQL');
    assert.equal(valores[0], EMPRESA_A);
    assert.ok(valores.includes('EPI') && valores.includes('Luva') && valores.includes('G') && valores.includes('expiring') && valores.includes(60));
    assert.ok(valores.includes(50) && valores.includes(50), 'limite e deslocamento (página 2 × 50)');
    assert.deepEqual(itens, [{
      materialId: MATERIAL, material: 'Botina', codigoInterno: 'EPI-1', categoria: 'EPI', tipo: 'Sapatão / Botina',
      tamanho: '40', saldo: 12, disponivel: 12, unidade: 'par', estoqueMinimo: 5, caValidade: '2027-01-31', validade: 'ok',
    }]);
  });

  test('a classificação da validade do CA é feita no SQL com CURRENT_DATE e o prazo de alerta como parâmetro; sem data é sem-validade', async () => {
    const executor = executorFalso([]);
    await repo.listarDisponiveis(executor, EMPRESA_A, { diasAlerta: 60 });
    const { texto } = executor.chamadas[0];
    assert.match(texto, /ca_validade IS NULL THEN 'sem-validade'/);
    assert.match(texto, /ca_validade < CURRENT_DATE THEN 'expired'/);
    assert.match(texto, /CURRENT_DATE \+ \$\d+::int THEN 'expiring'/);
    assert.match(texto, /ELSE 'ok'/);
  });

  test('contarDisponiveis usa exatamente os mesmos filtros, sem paginação', async () => {
    const executor = executorFalso([{ total: 7 }]);
    const total = await repo.contarDisponiveis(executor, EMPRESA_A, { categoria: 'EPI', diasAlerta: 60 });
    assert.equal(total, 7);
    assert.match(executor.chamadas[0].texto, /count\(\*\)/i);
    assert.match(executor.chamadas[0].texto, /m\.empresa_id\s*=\s*\$1/);
    assert.doesNotMatch(executor.chamadas[0].texto, /LIMIT/i);
  });

  test('listarFiltrosDisponiveis devolve categorias, tipos e tamanhos distintos só da empresa e de materiais ativos', async () => {
    const executor = executorFalso([{ categorias: ['EPI'], tipos: ['Luva'], tamanhos: ['G', 'M'] }]);
    const f = await repo.listarFiltrosDisponiveis(executor, EMPRESA_A);
    assert.deepEqual(f, { categorias: ['EPI'], tipos: ['Luva'], tamanhos: ['G', 'M'] });
    assert.match(executor.chamadas[0].texto, /m\.empresa_id\s*=\s*\$1/);
    assert.match(executor.chamadas[0].texto, /m\.ativo/);
    assert.deepEqual(executor.chamadas[0].valores, [EMPRESA_A]);
    assert.deepEqual(await repo.listarFiltrosDisponiveis(executorFalso([{ categorias: null, tipos: null, tamanhos: null }]), EMPRESA_A), { categorias: [], tipos: [], tamanhos: [] });
  });

  test('recusa entrada inválida antes de consultar', async () => {
    const executor = executorFalso([]);
    await assert.rejects(() => repo.listarDisponiveis(executor, 0, { diasAlerta: 60 }), /empresa/i);
    await assert.rejects(() => repo.listarDisponiveis(executor, EMPRESA_A, { validade: 'vencido', diasAlerta: 60 }), /validade/i);
    await assert.rejects(() => repo.listarDisponiveis(executor, EMPRESA_A, { pagina: 0, diasAlerta: 60 }), /página/i);
    await assert.rejects(() => repo.listarDisponiveis(executor, EMPRESA_A, { diasAlerta: 0 }), /alerta/i);
    await assert.rejects(() => repo.contarDisponiveis(executor, -1, { diasAlerta: 60 }), /empresa/i);
    await assert.rejects(() => repo.listarFiltrosDisponiveis(executor, 'x'), /empresa/i);
    assert.equal(executor.chamadas.length, 0);
  });
});
