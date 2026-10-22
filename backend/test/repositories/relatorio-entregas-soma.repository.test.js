'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const repo = require('../../src/repositories/relatorio-entregas.repository');

/**
 * 12I — "EPIs entregues" do Dashboard soma as UNIDADES (i.quantidade) pela MESMA consulta do relatório: o mesmo FROM e o mesmo WHERE da lista e da
 * contagem (empresa, período por data operacional de São Paulo, busca), só trocando o count(*) por sum(quantidade). Sem regra paralela.
 */

const EMPRESA = 42;
const FILTROS = { padraoItem: null, padraoFuncionario: null, padraoSetor: null, de: '2026-10-01', ate: '2026-10-31', diasMin: null, diasMax: null };
const executor = (rows) => { const chamadas = []; return { chamadas, query: async (texto, valores) => { chamadas.push({ texto, valores }); return { rows }; } }; };
const aposFrom = (texto) => texto.slice(texto.indexOf('FROM'));

describe('relatorio-entregas.repository.somarQuantidade (12I)', () => {
  test('soma i.quantidade pelo mesmo FROM e WHERE da contagem e da lista, com os mesmos parâmetros', async () => {
    assert.equal(typeof repo.somarQuantidade, 'function', 'somarQuantidade ainda não existe');
    const soma = executor([{ total: 17 }]);
    const conta = executor([{ total: 3 }]);
    assert.equal(await repo.somarQuantidade(soma, EMPRESA, FILTROS), 17);
    await repo.contar(conta, EMPRESA, FILTROS);
    assert.match(soma.chamadas[0].texto, /sum\(i\.quantidade\)/i);
    assert.equal(aposFrom(soma.chamadas[0].texto).replace(/\s+/g, ' '), aposFrom(conta.chamadas[0].texto).replace(/\s+/g, ' '), 'FROM e WHERE idênticos');
    assert.deepEqual(soma.chamadas[0].valores, conta.chamadas[0].valores);
  });

  test('sem entregas a soma é 0 (nunca nulo) e vem como número', async () => {
    assert.equal(await repo.somarQuantidade(executor([{ total: null }]), EMPRESA, FILTROS), 0);
    assert.equal(await repo.somarQuantidade(executor([{ total: '5' }]), EMPRESA, FILTROS), 5);
  });
});
