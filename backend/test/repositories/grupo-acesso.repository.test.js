'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  criar,
  buscarPorId,
  buscarPorIdParaAtualizacao,
  listarPorEmpresa,
  atualizar,
  TAMANHO_MAXIMO_NOME,
} = require('../../src/repositories/grupo-acesso.repository');

/**
 * Contrato do repositório de grupos de acesso. Não decide nada: valida
 * formato, monta SQL parametrizado, mapeia colunas para camelCase e
 * propaga erros do banco sem traduzir. Sem exclusão física — não existe
 * função de DELETE, de propósito.
 */

const EMPRESA_A = 4242;
const EMPRESA_B = 8888;
const MASTER = 7;

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

const linha = (extra = {}) => ({
  id: 15,
  empresa_id: EMPRESA_A,
  nome: 'Almoxarifado',
  descricao: null,
  ativo: true,
  criado_por: MASTER,
  criado_em: new Date('2026-09-21T12:00:00Z'),
  atualizado_em: new Date('2026-09-21T12:00:00Z'),
  ...extra,
});

const mapeada = {
  id: 15,
  empresaId: EMPRESA_A,
  nome: 'Almoxarifado',
  descricao: null,
  ativo: true,
  criadoPor: MASTER,
  criadoEm: new Date('2026-09-21T12:00:00Z'),
  atualizadoEm: new Date('2026-09-21T12:00:00Z'),
};

describe('criar', () => {
  test('INSERT parametrizado; ativo não é parâmetro (vem do DEFAULT da migration 020)', async () => {
    const executor = executorFalso([linha()]);

    const grupo = await criar(executor, { empresaId: EMPRESA_A, nome: 'Almoxarifado', criadoPor: MASTER });

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /insert\s+into\s+grupos_acesso/i);
    assert.match(texto, /returning/i);
    // Só a lista de colunas do INSERT: `ativo` aparece legitimamente no
    // RETURNING, mas não pode ser uma coluna gravada.
    const colunas = texto.slice(texto.indexOf('('), texto.search(/\bvalues\b/i));
    assert.doesNotMatch(colunas, /\bativo\b/i, 'ativo nasce do DEFAULT, não é enviado');
    assert.deepEqual(valores, [EMPRESA_A, 'Almoxarifado', null, MASTER]);
    assert.deepEqual(grupo, mapeada);
  });

  test('descrição opcional viaja como parâmetro quando informada', async () => {
    const executor = executorFalso([linha({ descricao: 'Equipe do depósito' })]);

    const grupo = await criar(executor, { empresaId: EMPRESA_A, nome: 'Almoxarifado', descricao: 'Equipe do depósito', criadoPor: MASTER });

    assert.equal(executor.chamadas[0].valores[2], 'Equipe do depósito');
    assert.equal(grupo.descricao, 'Equipe do depósito');
  });

  test('recusa entrada inválida antes de consultar', async () => {
    const executor = executorFalso([]);
    const base = { empresaId: EMPRESA_A, nome: 'Almoxarifado', criadoPor: MASTER };

    await assert.rejects(() => criar(executor, { ...base, empresaId: 0 }), /empresa/i);
    await assert.rejects(() => criar(executor, { ...base, nome: '' }), /nome/i);
    await assert.rejects(() => criar(executor, { ...base, nome: 'x'.repeat(TAMANHO_MAXIMO_NOME + 1) }), /nome/i);
    await assert.rejects(() => criar(executor, { ...base, nome: 42 }), /nome/i);
    await assert.rejects(() => criar(executor, { ...base, descricao: 42 }), /descri/i);
    await assert.rejects(() => criar(executor, { ...base, criadoPor: 0 }), /criador/i);
    assert.equal(executor.chamadas.length, 0);
  });

  test('aceita exatamente o tamanho máximo do banco (VARCHAR(100))', async () => {
    const executor = executorFalso([linha()]);

    await criar(executor, { empresaId: EMPRESA_A, nome: 'x'.repeat(TAMANHO_MAXIMO_NOME), criadoPor: MASTER });

    assert.equal(executor.chamadas[0].valores[1].length, TAMANHO_MAXIMO_NOME);
  });

  test('violação de constraint propaga com o SQLSTATE original, sem tradução', async () => {
    const erro = Object.assign(new Error('duplicate key'), { code: '23505' });
    const executor = { query: async () => { throw erro; } };

    await assert.rejects(
      () => criar(executor, { empresaId: EMPRESA_A, nome: 'Almoxarifado', criadoPor: MASTER }),
      (e) => e === erro && e.code === '23505',
    );
  });
});

