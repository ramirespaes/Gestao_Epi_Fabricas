'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  criar, buscarValidaPorHash, registrarUso, revogar, revogarTodasDoAdministrador,
} = require('../../src/repositories/sessao-plataforma.repository');

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
    assert.deepEqual(valores, [ADMIN_ID, HASH, expiraEm, null, null, null, null], 'sem MFA informado, as colunas de MFA ficam nulas');
    assert.equal(texto.includes(HASH), false, 'o hash não pode ser concatenado no SQL');
    assert.match(texto, /clock_timestamp\(\)/i);
    assert.doesNotMatch(texto, /empresa_id|usuario_id/i);
  });

  test('sessão nascida do MFA grava o instante e o método da verificação', async () => {
    const executor = executorFalso([{ id: SESSAO }]);
    const expiraEm = new Date('2026-09-28T18:00:00Z');
    const verificadoEm = new Date('2026-09-28T10:00:00Z');

    await criar(executor, { administradorId: ADMIN_ID, tokenHash: HASH, expiraEm, mfa: { verificadoEm, metodo: 'CADASTRO' } });

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /mfa_verificado_em/i);
    assert.match(texto, /mfa_metodo/i);
    assert.deepEqual(valores, [ADMIN_ID, HASH, expiraEm, null, null, verificadoEm, 'CADASTRO']);
  });

  test('recusa entrada inválida antes de consultar', async () => {
    const executor = executorFalso([{ id: SESSAO }]);
    const base = { administradorId: ADMIN_ID, tokenHash: HASH, expiraEm: new Date(Date.now() + 3600e3) };

    await assert.rejects(() => criar(executor, { ...base, administradorId: 0 }), /administrador/i);
    await assert.rejects(() => criar(executor, { ...base, tokenHash: 'curto' }), /hash/i);
    await assert.rejects(() => criar(executor, { ...base, tokenHash: 'A'.repeat(64) }), /hash/i);
    await assert.rejects(() => criar(executor, { ...base, expiraEm: '2026-09-23' }), /data/i);
    for (const mfa of [{ verificadoEm: new Date(), metodo: 'SENHA' }, { verificadoEm: 'ontem', metodo: 'TOTP' }, { metodo: 'TOTP' }, 'TOTP']) {
      await assert.rejects(() => criar(executor, { ...base, mfa }), /mfa/i, JSON.stringify(mfa));
    }

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

describe('revogarTodasDoAdministrador', () => {
  test('revoga todas as sessões não revogadas do administrador e devolve a quantidade', async () => {
    const executor = executorFalso([], 3);

    assert.equal(await revogarTodasDoAdministrador(executor, ADMIN_ID, 'MFA_RESET_OPERACIONAL'), 3);

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /update\s+sessoes_plataforma/i);
    assert.match(texto, /revogada_em\s*=\s*now\(\)/i);
    assert.match(texto, /motivo_revogacao\s*=\s*\$2/i);
    assert.match(texto, /administrador_id\s*=\s*\$1/i);
    assert.match(texto, /revogada_em\s+is\s+null/i, 'não sobrescreve motivo nem instante de quem já foi revogada');
    assert.deepEqual(valores, [ADMIN_ID, 'MFA_RESET_OPERACIONAL', null]);
  });

  test('exceção opcional de uma sessão (a que continua ou a que vai ser trocada por outra via)', async () => {
    const executor = executorFalso([], 2);

    assert.equal(await revogarTodasDoAdministrador(executor, ADMIN_ID, 'MFA_SUBSTITUIDO', { exceto: SESSAO }), 2);

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /id\s*<>\s*\$3/i);
    assert.deepEqual(valores, [ADMIN_ID, 'MFA_SUBSTITUIDO', SESSAO]);
  });

  test('idempotente: sem nada a revogar devolve 0', async () => {
    assert.equal(await revogarTodasDoAdministrador(executorFalso([], 0), ADMIN_ID, 'MFA_RESET_OPERACIONAL'), 0);
  });

  test('motivo é obrigatório e exceção precisa ser um id de sessão; nada é consultado antes', async () => {
    const executor = executorFalso([], 1);
    await assert.rejects(() => revogarTodasDoAdministrador(executor, ADMIN_ID), /motivo/i);
    await assert.rejects(() => revogarTodasDoAdministrador(executor, ADMIN_ID, 'mfa'), /motivo/i);
    await assert.rejects(() => revogarTodasDoAdministrador(executor, 0, 'MFA_RESET_OPERACIONAL'), /administrador/i);
    await assert.rejects(() => revogarTodasDoAdministrador(executor, ADMIN_ID, 'MFA_RESET_OPERACIONAL', { exceto: 777 }), /sess/i);
    assert.equal(executor.chamadas.length, 0);
  });
});

// O MFA só passa a ser exigido na leitura da sessão num incremento
// posterior; até lá a consulta não pode depender das colunas novas.
describe('buscarValidaPorHash ainda sem exigência de MFA', () => {
  test('a consulta não menciona mfa_verificado_em nem mfa_metodo', async () => {
    const executor = executorFalso([]);
    await buscarValidaPorHash(executor, HASH, INATIVIDADE);
    assert.doesNotMatch(executor.chamadas[0].texto, /mfa_/i);
  });
});
