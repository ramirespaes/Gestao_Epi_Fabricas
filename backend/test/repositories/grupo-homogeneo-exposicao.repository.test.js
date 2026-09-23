'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  criar, buscarPorId, buscarPorIdParaAtualizacao, buscarPorIdParaVinculo, listarPorEmpresa, contarPorEmpresa, atualizar,
  TAMANHO_MAXIMO_NOME, TAMANHO_MAXIMO_SETOR,
} = require('../../src/repositories/grupo-homogeneo-exposicao.repository');

/** Contrato do repositório de GHE (Bloco 9, Etapa B). Sem DELETE, de propósito. */

const EMPRESA_A = 4242;
const EMPRESA_B = 8888;

const executorFalso = (linhas = []) => {
  const chamadas = [];
  return {
    chamadas,
    query: async (texto, valores) => { chamadas.push({ texto, valores }); return { rows: linhas, rowCount: linhas.length }; },
  };
};

const linha = (extra = {}) => ({
  id: 50, empresa_id: EMPRESA_A, nome: 'Manutenção — Mecânicos', descricao: null, setor: 'Manutenção',
  funcao: 'Mecânico', riscos: 'Esmagamento; cortes', ativo: true,
  criado_em: new Date('2026-09-23T12:00:00Z'), atualizado_em: new Date('2026-09-23T12:00:00Z'), ...extra,
});

const mapeada = {
  id: 50, empresaId: EMPRESA_A, nome: 'Manutenção — Mecânicos', descricao: null, setor: 'Manutenção',
  funcao: 'Mecânico', riscos: 'Esmagamento; cortes', ativo: true,
  criadoEm: new Date('2026-09-23T12:00:00Z'), atualizadoEm: new Date('2026-09-23T12:00:00Z'),
};

describe('criar', () => {
  test('INSERT parametrizado; ativo não é parâmetro (DEFAULT da migration 004)', async () => {
    const executor = executorFalso([linha()]);

    const ghe = await criar(executor, { empresaId: EMPRESA_A, nome: 'Manutenção — Mecânicos', setor: 'Manutenção', funcao: 'Mecânico', riscos: 'Esmagamento; cortes' });

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /insert\s+into\s+grupos_homogeneos_exposicao/i);
    const colunas = texto.slice(texto.indexOf('('), texto.search(/\bvalues\b/i));
    assert.doesNotMatch(colunas, /\bativo\b/i);
    assert.deepEqual(valores, [EMPRESA_A, 'Manutenção — Mecânicos', null, 'Manutenção', 'Mecânico', 'Esmagamento; cortes']);
    assert.deepEqual(ghe, mapeada);
  });

  test('recusa entrada inválida antes de consultar', async () => {
    const executor = executorFalso([]);
    await assert.rejects(() => criar(executor, { empresaId: 0, nome: 'X' }), /empresa/i);
    await assert.rejects(() => criar(executor, { empresaId: EMPRESA_A, nome: '' }), /nome/i);
    await assert.rejects(() => criar(executor, { empresaId: EMPRESA_A, nome: 'x'.repeat(TAMANHO_MAXIMO_NOME + 1) }), /nome/i);
    await assert.rejects(() => criar(executor, { empresaId: EMPRESA_A, nome: 'X', setor: 'x'.repeat(TAMANHO_MAXIMO_SETOR + 1) }), /setor/i);
    await assert.rejects(() => criar(executor, { empresaId: EMPRESA_A, nome: 'X', descricao: '' }), /descri/i);
    assert.equal(executor.chamadas.length, 0);
  });

  test('violação de UNIQUE (empresa_id, nome) propaga com o SQLSTATE original', async () => {
    const erro = Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'uq_ghe_empresa_nome' });
    const executor = { query: async () => { throw erro; } };
    await assert.rejects(() => criar(executor, { empresaId: EMPRESA_A, nome: 'X' }), (e) => e === erro);
  });
});

describe('buscarPorId e buscarPorIdParaAtualizacao', () => {
  test('filtra por empresa E id; variante travada termina em FOR UPDATE', async () => {
    const comum = executorFalso([linha()]);
    assert.deepEqual(await buscarPorId(comum, EMPRESA_A, 50), mapeada);
    assert.match(comum.chamadas[0].texto, /empresa_id\s*=\s*\$1/i);
    assert.doesNotMatch(comum.chamadas[0].texto, /for\s+update/i);

    const travada = executorFalso([linha()]);
    await buscarPorIdParaAtualizacao(travada, EMPRESA_A, 50);
    assert.match(travada.chamadas[0].texto, /for\s+update\s*$/i);
    assert.deepEqual(travada.chamadas[0].valores, [EMPRESA_A, 50]);
  });

  test('GHE de outra empresa devolve null', async () => {
    assert.equal(await buscarPorId(executorFalso([]), EMPRESA_B, 50), null);
  });

  test('recusa entrada inválida antes de consultar', async () => {
    const executor = executorFalso([]);
    await assert.rejects(() => buscarPorId(executor, 0, 50), /empresa/i);
    await assert.rejects(() => buscarPorId(executor, EMPRESA_A, 0), /GHE/i);
    assert.equal(executor.chamadas.length, 0);
  });
});

