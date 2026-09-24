'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { criar, buscarCredencialPorEmail, buscarPorEmail, buscarPorId } = require('../../src/repositories/administrador-plataforma.repository');

/**
 * Contrato do repositório de administradores de plataforma (migration 027).
 * `senha_hash` só pode sair de buscarCredencialPorEmail — as demais consultas
 * nunca a projetam, mesma disciplina de usuario.repository.js.
 */

const ADMIN_ID = 3;
const EMAIL = 'admin@safework.com.br';
const SENHA_HASH = '$argon2id$v=19$m=65536,t=3,p=1$c2ludGV0aWNv$aGFzaHNpbnRldGljbw';

const executorFalso = (linhas = []) => {
  const chamadas = [];
  return {
    chamadas,
    query: async (texto, valores) => {
      chamadas.push({ texto, valores });
      return { rows: linhas };
    },
  };
};

const linhaAdministrador = (extra = {}) => ({
  id: ADMIN_ID,
  email: EMAIL,
  ativo: true,
  criado_em: new Date('2026-09-23T10:00:00Z'),
  atualizado_em: new Date('2026-09-23T10:00:00Z'),
  ...extra,
});

describe('criar', () => {
  test('grava email e senha_hash, de forma parametrizada, sem empresa_id', async () => {
    const executor = executorFalso([linhaAdministrador()]);

    const administrador = await criar(executor, { email: EMAIL, senhaHash: SENHA_HASH });

    assert.deepEqual(administrador, {
      id: ADMIN_ID, email: EMAIL, ativo: true,
      criadoEm: linhaAdministrador().criado_em, atualizadoEm: linhaAdministrador().atualizado_em,
    });
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /insert\s+into\s+administradores_plataforma/i);
    assert.deepEqual(valores, [EMAIL, SENHA_HASH]);
    assert.equal(texto.includes(SENHA_HASH), false, 'o hash não pode ser concatenado no SQL');
    assert.doesNotMatch(texto, /empresa_id/i, 'a criação nunca associa a empresa alguma');
  });

  test('recusa entrada inválida antes de consultar', async () => {
    const executor = executorFalso([linhaAdministrador()]);

    await assert.rejects(() => criar(executor, { email: '', senhaHash: SENHA_HASH }), /e-mail/i);
    await assert.rejects(() => criar(executor, { email: 'x'.repeat(151), senhaHash: SENHA_HASH }), /e-mail/i);
    await assert.rejects(() => criar(executor, { email: EMAIL, senhaHash: '' }), /hash/i);
    await assert.rejects(() => criar(executor, { email: EMAIL, senhaHash: null }), /hash/i);

    assert.equal(executor.chamadas.length, 0);
  });
});

describe('buscarCredencialPorEmail', () => {
  test('busca case-insensitive e devolve senha_hash', async () => {
    const executor = executorFalso([linhaAdministrador({ senha_hash: SENHA_HASH })]);

    const administrador = await buscarCredencialPorEmail(executor, EMAIL);

    assert.deepEqual(administrador, { id: ADMIN_ID, email: EMAIL, senhaHash: SENHA_HASH, ativo: true });
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /lower\(email\)\s*=\s*lower\(\$1\)/i);
    assert.match(texto, /senha_hash/i, 'esta é a única consulta que pode projetar senha_hash');
    assert.deepEqual(valores, [EMAIL]);
  });

  test('e-mail inexistente devolve null', async () => {
    assert.equal(await buscarCredencialPorEmail(executorFalso([]), EMAIL), null);
  });

  test('recusa e-mail inválido antes de consultar', async () => {
    const executor = executorFalso([]);
    await assert.rejects(() => buscarCredencialPorEmail(executor, ''), /e-mail/i);
    await assert.rejects(() => buscarCredencialPorEmail(executor, null), /e-mail/i);
    assert.equal(executor.chamadas.length, 0);
  });
});

describe('buscarPorEmail', () => {
  test('nunca projeta senha_hash', async () => {
    const executor = executorFalso([linhaAdministrador()]);

    const administrador = await buscarPorEmail(executor, EMAIL);

    assert.deepEqual(administrador, {
      id: ADMIN_ID, email: EMAIL, ativo: true,
      criadoEm: linhaAdministrador().criado_em, atualizadoEm: linhaAdministrador().atualizado_em,
    });
    assert.equal(Object.hasOwn(administrador, 'senhaHash'), false);
    assert.equal(/senha_hash/i.test(executor.chamadas[0].texto), false, 'buscarPorEmail não deve pedir a coluna senha_hash');
  });

  test('e-mail inexistente devolve null', async () => {
    assert.equal(await buscarPorEmail(executorFalso([]), EMAIL), null);
  });
});

describe('buscarPorId', () => {
  test('busca por identificador, sem senha_hash', async () => {
    const executor = executorFalso([linhaAdministrador()]);

    const administrador = await buscarPorId(executor, ADMIN_ID);

    assert.equal(administrador.id, ADMIN_ID);
    assert.equal(Object.hasOwn(administrador, 'senhaHash'), false);
    assert.deepEqual(executor.chamadas[0].valores, [ADMIN_ID]);
  });

  test('identificador inexistente devolve null', async () => {
    assert.equal(await buscarPorId(executorFalso([]), ADMIN_ID), null);
  });

  test('recusa identificador fora do formato', async () => {
    const executor = executorFalso([]);
    await assert.rejects(() => buscarPorId(executor, 0), /inválido/i);
    await assert.rejects(() => buscarPorId(executor, -1), /inválido/i);
    await assert.rejects(() => buscarPorId(executor, '3'), /inválido/i);
    assert.equal(executor.chamadas.length, 0);
  });
});
