'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const repo = require('../../src/repositories/estoque-lote.repository');

/**
 * Contrato do repositório de leitura do estoque por lote. A regra de
 * físico/bloqueado/disponível é provada com PostgreSQL real nos testes de
 * integração; aqui confiro isolamento, parâmetros e mapeamento.
 */

const EMPRESA = 4242;
const MATERIAL = 30;
const HOJE = '2026-09-30';

const executorFalso = (linhas = []) => {
  const chamadas = [];
  return {
    chamadas,
    query: async (texto, valores) => {
      chamadas.push({ texto, valores });
      return { rows: linhas };
    },
  };
};

function semFonteLegada(texto) {
  assert.doesNotMatch(texto, /estoque_tamanhos/, 'a leitura vem de estoque_lotes');
  assert.doesNotMatch(texto, /CURRENT_DATE|now\(\)/i, 'a data operacional chega como parâmetro');
  assert.match(texto, /FROM\s+estoque_lotes\s+l\s+JOIN\s+materiais\s+m\s+ON\s+m\.empresa_id\s*=\s*l\.empresa_id\s+AND\s+m\.id\s*=\s*l\.material_id/i);
  assert.match(texto, /l\.empresa_id\s*=\s*\$1/);
}

describe('listarPorMaterial', () => {
  test('lotes com saldo do material na empresa, com situação do CA derivada na consulta', async () => {
    const executor = executorFalso([{
      id: 7, material_id: MATERIAL, tamanho: '40', ca_numero: '12345', ca_validade: '2026-09-29', origem: 'SALDO_INICIAL',
      quantidade_entrada: 10, quantidade_baixada: 2, quantidade_entregue: 0, saldo: 8, bloqueado: 8, situacao_ca: 'VENCIDO',
    }]);
    const lotes = await repo.listarPorMaterial(executor, EMPRESA, MATERIAL, { hoje: HOJE, diasAlerta: 60 });
    const { texto, valores } = executor.chamadas[0];
    semFonteLegada(texto);
    assert.match(texto, /l\.saldo\s*>\s*0/, 'lote zerado fica fora');
    assert.match(texto, /m\.exige_ca/);
    assert.deepEqual(valores, [EMPRESA, HOJE, 60, MATERIAL]);
    assert.deepEqual(lotes, [{
      loteId: 7, materialId: MATERIAL, tamanho: '40', caNumero: '12345', caValidade: '2026-09-29', origem: 'SALDO_INICIAL',
      quantidadeEntrada: 10, quantidadeBaixada: 2, quantidadeEntregue: 0, fisico: 8, bloqueado: 8, disponivel: 0, situacaoCa: 'VENCIDO',
    }]);
  });
});

describe('listarDisponiveis / contarDisponiveis / listarFiltrosDisponiveis', () => {
  const linha = (extra = {}) => ({
    material_id: MATERIAL, material: 'Botina', codigo_interno: 'EPI-1', categoria: 'EPI', tipo: 'Sapatão / Botina',
    tamanho: '40', fisico: '15', bloqueado: '5', unidade: 'par', estoque_minimo: 5, ca_validade: '2026-09-29', validade: 'expired', ...extra,
  });

  test('agrega por material e tamanho de materiais ativos; saldo é o físico e disponível desconta o bloqueado', async () => {
    const executor = executorFalso([linha()]);
    const itens = await repo.listarDisponiveis(executor, EMPRESA, {
      hoje: HOJE, diasAlerta: 60, categoria: 'EPI', tipo: 'Luva', tamanho: 'G', validade: 'expired', pagina: 2, limite: 50,
    });
    const { texto, valores } = executor.chamadas[0];
    semFonteLegada(texto);
    assert.match(texto, /m\.ativo/);
    assert.match(texto, /LIMIT\s+\$\d+\s+OFFSET\s+\$\d+/i);
    assert.doesNotMatch(texto, /'EPI'|'Luva'/, 'nenhum valor de filtro concatenado no SQL');
    assert.deepEqual(valores.slice(0, 3), [EMPRESA, HOJE, 60]);
    assert.ok(['EPI', 'Luva', 'G', 'expired'].every((v) => valores.includes(v)));
    assert.deepEqual(valores.slice(-2), [50, 50], 'limite e deslocamento da página 2');
    assert.deepEqual(itens, [{
      materialId: MATERIAL, material: 'Botina', codigoInterno: 'EPI-1', categoria: 'EPI', tipo: 'Sapatão / Botina',
      tamanho: '40', saldo: 15, bloqueado: 5, disponivel: 10, unidade: 'par', estoqueMinimo: 5, caValidade: '2026-09-29', validade: 'expired',
    }]);
  });

  test('contarDisponiveis usa os mesmos filtros, sem paginação', async () => {
    const executor = executorFalso([{ total: 7 }]);
    assert.equal(await repo.contarDisponiveis(executor, EMPRESA, { hoje: HOJE, diasAlerta: 60, categoria: 'EPI' }), 7);
    semFonteLegada(executor.chamadas[0].texto);
    assert.match(executor.chamadas[0].texto, /count\(\*\)/i);
    assert.doesNotMatch(executor.chamadas[0].texto, /LIMIT/i);
  });

  test('listarFiltrosDisponiveis devolve opções só da empresa e de materiais ativos com lote', async () => {
    const executor = executorFalso([{ categorias: ['EPI'], tipos: ['Luva'], tamanhos: ['G', 'M'] }]);
    assert.deepEqual(await repo.listarFiltrosDisponiveis(executor, EMPRESA), { categorias: ['EPI'], tipos: ['Luva'], tamanhos: ['G', 'M'] });
    semFonteLegada(executor.chamadas[0].texto);
    assert.match(executor.chamadas[0].texto, /m\.ativo/);
    assert.deepEqual(executor.chamadas[0].valores, [EMPRESA]);
    const vazio = await repo.listarFiltrosDisponiveis(executorFalso([{ categorias: null, tipos: null, tamanhos: null }]), EMPRESA);
    assert.deepEqual(vazio, { categorias: [], tipos: [], tamanhos: [] });
  });
});

