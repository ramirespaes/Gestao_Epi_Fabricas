'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const servico = require('../../src/services/relatorio.service');
const entregasRepo = require('../../src/repositories/relatorio-entregas.repository');

/**
 * 12I — as duas contagens do Dashboard saem do serviço oficial dos relatórios (nenhuma regra duplicada):
 *   unidadesEntregues  = soma das unidades da aba "EPIs entregues" no período;
 *   contarProximoVencimento = o total da aba "Prazo de uso — próximo do vencimento" na janela padrão de até 30 dias.
 */

const EMPRESA = 42;

describe('relatorio.service.unidadesEntregues', () => {
  test('soma as unidades do período pelos mesmos filtros do relatório (de/ate), empresa da sessão', async (t) => {
    const chamadas = [];
    t.mock.method(entregasRepo, 'somarQuantidade', async (...a) => { chamadas.push(a); return 23; });
    const pool = { marca: 'pool' };
    assert.equal(await servico.unidadesEntregues(pool, { empresaId: EMPRESA, de: '2026-10-01', ate: '2026-10-31' }), 23);
    const [executor, empresa, filtros] = chamadas[0];
    assert.equal(executor, pool);
    assert.equal(empresa, EMPRESA);
    assert.deepEqual(filtros, { padraoItem: null, padraoFuncionario: null, padraoSetor: null, de: '2026-10-01', ate: '2026-10-31', diasMin: null, diasMax: null });
  });
});

describe('relatorio.service.contarProximoVencimento', () => {
  test('conta pelo repositório de contagem do relatório, na janela padrão de 0 a 30 dias, sem filtro de texto', async (t) => {
    const chamadas = [];
    t.mock.method(entregasRepo, 'contar', async (...a) => { chamadas.push(a); return 9; });
    assert.equal(await servico.contarProximoVencimento({ marca: 'pool' }, { empresaId: EMPRESA }), 9);
    assert.deepEqual(chamadas[0][2], { padraoItem: null, padraoFuncionario: null, padraoSetor: null, de: null, ate: null, diasMin: 0, diasMax: 30 });
  });

  test('a janela é a mesma da aba: proximoVencimento sem faixa usa [0, DIAS_PROXIMO_VENCIMENTO]', async (t) => {
    const usados = [];
    t.mock.method(entregasRepo, 'listar', async (_p, _e, filtros) => { usados.push(['listar', filtros.diasMin, filtros.diasMax]); return []; });
    t.mock.method(entregasRepo, 'contar', async (_p, _e, filtros) => { usados.push(['contar', filtros.diasMin, filtros.diasMax]); return 0; });
    await servico.proximoVencimento({}, { empresaId: EMPRESA, pagina: 1, limite: 20 });
    await servico.contarProximoVencimento({}, { empresaId: EMPRESA });
    const contagens = usados.filter((u) => u[0] === 'contar');
    assert.deepEqual(contagens[0].slice(1), contagens[1].slice(1));
  });
});