describe('buscarPorId e buscarPorIdParaAtualizacao', () => {
  test('filtra por empresa E id, mapeia para camelCase, sem FOR UPDATE na variante comum', async () => {
    const executor = executorFalso([linha()]);

    const grupo = await buscarPorId(executor, EMPRESA_A, 15);

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /from\s+grupos_acesso/i);
    assert.match(texto, /empresa_id\s*=\s*\$1/i);
    assert.match(texto, /\bid\s*=\s*\$2/i);
    assert.doesNotMatch(texto, /for\s+update/i);
    assert.deepEqual(valores, [EMPRESA_A, 15]);
    assert.deepEqual(grupo, mapeada);
  });

  test('a variante travada termina em FOR UPDATE, com o mesmo filtro', async () => {
    const executor = executorFalso([linha()]);

    await buscarPorIdParaAtualizacao(executor, EMPRESA_A, 15);

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /empresa_id\s*=\s*\$1/i);
    assert.match(texto, /for\s+update\s*$/i);
    assert.deepEqual(valores, [EMPRESA_A, 15]);
  });

  test('grupo inexistente nesta empresa devolve null nas duas variantes', async () => {
    assert.equal(await buscarPorId(executorFalso([]), EMPRESA_B, 15), null);
    assert.equal(await buscarPorIdParaAtualizacao(executorFalso([]), EMPRESA_B, 15), null);
  });

  test('grupo inativo é devolvido como está — a decisão é do serviço', async () => {
    const grupo = await buscarPorId(executorFalso([linha({ ativo: false })]), EMPRESA_A, 15);

    assert.equal(grupo.ativo, false);
  });

  test('recusa entrada inválida antes de consultar', async () => {
    const executor = executorFalso([]);
    await assert.rejects(() => buscarPorId(executor, 0, 15), /empresa/i);
    await assert.rejects(() => buscarPorId(executor, EMPRESA_A, 0), /grupo/i);
    assert.equal(executor.chamadas.length, 0);
  });
});

describe('listarPorEmpresa', () => {
  test('sem filtro: lista ativos e inativos da empresa, ordenados sem diferenciar maiúsculas', async () => {
    const executor = executorFalso([linha(), linha({ id: 16, nome: 'gerência', ativo: false })]);

    const grupos = await listarPorEmpresa(executor, EMPRESA_A);

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /empresa_id\s*=\s*\$1/i);
    assert.match(texto, /order\s+by\s+lower\(nome\)/i);
    assert.deepEqual(valores, [EMPRESA_A, null], 'filtro desligado viaja como NULL, sem SQL dinâmico');
    assert.equal(grupos.length, 2);
    assert.equal(grupos[1].nome, 'gerência');
  });

  test('filtro explícito ativo=true e ativo=false viajam como parâmetro', async () => {
    const soAtivos = executorFalso([linha()]);
    await listarPorEmpresa(soAtivos, EMPRESA_A, { ativo: true });
    assert.deepEqual(soAtivos.chamadas[0].valores, [EMPRESA_A, true]);

    const soInativos = executorFalso([]);
    await listarPorEmpresa(soInativos, EMPRESA_A, { ativo: false });
    assert.deepEqual(soInativos.chamadas[0].valores, [EMPRESA_A, false]);
  });

  test('empresa sem grupos devolve lista vazia', async () => {
    assert.deepEqual(await listarPorEmpresa(executorFalso([]), EMPRESA_B), []);
  });

  test('recusa entrada inválida antes de consultar', async () => {
    const executor = executorFalso([]);
    await assert.rejects(() => listarPorEmpresa(executor, 0), /empresa/i);
    await assert.rejects(() => listarPorEmpresa(executor, EMPRESA_A, { ativo: 'sim' }), /ativo/i);
    assert.equal(executor.chamadas.length, 0);
  });
});

