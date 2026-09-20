'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buscarPorEmail,
  buscarPorId,
  buscarCredencialPorEmail,
  CAMPOS_PUBLICOS,
} = require('../../src/repositories/usuario.repository');

/**
 * Contrato do repositório de usuários.
 *
 * Este é o primeiro repositório que recebe filtro de empresa, e por isso o
 * que fixa o padrão de isolamento: nenhuma busca é global. O identificador da
 * empresa é sempre o primeiro parâmetro, nunca opcional, e entra na cláusula
 * de filtro junto com o critério pedido.
 *
 * O hash da senha só sai por uma função, cujo nome diz isso. As demais
 * projetam apenas os campos públicos, para que um objeto de usuário devolvido
 * ao contexto de sessão ou à apresentação não possa carregar credencial.
 *
 * Verificação de senha, decisão sobre usuário ativo e resposta ao cliente não
 * pertencem aqui. São do serviço de autenticação.
 */

// Valores altos de propósito: com empresa 1, a verificação de concatenação
// casaria com o marcador $1 da própria consulta e não provaria nada.
const EMPRESA_A = 4242;
const EMPRESA_B = 8888;
const EMAIL = 'ana.souza@demo.safeworkengenharia.com.br';
const HASH = '$argon2id$v=19$m=65536,t=3,p=1$c2FsZ2Fkb2RlbW9uc3RyYQ$aGFzaGRlbW9uc3RyYWNhb3NpbnRldGljbw';

const executorFalso = (linhas = []) => {
  const chamadas = [];
  return {
    chamadas,
    query: async (texto, valores) => {
      chamadas.push({ texto, valores });
      return { rows: linhas, rowCount: linhas.length };
    },
  };
};

const linhaUsuario = (extra = {}) => ({
  id: 10,
  empresa_id: EMPRESA_A,
  nome: 'Ana Souza',
  email: EMAIL,
  perfil: 'ADMINISTRADOR',
  ativo: true,
  biometria_cadastrada: false,
  ...extra,
});

describe('buscarPorEmail', () => {
  test('filtra pela empresa e pelo e-mail, de forma parametrizada', async () => {
    const executor = executorFalso([linhaUsuario()]);

    await buscarPorEmail(executor, EMPRESA_A, EMAIL);

    const { texto, valores } = executor.chamadas[0];
    assert.deepEqual(valores, [EMPRESA_A, EMAIL], 'a empresa deve ser o primeiro parâmetro');
    assert.equal(texto.includes(EMAIL), false, 'o e-mail não pode aparecer no texto da consulta');
    assert.equal(texto.includes(String(EMPRESA_A)), false, 'o identificador não pode ser concatenado');
    assert.match(texto, /empresa_id\s*=\s*\$1/i, 'o filtro de empresa é obrigatório');
    assert.match(texto, /lower\(email\)\s*=\s*\$2/i, 'deve casar com o índice único por empresa e e-mail');
  });

  test('não devolve o hash da senha', async () => {
    const executor = executorFalso([linhaUsuario({ senha_hash: HASH })]);

    const usuario = await buscarPorEmail(executor, EMPRESA_A, EMAIL);

    assert.deepEqual(Object.keys(usuario).sort(), [...CAMPOS_PUBLICOS].sort());
    assert.equal('senha_hash' in usuario, false);
    assert.equal(JSON.stringify(usuario).includes(HASH), false);
    assert.equal(CAMPOS_PUBLICOS.includes('senha_hash'), false);
  });

  test('a projeção da consulta não pede a coluna de senha', async () => {
    const executor = executorFalso([linhaUsuario()]);

    await buscarPorEmail(executor, EMPRESA_A, EMAIL);

    assert.equal(/senha_hash/i.test(executor.chamadas[0].texto), false);
  });

  test('usuário inexistente devolve null', async () => {
    assert.equal(await buscarPorEmail(executorFalso([]), EMPRESA_A, EMAIL), null);
  });

  test('recusa entrada inválida antes de consultar', async () => {
    const executor = executorFalso([linhaUsuario()]);

    await assert.rejects(() => buscarPorEmail(executor, 0, EMAIL), /empresa/i);
    await assert.rejects(() => buscarPorEmail(executor, -1, EMAIL), /empresa/i);
    await assert.rejects(() => buscarPorEmail(executor, '1', EMAIL), /empresa/i);
    await assert.rejects(() => buscarPorEmail(executor, null, EMAIL), /empresa/i);
    await assert.rejects(() => buscarPorEmail(executor, EMPRESA_A, 'Ana.Souza@Demo.Test'), /e-mail/i);
    await assert.rejects(() => buscarPorEmail(executor, EMPRESA_A, '  espaco@demo.test  '), /e-mail/i);
    await assert.rejects(() => buscarPorEmail(executor, EMPRESA_A, null), /e-mail/i);

    assert.equal(executor.chamadas.length, 0, 'nenhuma consulta deve ser emitida');
  });
});

