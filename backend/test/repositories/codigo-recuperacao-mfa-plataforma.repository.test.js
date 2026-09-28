'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { assertSemSensiveis } = require('../helpers/sensiveis');

const repo = require('../../src/repositories/codigo-recuperacao-mfa-plataforma.repository');

/**
 * Contrato do repositório de recovery codes (migration 051). Só hashes
 * chegam aqui: o código em claro nunca é parâmetro de nenhuma função. Um
 * código só é utilizável com o lote ATIVO e ainda não consumido, e o
 * consumo é um UPDATE condicional com um único vencedor.
 */

const ADMIN = 7;
const LOTE = '12';
const hash = (n) => crypto.createHash('sha256').update(`codigo-${n}`).digest('hex');
const HASHES = Array.from({ length: 10 }, (_, i) => hash(i));
const CODIGO_EM_CLARO = '7ZQ3K9M2W4X8H6TD';

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

describe('inserirHashes', () => {
  test('um único INSERT, só no lote ATIVO deste administrador, com o formato do hash', async () => {
    const executor = executorFalso([], 10);

    assert.equal(await repo.inserirHashes(executor, { administradorId: ADMIN, loteId: LOTE, hashes: HASHES }), 10);

    assert.equal(executor.chamadas.length, 1);
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /insert\s+into\s+codigos_recuperacao_mfa_plataforma/i);
    assert.match(texto, /unnest\(\$3/i);
    assert.match(texto, /estado\s*=\s*'ATIVO'/i);
    assert.match(texto, /clock_timestamp\(\)/i);
    assert.deepEqual(valores, [LOTE, ADMIN, HASHES, 1]);
    for (const h of HASHES) assert.equal(texto.includes(h), false);
  });

  test('lote que não está ATIVO insere zero (quem chama confere a quantidade)', async () => {
    assert.equal(await repo.inserirHashes(executorFalso([], 0), { administradorId: ADMIN, loteId: LOTE, hashes: HASHES }), 0);
  });

  test('recusa lista vazia, grande demais, repetida, hash fora do formato ou código em claro, sem ecoar valores', async () => {
    const executor = executorFalso([], 0);
    const casos = [
      [],
      Array.from({ length: 21 }, (_, i) => hash(`x${i}`)),
      [HASHES[0], HASHES[0]],
      [HASHES[0].toUpperCase()],
      [HASHES[0].slice(1)],
      [CODIGO_EM_CLARO],
      'nao-e-lista',
    ];
    for (const hashes of casos) {
      await assert.rejects(() => repo.inserirHashes(executor, { administradorId: ADMIN, loteId: LOTE, hashes }), (erro) => {
        assert.ok(erro instanceof TypeError);
        assertSemSensiveis(erro.message, [CODIGO_EM_CLARO, HASHES[0], HASHES[0].toUpperCase()], 'erro');
        return true;
      });
    }
    await assert.rejects(() => repo.inserirHashes(executor, { administradorId: ADMIN, loteId: 12, hashes: HASHES }), TypeError);
    assert.equal(executor.chamadas.length, 0);
  });
});

describe('buscarUtilizavelPorHash', () => {
  test('exige lote ATIVO e código não consumido; trava só a linha do código', async () => {
    const executor = executorFalso([{ id: '99', lote_id: LOTE }]);

    assert.deepEqual(await repo.buscarUtilizavelPorHash(executor, { administradorId: ADMIN, codigoHash: HASHES[0] }), { id: '99', loteId: LOTE });
    await repo.buscarUtilizavelPorHash(executor, { administradorId: ADMIN, codigoHash: HASHES[0] }, { travar: true });

    const { texto, valores } = executor.chamadas[0];
    assert.deepEqual(valores, [ADMIN, HASHES[0]]);
    assert.match(texto, /codigo_hash\s*=\s*\$2/i);
    assert.match(texto, /consumido_em\s+is\s+null/i);
    assert.match(texto, /estado\s*=\s*'ATIVO'/i);
    assert.doesNotMatch(texto, /for\s+update/i);
    assert.match(executor.chamadas[1].texto, /for\s+update\s+of\s+c\b/i);
  });

  test('nada utilizável devolve null', async () => {
    assert.equal(await repo.buscarUtilizavelPorHash(executorFalso([]), { administradorId: ADMIN, codigoHash: HASHES[0] }), null);
  });
});

describe('consumir', () => {
  test('UPDATE condicional atômico: marca consumido só se o lote está ATIVO e o código ainda não foi usado', async () => {
    const executor = executorFalso([{ id: '99', lote_id: LOTE }], 1);

    assert.deepEqual(await repo.consumir(executor, { administradorId: ADMIN, codigoHash: HASHES[3] }), { id: '99', loteId: LOTE });

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /update\s+codigos_recuperacao_mfa_plataforma/i);
    assert.match(texto, /consumido_em\s*=\s*clock_timestamp\(\)/i);
    assert.match(texto, /consumido_em\s+is\s+null/i);
    assert.match(texto, /estado\s*=\s*'ATIVO'/i);
    assert.match(texto, /returning/i);
    assert.deepEqual(valores, [ADMIN, HASHES[3]]);
  });

  test('perdedor da corrida (0 linhas) recebe null', async () => {
    assert.equal(await repo.consumir(executorFalso([], 0), { administradorId: ADMIN, codigoHash: HASHES[3] }), null);
  });

  test('nunca aceita o código em claro no lugar do hash', async () => {
    const executor = executorFalso([], 1);
    await assert.rejects(() => repo.consumir(executor, { administradorId: ADMIN, codigoHash: CODIGO_EM_CLARO }), (erro) => {
      assert.ok(erro instanceof TypeError);
      assertSemSensiveis(erro.message, [CODIGO_EM_CLARO], 'erro');
      return true;
    });
    await assert.rejects(() => repo.buscarUtilizavelPorHash(executor, { administradorId: ADMIN, codigoHash: CODIGO_EM_CLARO }), TypeError);
    assert.equal(executor.chamadas.length, 0);
  });
});

describe('contarRestantes', () => {
  test('conta os não consumidos do lote ATIVO do administrador', async () => {
    const executor = executorFalso([{ restantes: 7 }]);

    assert.equal(await repo.contarRestantes(executor, ADMIN), 7);

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /count\(\*\)/i);
    assert.match(texto, /consumido_em\s+is\s+null/i);
    assert.match(texto, /estado\s*=\s*'ATIVO'/i);
    assert.deepEqual(valores, [ADMIN]);
  });
});
