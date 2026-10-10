'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const servico = require('../../src/services/relatorio.service');

/** Executor de mentira: guarda os parâmetros de cada consulta e devolve resultado vazio. */
function executor() {
  const chamadas = [];
  return {
    chamadas,
    query: async (sql, params) => {
      chamadas.push({ sql, params });
      return { rows: /count\(\*\)/.test(sql) ? [{ total: 0 }] : [] };
    },
  };
}
const base = { empresaId: 7, pagina: 1, limite: 20 };

describe('Relatórios 12K-D: status e faixas de dias, sem tocar o banco', () => {
  test('status de "próximo do vencimento": 0–10 trocar urgente, 11–20 atenção, 21–30 próximo', () => {
    assert.deepEqual([0, 5, 10].map(servico.statusProximo), ['TROCAR_URGENTE', 'TROCAR_URGENTE', 'TROCAR_URGENTE']);
    assert.deepEqual([11, 15, 20].map(servico.statusProximo), ['ATENCAO', 'ATENCAO', 'ATENCAO']);
    assert.deepEqual([21, 25, 30].map(servico.statusProximo), ['PROXIMO', 'PROXIMO', 'PROXIMO']);
  });

  test('faixa vira limites de dias no servidor; sem faixa, 0 a 30; vencidos só abaixo de zero; entregues sem limite de dias', async () => {
    const limites = async (funcao, extra = {}) => {
      const e = executor();
      await funcao(e, { ...base, ...extra });
      const consulta = e.chamadas.find((c) => !/count\(\*\)/.test(c.sql));
      return [consulta.params[6], consulta.params[7]];
    };
    assert.deepEqual(await limites(servico.proximoVencimento), [0, 30]);
    assert.deepEqual(await limites(servico.proximoVencimento, { faixa: '0-10' }), [0, 10]);
    assert.deepEqual(await limites(servico.proximoVencimento, { faixa: '11-20' }), [11, 20]);
    assert.deepEqual(await limites(servico.proximoVencimento, { faixa: '21-30' }), [21, 30]);
    assert.deepEqual(await limites(servico.vencidos), [null, -1]);
    assert.deepEqual(await limites(servico.entregues), [null, null]);
  });

  test('empresa vem só do chamador (primeiro parâmetro); busca sem acento e com curingas escapados; ordenação padrão por relatório', async () => {
    const e = executor();
    await servico.entregues(e, { ...base, funcionario: 'Ana_%', setor: 'Produção', item: ' LUVA ' });
    const consulta = e.chamadas.find((c) => !/count\(\*\)/.test(c.sql));
    assert.equal(consulta.params[0], 7);
    assert.equal(consulta.params[1], '%luva%');
    assert.equal(consulta.params[2], '%ana\\_\\%%');
    assert.equal(consulta.params[5], '%producao%');
    assert.match(consulta.sql, /ORDER BY e\.data_operacional DESC/);
    const v = executor();
    await servico.vencidos(v, base);
    assert.match(v.chamadas.find((c) => !/count\(\*\)/.test(c.sql)).sql, /ORDER BY\s+\(\(\s*e\.data_operacional\s*\+\s*i\.material_prazo_uso_dias\s*\)\s*-[\s\S]*?\)\s+ASC,\s*e\.entregue_em\s+DESC/);
  });

  test('ordenação fora da lista nunca chega ao SQL', async () => {
    await assert.rejects(() => servico.entregues(executor(), { ...base, ordem: 'senha_hash' }), TypeError);
    await assert.rejects(() => servico.estoque(executor(), { ...base, ordem: '1; DROP TABLE materiais' }), TypeError);
  });
});
