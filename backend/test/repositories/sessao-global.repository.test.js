'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { criar, buscarValidaPorHash, registrarUso, revogar } = require('../../src/repositories/sessao-global.repository');

/**
 * Contrato do repositório de sessões GLOBAIS (migration 035, Pacote 4).
 * Mesma disciplina de sessao-plataforma.repository.test.js: condições de
 * validade só na consulta (inclusive identidades.ativo), nunca depois;
 * sem empresa_id/usuario_id em lugar nenhum — a sessão global identifica a
 * pessoa, não um vínculo.
 */

const IDENTIDADE_ID = 9;
const SESSAO = '777';
const HASH = 'a'.repeat(64);
const INATIVIDADE = 30;

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

const linhaSessao = (extra = {}) => ({
  id: SESSAO,
  criado_em: new Date('2026-09-24T10:00:00Z'),
  expira_em: new Date('2026-09-24T22:00:00Z'),
  ultimo_uso_em: new Date('2026-09-24T10:30:00Z'),
  identidade_id: IDENTIDADE_ID,
  identidade_email: 'pessoa@exemplo-cliente.com.br',
  ...extra,
});

describe('criar', () => {
  test('grava o vínculo com a identidade, sem empresa_id/usuario_id, com clock_timestamp()', async () => {
    const executor = executorFalso([{ id: SESSAO }]);
    const expiraEm = new Date('2026-09-24T22:00:00Z');

    const id = await criar(executor, { identidadeId: IDENTIDADE_ID, tokenHash: HASH, expiraEm });

    assert.equal(id, SESSAO);
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /insert\s+into\s+sessoes_globais/i);
    assert.deepEqual(valores, [IDENTIDADE_ID, HASH, expiraEm, null, null]);
    assert.equal(texto.includes(HASH), false, 'o hash não pode ser concatenado no SQL');
    assert.match(texto, /clock_timestamp\(\)/i);
    assert.doesNotMatch(texto, /empresa_id|usuario_id/i);
  });

  test('recusa entrada inválida antes de consultar', async () => {
    const executor = executorFalso([{ id: SESSAO }]);
    const base = { identidadeId: IDENTIDADE_ID, tokenHash: HASH, expiraEm: new Date(Date.now() + 3600e3) };

    await assert.rejects(() => criar(executor, { ...base, identidadeId: 0 }), /identidade/i);
    await assert.rejects(() => criar(executor, { ...base, identidadeId: '9' }), /identidade/i);
    await assert.rejects(() => criar(executor, { ...base, tokenHash: 'curto' }), /hash/i);
    await assert.rejects(() => criar(executor, { ...base, tokenHash: 'A'.repeat(64) }), /hash/i);
    await assert.rejects(() => criar(executor, { ...base, tokenHash: 'Zm9ybWF0b2Jhc2U2NHVybGRldG9rZW5jb21fNDNjaGFy'.slice(0, 43) }), /hash/i);
    await assert.rejects(() => criar(executor, { ...base, expiraEm: '2026-09-24' }), /data/i);

    assert.equal(executor.chamadas.length, 0);
  });
});

describe('buscarValidaPorHash', () => {
  test('as condições de validade — inclusive identidades.ativo — estão na consulta', async () => {
    const executor = executorFalso([linhaSessao()]);

    await buscarValidaPorHash(executor, HASH, INATIVIDADE);

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /join\s+identidades/i);
    assert.match(texto, /revogada_em\s+is\s+null/i);
    assert.match(texto, /expira_em\s*>\s*now\(\)/i);
    assert.match(texto, /ultimo_uso_em\s*>\s*now\(\)\s*-/i);
    assert.match(texto, /i\.ativo/i);
    assert.doesNotMatch(texto, /empresa|usuario/i);
    assert.deepEqual(valores, [HASH, INATIVIDADE]);
  });

  test('devolve { sessao, identidade } sem hash de senha nem token', async () => {
    const contexto = await buscarValidaPorHash(executorFalso([linhaSessao()]), HASH, INATIVIDADE);

    assert.deepEqual(Object.keys(contexto).sort(), ['identidade', 'sessao']);
    assert.deepEqual(contexto.identidade, { id: IDENTIDADE_ID, email: 'pessoa@exemplo-cliente.com.br' });
    assert.equal(contexto.sessao.id, SESSAO);
    const serializado = JSON.stringify(contexto);
    assert.equal(serializado.includes('senha'), false);
    assert.equal(serializado.includes(HASH), false);
  });

  test('sessão inválida devolve null; entradas inválidas são recusadas antes de consultar', async () => {
    assert.equal(await buscarValidaPorHash(executorFalso([]), HASH, INATIVIDADE), null);
    const executor = executorFalso([]);
    await assert.rejects(() => buscarValidaPorHash(executor, 'x', INATIVIDADE), /hash/i);
    await assert.rejects(() => buscarValidaPorHash(executor, HASH, 0), /inatividade/i);
    assert.equal(executor.chamadas.length, 0);
  });
});

describe('registrarUso e revogar', () => {
  test('registrarUso atualiza só sessão ainda válida e devolve false quando nada muda', async () => {
    const executor = executorFalso([], 1);
    assert.equal(await registrarUso(executor, SESSAO, INATIVIDADE), true);
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /update\s+sessoes_globais/i);
    assert.match(texto, /revogada_em\s+is\s+null/i);
    assert.match(texto, /expira_em\s*>\s*now\(\)/i);
    assert.deepEqual(valores, [SESSAO, INATIVIDADE]);
    assert.equal(await registrarUso(executorFalso([], 0), SESSAO, INATIVIDADE), false);
    await assert.rejects(() => registrarUso(executorFalso([]), 777, INATIVIDADE), /sessão/i);
  });

  test('revogar registra o motivo e não revoga duas vezes', async () => {
    const executor = executorFalso([], 1);
    assert.equal(await revogar(executor, SESSAO, 'LOGOUT'), true);
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /revogada_em\s+is\s+null/i);
    assert.deepEqual(valores, [SESSAO, 'LOGOUT']);
    assert.equal(await revogar(executorFalso([], 0), SESSAO, 'LOGOUT'), false);
    await assert.rejects(() => revogar(executorFalso([]), SESSAO, 'logout'), /motivo/i);
    await assert.rejects(() => revogar(executorFalso([]), '0', 'LOGOUT'), /sessão/i);
  });
});

describe('bloquearValida', () => {
  const { bloquearValida } = require('../../src/repositories/sessao-global.repository');

  test('FOR UPDATE só em sessão não revogada e não expirada; true/false conforme a linha exista', async () => {
    const executor = executorFalso([{ id: SESSAO }]);
    assert.equal(await bloquearValida(executor, SESSAO), true);
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /for\s+update/i);
    assert.match(texto, /revogada_em\s+is\s+null/i);
    assert.match(texto, /expira_em\s*>\s*now\(\)/i);
    assert.deepEqual(valores, [SESSAO]);
    assert.equal(await bloquearValida(executorFalso([]), SESSAO), false);
    await assert.rejects(() => bloquearValida(executorFalso([]), 55), /sessão/i);
  });
});
