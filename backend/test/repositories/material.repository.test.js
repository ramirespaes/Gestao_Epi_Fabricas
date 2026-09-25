'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  criar,
  buscarPorId,
  buscarPorIdParaAtualizacao,
  listarPorEmpresa,
  contarPorEmpresa,
  atualizar,
  TAMANHO_MAXIMO_NOME,
} = require('../../src/repositories/material.repository');

/**
 * Contrato do repositório de materiais (Bloco 9, Etapa A). Não decide
 * nada: valida formato, monta SQL parametrizado, mapeia colunas para
 * camelCase e propaga erros do banco sem traduzir. Sem exclusão física —
 * não existe função de DELETE, de propósito.
 */

const EMPRESA_A = 4242;
const EMPRESA_B = 8888;

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
  id: 30,
  empresa_id: EMPRESA_A,
  nome: 'Botina de segurança',
  tipo: 'Sapatão / Botina',
  fabricante: 'Bracol',
  ca_numero: '38271',
  ca_validade: '2026-08-15',
  prazo_uso_dias: 365,
  unidade: 'par',
  estoque_minimo: 5,
  categoria: null,
  codigo_interno: null,
  descricao: null,
  ativo: true,
  criado_em: new Date('2026-09-23T12:00:00Z'),
  atualizado_em: new Date('2026-09-23T12:00:00Z'),
  ...extra,
});

const mapeada = {
  id: 30,
  empresaId: EMPRESA_A,
  nome: 'Botina de segurança',
  tipo: 'Sapatão / Botina',
  fabricante: 'Bracol',
  caNumero: '38271',
  caValidade: '2026-08-15',
  prazoUsoDias: 365,
  unidade: 'par',
  estoqueMinimo: 5,
  categoria: null,
  codigoInterno: null,
  descricao: null,
  ativo: true,
  criadoEm: new Date('2026-09-23T12:00:00Z'),
  atualizadoEm: new Date('2026-09-23T12:00:00Z'),
};

describe('criar', () => {
  test('INSERT parametrizado; ativo não é parâmetro (vem do DEFAULT da migration 007)', async () => {
    const executor = executorFalso([linha()]);

    const material = await criar(executor, { empresaId: EMPRESA_A, nome: 'Botina de segurança' });

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /insert\s+into\s+materiais/i);
    assert.match(texto, /returning/i);
    const colunas = texto.slice(texto.indexOf('('), texto.search(/\bvalues\b/i));
    assert.doesNotMatch(colunas, /\bativo\b/i, 'ativo nasce do DEFAULT, não é enviado');
    assert.deepEqual(valores, [EMPRESA_A, 'Botina de segurança', null, null, null, null, null, 'unidade', 0, null, null, null]);
    assert.deepEqual(material, mapeada);
  });

  test('campos opcionais viajam como parâmetro quando informados', async () => {
    const executor = executorFalso([linha()]);

    await criar(executor, {
      empresaId: EMPRESA_A,
      nome: 'Botina de segurança',
      tipo: 'Sapatão / Botina',
      fabricante: 'Bracol',
      caNumero: '38271',
      caValidade: '2026-08-15',
      prazoUsoDias: 365,
      unidade: 'par',
      estoqueMinimo: 5,
    });

    assert.deepEqual(executor.chamadas[0].valores, [
      EMPRESA_A, 'Botina de segurança', 'Sapatão / Botina', 'Bracol', '38271', '2026-08-15', 365, 'par', 5,
      null, null, null,
    ]);
  });

  test('recusa entrada inválida antes de consultar', async () => {
    const executor = executorFalso([]);
    const base = { empresaId: EMPRESA_A, nome: 'Botina' };

    await assert.rejects(() => criar(executor, { ...base, empresaId: 0 }), /empresa/i);
    await assert.rejects(() => criar(executor, { ...base, nome: '' }), /nome/i);
    await assert.rejects(() => criar(executor, { ...base, nome: 'x'.repeat(TAMANHO_MAXIMO_NOME + 1) }), /nome/i);
    await assert.rejects(() => criar(executor, { ...base, tipo: '' }), /tipo/i);
    await assert.rejects(() => criar(executor, { ...base, prazoUsoDias: 0 }), /prazo/i);
    await assert.rejects(() => criar(executor, { ...base, prazoUsoDias: -5 }), /prazo/i);
    await assert.rejects(() => criar(executor, { ...base, prazoUsoDias: 1.5 }), /prazo/i);
    await assert.rejects(() => criar(executor, { ...base, estoqueMinimo: -1 }), /estoque/i);
    await assert.rejects(() => criar(executor, { ...base, unidade: '' }), /unidade/i);
    assert.equal(executor.chamadas.length, 0);
  });

  test('violação de constraint propaga com o SQLSTATE original, sem tradução', async () => {
    const erro = Object.assign(new Error('check violation'), { code: '23514' });
    const executor = { query: async () => { throw erro; } };

    await assert.rejects(
      () => criar(executor, { empresaId: EMPRESA_A, nome: 'Botina' }),
      (e) => e === erro && e.code === '23514',
    );
  });
});

