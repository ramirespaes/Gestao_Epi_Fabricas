'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const repo = require('../../src/repositories/permissao-provisionamento.repository');

/**
 * Contrato do repositório de escrita de permissões por perfil (Bloco 9,
 * Etapa B). Sem PostgreSQL: o executor falso captura SQL e parâmetros.
 * O ponto central: inserir SÓ se ausente (ON CONFLICT DO NOTHING), nunca
 * DO UPDATE, e devolver se a linha foi criada.
 */

const EMPRESA = 42;

const executorFalso = (linhas = []) => {
  const chamadas = [];
  return {
    chamadas,
    query: async (texto, valores) => { chamadas.push({ texto, valores }); return { rows: linhas, rowCount: linhas.length }; },
  };
};

const flags = { podeVisualizar: true, podeCriar: true, podeEditar: true, podeExcluir: false };

describe('listarPermissoesRecurso / listarPermissoesAcao', () => {
  test('consulta parametrizada por empresa, perfil e lista de recursos; devolve Map recurso -> flags como persistidas', async () => {
    const executor = executorFalso([
      { recurso: 'materials', pode_visualizar: true, pode_criar: true, pode_editar: false, pode_excluir: false },
    ]);
    const mapa = await repo.listarPermissoesRecurso(executor, EMPRESA, 'MASTER', ['materials', 'employeeHistory']);
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /from\s+permissoes_recurso/i);
    assert.match(texto, /recurso\s*=\s*ANY\(\$3::text\[\]\)/i);
    assert.deepEqual(valores, [EMPRESA, 'MASTER', ['materials', 'employeeHistory']]);
    assert.deepEqual([...mapa.keys()], ['materials']);
    assert.deepEqual(mapa.get('materials'), { recurso: 'materials', podeVisualizar: true, podeCriar: true, podeEditar: false, podeExcluir: false });
  });

  test('ações: mesmo desenho, Map acaoCodigo -> { permitido } (false preservado)', async () => {
    const executor = executorFalso([{ acao_codigo: 'MOVIMENTAR_ESTOQUE', permitido: false }]);
    const mapa = await repo.listarPermissoesAcao(executor, EMPRESA, 'MASTER', ['MOVIMENTAR_ESTOQUE']);
    assert.match(executor.chamadas[0].texto, /from\s+permissoes_acao/i);
    assert.deepEqual(mapa.get('MOVIMENTAR_ESTOQUE'), { acaoCodigo: 'MOVIMENTAR_ESTOQUE', permitido: false });
  });

  test('recusa entrada inválida antes de consultar (empresa, perfil, lista vazia, recurso malformado, código minúsculo)', async () => {
    const executor = executorFalso();
    await assert.rejects(() => repo.listarPermissoesRecurso(executor, 0, 'MASTER', ['materials']), TypeError);
    await assert.rejects(() => repo.listarPermissoesRecurso(executor, EMPRESA, 'master', ['materials']), TypeError);
    await assert.rejects(() => repo.listarPermissoesRecurso(executor, EMPRESA, 'MASTER', []), TypeError);
    await assert.rejects(() => repo.listarPermissoesRecurso(executor, EMPRESA, 'MASTER', ['1nvalido']), TypeError);
    await assert.rejects(() => repo.listarPermissoesAcao(executor, EMPRESA, 'MASTER', ['movimentar']), TypeError);
    assert.equal(executor.chamadas.length, 0);
  });
});

describe('inserirPermissaoRecursoSeAusente', () => {
  test('INSERT com ON CONFLICT na UNIQUE da 009 e DO NOTHING (nunca DO UPDATE); true quando RETURNING trouxe linha', async () => {
    const executor = executorFalso([{ recurso: 'materials' }]);
    const criado = await repo.inserirPermissaoRecursoSeAusente(executor, { empresaId: EMPRESA, perfil: 'MASTER', recurso: 'materials', ...flags });
    const { texto, valores } = executor.chamadas[0];
    assert.equal(criado, true);
    assert.match(texto, /insert\s+into\s+permissoes_recurso/i);
    assert.match(texto, /on\s+conflict\s+on\s+constraint\s+uq_permissoes_recurso_empresa_perfil_recurso\s+do\s+nothing/i);
    assert.doesNotMatch(texto, /do\s+update/i);
    assert.match(texto, /returning\s+recurso/i);
    assert.deepEqual(valores, [EMPRESA, 'MASTER', 'materials', true, true, true, false]);
  });

  test('false quando a linha já existia (RETURNING vazio) — a linha existente não é tocada', async () => {
    const executor = executorFalso([]);
    assert.equal(await repo.inserirPermissaoRecursoSeAusente(executor, { empresaId: EMPRESA, perfil: 'MASTER', recurso: 'materials', ...flags }), false);
    assert.equal(executor.chamadas.length, 1);
  });

  test('flags precisam ser booleanos estritos', async () => {
    const executor = executorFalso();
    await assert.rejects(() => repo.inserirPermissaoRecursoSeAusente(executor, { empresaId: EMPRESA, perfil: 'MASTER', recurso: 'materials', ...flags, podeEditar: 'true' }), TypeError);
    await assert.rejects(() => repo.inserirPermissaoRecursoSeAusente(executor, { empresaId: EMPRESA, perfil: 'MASTER', recurso: 'materials', ...flags, podeExcluir: undefined }), TypeError);
    assert.equal(executor.chamadas.length, 0);
  });
});

describe('inserirPermissaoAcaoSeAusente', () => {
  test('INSERT com ON CONFLICT na UNIQUE da 010 e DO NOTHING; parâmetros na ordem', async () => {
    const executor = executorFalso([{ acao_codigo: 'MOVIMENTAR_ESTOQUE' }]);
    const criado = await repo.inserirPermissaoAcaoSeAusente(executor, { empresaId: EMPRESA, perfil: 'MASTER', acaoCodigo: 'MOVIMENTAR_ESTOQUE', permitido: true });
    const { texto, valores } = executor.chamadas[0];
    assert.equal(criado, true);
    assert.match(texto, /insert\s+into\s+permissoes_acao/i);
    assert.match(texto, /on\s+conflict\s+on\s+constraint\s+uq_permissoes_acao_empresa_perfil_acao\s+do\s+nothing/i);
    assert.doesNotMatch(texto, /do\s+update/i);
    assert.deepEqual(valores, [EMPRESA, 'MASTER', 'MOVIMENTAR_ESTOQUE', true]);
  });

  test('violação de FK (ação fora do catálogo) propaga sem traduzir', async () => {
    const executor = { query: async () => { throw Object.assign(new Error('fk'), { code: '23503' }); } };
    await assert.rejects(() => repo.inserirPermissaoAcaoSeAusente(executor, { empresaId: EMPRESA, perfil: 'MASTER', acaoCodigo: 'INEXISTENTE', permitido: true }), (e) => e.code === '23503');
  });
});
