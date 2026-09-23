'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  criar, buscarPorId, buscarPorIdParaAtualizacao, listarPorEmpresa, contarPorEmpresa, atualizar,
  TAMANHO_MAXIMO_MATRICULA, TAMANHO_MAXIMO_NOME,
} = require('../../src/repositories/funcionario.repository');

/**
 * Contrato do repositório de funcionários (Bloco 9, Etapa B). Sem DELETE.
 * Nenhuma consulta toca `usuarios`: funcionário e usuário são entidades
 * distintas (migration 005/006).
 */

const EMPRESA_A = 4242;
const EMPRESA_B = 8888;
const GHE = 50;

const executorFalso = (linhas = []) => {
  const chamadas = [];
  return {
    chamadas,
    query: async (texto, valores) => { chamadas.push({ texto, valores }); return { rows: linhas, rowCount: linhas.length }; },
  };
};

const linha = (extra = {}) => ({
  id: 70, empresa_id: EMPRESA_A, grupo_homogeneo_id: GHE, matricula: 'MAT-000171', nome: 'Marcos Silva',
  cpf: '52998224725', data_nascimento: '1990-03-15', setor: 'Manutenção', funcao: 'Mecânico',
  cracha: 'CR-001284', telefone: null, ativo: true,
  criado_em: new Date('2026-09-23T12:00:00Z'), atualizado_em: new Date('2026-09-23T12:00:00Z'), ...extra,
});

const mapeada = {
  id: 70, empresaId: EMPRESA_A, grupoHomogeneoId: GHE, matricula: 'MAT-000171', nome: 'Marcos Silva',
  cpf: '52998224725', dataNascimento: '1990-03-15', setor: 'Manutenção', funcao: 'Mecânico',
  cracha: 'CR-001284', telefone: null, ativo: true,
  criadoEm: new Date('2026-09-23T12:00:00Z'), atualizadoEm: new Date('2026-09-23T12:00:00Z'),
};

const base = { empresaId: EMPRESA_A, matricula: 'MAT-000171', nome: 'Marcos Silva', cpf: '52998224725' };

describe('criar', () => {
  test('INSERT parametrizado; ativo não é parâmetro; nenhuma referência a usuarios', async () => {
    const executor = executorFalso([linha()]);

    const funcionario = await criar(executor, { ...base, grupoHomogeneoId: GHE, dataNascimento: '1990-03-15', setor: 'Manutenção', funcao: 'Mecânico', cracha: 'CR-001284' });

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /insert\s+into\s+funcionarios/i);
    assert.doesNotMatch(texto, /usuarios/i);
    const colunas = texto.slice(texto.indexOf('('), texto.search(/\bvalues\b/i));
    assert.doesNotMatch(colunas, /\bativo\b/i);
    assert.deepEqual(valores, [EMPRESA_A, GHE, 'MAT-000171', 'Marcos Silva', '52998224725', '1990-03-15', 'Manutenção', 'Mecânico', 'CR-001284', null]);
    assert.deepEqual(funcionario, mapeada);
  });

  test('sem GHE e sem opcionais: NULLs como parâmetro', async () => {
    const executor = executorFalso([linha({ grupo_homogeneo_id: null })]);
    await criar(executor, base);
    assert.deepEqual(executor.chamadas[0].valores, [EMPRESA_A, null, 'MAT-000171', 'Marcos Silva', '52998224725', null, null, null, null, null]);
  });

  test('recusa entrada inválida antes de consultar — CPF só é aceito já normalizado (11 dígitos)', async () => {
    const executor = executorFalso([]);
    await assert.rejects(() => criar(executor, { ...base, empresaId: 0 }), /empresa/i);
    await assert.rejects(() => criar(executor, { ...base, matricula: '' }), /matr/i);
    await assert.rejects(() => criar(executor, { ...base, matricula: 'x'.repeat(TAMANHO_MAXIMO_MATRICULA + 1) }), /matr/i);
    await assert.rejects(() => criar(executor, { ...base, nome: 'x'.repeat(TAMANHO_MAXIMO_NOME + 1) }), /nome/i);
    await assert.rejects(() => criar(executor, { ...base, cpf: '529.982.247-25' }), /CPF/);
    await assert.rejects(() => criar(executor, { ...base, cpf: '5299822472' }), /CPF/);
    await assert.rejects(() => criar(executor, { ...base, grupoHomogeneoId: 0 }), /GHE/);
    await assert.rejects(() => criar(executor, { ...base, telefone: '' }), /telefone/i);
    assert.equal(executor.chamadas.length, 0);
  });

  test('violações de constraint propagam com code e constraint originais (o serviço distingue matrícula de CPF)', async () => {
    for (const constraint of ['uq_funcionarios_empresa_matricula', 'uq_funcionarios_empresa_cpf', 'fk_funcionarios_ghe_mesma_empresa']) {
      const erro = Object.assign(new Error('violação'), { code: constraint.startsWith('fk') ? '23503' : '23505', constraint });
      await assert.rejects(() => criar({ query: async () => { throw erro; } }, base), (e) => e === erro && e.constraint === constraint);
    }
  });
});

