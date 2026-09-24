'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { criar, buscarValidaPorHash, registrarUso, revogar } = require('../../src/repositories/sessao-plataforma.repository');

/**
 * Contrato do repositório de sessões de plataforma (migration 028). Mesma
 * disciplina de sessao.repository.test.js: condições de validade só na
 * consulta, nunca depois; sem empresa_id em lugar nenhum (uma sessão de
 * plataforma não carrega contexto empresarial).
 */

const ADMIN_ID = 9;
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
  criado_em: new Date('2026-09-23T10:00:00Z'),
  expira_em: new Date('2026-09-23T22:00:00Z'),
  ultimo_uso_em: new Date('2026-09-23T10:30:00Z'),
  administrador_id: ADMIN_ID,
  administrador_email: 'admin@safework.com.br',
  ...extra,
});

describe('criar', () => {
  test('grava o vínculo com o administrador, sem empresa_id/usuario_id', async () => {
    const executor = executorFalso([{ id: SESSAO }]);
    const expiraEm = new Date('2026-09-23T22:00:00Z');

    const id = await criar(executor, { administradorId: ADMIN_ID, tokenHash: HASH, expiraEm });

    assert.equal(id, SESSAO);
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /insert\s+into\s+sessoes_plataforma/i);
    assert.deepEqual(valores, [ADMIN_ID, HASH, expiraEm, null, null]);
    assert.equal(texto.includes(HASH), false, 'o hash não pode ser concatenado no SQL');
    assert.match(texto, /clock_timestamp\(\)/i);
    assert.doesNotMatch(texto, /empresa_id|usuario_id/i);
  });

  test('recusa entrada inválida antes de consultar', async () => {
    const executor = executorFalso([{ id: SESSAO }]);
    const base = { administradorId: ADMIN_ID, tokenHash: HASH, expiraEm: new Date(Date.now() + 3600e3) };

    await assert.rejects(() => criar(executor, { ...base, administradorId: 0 }), /administrador/i);
    await assert.rejects(() => criar(executor, { ...base, tokenHash: 'curto' }), /hash/i);
    await assert.rejects(() => criar(executor, { ...base, tokenHash: 'A'.repeat(64) }), /hash/i);
    await assert.rejects(() => criar(executor, { ...base, expiraEm: '2026-09-23' }), /data/i);

    assert.equal(executor.chamadas.length, 0);
  });
});

describe('buscarValidaPorHash', () => {
  test('as condições de validade estão na consulta, inclusive administrador.ativo', async () => {
    const executor = executorFalso([linhaSessao()]);

    await buscarValidaPorHash(executor, HASH, INATIVIDADE);

    const { texto, valores } = executor.chamadas[0];
    assert.deepEqual(valores, [HASH, INATIVIDADE]);
    assert.match(texto, /revogada_em\s+is\s+null/i);
    assert.match(texto, /expira_em\s*>/i);
    assert.match(texto, /ultimo_uso_em/i);
    assert.match(texto, /a\.ativo/i, 'administrador inativo derruba a sessão');
    assert.doesNotMatch(texto, /empresa_id|usuario_id/i);
  });

  test('devolve contexto estruturado, sem hash nem token', async () => {
    const executor = executorFalso([linhaSessao()]);

    const contexto = await buscarValidaPorHash(executor, HASH, INATIVIDADE);

    assert.deepEqual(Object.keys(contexto).sort(), ['administrador', 'sessao']);
    assert.equal(contexto.sessao.id, SESSAO);
    assert.equal(contexto.administrador.id, ADMIN_ID);
    const serializado = JSON.stringify(contexto);
    assert.equal(serializado.includes(HASH), false);
    assert.equal(/senha_hash/i.test(executor.chamadas[0].texto), false);
  });

  test('sessão inválida não é encontrada e devolve null', async () => {
    assert.equal(await buscarValidaPorHash(executorFalso([]), HASH, INATIVIDADE), null);
  });

  test('recusa entrada inválida antes de consultar', async () => {
    const executor = executorFalso([linhaSessao()]);

    await assert.rejects(() => buscarValidaPorHash(executor, 'curto', INATIVIDADE), /hash/i);
    await assert.rejects(() => buscarValidaPorHash(executor, HASH, 0), /inatividade/i);

    assert.equal(executor.chamadas.length, 0);
  });
});

describe('registrarUso', () => {
  test('atualiza o último uso sob os mesmos critérios de validade', async () => {
    const executor = executorFalso([], 1);

    const atualizou = await registrarUso(executor, SESSAO, INATIVIDADE);

    assert.equal(atualizou, true);
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /update\s+sessoes_plataforma/i);
    assert.match(texto, /ultimo_uso_em\s*=\s*now\(\)/i);
    assert.match(texto, /revogada_em\s+is\s+null/i);
    assert.deepEqual(valores, [SESSAO, INATIVIDADE]);
  });

  test('devolve false quando nada foi atualizado', async () => {
    assert.equal(await registrarUso(executorFalso([], 0), SESSAO, INATIVIDADE), false);
  });

  test('recusa identificador fora do formato decimal canônico', async () => {
    const executor = executorFalso([], 1);
    await assert.rejects(() => registrarUso(executor, 777, INATIVIDADE), /sess/i);
    await assert.rejects(() => registrarUso(executor, '0', INATIVIDADE), /sess/i);
    assert.equal(executor.chamadas.length, 0);
  });
});

describe('revogar', () => {
  test('revoga a sessão registrando o motivo, sem filtro de empresa', async () => {
    const executor = executorFalso([], 1);

    const revogou = await revogar(executor, SESSAO, 'LOGOUT');

    assert.equal(revogou, true);
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /update\s+sessoes_plataforma/i);
    assert.match(texto, /revogada_em\s*=\s*now\(\)/i);
    assert.deepEqual(valores, [SESSAO, 'LOGOUT']);
  });

  test('não revoga duas vezes a mesma sessão', async () => {
    const executor = executorFalso([], 1);
    await revogar(executor, SESSAO, 'LOGOUT');
    assert.match(executor.chamadas[0].texto, /revogada_em\s+is\s+null/i);
  });

  test('devolve false quando a sessão já não está ativa', async () => {
    assert.equal(await revogar(executorFalso([], 0), SESSAO, 'LOGOUT'), false);
  });

  test('recusa motivo fora do formato aceito pela coluna', async () => {
    const executor = executorFalso([], 1);
    await assert.rejects(() => revogar(executor, SESSAO, 'logout'), /motivo/i);
    await assert.rejects(() => revogar(executor, SESSAO, ''), /motivo/i);
    assert.equal(executor.chamadas.length, 0);
  });
});
