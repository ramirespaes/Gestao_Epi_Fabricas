'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { assertSemSensiveis } = require('../helpers/sensiveis');

const repo = require('../../src/repositories/liberacao-cadastro-mfa-plataforma.repository');

/**
 * Contrato do repositório de liberações de cadastro (migration 053). Só o
 * hash do código chega aqui. O banco garante no máximo uma liberação aberta
 * por administrador; o consumo é condicional e respeita o prazo pelo
 * relógio do banco.
 */

const ADMIN = 7;
const LIBERACAO = '5';
const HASH = 'c'.repeat(64);
const CODIGO_EM_CLARO = 'ABCD-EFGH-JKMN-PQRS';

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

describe('criar', () => {
  test('grava hash, origem e prazo a partir do mesmo instante do banco', async () => {
    const criadoEm = new Date('2026-09-28T10:00:00Z');
    const expiraEm = new Date('2026-09-28T10:30:00Z');
    const executor = executorFalso([{ id: LIBERACAO, criado_em: criadoEm, expira_em: expiraEm }]);

    const liberacao = await repo.criar(executor, { administradorId: ADMIN, codigoHash: HASH, origem: 'CLI_RESET', validadeMinutos: 30 });

    assert.deepEqual(liberacao, { id: LIBERACAO, criadoEm, expiraEm });
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /insert\s+into\s+liberacoes_cadastro_mfa_plataforma/i);
    assert.match(texto, /clock_timestamp\(\)/i);
    assert.deepEqual(valores, [ADMIN, HASH, 'CLI_RESET', 30]);
  });

  test('recusa origem desconhecida, prazo inválido e código em claro, sem ecoar valores', async () => {
    const executor = executorFalso([]);
    const base = { administradorId: ADMIN, codigoHash: HASH, origem: 'CLI_LIBERACAO', validadeMinutos: 30 };
    for (const extra of [{ origem: 'MANUAL' }, { origem: 'cli_reset' }, { validadeMinutos: 0 }, { codigoHash: CODIGO_EM_CLARO }, { administradorId: 0 }]) {
      await assert.rejects(() => repo.criar(executor, { ...base, ...extra }), (erro) => {
        assert.ok(erro instanceof TypeError);
        assertSemSensiveis(erro.message, [CODIGO_EM_CLARO, HASH], 'erro');
        return true;
      });
    }
    assert.equal(executor.chamadas.length, 0);
  });
});

describe('buscas', () => {
  test('buscarAberta: nem consumida nem revogada, com a vigência calculada no banco', async () => {
    const linha = { id: LIBERACAO, origem: 'CLI_LIBERACAO', criado_em: new Date(), expira_em: new Date(), vigente: false };
    const executor = executorFalso([linha]);

    const aberta = await repo.buscarAberta(executor, ADMIN, { travar: true });

    assert.deepEqual(aberta, { id: LIBERACAO, origem: 'CLI_LIBERACAO', criadoEm: linha.criado_em, expiraEm: linha.expira_em, vigente: false });
    const { texto, valores } = executor.chamadas[0];
    assert.deepEqual(valores, [ADMIN]);
    assert.match(texto, /consumida_em\s+is\s+null/i);
    assert.match(texto, /revogada_em\s+is\s+null/i);
    assert.match(texto, /expira_em\s*>\s*clock_timestamp\(\)/i);
    assert.match(texto, /for\s+update/i);
  });

  test('buscarValidaPorHash exige também o prazo e o administrador', async () => {
    const executor = executorFalso([{ id: LIBERACAO, origem: 'CLI_CRIACAO', criado_em: new Date(), expira_em: new Date(), vigente: true }]);

    await repo.buscarValidaPorHash(executor, { administradorId: ADMIN, codigoHash: HASH });

    const { texto, valores } = executor.chamadas[0];
    assert.deepEqual(valores, [ADMIN, HASH]);
    assert.match(texto, /administrador_id\s*=\s*\$1/i);
    assert.match(texto, /codigo_hash\s*=\s*\$2/i);
    assert.match(texto, /where[\s\S]*expira_em\s*>\s*clock_timestamp\(\)/i);
    assert.equal(await repo.buscarValidaPorHash(executorFalso([]), { administradorId: ADMIN, codigoHash: HASH }), null);
  });
});

describe('consumir', () => {
  test('UPDATE condicional: aberta, no prazo, deste administrador; devolve o id do vencedor', async () => {
    const executor = executorFalso([{ id: LIBERACAO }], 1);

    assert.equal(await repo.consumir(executor, { administradorId: ADMIN, codigoHash: HASH }), LIBERACAO);

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /consumida_em\s*=\s*clock_timestamp\(\)/i);
    assert.match(texto, /consumida_em\s+is\s+null/i);
    assert.match(texto, /revogada_em\s+is\s+null/i);
    assert.match(texto, /expira_em\s*>\s*clock_timestamp\(\)/i);
    assert.deepEqual(valores, [ADMIN, HASH]);
    assert.equal(await repo.consumir(executorFalso([], 0), { administradorId: ADMIN, codigoHash: HASH }), null);
  });
});

describe('revogarAberta', () => {
  test('revoga a aberta mesmo vencida, com motivo; sem aberta devolve false', async () => {
    const executor = executorFalso([], 1);

    assert.equal(await repo.revogarAberta(executor, { administradorId: ADMIN, motivo: 'SUBSTITUIDA' }), true);

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /revogada_em\s*=\s*clock_timestamp\(\)/i);
    assert.match(texto, /motivo_revogacao\s*=\s*\$2/i);
    assert.doesNotMatch(texto, /expira_em/i, 'a vencida também é revogada');
    assert.deepEqual(valores, [ADMIN, 'SUBSTITUIDA']);
    assert.equal(await repo.revogarAberta(executorFalso([], 0), { administradorId: ADMIN, motivo: 'SUBSTITUIDA' }), false);
    await assert.rejects(() => repo.revogarAberta(executor, { administradorId: ADMIN, motivo: 'x' }), TypeError);
  });
});