describe('buscarPorId', () => {
  test('filtra pela empresa junto com o identificador', async () => {
    const executor = executorFalso([linhaUsuario()]);

    await buscarPorId(executor, EMPRESA_A, 10);

    const { texto, valores } = executor.chamadas[0];
    assert.deepEqual(valores, [EMPRESA_A, 10]);
    assert.match(texto, /empresa_id\s*=\s*\$1/i, 'sem o filtro de empresa a busca alcançaria outra contratante');
    assert.match(texto, /id\s*=\s*\$2/i);
  });

  test('não devolve o hash da senha', async () => {
    const executor = executorFalso([linhaUsuario({ senha_hash: HASH })]);

    const usuario = await buscarPorId(executor, EMPRESA_A, 10);

    assert.equal('senha_hash' in usuario, false);
    assert.equal(/senha_hash/i.test(executor.chamadas[0].texto), false);
  });

  test('devolve null quando não encontra', async () => {
    assert.equal(await buscarPorId(executorFalso([]), EMPRESA_A, 999), null);
  });

  test('recusa entrada inválida antes de consultar', async () => {
    const executor = executorFalso([linhaUsuario()]);

    await assert.rejects(() => buscarPorId(executor, 0, 10), /empresa/i);
    await assert.rejects(() => buscarPorId(executor, EMPRESA_A, 0), /identificador/i);
    await assert.rejects(() => buscarPorId(executor, EMPRESA_A, 1.5), /identificador/i);
    await assert.rejects(() => buscarPorId(executor, EMPRESA_A, '10'), /identificador/i);

    assert.equal(executor.chamadas.length, 0);
  });
});

describe('buscarCredencialPorEmail', () => {
  test('devolve o hash, que é o motivo de esta função existir', async () => {
    const executor = executorFalso([linhaUsuario({ senha_hash: HASH })]);

    const credencial = await buscarCredencialPorEmail(executor, EMPRESA_A, EMAIL);

    assert.equal(credencial.senha_hash, HASH);
    assert.match(executor.chamadas[0].texto, /senha_hash/i);
    assert.deepEqual(
      Object.keys(credencial).sort(),
      [...CAMPOS_PUBLICOS, 'senha_hash'].sort(),
      'traz os campos públicos mais o hash, e nada além',
    );
  });

  test('também é delimitada por empresa', async () => {
    const executor = executorFalso([linhaUsuario({ senha_hash: HASH })]);

    await buscarCredencialPorEmail(executor, EMPRESA_B, EMAIL);

    const { texto, valores } = executor.chamadas[0];
    assert.deepEqual(valores, [EMPRESA_B, EMAIL]);
    assert.match(texto, /empresa_id\s*=\s*\$1/i);
    assert.match(texto, /lower\(email\)\s*=\s*\$2/i);
  });

  test('devolve null quando não encontra, sem revelar o motivo', async () => {
    assert.equal(await buscarCredencialPorEmail(executorFalso([]), EMPRESA_A, EMAIL), null);
  });

  test('recusa entrada inválida antes de consultar', async () => {
    const executor = executorFalso([linhaUsuario({ senha_hash: HASH })]);

    await assert.rejects(() => buscarCredencialPorEmail(executor, 0, EMAIL), /empresa/i);
    await assert.rejects(() => buscarCredencialPorEmail(executor, EMPRESA_A, 'MAIUSCULA@demo.test'), /e-mail/i);

    assert.equal(executor.chamadas.length, 0);
  });

  test('o repositório não decide se o usuário pode entrar', async () => {
    const executor = executorFalso([linhaUsuario({ senha_hash: HASH, ativo: false })]);

    const credencial = await buscarCredencialPorEmail(executor, EMPRESA_A, EMAIL);

    assert.notEqual(credencial, null, 'usuário inativo é devolvido; quem decide é o serviço');
    assert.equal(credencial.ativo, false);
  });
});
