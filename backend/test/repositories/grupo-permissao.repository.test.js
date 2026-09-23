'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buscarRecurso,
  buscarAcao,
  salvarRecurso,
  salvarAcao,
  listarRecursosDoGrupo,
  listarAcoesDoGrupo,
} = require('../../src/repositories/grupo-permissao.repository');

/**
 * Contrato do repositório administrativo das permissões de grupo. Não
 * decide nada: valida formato, monta SQL parametrizado, mapeia colunas
 * para camelCase e grava o tri-state exatamente como recebe. Sem DELETE.
 */

const EMPRESA_A = 4242;
const EMPRESA_B = 8888;
const GRUPO = 55;
const RECURSO = 'materials';
const ACAO = 'MOVIMENTAR_ESTOQUE';

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

const linhaRecurso = (extra = {}) => ({
  id: 9,
  empresa_id: EMPRESA_A,
  grupo_acesso_id: GRUPO,
  recurso: RECURSO,
  pode_visualizar: true,
  pode_criar: false,
  pode_editar: null,
  pode_excluir: null,
  criado_em: new Date('2026-09-21T12:00:00Z'),
  atualizado_em: new Date('2026-09-21T12:00:00Z'),
  ...extra,
});

const linhaAcao = (extra = {}) => ({
  id: 4,
  empresa_id: EMPRESA_A,
  grupo_acesso_id: GRUPO,
  acao_codigo: ACAO,
  permitido: true,
  criado_em: new Date('2026-09-21T12:00:00Z'),
  atualizado_em: new Date('2026-09-21T12:00:00Z'),
  ...extra,
});

describe('buscarRecurso', () => {
  test('filtra por empresa, grupo e recurso, e preserva o tri-state misto', async () => {
    const executor = executorFalso([linhaRecurso()]);

    const configuracao = await buscarRecurso(executor, EMPRESA_A, GRUPO, RECURSO);

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /from\s+grupo_permissoes_recurso/i);
    assert.match(texto, /empresa_id\s*=\s*\$1/i);
    assert.match(texto, /grupo_acesso_id\s*=\s*\$2/i);
    assert.match(texto, /recurso\s*=\s*\$3/i);
    assert.deepEqual(valores, [EMPRESA_A, GRUPO, RECURSO]);
    assert.equal(configuracao.podeVisualizar, true);
    assert.equal(configuracao.podeCriar, false, 'false não vira null nem some');
    assert.equal(configuracao.podeEditar, null);
    assert.equal(configuracao.podeExcluir, null);
  });

  test('linha ausente devolve null — distinto de linha existente com tudo null', async () => {
    assert.equal(await buscarRecurso(executorFalso([]), EMPRESA_B, GRUPO, RECURSO), null);

    const tudoNull = await buscarRecurso(
      executorFalso([linhaRecurso({ pode_visualizar: null, pode_criar: null })]),
      EMPRESA_A, GRUPO, RECURSO,
    );
    assert.notEqual(tudoNull, null, 'a linha existe, ainda que sem opinião nenhuma');
    assert.equal(tudoNull.podeVisualizar, null);
  });

  test('recusa entrada inválida antes de consultar', async () => {
    const executor = executorFalso([]);
    await assert.rejects(() => buscarRecurso(executor, 0, GRUPO, RECURSO), /empresa/i);
    await assert.rejects(() => buscarRecurso(executor, EMPRESA_A, 0, RECURSO), /grupo/i);
    await assert.rejects(() => buscarRecurso(executor, EMPRESA_A, GRUPO, 'com espaco'), /recurso/i);
    assert.equal(executor.chamadas.length, 0);
  });
});

describe('buscarAcao', () => {
  test('filtra por empresa, grupo e ação; permitido false e null são preservados', async () => {
    const executor = executorFalso([linhaAcao({ permitido: false })]);

    const configuracao = await buscarAcao(executor, EMPRESA_A, GRUPO, ACAO);

    assert.deepEqual(executor.chamadas[0].valores, [EMPRESA_A, GRUPO, ACAO]);
    assert.equal(configuracao.permitido, false);

    const semOpiniao = await buscarAcao(executorFalso([linhaAcao({ permitido: null })]), EMPRESA_A, GRUPO, ACAO);
    assert.equal(semOpiniao.permitido, null);
    assert.notEqual(semOpiniao, null);
  });

  test('linha ausente devolve null e entrada inválida é recusada antes de consultar', async () => {
    assert.equal(await buscarAcao(executorFalso([]), EMPRESA_A, GRUPO, ACAO), null);

    const executor = executorFalso([]);
    await assert.rejects(() => buscarAcao(executor, EMPRESA_A, GRUPO, 'minuscula'), /ação/i);
    assert.equal(executor.chamadas.length, 0);
  });
});

