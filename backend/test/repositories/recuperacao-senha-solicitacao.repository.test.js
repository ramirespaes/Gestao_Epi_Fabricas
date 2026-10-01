'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

/**
 * Contrato do repositório de solicitações de recuperação de senha (migration
 * 063): primitivas do limite por e-mail. Só a chave HMAC e o escopo entram;
 * não há e-mail, conta nem resultado do envio. A regra do limite (quantas por
 * janela) é do serviço.
 */

const CAMINHO = '../../src/repositories/recuperacao-senha-solicitacao.repository';
const repo = () => require(CAMINHO); // eslint-disable-line global-require
const CHAVE = 'b'.repeat(64);

const executorFalso = (linhas = [], rowCount) => {
  const chamadas = [];
  return {
    chamadas,
    query: async (texto, valores) => {
      chamadas.push({ texto, valores });
      return { rows: linhas, rowCount: rowCount ?? linhas.length };
    },
  };
};

describe('recuperacao-senha-solicitacao.repository', () => {
  test('escopos são exatamente os da migration 063', () => {
    assert.deepEqual(repo().ESCOPOS, { PORTAL: 'PORTAL', PLATAFORMA: 'PLATAFORMA' });
    assert.equal(Object.isFrozen(repo().ESCOPOS), true);
  });

  test('registrar: grava só escopo, chave e origem da requisição; devolve o identificador', async () => {
    const executor = executorFalso([{ id: '31' }]);
    const id = await repo().registrar(executor, { escopo: 'PORTAL', chave: CHAVE, ip: '203.0.113.7', dispositivo: 'Agente de Teste' });
    assert.equal(id, '31');
    const [{ texto, valores }] = executor.chamadas;
    assert.match(texto, /INSERT INTO recuperacao_senha_solicitacoes\s*\(escopo, chave, ip, dispositivo\)/);
    assert.match(texto, /VALUES \(\$1, \$2, \$3, \$4\)/);
    assert.deepEqual(valores, ['PORTAL', CHAVE, '203.0.113.7', 'Agente de Teste']);
    assert.equal(/criado_em/.test(texto.split('RETURNING')[0]), false, 'criado_em é do banco');
  });

  test('registrar: ip e dispositivo são opcionais', async () => {
    const executor = executorFalso([{ id: '32' }]);
    await repo().registrar(executor, { escopo: 'PLATAFORMA', chave: CHAVE });
    assert.deepEqual(executor.chamadas[0].valores, ['PLATAFORMA', CHAVE, null, null]);
  });

  test('contarRecentes: conta por escopo e chave dentro da janela, pelo relógio do banco', async () => {
    const executor = executorFalso([{ total: 2 }]);
    const total = await repo().contarRecentes(executor, { escopo: 'PORTAL', chave: CHAVE, janelaMinutos: 60 });
    assert.equal(total, 2);
    const [{ texto, valores }] = executor.chamadas;
    assert.match(texto, /FROM recuperacao_senha_solicitacoes/);
    assert.match(texto, /escopo = \$1/);
    assert.match(texto, /chave = \$2/);
    assert.match(texto, /criado_em > now\(\) - \(\$3 \* INTERVAL '1 minute'\)/);
    assert.deepEqual(valores, ['PORTAL', CHAVE, 60]);
    assert.equal(valores.some((v) => v instanceof Date), false);
  });

  test('escopo fora da lista, chave fora do formato HMAC (inclusive um e-mail) e janela inválida são recusados antes de qualquer consulta', async () => {
    const ruinsDeRegistro = [
      { escopo: 'portal', chave: CHAVE }, { escopo: 'CLIENTE', chave: CHAVE }, { escopo: undefined, chave: CHAVE },
      { escopo: 'PORTAL', chave: 'pessoa@exemplo-cliente.com.br' }, { escopo: 'PORTAL', chave: 'B'.repeat(64) },
      { escopo: 'PORTAL', chave: 'b'.repeat(63) }, { escopo: 'PORTAL', chave: undefined },
    ];
    for (const ruim of ruinsDeRegistro) {
      const executor = executorFalso([{ id: '1' }]);
      await assert.rejects(() => repo().registrar(executor, ruim), TypeError, JSON.stringify(ruim));
      assert.equal(executor.chamadas.length, 0);
      const outro = executorFalso([{ total: 0 }]);
      await assert.rejects(() => repo().contarRecentes(outro, { ...ruim, janelaMinutos: 60 }), TypeError, JSON.stringify(ruim));
      assert.equal(outro.chamadas.length, 0);
    }
    for (const janelaMinutos of [0, -1, 1.5, '60', undefined, 1441]) {
      const executor = executorFalso([{ total: 0 }]);
      await assert.rejects(() => repo().contarRecentes(executor, { escopo: 'PORTAL', chave: CHAVE, janelaMinutos }), TypeError, String(janelaMinutos));
      assert.equal(executor.chamadas.length, 0);
    }
  });

  test('o módulo só exporta as primitivas, sem purga, sem e-mail e sem ligação com conta', () => {
    assert.deepEqual(Object.keys(repo()).sort(), ['ESCOPOS', 'contarRecentes', 'registrar']);
    const fonte = fs.readFileSync(require.resolve(CAMINHO), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    for (const proibido of [/config\/database/, /\bemail\b/i, /identidade/i, /administrador/i, /DELETE\s+FROM/i]) {
      assert.doesNotMatch(fonte, proibido, String(proibido));
    }
  });
});