describe('buscarPorId e buscarPorIdParaAtualizacao', () => {
  test('filtra por empresa E id, mapeia para camelCase, sem FOR UPDATE na variante comum', async () => {
    const executor = executorFalso([linha()]);

    const material = await buscarPorId(executor, EMPRESA_A, 30);

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /from\s+materiais/i);
    assert.match(texto, /empresa_id\s*=\s*\$1/i);
    assert.match(texto, /\bid\s*=\s*\$2/i);
    assert.doesNotMatch(texto, /for\s+update/i);
    assert.deepEqual(valores, [EMPRESA_A, 30]);
    assert.deepEqual(material, mapeada);
  });

  test('a variante travada termina em FOR UPDATE, com o mesmo filtro', async () => {
    const executor = executorFalso([linha()]);

    await buscarPorIdParaAtualizacao(executor, EMPRESA_A, 30);

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /empresa_id\s*=\s*\$1/i);
    assert.match(texto, /for\s+update\s*$/i);
    assert.deepEqual(valores, [EMPRESA_A, 30]);
  });

  test('material de outra empresa (isolamento) devolve null nas duas variantes', async () => {
    assert.equal(await buscarPorId(executorFalso([]), EMPRESA_B, 30), null);
    assert.equal(await buscarPorIdParaAtualizacao(executorFalso([]), EMPRESA_B, 30), null);
  });

  test('recusa entrada inválida antes de consultar', async () => {
    const executor = executorFalso([]);
    await assert.rejects(() => buscarPorId(executor, 0, 30), /empresa/i);
    await assert.rejects(() => buscarPorId(executor, EMPRESA_A, 0), /material/i);
    assert.equal(executor.chamadas.length, 0);
  });
});