describe('salvarRecurso', () => {
  test('UPSERT nas quatro operações, parametrizado, com ON CONFLICT na UNIQUE da migration 021', async () => {
    const executor = executorFalso([linhaRecurso()]);

    await salvarRecurso(executor, {
      empresaId: EMPRESA_A, grupoAcessoId: GRUPO, recurso: RECURSO,
      podeVisualizar: true, podeCriar: false, podeEditar: null, podeExcluir: null,
    });

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /insert\s+into\s+grupo_permissoes_recurso/i);
    assert.match(texto, /on\s+conflict\s+on\s+constraint\s+uq_grupo_permissoes_recurso_grupo_recurso\s+do\s+update/i);
    assert.match(texto, /returning/i);
    assert.deepEqual(valores, [EMPRESA_A, GRUPO, RECURSO, true, false, null, null]);
  });

  test('grava false e null literalmente — nenhuma conversão, nenhum COALESCE escondido', async () => {
    const executor = executorFalso([linhaRecurso({ pode_visualizar: false, pode_criar: null, pode_editar: false, pode_excluir: null })]);

    const salvo = await salvarRecurso(executor, {
      empresaId: EMPRESA_A, grupoAcessoId: GRUPO, recurso: RECURSO,
      podeVisualizar: false, podeCriar: null, podeEditar: false, podeExcluir: null,
    });

    assert.deepEqual(executor.chamadas[0].valores.slice(3), [false, null, false, null]);
    assert.doesNotMatch(executor.chamadas[0].texto, /coalesce/i, 'nada de COALESCE: o estado final vem pronto do serviço');
    assert.equal(salvo.podeVisualizar, false);
    assert.equal(salvo.podeCriar, null);
  });

  test('as quatro operações são obrigatórias: undefined é erro de contrato', async () => {
    const executor = executorFalso([]);
    const base = {
      empresaId: EMPRESA_A, grupoAcessoId: GRUPO, recurso: RECURSO,
      podeVisualizar: null, podeCriar: null, podeEditar: null, podeExcluir: null,
    };

    await assert.rejects(() => salvarRecurso(executor, { ...base, podeVisualizar: undefined }), /pode_visualizar/i);
    await assert.rejects(() => salvarRecurso(executor, { ...base, podeCriar: 'sim' }), /pode_criar/i);
    await assert.rejects(() => salvarRecurso(executor, { ...base, podeEditar: 1 }), /pode_editar/i);
    await assert.rejects(() => salvarRecurso(executor, { ...base, empresaId: 0 }), /empresa/i);
    assert.equal(executor.chamadas.length, 0);
  });

  test('violação de constraint propaga com SQLSTATE original', async () => {
    const erro = Object.assign(new Error('fk'), { code: '23503' });
    const executor = { query: async () => { throw erro; } };

    await assert.rejects(
      () => salvarRecurso(executor, {
        empresaId: EMPRESA_A, grupoAcessoId: GRUPO, recurso: RECURSO,
        podeVisualizar: null, podeCriar: null, podeEditar: null, podeExcluir: null,
      }),
      (e) => e === erro && e.code === '23503',
    );
  });
});

describe('salvarAcao', () => {
  test('UPSERT de permitido, parametrizado, com ON CONFLICT na UNIQUE da 021', async () => {
    const executor = executorFalso([linhaAcao()]);

    await salvarAcao(executor, { empresaId: EMPRESA_A, grupoAcessoId: GRUPO, acaoCodigo: ACAO, permitido: true });

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /insert\s+into\s+grupo_permissoes_acao/i);
    assert.match(texto, /on\s+conflict\s+on\s+constraint\s+uq_grupo_permissoes_acao_grupo_acao\s+do\s+update/i);
    assert.deepEqual(valores, [EMPRESA_A, GRUPO, ACAO, true]);
  });

  test('permitido false e null são gravados literalmente', async () => {
    const negado = executorFalso([linhaAcao({ permitido: false })]);
    await salvarAcao(negado, { empresaId: EMPRESA_A, grupoAcessoId: GRUPO, acaoCodigo: ACAO, permitido: false });
    assert.equal(negado.chamadas[0].valores[3], false);

    const semOpiniao = executorFalso([linhaAcao({ permitido: null })]);
    await salvarAcao(semOpiniao, { empresaId: EMPRESA_A, grupoAcessoId: GRUPO, acaoCodigo: ACAO, permitido: null });
    assert.equal(semOpiniao.chamadas[0].valores[3], null);
  });

  test('recusa entrada inválida antes de consultar', async () => {
    const executor = executorFalso([]);
    const base = { empresaId: EMPRESA_A, grupoAcessoId: GRUPO, acaoCodigo: ACAO, permitido: null };

    await assert.rejects(() => salvarAcao(executor, { ...base, permitido: undefined }), /permitido/i);
    await assert.rejects(() => salvarAcao(executor, { ...base, permitido: 'sim' }), /permitido/i);
    await assert.rejects(() => salvarAcao(executor, { ...base, acaoCodigo: 'minuscula' }), /ação/i);
    assert.equal(executor.chamadas.length, 0);
  });
});

describe('listagens por grupo', () => {
  test('recursos e ações do grupo, filtrados por empresa e ordenados', async () => {
    const recursos = executorFalso([linhaRecurso(), linhaRecurso({ id: 10, recurso: 'stockValidity' })]);
    const lista = await listarRecursosDoGrupo(recursos, EMPRESA_A, GRUPO);
    assert.match(recursos.chamadas[0].texto, /order\s+by\s+recurso/i);
    assert.deepEqual(recursos.chamadas[0].valores, [EMPRESA_A, GRUPO]);
    assert.equal(lista.length, 2);

    const acoes = executorFalso([linhaAcao()]);
    await listarAcoesDoGrupo(acoes, EMPRESA_A, GRUPO);
    assert.match(acoes.chamadas[0].texto, /order\s+by\s+acao_codigo/i);
    assert.deepEqual(acoes.chamadas[0].valores, [EMPRESA_A, GRUPO]);
  });

  test('grupo sem configurações devolve listas vazias', async () => {
    assert.deepEqual(await listarRecursosDoGrupo(executorFalso([]), EMPRESA_A, GRUPO), []);
    assert.deepEqual(await listarAcoesDoGrupo(executorFalso([]), EMPRESA_A, GRUPO), []);
  });
});

describe('ausência de exclusão', () => {
  test('o módulo não exporta nenhuma função de exclusão: retirar opinião é gravar null', () => {
    const repo = require('../../src/repositories/grupo-permissao.repository');

    assert.doesNotMatch(Object.keys(repo).join(' ').toLowerCase(), /excluir|remover|deletar|apagar/);
  });
});
