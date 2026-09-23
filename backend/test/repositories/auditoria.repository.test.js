'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { registrar } = require('../../src/repositories/auditoria.repository');

/**
 * Contrato do repositório de auditoria (logs_auditoria). Só persiste o que
 * recebe: não redige, não decide, não traduz erro. A proibição de dados
 * sensíveis nos JSONB é responsabilidade do chamador (primeira barreira) e
 * da trigger da migration 014 (segunda) — este repositório só garante que
 * os três campos JSONB sejam objetos ou null, o que a CHECK do banco
 * também exige.
 */

const EMPRESA = 4242;
const USUARIO = 77;

const executorFalso = (linhas = [{ id: '901', criado_em: new Date('2026-09-21T12:00:00Z') }]) => {
  const chamadas = [];
  return {
    chamadas,
    query: async (texto, valores) => {
      chamadas.push({ texto, valores });
      return { rows: linhas, rowCount: linhas.length };
    },
  };
};

describe('registrar', () => {
  test('INSERT parametrizado nas dez colunas, na ordem esperada, devolvendo id (string, BIGINT) e criado_em', async () => {
    const executor = executorFalso();

    const resultado = await registrar(executor, {
      empresaId: EMPRESA,
      usuarioId: USUARIO,
      acao: 'AUTORIZACAO_INDIVIDUAL_CONCEDIDA',
      referencia: '15',
      descricao: 'motivo qualquer',
      ip: '10.0.0.1',
      dispositivo: 'teste',
      contexto: { tipo: 'DIRETA' },
      dadosAnteriores: null,
      dadosNovos: { usuarioId: 9, acaoCodigo: 'MOVIMENTAR_ESTOQUE' },
    });

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /insert\s+into\s+logs_auditoria/i);
    assert.match(texto, /returning\s+id,\s*criado_em/i);
    assert.doesNotMatch(texto, /update|delete|truncate/i, 'append-only: nunca outra operação');
    assert.deepEqual(valores, [
      EMPRESA, USUARIO, 'AUTORIZACAO_INDIVIDUAL_CONCEDIDA', '15', 'motivo qualquer', '10.0.0.1', 'teste',
      { tipo: 'DIRETA' }, null, { usuarioId: 9, acaoCodigo: 'MOVIMENTAR_ESTOQUE' },
    ]);
    assert.deepEqual(resultado, { id: '901', criadoEm: new Date('2026-09-21T12:00:00Z') });
  });

  test('campos opcionais ausentes viajam como null, nunca undefined', async () => {
    const executor = executorFalso();

    await registrar(executor, { empresaId: EMPRESA, acao: 'X' });

    assert.deepEqual(executor.chamadas[0].valores, [EMPRESA, null, 'X', null, null, null, null, null, null, null]);
  });

  test('recusa entrada inválida antes de consultar', async () => {
    const executor = executorFalso();

    await assert.rejects(() => registrar(executor, { empresaId: 0, acao: 'X' }), /empresa/i);
    await assert.rejects(() => registrar(executor, { empresaId: EMPRESA, usuarioId: 0, acao: 'X' }), /usuário/i);
    await assert.rejects(() => registrar(executor, { empresaId: EMPRESA, acao: '' }), /ação de auditoria/i);
    await assert.rejects(() => registrar(executor, { empresaId: EMPRESA, acao: 'A'.repeat(61) }), /ação de auditoria/i);
    await assert.rejects(() => registrar(executor, { empresaId: EMPRESA, acao: 'X', contexto: [] }), /contexto/i);
    await assert.rejects(() => registrar(executor, { empresaId: EMPRESA, acao: 'X', dadosAnteriores: 'texto' }), /dadosAnteriores/i);
    await assert.rejects(() => registrar(executor, { empresaId: EMPRESA, acao: 'X', dadosNovos: 7 }), /dadosNovos/i);
    assert.equal(executor.chamadas.length, 0);
  });

  test('erro do banco propaga sem tradução (inclusive rejeição por chave sensível da migration 014)', async () => {
    const erro = new Error('logs_auditoria: campo JSONB contém chave sensível');
    const executor = { query: async () => { throw erro; } };

    await assert.rejects(() => registrar(executor, { empresaId: EMPRESA, acao: 'X' }), (e) => e === erro);
  });
});