describe('resumirIndicadores', () => {
  test('disponível, abaixo do mínimo (só com mínimo configurado) e lotes com CA vencido ou a vencer, só de materiais ativos', async () => {
    const executor = executorFalso([{ disponivel: '47', abaixo_minimo: 3, ca_vencido: 2, ca_a_vencer: 2 }]);
    const r = await repo.resumirIndicadores(executor, EMPRESA, { hoje: HOJE, diasAlerta: 60 });
    const { texto, valores } = executor.chamadas[0];
    semFonteLegada(texto);
    assert.match(texto, /m\.ativo/);
    assert.match(texto, /WHERE\s+m\.estoque_minimo\s*>\s*0\s+AND\s+p\.disponivel\s*<\s*m\.estoque_minimo/);
    assert.doesNotMatch(texto, /disponivel\s*<=\s*0/, 'disponível zero sem mínimo configurado não é abaixo do mínimo');
    assert.deepEqual(valores, [EMPRESA, HOJE, 60]);
    assert.deepEqual(r, { disponivel: 47, abaixoMinimo: 3, caVencido: 2, caAVencer: 2 });
  });
});

describe('recusa entrada inválida antes de consultar', () => {
  test('empresa, material, data operacional, alerta, validade e paginação', async () => {
    const executor = executorFalso([]);
    const base = { hoje: HOJE, diasAlerta: 60 };
    await assert.rejects(() => repo.listarPorMaterial(executor, 0, MATERIAL, base), /empresa/i);
    await assert.rejects(() => repo.listarPorMaterial(executor, EMPRESA, 'x', base), /material/i);
    await assert.rejects(() => repo.listarPorMaterial(executor, EMPRESA, MATERIAL, { ...base, hoje: '30/09/2026' }), /data operacional/i);
    await assert.rejects(() => repo.listarDisponiveis(executor, EMPRESA, { ...base, diasAlerta: 0 }), /alerta/i);
    await assert.rejects(() => repo.listarDisponiveis(executor, EMPRESA, { ...base, validade: 'vencido' }), /validade/i);
    await assert.rejects(() => repo.listarDisponiveis(executor, EMPRESA, { ...base, pagina: 0 }), /página/i);
    await assert.rejects(() => repo.contarDisponiveis(executor, -1, base), /empresa/i);
    await assert.rejects(() => repo.listarFiltrosDisponiveis(executor, 'x'), /empresa/i);
    await assert.rejects(() => repo.resumirIndicadores(executor, EMPRESA, { diasAlerta: 60 }), /data operacional/i);
    assert.equal(executor.chamadas.length, 0);
  });
});

describe('lote sem tamanho e saldo incompatível — migration 044', () => {
  test('listarFiltrosDisponiveis não oferece tamanho nulo como opção de filtro', async () => {
    const executor = executorFalso([{ categorias: [], tipos: [], tamanhos: ['40'] }]);
    await repo.listarFiltrosDisponiveis(executor, EMPRESA);
    assert.match(executor.chamadas[0].texto, /array_agg\(DISTINCT l\.tamanho ORDER BY l\.tamanho\) FILTER \(WHERE l\.tamanho IS NOT NULL\)/);
  });

  test('possuiSaldoIncompativel procura saldo positivo com tamanho incompatível com o novo valor, só na empresa', async () => {
    for (const [resposta, novoValor] of [[true, false], [false, true]]) {
      const executor = executorFalso([{ existe: resposta }]);
      assert.equal(await repo.possuiSaldoIncompativel(executor, EMPRESA, MATERIAL, novoValor), resposta);
      const { texto, valores } = executor.chamadas[0];
      assert.match(texto, /FROM\s+estoque_lotes/);
      assert.match(texto, /empresa_id\s*=\s*\$1\s+AND\s+material_id\s*=\s*\$2/);
      assert.match(texto, /saldo\s*>\s*0/);
      assert.match(texto, /\(tamanho IS NULL\)\s*=\s*\$3/);
      assert.deepEqual(valores, [EMPRESA, MATERIAL, novoValor]);
    }
  });

  test('possuiSaldoIncompativel recusa valor que não é booleano antes de consultar', async () => {
    const executor = executorFalso([]);
    await assert.rejects(() => repo.possuiSaldoIncompativel(executor, EMPRESA, MATERIAL, null), /tamanho/);
    assert.equal(executor.chamadas.length, 0);
  });
});
