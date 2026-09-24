'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { registrar } = require('../../src/repositories/auditoria-plataforma.repository');

/**
 * Contrato do repositório de auditoria de plataforma (migration 029).
 * Diferença de forma em relação a auditoria.repository.js: administrador_id
 * é OBRIGATÓRIO (nenhuma ação de plataforma é anônima) e empresa_afetada_id
 * é OPCIONAL. O repositório só grava o que recebe; a recusa de chave
 * sensível é responsabilidade do PostgreSQL (trigger reaproveitada de 014),
 * não deste módulo.
 */

const ADMIN_ID = 5;

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

describe('registrar', () => {
  test('grava com administrador_id obrigatório e empresa_afetada_id nulo por padrão', async () => {
    const executor = executorFalso([{ id: '1', criado_em: new Date('2026-09-23T10:00:00Z') }]);

    const resultado = await registrar(executor, { administradorId: ADMIN_ID, acao: 'ADMINISTRADOR_PLATAFORMA_CRIADO' });

    assert.deepEqual(resultado, { id: '1', criadoEm: new Date('2026-09-23T10:00:00Z') });
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /insert\s+into\s+logs_auditoria_plataforma/i);
    assert.deepEqual(valores, [ADMIN_ID, null, 'ADMINISTRADOR_PLATAFORMA_CRIADO', null, null, null, null, null, null, null]);
  });

  test('repassa empresa_afetada_id e os campos JSONB tal como recebidos, sem alterar', async () => {
    const executor = executorFalso([{ id: '2', criado_em: new Date() }]);
    const contexto = { origem: 'script_administrativo_bootstrap' };

    await registrar(executor, {
      administradorId: ADMIN_ID,
      empresaAfetadaId: 77,
      acao: 'EMPRESA_INSPECIONADA',
      referencia: '77',
      descricao: 'consulta administrativa',
      ip: '203.0.113.10',
      dispositivo: 'curl/8.0',
      contexto,
      dadosAnteriores: null,
      dadosNovos: { ativo: true },
    });

    const { valores } = executor.chamadas[0];
    assert.deepEqual(valores, [ADMIN_ID, 77, 'EMPRESA_INSPECIONADA', '77', 'consulta administrativa', '203.0.113.10', 'curl/8.0', contexto, null, { ativo: true }]);
  });

  test('recusa administrador_id inválido ou ausente antes de consultar', async () => {
    const executor = executorFalso([]);

    await assert.rejects(() => registrar(executor, { administradorId: 0, acao: 'X' }), /administrador/i);
    await assert.rejects(() => registrar(executor, { administradorId: null, acao: 'X' }), /administrador/i);

    assert.equal(executor.chamadas.length, 0);
  });

  test('recusa empresa_afetada_id inválido (quando informado)', async () => {
    const executor = executorFalso([]);
    await assert.rejects(() => registrar(executor, { administradorId: ADMIN_ID, empresaAfetadaId: 0, acao: 'X' }), /empresa/i);
    assert.equal(executor.chamadas.length, 0);
  });

  test('recusa ação vazia ou fora do limite da coluna', async () => {
    const executor = executorFalso([]);
    await assert.rejects(() => registrar(executor, { administradorId: ADMIN_ID, acao: '' }), /ação/i);
    await assert.rejects(() => registrar(executor, { administradorId: ADMIN_ID, acao: 'A'.repeat(61) }), /ação/i);
    assert.equal(executor.chamadas.length, 0);
  });

  test('recusa contexto/dados_anteriores/dados_novos que não sejam objeto ou null', async () => {
    const executor = executorFalso([]);
    await assert.rejects(() => registrar(executor, { administradorId: ADMIN_ID, acao: 'X', contexto: 'não é objeto' }), /contexto/i);
    await assert.rejects(() => registrar(executor, { administradorId: ADMIN_ID, acao: 'X', dadosAnteriores: [] }), /dadosAnteriores/i);
    await assert.rejects(() => registrar(executor, { administradorId: ADMIN_ID, acao: 'X', dadosNovos: 42 }), /dadosNovos/i);
    assert.equal(executor.chamadas.length, 0);
  });

  test('propaga sem tradução um erro do PostgreSQL (ex.: rejeição por chave sensível)', async () => {
    const executor = {
      chamadas: [],
      query: async () => { throw new Error('logs_auditoria: campo JSONB contém chave sensível'); },
    };

    await assert.rejects(
      () => registrar(executor, { administradorId: ADMIN_ID, acao: 'X', contexto: { senha: 'x' } }),
      /chave sensível/,
    );
  });
});
