'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * Contexto da nova solicitação de EPI (12G-0, L2), sem banco: valida antes de
 * abrir transação, lê num retrato único somente leitura, usa a empresa da
 * sessão e projeta só o que a tela de quem pede precisa (sem CPF e sem número
 * de estoque). O comportamento contra o PostgreSQL real está em
 * test/integracao/solicitacao-epi-contexto-routes.integration.js.
 */

const servico = () => exigirModulo('src/services/solicitacao-epi-contexto.service');
const funcionarioRepo = require('../../src/repositories/funcionario.repository');
const entregaContextoRepo = require('../../src/repositories/entrega-epi-contexto.repository');
const contextoRepo = () => exigirModulo('src/repositories/solicitacao-epi-contexto.repository');

const poolFechado = { connect: async () => { throw new Error('não deve abrir transação'); } };
function poolFalso() {
  const comandos = [];
  const client = { query: async (texto) => { comandos.push(texto); return { rows: [] }; }, release: () => {} };
  return { comandos, connect: async () => client };
}
const transacoes = (pool) => pool.comandos.filter((c) => /^(BEGIN|COMMIT|ROLLBACK)/.test(c));

describe('solicitacao-epi-contexto.service', () => {
  test('validação antes de qualquer acesso ao banco: empresa e trabalhador inteiros positivos', async () => {
    for (const empresaId of [0, -1, 1.5, '3']) {
      await assert.rejects(servico().localizarTrabalhadores(poolFechado, { empresaId, pagina: 1, limite: 20 }), TypeError, String(empresaId));
      await assert.rejects(servico().listarMateriais(poolFechado, { empresaId, funcionarioId: 5, pagina: 1, limite: 20 }), TypeError, String(empresaId));
    }
    for (const funcionarioId of [0, null, '5']) {
      await assert.rejects(servico().listarMateriais(poolFechado, { empresaId: 3, funcionarioId, pagina: 1, limite: 20 }), TypeError, String(funcionarioId));
    }
  });

  test('trabalhadores: a busca do contexto da entrega (só ativos), com a empresa da sessão, num retrato único; a resposta sai sem CPF nem GHE', async (t) => {
    const lista = t.mock.method(entregaContextoRepo, 'listarFuncionarios', async () => [{
      id: 5, nome: 'Ana', matricula: 'M-1', cpf: '12345678909', setor: 'S', funcao: 'F', ativo: true, ghe: { id: 2, nome: 'G' },
    }]);
    const conta = t.mock.method(entregaContextoRepo, 'contarFuncionarios', async () => 1);
    const pool = poolFalso();
    const r = await servico().localizarTrabalhadores(pool, {
      empresaId: 3, busca: 'Ana', pagina: 2, limite: 10,
    });
    assert.deepEqual(lista.mock.calls[0].arguments.slice(1), [3, { busca: 'Ana', pagina: 2, limite: 10 }]);
    assert.deepEqual(conta.mock.calls[0].arguments.slice(1), [3, { busca: 'Ana' }]);
    assert.deepEqual(r, {
      funcionarios: [{
        id: 5, nome: 'Ana', matricula: 'M-1', setor: 'S', funcao: 'F',
      }],
      total: 1,
      pagina: 2,
      limite: 10,
    });
    assert.deepEqual(transacoes(pool), ['BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ', 'COMMIT']);
  });

  test('materiais: trabalhador inexistente ou de outra empresa é 404; inativo é 409; nada de material é lido nesses casos', async (t) => {
    const busca = t.mock.method(funcionarioRepo, 'buscarPorId', async () => null);
    assert.equal(typeof contextoRepo().listarMateriais, 'function');
    const lista = t.mock.method(contextoRepo(), 'listarMateriais', async () => []);
    await assert.rejects(servico().listarMateriais(poolFalso(), { empresaId: 3, funcionarioId: 5, pagina: 1, limite: 20 }), (e) => e.status === 404 && e.codigo === 'FUNCIONARIO_NAO_ENCONTRADO');
    busca.mock.mockImplementation(async () => ({ id: 5, ativo: false, grupoHomogeneoId: 2 }));
    await assert.rejects(servico().listarMateriais(poolFalso(), { empresaId: 3, funcionarioId: 5, pagina: 1, limite: 20 }), (e) => e.status === 409 && e.codigo === 'FUNCIONARIO_INATIVO');
    assert.equal(lista.mock.calls.length, 0);
    assert.deepEqual(busca.mock.calls[0].arguments.slice(1), [3, 5]);
  });

  test('materiais: o GHE atual do trabalhador vai como filtro; a resposta sai só com os campos do contexto, sem estoque', async (t) => {
    t.mock.method(funcionarioRepo, 'buscarPorId', async () => ({ id: 5, ativo: true, grupoHomogeneoId: 2, cpf: '12345678909' }));
    const lista = t.mock.method(contextoRepo(), 'listarMateriais', async () => [{
      id: 9, nome: 'Botina', unidade: 'par', exigeTamanho: true, previstoNoGhe: true, tamanhosSugeridos: ['40'], saldo: 3,
    }]);
    const conta = t.mock.method(contextoRepo(), 'contarMateriais', async () => 1);
    const pool = poolFalso();
    const r = await servico().listarMateriais(pool, {
      empresaId: 3, funcionarioId: 5, busca: 'Bo', previstoNoGhe: true, pagina: 1, limite: 20,
    });
    assert.deepEqual(lista.mock.calls[0].arguments.slice(1), [3, {
      gheId: 2, busca: 'Bo', previstoNoGhe: true, pagina: 1, limite: 20,
    }]);
    assert.deepEqual(conta.mock.calls[0].arguments.slice(1), [3, { gheId: 2, busca: 'Bo', previstoNoGhe: true }]);
    assert.deepEqual(r, {
      funcionarioId: 5,
      materiais: [{
        id: 9, nome: 'Botina', unidade: 'par', exigeTamanho: true, previstoNoGhe: true, tamanhosSugeridos: ['40'],
      }],
      total: 1,
      pagina: 1,
      limite: 20,
    });
    assert.deepEqual(transacoes(pool), ['BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ', 'COMMIT']);
  });

  test('uma falha de leitura desfaz o retrato e sobe sem tratamento', async (t) => {
    const erro = new Error('banco');
    t.mock.method(entregaContextoRepo, 'listarFuncionarios', async () => { throw erro; });
    const pool = poolFalso();
    await assert.rejects(servico().localizarTrabalhadores(pool, { empresaId: 3, pagina: 1, limite: 20 }), erro);
    assert.deepEqual(transacoes(pool), ['BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ', 'ROLLBACK']);
  });
});