describe('atualizar', () => {
  test('UPDATE alcança apenas nome, descricao e ativo — nunca id, empresa_id, criado_por ou criado_em', async () => {
    const executor = executorFalso([linha({ nome: 'Depósito' })]);

    await atualizar(executor, EMPRESA_A, 15, { nome: 'Depósito' });

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /update\s+grupos_acesso/i);
    const set = texto.slice(texto.search(/\bset\b/i), texto.search(/\bwhere\b/i));
    assert.match(set, /nome\s*=/i);
    assert.match(set, /descricao\s*=/i);
    assert.match(set, /ativo\s*=/i);
    assert.doesNotMatch(set, /empresa_id\s*=/i);
    assert.doesNotMatch(set, /criado_por\s*=/i);
    assert.doesNotMatch(set, /criado_em\s*=/i);
    assert.doesNotMatch(set, /\bid\s*=/i);
    assert.deepEqual(valores, [EMPRESA_A, 15, 'Depósito', null, false, null]);
  });

  test('campos ausentes preservam o valor atual (COALESCE), inclusive o nome', async () => {
    const executor = executorFalso([linha()]);

    await atualizar(executor, EMPRESA_A, 15, { ativo: false });

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /nome\s*=\s*coalesce\(\$3,\s*nome\)/i);
    assert.equal(valores[2], null, 'nome ausente vai como NULL e o COALESCE mantém o atual');
    assert.equal(valores[5], false);
  });

  test('descricaoInformada distingue "não mexer" de "limpar"', async () => {
    const naoMexer = executorFalso([linha({ descricao: 'mantida' })]);
    await atualizar(naoMexer, EMPRESA_A, 15, { nome: 'Depósito' });
    assert.equal(naoMexer.chamadas[0].valores[4], false);

    const limpar = executorFalso([linha({ descricao: null })]);
    await atualizar(limpar, EMPRESA_A, 15, { descricao: null, descricaoInformada: true });
    assert.equal(limpar.chamadas[0].valores[4], true);
    assert.equal(limpar.chamadas[0].valores[3], null);
  });

  test('grupo inexistente nesta empresa devolve null', async () => {
    assert.equal(await atualizar(executorFalso([]), EMPRESA_B, 15, { ativo: false }), null);
  });

  test('recusa entrada inválida antes de consultar', async () => {
    const executor = executorFalso([]);
    await assert.rejects(() => atualizar(executor, 0, 15, { ativo: true }), /empresa/i);
    await assert.rejects(() => atualizar(executor, EMPRESA_A, 0, { ativo: true }), /grupo/i);
    await assert.rejects(() => atualizar(executor, EMPRESA_A, 15, { nome: '' }), /nome/i);
    await assert.rejects(() => atualizar(executor, EMPRESA_A, 15, { ativo: 'sim' }), /ativo/i);
    await assert.rejects(() => atualizar(executor, EMPRESA_A, 15, { descricaoInformada: 'sim' }), /descricaoInformada/i);
    assert.equal(executor.chamadas.length, 0);
  });

  test('violação do índice único de nome propaga com SQLSTATE original', async () => {
    const erro = Object.assign(new Error('duplicate key'), { code: '23505' });
    const executor = { query: async () => { throw erro; } };

    await assert.rejects(() => atualizar(executor, EMPRESA_A, 15, { nome: 'Gerência' }), (e) => e.code === '23505');
  });
});

describe('ausência de exclusão física', () => {
  test('o módulo não exporta nenhuma função de exclusão', () => {
    const repo = require('../../src/repositories/grupo-acesso.repository');

    const nomes = Object.keys(repo).join(' ').toLowerCase();
    assert.doesNotMatch(nomes, /excluir|remover|deletar|apagar/);
  });
});