describe('buscarPorIdParaVinculo (correção pós-auditoria da Etapa B)', () => {
  test('mesmo filtro por empresa E id, mas termina em FOR SHARE — não FOR UPDATE', async () => {
    const executor = executorFalso([linha()]);
    assert.deepEqual(await buscarPorIdParaVinculo(executor, EMPRESA_A, 50), mapeada);
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /empresa_id\s*=\s*\$1/i);
    assert.match(texto, /\bid\s*=\s*\$2/i);
    assert.match(texto, /for\s+share\s*$/i);
    assert.doesNotMatch(texto, /for\s+update/i);
    assert.deepEqual(valores, [EMPRESA_A, 50]);
  });

  test('GHE de outra empresa devolve null; entrada inválida é recusada antes de consultar', async () => {
    assert.equal(await buscarPorIdParaVinculo(executorFalso([]), EMPRESA_B, 50), null);
    const executor = executorFalso([]);
    await assert.rejects(() => buscarPorIdParaVinculo(executor, 0, 50), /empresa/i);
    await assert.rejects(() => buscarPorIdParaVinculo(executor, EMPRESA_A, 0), /GHE/i);
    assert.equal(executor.chamadas.length, 0);
  });
});

describe('listarPorEmpresa e contarPorEmpresa', () => {
  test('pagina, ordena sem diferenciar maiúsculas, filtros como parâmetro', async () => {
    const executor = executorFalso([linha()]);
    await listarPorEmpresa(executor, EMPRESA_A, { ativo: true, busca: 'manu', pagina: 3, limite: 10 });
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /order\s+by\s+lower\(nome\)/i);
    assert.match(texto, /limit\s+\$4\s+offset\s+\$5/i);
    assert.deepEqual(valores, [EMPRESA_A, true, 'manu', 10, 20]);
  });

  test('% e _ da busca são escapados (texto literal), sem concatenar no SQL', async () => {
    const executor = executorFalso([]);
    await listarPorEmpresa(executor, EMPRESA_A, { busca: 'a%_b' });
    assert.equal(executor.chamadas[0].valores[2], 'a\\%\\_b');
    const contagem = executorFalso([{ total: 0 }]);
    await contarPorEmpresa(contagem, EMPRESA_A, { busca: 'a%_b' });
    assert.equal(contagem.chamadas[0].valores[2], 'a\\%\\_b');
  });

  test('contarPorEmpresa devolve o total', async () => {
    assert.equal(await contarPorEmpresa(executorFalso([{ total: 3 }]), EMPRESA_A), 3);
  });

  test('recusa entrada inválida antes de consultar', async () => {
    const executor = executorFalso([]);
    await assert.rejects(() => listarPorEmpresa(executor, 0), /empresa/i);
    await assert.rejects(() => listarPorEmpresa(executor, EMPRESA_A, { ativo: 'sim' }), /ativo/i);
    await assert.rejects(() => listarPorEmpresa(executor, EMPRESA_A, { pagina: 0 }), /p.gina/i);
    assert.equal(executor.chamadas.length, 0);
  });
});

describe('atualizar', () => {
  test('UPDATE alcança nome, descricao, setor, funcao, riscos e ativo — nunca id, empresa_id ou criado_em', async () => {
    const executor = executorFalso([linha({ nome: 'Novo' })]);
    await atualizar(executor, EMPRESA_A, 50, { nome: 'Novo' });
    const { texto, valores } = executor.chamadas[0];
    const set = texto.slice(texto.search(/\bset\b/i), texto.search(/\bwhere\b/i));
    for (const c of ['nome', 'descricao', 'setor', 'funcao', 'riscos', 'ativo']) assert.match(set, new RegExp(`${c}\\s*=`, 'i'));
    assert.doesNotMatch(set, /empresa_id\s*=/i);
    assert.doesNotMatch(set, /criado_em\s*=/i);
    assert.doesNotMatch(set, /\bid\s*=/i);
    assert.deepEqual(valores, [EMPRESA_A, 50, 'Novo', false, null, false, null, false, null, false, null, null]);
  });

  test('campo opcional null com *Informado=true limpa o valor', async () => {
    const executor = executorFalso([linha({ setor: null })]);
    await atualizar(executor, EMPRESA_A, 50, { setor: null, setorInformado: true });
    assert.equal(executor.chamadas[0].valores[5], true);
    assert.equal(executor.chamadas[0].valores[6], null);
  });

  test('GHE inexistente nesta empresa devolve null; entrada inválida é recusada antes', async () => {
    assert.equal(await atualizar(executorFalso([]), EMPRESA_B, 50, { nome: 'X' }), null);
    const executor = executorFalso([]);
    await assert.rejects(() => atualizar(executor, EMPRESA_A, 50, { nome: '' }), /nome/i);
    await assert.rejects(() => atualizar(executor, EMPRESA_A, 50, { ativo: 'sim' }), /ativo/i);
    assert.equal(executor.chamadas.length, 0);
  });
});
