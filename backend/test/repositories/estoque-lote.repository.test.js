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

describe('listarFiltrosDisponiveis', () => {
  // 12D-3: a listagem por lote (listarDisponiveis e contarDisponiveis) saiu daqui. Os itens de Itens
  // Disponíveis saem da posição por par (posicao-estoque.repository), a única definição de "utilizável";
  // uma segunda listagem por lote poderia divergir dela. O que continua é só o que a posição não faz.
  test('a listagem antiga por lote não existe mais neste repositório (a única fonte dos itens é a posição por par)', () => {
    assert.equal(repo.listarDisponiveis, undefined);
    assert.equal(repo.contarDisponiveis, undefined);
    assert.equal(repo.VALIDADES, undefined);
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
  test('só a validade (12D-2): lotes com CA vencido ou a vencer, no recorte da Validade de estoque; o estoque do dashboard sai da posição', async () => {
    const executor = executorFalso([{ ca_vencido: 2, ca_a_vencer: 2 }]);
    const r = await repo.resumirIndicadores(executor, EMPRESA, { hoje: HOJE, diasAlerta: 60 });
    const { texto, valores } = executor.chamadas[0];
    semFonteLegada(texto);
    assert.match(texto, /l\.saldo > 0/, 'o lote zerado não entra');
    assert.doesNotMatch(texto, /estoque_minimo|disponivel/, 'o mínimo e o disponível não são mais daqui: vêm da posição por par');
    assert.deepEqual(valores, [EMPRESA, HOJE, 60]);
    assert.deepEqual(r, { caVencido: 2, caAVencer: 2 });
  });
});

describe('recusa entrada inválida antes de consultar', () => {
  test('empresa, material, data operacional e alerta', async () => {
    const executor = executorFalso([]);
    const base = { hoje: HOJE, diasAlerta: 60 };
    await assert.rejects(() => repo.listarPorMaterial(executor, 0, MATERIAL, base), /empresa/i);
    await assert.rejects(() => repo.listarPorMaterial(executor, EMPRESA, 'x', base), /material/i);
    await assert.rejects(() => repo.listarPorMaterial(executor, EMPRESA, MATERIAL, { ...base, hoje: '30/09/2026' }), /data operacional/i);
    await assert.rejects(() => repo.listarPorMaterial(executor, EMPRESA, MATERIAL, { ...base, diasAlerta: 0 }), /alerta/i);
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
