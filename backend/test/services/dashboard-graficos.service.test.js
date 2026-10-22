'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const servico = require('../../src/services/dashboard-graficos.service');
const autorizacao = require('../../src/middleware/autorizacao');
const repo = require('../../src/repositories/dashboard-graficos.repository');
const entregasRepo = require('../../src/repositories/relatorio-entregas.repository');

/**
 * 12I — serviço dos gráficos do Dashboard (RED, sem PostgreSQL). A rota já exigiu dashboard.visualizar; aqui cada gráfico só sai se o usuário
 * vê a FONTE, pela mesma função do middleware:
 *   setores      -> employeeHistory.visualizar (os funcionários);
 *   episEntregues -> epiFicha.visualizar (a mesma permissão da aba "EPIs entregues" e do cartão).
 * Sem a permissão: { permitido: false }, sem número. Empresa, usuário e perfil vêm só do contexto (sessão).
 */

const CONTEXTO = { empresaId: 42, usuarioId: 7, perfil: 'USUARIO', hoje: '2026-10-21' };
// As leituras dos produtos saem de uma transação só (READ ONLY); o pool simulado entrega um client inerte.
const pool = { query: async () => ({ rows: [] }), connect: async () => ({ query: async () => ({ rows: [] }), release() {} }) };

function simular(t, { recursos = {}, setores = [], top = [], serie = [], soma = 0 } = {}) {
  const liberado = { employeeHistory: true, epiFicha: true, ...recursos };
  const chamadas = { setores: [], top: [], serie: [], soma: [] };
  t.mock.method(autorizacao, 'avaliarPermissaoRecurso', async (_p, _c, r) => ({ visualizar: liberado[r] === true }));
  t.mock.method(repo, 'contarAtivosPorSetor', async (...a) => { chamadas.setores.push(a); return setores; });
  t.mock.method(repo, 'topProdutosEntregues', async (...a) => { chamadas.top.push(a); return top; });
  t.mock.method(repo, 'seriePorProduto', async (...a) => { chamadas.serie.push(a); return serie; });
  t.mock.method(entregasRepo, 'somarQuantidade', async (...a) => { chamadas.soma.push(a); return soma; });
  return chamadas;
}

describe('setores: funcionários ativos cadastrados no período, por setor', () => {
  test('MES: consulta o mês corrente da empresa do contexto; nulo vira "Sem setor"; ordem do repositório preservada; total = soma', async (t) => {
    const chamadas = simular(t, { setores: [{ setor: 'Produção', quantidade: 3 }, { setor: 'Manutenção', quantidade: 2 }, { setor: null, quantidade: 1 }] });
    const r = await servico.setores(pool, { ...CONTEXTO, periodo: 'MES' });
    assert.deepEqual(r, {
      permitido: true, periodo: 'MES', de: '2026-10-01', ate: '2026-10-31', total: 6,
      setores: [{ setor: 'Produção', quantidade: 3 }, { setor: 'Manutenção', quantidade: 2 }, { setor: 'Sem setor', quantidade: 1 }],
    });
    assert.deepEqual(chamadas.setores[0].slice(1), [42, { de: '2026-10-01', ate: '2026-10-31' }]);
  });

  test('SEIS_MESES e ANO calculam o período de calendário e o passam ao repositório', async (t) => {
    const chamadas = simular(t);
    const seis = await servico.setores(pool, { ...CONTEXTO, periodo: 'SEIS_MESES' });
    const ano = await servico.setores(pool, { ...CONTEXTO, periodo: 'ANO' });
    assert.deepEqual([seis.de, seis.ate, ano.de, ano.ate], ['2026-05-01', '2026-10-31', '2025-11-01', '2026-10-31']);
    assert.deepEqual(chamadas.setores.map((a) => a[2]), [{ de: '2026-05-01', ate: '2026-10-31' }, { de: '2025-11-01', ate: '2026-10-31' }]);
    assert.deepEqual(seis.setores, []);
    assert.equal(seis.total, 0);
  });

  test('sem employeeHistory.visualizar: { permitido: false } e nenhuma consulta', async (t) => {
    const chamadas = simular(t, { recursos: { employeeHistory: false } });
    assert.deepEqual(await servico.setores(pool, { ...CONTEXTO, periodo: 'MES' }), { permitido: false });
    assert.equal(chamadas.setores.length, 0);
  });

  test('contexto inválido é TypeError antes de qualquer consulta', async (t) => {
    const chamadas = simular(t);
    for (const ctx of [{ ...CONTEXTO, empresaId: 0 }, { ...CONTEXTO, hoje: '2026-02-30' }, { ...CONTEXTO, periodo: 'DIA' }, { ...CONTEXTO, usuarioId: null }, { ...CONTEXTO, perfil: '' }]) {
      await assert.rejects(() => servico.setores(pool, { periodo: 'MES', ...ctx }), TypeError);
    }
    assert.equal(chamadas.setores.length, 0);
  });
});

