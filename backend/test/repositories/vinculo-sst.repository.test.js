'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * Contrato do repositório administrativo de vinculo_sst (migration 018). A
 * existência da linha é o vínculo: o repositório só insere, remove e lê, sempre
 * filtrando pela empresa; quem pode fazê-lo e a auditoria são do serviço. As
 * FKs compostas e a chave primária são provadas com PostgreSQL real na
 * integração do serviço.
 */

const repo = () => exigirModulo('src/repositories/vinculo-sst.repository');

const EMPRESA = 4242;
const CONCEDIDO_EM = new Date('2026-10-02T15:00:00Z');

const executorFalso = (...respostas) => {
  const chamadas = [];
  return {
    chamadas,
    query: async (texto, valores) => {
      chamadas.push({ texto, valores });
      return { rows: respostas.length > 0 ? respostas.shift() : [] };
    },
  };
};

const linha = (extra = {}) => ({ usuario_id: 11, empresa_id: EMPRESA, concedido_por: 7, concedido_em: CONCEDIDO_EM, motivo: null, ...extra });
const publica = (extra = {}) => ({ usuarioId: 11, empresaId: EMPRESA, concedidoPor: 7, concedidoEm: CONCEDIDO_EM, motivo: null, ...extra });

describe('inserir', () => {
  test('insere o vínculo da empresa sem conflito e devolve a linha; o repositório não decide quem pode', async () => {
    const executor = executorFalso([linha()]);
    assert.deepEqual(await repo().inserir(executor, { empresaId: EMPRESA, usuarioId: 11, concedidoPor: 7 }), publica());
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /^INSERT INTO vinculo_sst \(empresa_id, usuario_id, concedido_por, motivo\)/);
    assert.match(texto, /ON CONFLICT \(usuario_id\) DO NOTHING/);
    assert.match(texto, /RETURNING /);
    assert.deepEqual(valores, [EMPRESA, 11, 7, null]);
  });

  test('devolve null quando o vínculo já existe (nenhuma linha inserida); o motivo opcional vai ao banco', async () => {
    const executor = executorFalso([], [linha({ motivo: 'Técnico de segurança' })]);
    assert.equal(await repo().inserir(executor, { empresaId: EMPRESA, usuarioId: 11, concedidoPor: 7 }), null);
    const inserida = await repo().inserir(executor, { empresaId: EMPRESA, usuarioId: 11, concedidoPor: 7, motivo: 'Técnico de segurança' });
    assert.equal(inserida.motivo, 'Técnico de segurança');
    assert.equal(executor.chamadas[1].valores[3], 'Técnico de segurança');
  });

  test('recusa identificadores e motivo inválidos sem consultar; o motivo conta caracteres', async () => {
    const vazio = executorFalso();
    for (const extra of [{ empresaId: 0 }, { usuarioId: -1 }, { concedidoPor: 1.5 }, { motivo: '' }, { motivo: 'x'.repeat(501) }, { motivo: 7 }]) {
      await assert.rejects(() => repo().inserir(vazio, { empresaId: EMPRESA, usuarioId: 11, concedidoPor: 7, ...extra }), TypeError, JSON.stringify(extra));
    }
    await repo().inserir(executorFalso([linha()]), { empresaId: EMPRESA, usuarioId: 11, concedidoPor: 7, motivo: '\u{1D400}'.repeat(500) });
    assert.equal(vazio.chamadas.length, 0);
  });
});

describe('remover', () => {
  test('remove só o vínculo do usuário na empresa e devolve a linha removida; null quando não havia', async () => {
    const executor = executorFalso([linha()], []);
    assert.deepEqual(await repo().remover(executor, EMPRESA, 11), publica());
    assert.equal(await repo().remover(executor, EMPRESA, 11), null);
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /^DELETE FROM vinculo_sst WHERE empresa_id = \$1 AND usuario_id = \$2\s+RETURNING /);
    assert.deepEqual(valores, [EMPRESA, 11]);
  });

  test('recusa identificadores inválidos sem consultar', async () => {
    const vazio = executorFalso();
    await assert.rejects(() => repo().remover(vazio, 0, 11), /empresa/);
    await assert.rejects(() => repo().remover(vazio, EMPRESA, '11'), /usuário/);
    assert.equal(vazio.chamadas.length, 0);
  });
});

describe('buscarPorUsuario e listarPorEmpresa', () => {
  test('buscarPorUsuario procura pelo par (empresa, usuário); null quando não há', async () => {
    const executor = executorFalso([linha()], []);
    assert.deepEqual(await repo().buscarPorUsuario(executor, EMPRESA, 11), publica());
    assert.equal(await repo().buscarPorUsuario(executor, EMPRESA, 11), null);
    assert.match(executor.chamadas[0].texto, /WHERE empresa_id = \$1 AND usuario_id = \$2/);
    assert.deepEqual(executor.chamadas[0].valores, [EMPRESA, 11]);
  });

  test('listarPorEmpresa devolve os vínculos da empresa, por usuário', async () => {
    const executor = executorFalso([linha({ usuario_id: 11 }), linha({ usuario_id: 12 })], []);
    assert.deepEqual((await repo().listarPorEmpresa(executor, EMPRESA)).map((v) => v.usuarioId), [11, 12]);
    assert.deepEqual(await repo().listarPorEmpresa(executor, EMPRESA), []);
    assert.match(executor.chamadas[0].texto, /WHERE empresa_id = \$1\s+ORDER BY usuario_id$/);
    assert.deepEqual(executor.chamadas[0].valores, [EMPRESA]);
  });

  test('recusa identificadores inválidos sem consultar', async () => {
    const vazio = executorFalso();
    await assert.rejects(() => repo().buscarPorUsuario(vazio, 0, 11), /empresa/);
    await assert.rejects(() => repo().buscarPorUsuario(vazio, EMPRESA, 0), /usuário/);
    await assert.rejects(() => repo().listarPorEmpresa(vazio, -1), /empresa/);
    assert.equal(vazio.chamadas.length, 0);
  });
});

describe('o repositório não toca outras tabelas', () => {
  test('só vinculo_sst', async () => {
    const executor = executorFalso([linha()], [linha()], [linha()], [linha()]);
    await repo().inserir(executor, { empresaId: EMPRESA, usuarioId: 11, concedidoPor: 7 });
    await repo().remover(executor, EMPRESA, 11);
    await repo().buscarPorUsuario(executor, EMPRESA, 11);
    await repo().listarPorEmpresa(executor, EMPRESA);
    for (const { texto } of executor.chamadas) {
      assert.doesNotMatch(texto, /usuarios|usuario_autorizacoes|permissoes|logs_auditoria/);
    }
  });
});