describe('solicitacao-epi-contexto.repository — parâmetros', () => {
  const executor = () => {
    const chamadas = [];
    return { chamadas, query: async (sql, params) => { chamadas.push([sql, params]); return { rows: [{ total: 0 }] }; } };
  };

  test('empresa, GHE, busca, previsto, página e limite validados antes da consulta', async () => {
    for (const [empresaId, filtros] of [[0, {}], [3, { gheId: 0 }], [3, { busca: '' }], [3, { previstoNoGhe: 'true' }]]) {
      await assert.rejects(contextoRepo().contarMateriais(executor(), empresaId, filtros), TypeError, JSON.stringify(filtros));
    }
    for (const limite of [0, 101, 1.5]) {
      await assert.rejects(contextoRepo().listarMateriais(executor(), 3, { pagina: 1, limite }), TypeError, String(limite));
    }
    await assert.rejects(contextoRepo().listarMateriais(executor(), 3, { pagina: 0, limite: 20 }), TypeError);
  });

  test('a busca vai como parâmetro com os coringas escapados; o deslocamento vem da página', async () => {
    const e = executor();
    await contextoRepo().listarMateriais(e, 3, {
      gheId: 2, busca: '50%_x', previstoNoGhe: false, pagina: 3, limite: 10,
    });
    const [sql, params] = e.chamadas[0];
    assert.deepEqual(params, [3, 2, '50\\%\\_x', false, 10, 20]);
    assert.match(sql, /m\.empresa_id = \$1 AND m\.ativo\s/);
    assert.equal(/exige_tamanho\s+IS\s+NOT\s+NULL/i.test(sql), false, 'o não classificado do GHE não some: a tela explica e a criação recusa');
    assert.equal(/saldo|quantidade/i.test(sql.replace(/l\.tamanho/g, '')), false, 'a consulta não lê saldo nem quantidade');
  });
});