describe('episEntregues: top 5 produtos por unidades entregues no período', () => {
  const TOP = [{ materialId: 7, nome: 'Luva', total: 20 }, { materialId: 9, nome: 'Botina', total: 5 }];

  test('MES: série por dia de 1º até hoje, cinco produtos fixos pelo total do período, zeros preenchidos, total do período pela mesma soma do cartão', async (t) => {
    const chamadas = simular(t, {
      top: TOP,
      serie: [{ materialId: 7, chave: '2026-10-03', quantidade: 12 }, { materialId: 9, chave: '2026-10-03', quantidade: 5 }, { materialId: 7, chave: '2026-10-21', quantidade: 8 }],
      soma: 26,
    });
    const r = await servico.episEntregues(pool, { ...CONTEXTO, periodo: 'MES' });
    assert.deepEqual({ permitido: r.permitido, periodo: r.periodo, de: r.de, ate: r.ate, agrupamento: r.agrupamento, total: r.total }, { permitido: true, periodo: 'MES', de: '2026-10-01', ate: '2026-10-31', agrupamento: 'DIA', total: 26 });
    assert.deepEqual(r.produtos, TOP);
    assert.equal(r.series.length, 21);
    assert.deepEqual(r.series[0], { chave: '2026-10-01', quantidades: [0, 0] });
    assert.deepEqual(r.series[2], { chave: '2026-10-03', quantidades: [12, 5] });
    assert.deepEqual(r.series[20], { chave: '2026-10-21', quantidades: [8, 0] });
    // Os filtros do relatório: só empresa (parâmetro), de e ate; limite 5; a série só dos cinco materiais.
    const filtros = chamadas.top[0][2];
    assert.deepEqual(filtros, { padraoItem: null, padraoFuncionario: null, padraoSetor: null, de: '2026-10-01', ate: '2026-10-31', diasMin: null, diasMax: null });
    assert.deepEqual(chamadas.top[0][3], { limite: 5 });
    assert.deepEqual(chamadas.serie[0].slice(1), [42, filtros, { materialIds: [7, 9], agrupamento: 'DIA' }]);
    assert.deepEqual(chamadas.soma[0].slice(1), [42, filtros]);
  });

  test('SEIS_MESES: série por mês, seis chaves, inclusive meses sem entrega', async (t) => {
    simular(t, { top: TOP, serie: [{ materialId: 9, chave: '2026-05', quantidade: 5 }], soma: 5 });
    const r = await servico.episEntregues(pool, { ...CONTEXTO, periodo: 'SEIS_MESES' });
    assert.equal(r.agrupamento, 'MES');
    assert.deepEqual(r.series.map((s) => s.chave), ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
    assert.deepEqual(r.series[0].quantidades, [0, 5]);
    assert.deepEqual(r.series[5].quantidades, [0, 0]);
  });

  test('sem nenhuma entrega no período: produtos e série vazios (com as chaves), total 0 — estado vazio decidido pelo cliente', async (t) => {
    const chamadas = simular(t, { top: [], serie: [], soma: 0 });
    const r = await servico.episEntregues(pool, { ...CONTEXTO, periodo: 'ANO' });
    assert.deepEqual(r.produtos, []);
    assert.equal(r.series.length, 12);
    assert.ok(r.series.every((s) => s.quantidades.length === 0));
    assert.equal(r.total, 0);
    assert.equal(chamadas.serie.length, 0, 'sem produtos não há série a consultar');
  });

  test('um material da série fora do top (não deveria vir) é ignorado, nunca cria coluna', async (t) => {
    simular(t, { top: TOP, serie: [{ materialId: 99, chave: '2026-10-01', quantidade: 3 }], soma: 3 });
    const r = await servico.episEntregues(pool, { ...CONTEXTO, periodo: 'MES' });
    assert.deepEqual(r.series[0].quantidades, [0, 0]);
  });

  test('sem epiFicha.visualizar: { permitido: false } e nenhuma consulta', async (t) => {
    const chamadas = simular(t, { recursos: { epiFicha: false } });
    assert.deepEqual(await servico.episEntregues(pool, { ...CONTEXTO, periodo: 'MES' }), { permitido: false });
    assert.equal(chamadas.top.length + chamadas.serie.length + chamadas.soma.length, 0);
  });

  test('LIMITE_PRODUTOS é 5', () => {
    assert.equal(servico.LIMITE_PRODUTOS, 5);
  });
});