describe('listarPorEmpresa e contarPorEmpresa', () => {
  test('sem filtro: pagina com LIMIT/OFFSET, ordena sem diferenciar maiúsculas', async () => {
    const executor = executorFalso([linha(), linha({ id: 31, nome: 'óculos', ativo: false })]);

    const materiais = await listarPorEmpresa(executor, EMPRESA_A);

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /empresa_id\s*=\s*\$1/i);
    assert.match(texto, /order\s+by\s+lower\(nome\)/i);
    assert.match(texto, /limit\s+\$4\s+offset\s+\$5/i);
    assert.deepEqual(valores, [EMPRESA_A, null, null, 20, 0]);
    assert.equal(materiais.length, 2);
  });

  test('página 2 com limite 10 calcula o deslocamento correto', async () => {
    const executor = executorFalso([]);

    await listarPorEmpresa(executor, EMPRESA_A, { pagina: 2, limite: 10 });

    assert.deepEqual(executor.chamadas[0].valores, [EMPRESA_A, null, null, 10, 10]);
  });

  test('filtro de busca viaja como parâmetro, sem concatenar no SQL', async () => {
    const executor = executorFalso([linha()]);

    await listarPorEmpresa(executor, EMPRESA_A, { busca: 'bot' });

    assert.match(executor.chamadas[0].texto, /ilike/i);
    assert.deepEqual(executor.chamadas[0].valores, [EMPRESA_A, null, 'bot', 20, 0]);
  });

  test('% e _ no termo de busca são tratados como texto literal, não como coringa do ILIKE (correção pós-auditoria de 23/09/2026)', async () => {
    const executor = executorFalso([]);

    await listarPorEmpresa(executor, EMPRESA_A, { busca: '100%_seguro' });

    // O termo chega escapado ($3), preservando o parametrizado — nunca
    // concatenado na string SQL. \\% e \\_ literais; \\\\ para o caso de a
    // própria busca já conter uma barra invertida.
    assert.equal(executor.chamadas[0].valores[2], '100\\%\\_seguro');
  });

  test('barra invertida literal no termo de busca também é escapada, antes dos outros coringas', async () => {
    const executor = executorFalso([]);

    await listarPorEmpresa(executor, EMPRESA_A, { busca: 'a\\b' });

    assert.equal(executor.chamadas[0].valores[2], 'a\\\\b');
  });

  test('contarPorEmpresa também escapa % e _ do termo de busca', async () => {
    const executor = executorFalso([{ total: 0 }]);

    await contarPorEmpresa(executor, EMPRESA_A, { busca: '50%' });

    assert.equal(executor.chamadas[0].valores[2], '50\\%');
  });

  test('contarPorEmpresa usa o mesmo filtro, sem paginação', async () => {
    const executor = executorFalso([{ total: 7 }]);

    const total = await contarPorEmpresa(executor, EMPRESA_A, { ativo: true, busca: 'bot' });

    assert.match(executor.chamadas[0].texto, /count\(\*\)/i);
    assert.deepEqual(executor.chamadas[0].valores, [EMPRESA_A, true, 'bot']);
    assert.equal(total, 7);
  });

  test('empresa sem materiais devolve lista vazia', async () => {
    assert.deepEqual(await listarPorEmpresa(executorFalso([]), EMPRESA_B), []);
  });

  test('recusa entrada inválida antes de consultar', async () => {
    const executor = executorFalso([]);
    await assert.rejects(() => listarPorEmpresa(executor, 0), /empresa/i);
    await assert.rejects(() => listarPorEmpresa(executor, EMPRESA_A, { ativo: 'sim' }), /ativo/i);
    await assert.rejects(() => listarPorEmpresa(executor, EMPRESA_A, { pagina: 0 }), /p.gina/i);
    await assert.rejects(() => listarPorEmpresa(executor, EMPRESA_A, { limite: 0 }), /limite/i);
    assert.equal(executor.chamadas.length, 0);
  });
});