describe('buscarPorId e buscarPorIdParaAtualizacao', () => {
  test('filtra por empresa E id; variante travada termina em FOR UPDATE', async () => {
    const comum = executorFalso([linha()]);
    assert.deepEqual(await buscarPorId(comum, EMPRESA_A, 70), mapeada);
    assert.match(comum.chamadas[0].texto, /empresa_id\s*=\s*\$1/i);
    assert.doesNotMatch(comum.chamadas[0].texto, /for\s+update/i);

    const travada = executorFalso([linha()]);
    await buscarPorIdParaAtualizacao(travada, EMPRESA_A, 70);
    assert.match(travada.chamadas[0].texto, /for\s+update\s*$/i);
  });

  test('funcionário de outra empresa devolve null', async () => {
    assert.equal(await buscarPorId(executorFalso([]), EMPRESA_B, 70), null);
  });
});

describe('listarPorEmpresa e contarPorEmpresa', () => {
  test('busca por nome OU matrícula (escapada), filtro por GHE, paginação — nunca por CPF', async () => {
    const executor = executorFalso([linha()]);
    await listarPorEmpresa(executor, EMPRESA_A, { ativo: true, busca: 'MAT_%', grupoHomogeneoId: GHE, pagina: 2, limite: 5 });
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /nome\s+ilike/i);
    assert.match(texto, /matricula\s+ilike/i);
    assert.doesNotMatch(texto, /cpf\s+ilike/i);
    assert.match(texto, /grupo_homogeneo_id\s*=\s*\$4/i);
    assert.match(texto, /order\s+by\s+lower\(nome\)/i);
    assert.deepEqual(valores, [EMPRESA_A, true, 'MAT\\_\\%', GHE, 5, 5]);
  });

  test('contarPorEmpresa usa os mesmos filtros', async () => {
    const executor = executorFalso([{ total: 9 }]);
    assert.equal(await contarPorEmpresa(executor, EMPRESA_A, { busca: 'silva', grupoHomogeneoId: GHE }), 9);
    assert.deepEqual(executor.chamadas[0].valores, [EMPRESA_A, null, 'silva', GHE]);
  });

  test('recusa entrada inválida antes de consultar', async () => {
    const executor = executorFalso([]);
    await assert.rejects(() => listarPorEmpresa(executor, 0), /empresa/i);
    await assert.rejects(() => listarPorEmpresa(executor, EMPRESA_A, { grupoHomogeneoId: 0 }), /GHE/);
    await assert.rejects(() => listarPorEmpresa(executor, EMPRESA_A, { limite: 0 }), /limite/i);
    assert.equal(executor.chamadas.length, 0);
  });
});

describe('atualizar', () => {
  test('UPDATE alcança só o cadastro — nunca id, empresa_id, criado_em nem cpf; parâmetros na ordem do contrato', async () => {
    const executor = executorFalso([linha({ nome: 'Marcos S.' })]);
    await atualizar(executor, EMPRESA_A, 70, { nome: 'Marcos S.' });
    const { texto, valores } = executor.chamadas[0];
    const set = texto.slice(texto.search(/\bset\b/i), texto.search(/\bwhere\b/i));
    for (const c of ['matricula', 'nome', 'grupo_homogeneo_id', 'data_nascimento', 'setor', 'funcao', 'cracha', 'telefone', 'ativo']) {
      assert.match(set, new RegExp(`${c}\\s*=`, 'i'));
    }
    assert.doesNotMatch(set, /empresa_id\s*=/i);
    assert.doesNotMatch(set, /criado_em\s*=/i);
    assert.doesNotMatch(set, /\bid\s*=/i);
    assert.doesNotMatch(set, /\bcpf\s*=/i, 'CPF é imutável: o UPDATE não tem cláusula para a coluna (ela só aparece na projeção RETURNING)');
    assert.deepEqual(valores, [EMPRESA_A, 70, null, 'Marcos S.', false, null, false, null, false, null, false, null, false, null, false, null, null]);
  });

  test('CPF imutável: atualizar recusa a chave cpf com qualquer valor (válido, inválido ou null), sem consultar', async () => {
    const executor = executorFalso([]);
    for (const cpf of ['11144477735', '123', null]) {
      await assert.rejects(() => atualizar(executor, EMPRESA_A, 70, { nome: 'X', cpf }), (erro) => erro instanceof TypeError && /cpf/i.test(erro.message), String(cpf));
    }
    assert.equal(executor.chamadas.length, 0);
  });

  test('desvincular do GHE: grupoHomogeneoId null com a flag informada', async () => {
    const executor = executorFalso([linha({ grupo_homogeneo_id: null })]);
    await atualizar(executor, EMPRESA_A, 70, { grupoHomogeneoId: null, grupoHomogeneoIdInformado: true });
    // posições 4/5 desde a retirada de cpf do UPDATE (CPF imutável)
    assert.equal(executor.chamadas[0].valores[4], true);
    assert.equal(executor.chamadas[0].valores[5], null);
  });

  test('inexistente nesta empresa devolve null; entrada inválida é recusada antes', async () => {
    assert.equal(await atualizar(executorFalso([]), EMPRESA_B, 70, { nome: 'X' }), null);
    const executor = executorFalso([]);
    await assert.rejects(() => atualizar(executor, EMPRESA_A, 70, { matricula: '' }), /matrícula/i);
    await assert.rejects(() => atualizar(executor, EMPRESA_A, 70, { ativo: 'sim' }), /ativo/i);
    assert.equal(executor.chamadas.length, 0);
  });
});
