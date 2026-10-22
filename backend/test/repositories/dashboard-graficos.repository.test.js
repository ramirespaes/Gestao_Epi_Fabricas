'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const repo = require('../../src/repositories/dashboard-graficos.repository');
const entregasRepo = require('../../src/repositories/relatorio-entregas.repository');

/**
 * 12I — repositório dos gráficos do Dashboard, sem PostgreSQL:
 *   - setores: funcionários ATIVOS da empresa cuja DATA DE CADASTRO (criado_em, convertida ao dia civil de São Paulo) cai no período,
 *     agrupados pelo setor normalizado (lower(btrim)); nulo/vazio vira um grupo só; ordem por quantidade decrescente;
 *   - produtos: o top N e a série saem do MESMO FROM e WHERE do relatório "EPIs entregues" (relatorio-entregas: DE + FILTRO), com os mesmos
 *     parâmetros, agrupados por material_id (nunca por nome, tipo ou categoria); a quantidade é i.quantidade.
 */

const EMPRESA = 42;
const FILTROS = { padraoItem: null, padraoFuncionario: null, padraoSetor: null, de: '2026-10-01', ate: '2026-10-31', diasMin: null, diasMax: null };
const executor = (rows) => { const chamadas = []; return { chamadas, query: async (texto, valores) => { chamadas.push({ texto, valores }); return { rows }; } }; };
const compacto = (s) => s.replace(/\s+/g, ' ').trim();
const entreFromEWhereFinal = (texto) => { const corpo = texto.slice(texto.indexOf('FROM')); return compacto(corpo.slice(0, corpo.search(/GROUP BY|ORDER BY|LIMIT|$/))); };

describe('dashboard-graficos.repository.contarAtivosPorSetor', () => {
  test('consulta funcionarios da empresa, ativos, por criado_em no dia civil de São Paulo dentro do período, agrupando pelo setor normalizado', async () => {
    const ex = executor([{ setor: 'Produção', quantidade: 3 }, { setor: null, quantidade: 1 }]);
    const linhas = await repo.contarAtivosPorSetor(ex, EMPRESA, { de: '2026-10-01', ate: '2026-10-31' });
    assert.deepEqual(linhas, [{ setor: 'Produção', quantidade: 3 }, { setor: null, quantidade: 1 }]);
    const { texto, valores } = ex.chamadas[0];
    assert.match(texto, /FROM funcionarios/);
    assert.match(texto, /empresa_id = \$1/);
    assert.match(texto, /ativo = true|situacao = 'ATIVO'/);
    assert.match(texto, /criado_em AT TIME ZONE 'America\/Sao_Paulo'\)::date/);
    assert.match(texto, /lower\(btrim\(setor\)\)/);
    assert.match(texto, /ORDER BY quantidade DESC/);
    assert.deepEqual(valores, [EMPRESA, '2026-10-01', '2026-10-31']);
  });

  test('quantidade sempre numérica; empresa inválida é TypeError antes da consulta', async () => {
    const ex = executor([{ setor: 'X', quantidade: '2' }]);
    assert.deepEqual(await repo.contarAtivosPorSetor(ex, EMPRESA, { de: '2026-10-01', ate: '2026-10-31' }), [{ setor: 'X', quantidade: 2 }]);
    await assert.rejects(() => repo.contarAtivosPorSetor(ex, 0, { de: '2026-10-01', ate: '2026-10-31' }), TypeError);
    assert.equal(ex.chamadas.length, 1);
  });
});

describe('dashboard-graficos.repository.topProdutosEntregues', () => {
  test('mesmo FROM e WHERE e mesmos 8 parâmetros da contagem do relatório; agrupa por i.material_id; soma i.quantidade; limite por parâmetro', async () => {
    const top = executor([{ material_id: 7, nome: 'Luva', total: '20' }]);
    const conta = executor([{ total: 1 }]);
    const r = await repo.topProdutosEntregues(top, EMPRESA, FILTROS, { limite: 5 });
    await entregasRepo.contar(conta, EMPRESA, FILTROS);
    assert.deepEqual(r, [{ materialId: 7, nome: 'Luva', total: 20 }]);
    const { texto, valores } = top.chamadas[0];
    assert.equal(entreFromEWhereFinal(texto), entreFromEWhereFinal(conta.chamadas[0].texto), 'população idêntica à do relatório');
    assert.deepEqual(valores.slice(0, 8), conta.chamadas[0].valores);
    assert.equal(valores[8], 5);
    assert.match(texto, /GROUP BY i\.material_id/);
    assert.match(texto, /sum\(i\.quantidade\)/);
    assert.match(texto, /ORDER BY total DESC, i\.material_id ASC/);
    assert.match(texto, /LIMIT \$9/);
  });
});

describe('dashboard-graficos.repository.seriePorProduto', () => {
  test('por DIA: a chave é a data operacional (YYYY-MM-DD) só dos materiais pedidos, mesma população do relatório', async () => {
    const ex = executor([{ material_id: 7, chave: '2026-10-03', quantidade: '4' }]);
    const conta = executor([{ total: 1 }]);
    const r = await repo.seriePorProduto(ex, EMPRESA, FILTROS, { materialIds: [7, 9], agrupamento: 'DIA' });
    await entregasRepo.contar(conta, EMPRESA, FILTROS);
    assert.deepEqual(r, [{ materialId: 7, chave: '2026-10-03', quantidade: 4 }]);
    const { texto, valores } = ex.chamadas[0];
    assert.ok(entreFromEWhereFinal(texto).startsWith(entreFromEWhereFinal(conta.chamadas[0].texto)), 'começa pelo FROM/WHERE do relatório');
    assert.match(texto, /i\.material_id = ANY\(\$9::int\[\]\)/);
    assert.match(texto, /to_char\(e\.data_operacional, 'YYYY-MM-DD'\)/);
    assert.deepEqual(valores, [...conta.chamadas[0].valores, [7, 9]]);
  });

  test('por MES: a chave é YYYY-MM da data operacional', async () => {
    const ex = executor([]);
    await repo.seriePorProduto(ex, EMPRESA, FILTROS, { materialIds: [7], agrupamento: 'MES' });
    assert.match(ex.chamadas[0].texto, /to_char\(e\.data_operacional, 'YYYY-MM'\)/);
  });

  test('sem materiais não consulta e devolve lista vazia; agrupamento desconhecido é TypeError', async () => {
    const ex = executor([]);
    assert.deepEqual(await repo.seriePorProduto(ex, EMPRESA, FILTROS, { materialIds: [], agrupamento: 'DIA' }), []);
    assert.equal(ex.chamadas.length, 0);
    await assert.rejects(() => repo.seriePorProduto(ex, EMPRESA, FILTROS, { materialIds: [1], agrupamento: 'SEMANA' }), TypeError);
  });
});