describe('atualizar', () => {
  test('UPDATE alcança os campos do cadastro — nunca id, empresa_id ou criado_em', async () => {
    const executor = executorFalso([linha({ nome: 'Botina reforçada' })]);

    await atualizar(executor, EMPRESA_A, 30, { nome: 'Botina reforçada' });

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /update\s+materiais/i);
    const set = texto.slice(texto.search(/\bset\b/i), texto.search(/\bwhere\b/i));
    assert.match(set, /nome\s*=/i);
    assert.match(set, /tipo\s*=/i);
    assert.match(set, /estoque_minimo\s*=/i);
    assert.match(set, /ativo\s*=/i);
    assert.doesNotMatch(set, /empresa_id\s*=/i);
    assert.doesNotMatch(set, /criado_em\s*=/i);
    assert.doesNotMatch(set, /\bid\s*=/i);
    assert.deepEqual(valores, [
      EMPRESA_A, 30, 'Botina reforçada',
      false, null, false, null, false, null, false, null, false, null,
      null, null, null,
      false, null, false, null, false, null,
    ]);
  });

  test('campos ausentes preservam o valor atual (COALESCE/CASE), inclusive o nome', async () => {
    const executor = executorFalso([linha()]);

    await atualizar(executor, EMPRESA_A, 30, {});

    assert.deepEqual(executor.chamadas[0].valores, [
      EMPRESA_A, 30, null,
      false, null, false, null, false, null, false, null, false, null,
      null, null, null,
      false, null, false, null, false, null,
    ]);
  });

  test('campo opcional informado como null explícito limpa o valor (via flag *Informado)', async () => {
    const executor = executorFalso([linha({ tipo: null })]);

    await atualizar(executor, EMPRESA_A, 30, { tipo: null, tipoInformado: true });

    assert.equal(executor.chamadas[0].valores[3], true, 'tipoInformado viaja como true');
    assert.equal(executor.chamadas[0].valores[4], null, 'tipo viaja como null explícito');
  });

  test('material inexistente nesta empresa devolve null', async () => {
    assert.equal(await atualizar(executorFalso([]), EMPRESA_B, 30, { nome: 'X' }), null);
  });

  test('recusa entrada inválida antes de consultar', async () => {
    const executor = executorFalso([]);
    await assert.rejects(() => atualizar(executor, 0, 30, {}), /empresa/i);
    await assert.rejects(() => atualizar(executor, EMPRESA_A, 0, {}), /material/i);
    await assert.rejects(() => atualizar(executor, EMPRESA_A, 30, { nome: '' }), /nome/i);
    await assert.rejects(() => atualizar(executor, EMPRESA_A, 30, { estoqueMinimo: -1 }), /estoque/i);
    await assert.rejects(() => atualizar(executor, EMPRESA_A, 30, { ativo: 'sim' }), /ativo/i);
    assert.equal(executor.chamadas.length, 0);
  });
});

describe('categoria, codigo_interno e descricao — Parte C2 (migration 039)', () => {
  test('criar grava os três campos como parâmetros (nunca concatenados) e a projeção os devolve mapeados', async () => {
    const executor = executorFalso([linha({ categoria: 'EPI', codigo_interno: 'EPI-000245', descricao: 'Proteção leve' })]);
    const r = await criar(executor, { empresaId: EMPRESA_A, nome: 'Luva', categoria: 'EPI', codigoInterno: 'EPI-000245', descricao: 'Proteção leve' });
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /categoria/);
    assert.match(texto, /codigo_interno/);
    assert.match(texto, /descricao/);
    assert.ok(valores.includes('EPI-000245') && valores.includes('EPI') && valores.includes('Proteção leve'));
    assert.equal(texto.includes('EPI-000245'), false);
    assert.deepEqual([r.categoria, r.codigoInterno, r.descricao], ['EPI', 'EPI-000245', 'Proteção leve']);
  });

  test('criar sem os três campos grava NULL (compatível com a 007 + 039)', async () => {
    const executor = executorFalso([linha()]);
    const r = await criar(executor, { empresaId: EMPRESA_A, nome: 'Luva' });
    assert.deepEqual([r.categoria, r.codigoInterno, r.descricao], [null, null, null]);
    assert.equal(executor.chamadas[0].valores.filter((v) => v === null).length >= 3, true);
  });

  test('atualizar: *Informado distingue "limpar" de "não mexer" também para os três campos', async () => {
    const executor = executorFalso([linha()]);
    await atualizar(executor, EMPRESA_A, 30, { codigoInternoInformado: true, codigoInterno: null, categoriaInformado: true, categoria: 'Uniforme' });
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /codigo_interno = CASE WHEN/);
    assert.match(texto, /categoria = CASE WHEN/);
    assert.match(texto, /descricao = CASE WHEN/);
    assert.ok(valores.includes('Uniforme'));
  });

  test('recusa texto acima do limite antes de consultar', async () => {
    const executor = executorFalso([linha()]);
    await assert.rejects(() => criar(executor, { empresaId: EMPRESA_A, nome: 'L', codigoInterno: 'x'.repeat(31) }), /código interno/i);
    await assert.rejects(() => criar(executor, { empresaId: EMPRESA_A, nome: 'L', categoria: 'x'.repeat(31) }), /categoria/i);
    await assert.rejects(() => criar(executor, { empresaId: EMPRESA_A, nome: 'L', descricao: 'x'.repeat(501) }), /descrição/i);
    assert.equal(executor.chamadas.length, 0);
  });
});
