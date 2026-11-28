'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const entregasRepo = require('../src/repositories/relatorio-entregas.repository');
const { SELECIONAR, DIAS, DE } = require('../src/repositories/entrega-epi-historico.repository');
const { criarRelatorioController } = require('../src/controllers/relatorio.controller');

/**
 * Relógio injetável dos relatórios de entregas (D2, D3, D4): sem injeção, a consulta é exatamente a de antes, com o
 * "hoje" do PostgreSQL; com injeção, o "hoje" chega como parâmetro. O FILTRO exportado, a numeração dos parâmetros e o
 * Dashboard não mudam.
 */
const sha = (texto) => crypto.createHash('sha256').update(texto).digest('hex');
const FILTROS = {
  padraoItem: null, padraoFuncionario: null, padraoSetor: null, de: null, ate: null, diasMin: 0, diasMax: 30,
};
const PAGINA = { ordem: 'dias', direcao: 'asc', pagina: 2, limite: 25 };
const ORDEM_DIAS = `ORDER BY ${DIAS} ASC, e.entregue_em DESC, i.id DESC`;

function executorFalso() {
  const consultas = [];
  return {
    consultas,
    async query(sql, params) {
      consultas.push({ sql, params });
      return { rows: /count\(\*\)|sum\(/.test(sql) ? [{ total: 0 }] : [] };
    },
  };
}

describe('relatório de entregas sem relógio injetado: consulta idêntica à original', () => {
  test('FILTRO, DE e SELECIONAR exportados não mudam (o Dashboard os reutiliza)', () => {
    assert.equal(sha(entregasRepo.FILTRO), '12bed4df9d955e00682ffc441fce2517e43c823fd28041c4ee2c3fbe65da5f7d');
    assert.equal(sha(DE), '1e842e49e90a9526a3e863810fbaa13a21488d5201083a165de20d5e79675cc6');
    assert.equal(sha(SELECIONAR), 'ed840b2feaabb7e899cde87e8952d4ce1d55979a1fb47834aba4192395961f2e');
    assert.deepEqual(entregasRepo.parametros(7, FILTROS), [7, null, null, null, null, null, 0, 30]);
  });

  test('listar, contar e somarQuantidade: mesmo SQL e mesmos parâmetros, hoje do PostgreSQL', async () => {
    const x = executorFalso();
    await entregasRepo.listar(x, 7, FILTROS, PAGINA);
    await entregasRepo.contar(x, 7, FILTROS);
    await entregasRepo.somarQuantidade(x, 7, FILTROS);
    const base = [7, null, null, null, null, null, 0, 30];
    assert.deepEqual(x.consultas, [
      { sql: `${SELECIONAR} ${DE} ${entregasRepo.FILTRO} ${ORDEM_DIAS} LIMIT $9 OFFSET $10`, params: [...base, 25, 25] },
      { sql: `SELECT count(*)::int AS total ${DE} ${entregasRepo.FILTRO}`, params: base },
      { sql: `SELECT coalesce(sum(i.quantidade), 0)::int AS total ${DE} ${entregasRepo.FILTRO}`, params: base },
    ]);
    for (const { sql } of x.consultas) assert.match(sql, /now\(\) AT TIME ZONE 'America\/Sao_Paulo'/);
  });
});

describe('relatório de entregas com relógio injetado', () => {
  test('listar: o hoje vai como $11, depois de LIMIT $9 e OFFSET $10; nenhum now() nos dias', async () => {
    const x = executorFalso();
    await entregasRepo.listar(x, 7, FILTROS, PAGINA, '2026-11-28');
    const [{ sql, params }] = x.consultas;
    assert.deepEqual(params, [7, null, null, null, null, null, 0, 30, 25, 25, '2026-11-28']);
    assert.ok(sql.endsWith('LIMIT $9 OFFSET $10'));
    assert.doesNotMatch(sql, /now\(\)/);
    assert.match(sql, /\$11::date/);
  });

  test('contar: o hoje vai como $9; os oito parâmetros originais ficam na mesma posição', async () => {
    const x = executorFalso();
    await entregasRepo.contar(x, 7, FILTROS, '2026-11-28');
    const [{ sql, params }] = x.consultas;
    assert.deepEqual(params, [7, null, null, null, null, null, 0, 30, '2026-11-28']);
    assert.doesNotMatch(sql, /now\(\)/);
    assert.match(sql, /\$9::date/);
  });

  test('hoje inválido é erro de programação, antes de consultar', async () => {
    const x = executorFalso();
    await assert.rejects(entregasRepo.listar(x, 7, FILTROS, PAGINA, '2026-13-01'), TypeError);
    await assert.rejects(entregasRepo.contar(x, 7, FILTROS, 'hoje'), TypeError);
    assert.equal(x.consultas.length, 0);
  });
});

describe('controller: o relógio só é usado quando injetado', () => {
  const req = (query = {}) => ({ empresa: { id: 7 }, validado: { query: { pagina: 1, limite: 10, ...query } } });
  const res = () => ({ status() { return this; }, json(corpo) { this.corpo = corpo; return this; } });
  const ROTAS = ['proximoVencimento', 'vencidos', 'entregues'];

  test('sem relógio: as três rotas de entregas consultam com o hoje do PostgreSQL e sem parâmetro extra', async () => {
    for (const rota of ROTAS) {
      const pool = executorFalso();
      await criarRelatorioController({ pool })[rota](req(), res());
      assert.equal(pool.consultas.length, 2, rota);
      for (const { sql, params } of pool.consultas) {
        assert.match(sql, /now\(\) AT TIME ZONE 'America\/Sao_Paulo'/, rota);
        assert.ok(!params.includes('2026-11-28'), rota);
      }
    }
  });

  test('com relógio: o dia operacional do instante injetado chega às três rotas', async () => {
    const instante = new Date('2026-11-28T00:00:01-03:00');
    for (const rota of ROTAS) {
      const pool = executorFalso();
      await criarRelatorioController({ pool, agora: () => instante })[rota](req(), res());
      for (const { sql, params } of pool.consultas) {
        assert.doesNotMatch(sql, /now\(\)/, rota);
        assert.equal(params.at(-1), '2026-11-28', rota);
      }
    }
  });

  test('virada do dia: 23:59:59 e 00:00:01 de São Paulo dão dias operacionais consecutivos', async () => {
    const hoje = async (iso) => {
      const pool = executorFalso();
      await criarRelatorioController({ pool, agora: () => new Date(iso) }).vencidos(req(), res());
      return pool.consultas[0].params.at(-1);
    };
    assert.equal(await hoje('2026-11-27T23:59:59-03:00'), '2026-11-27');
    assert.equal(await hoje('2026-11-28T00:00:01-03:00'), '2026-11-28');
    assert.equal(await hoje('2026-11-28T02:59:59Z'), '2026-11-27', '02:59:59 UTC ainda é dia 27 em São Paulo');
    assert.equal(await hoje('2026-11-28T03:00:01Z'), '2026-11-28');
  });
});
