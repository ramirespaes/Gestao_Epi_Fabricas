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
  id: 70, empresa_id: EMPRESA_A, grupo_homogeneo_id: GHE, matricula: 'MAT-000171', nome: 'Tício de Tal',
  cpf: '52998224725', data_nascimento: '1990-03-15', setor: 'Manutenção', funcao: 'Mecânico',
  cracha: 'CR-001284', telefone: null, situacao: 'ATIVO', ativo: true, data_admissao: '2020-06-01',
  criado_em: new Date('2026-09-23T12:00:00Z'), atualizado_em: new Date('2026-09-23T12:00:00Z'), ...extra,
});

const mapeada = {
  id: 70, empresaId: EMPRESA_A, grupoHomogeneoId: GHE, matricula: 'MAT-000171', nome: 'Tício de Tal',
  cpf: '52998224725', dataNascimento: '1990-03-15', setor: 'Manutenção', funcao: 'Mecânico',
  cracha: 'CR-001284', telefone: null, situacao: 'ATIVO', ativo: true, dataAdmissao: '2020-06-01',
  criadoEm: new Date('2026-09-23T12:00:00Z'), atualizadoEm: new Date('2026-09-23T12:00:00Z'),
};

const base = { empresaId: EMPRESA_A, matricula: 'MAT-000171', nome: 'Tício de Tal', cpf: '52998224725' };

describe('criar', () => {
  test('INSERT parametrizado; ativo não é parâmetro; nenhuma referência a usuarios', async () => {
    const executor = executorFalso([linha()]);

    const funcionario = await criar(executor, { ...base, grupoHomogeneoId: GHE, dataNascimento: '1990-03-15', setor: 'Manutenção', funcao: 'Mecânico', cracha: 'CR-001284' });

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /insert\s+into\s+funcionarios/i);
    assert.doesNotMatch(texto, /usuarios/i);
    const colunas = texto.slice(texto.indexOf('('), texto.search(/\bvalues\b/i));
    assert.doesNotMatch(colunas, /\bativo\b/i);
    assert.deepEqual(valores, [EMPRESA_A, GHE, 'MAT-000171', 'Tício de Tal', '52998224725', '1990-03-15', 'Manutenção', 'Mecânico', 'CR-001284', null, null]);
    assert.deepEqual(funcionario, mapeada);
  });

  test('sem GHE e sem opcionais: NULLs como parâmetro', async () => {
    const executor = executorFalso([linha({ grupo_homogeneo_id: null })]);
    await criar(executor, base);
    assert.deepEqual(executor.chamadas[0].valores, [EMPRESA_A, null, 'MAT-000171', 'Tício de Tal', '52998224725', null, null, null, null, null, null]);
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
    assert.deepEqual(valores, [EMPRESA_A, true, 'MAT\\_\\%', GHE, null, 5, 5]);
  });

  test('contarPorEmpresa usa os mesmos filtros', async () => {
    const executor = executorFalso([{ total: 9 }]);
    assert.equal(await contarPorEmpresa(executor, EMPRESA_A, { busca: 'silva', grupoHomogeneoId: GHE }), 9);
    assert.deepEqual(executor.chamadas[0].valores, [EMPRESA_A, null, 'silva', GHE, null]);
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
    const executor = executorFalso([linha({ nome: 'Tício T.' })]);
    await atualizar(executor, EMPRESA_A, 70, { nome: 'Tício T.' });
    const { texto, valores } = executor.chamadas[0];
    const set = texto.slice(texto.search(/\bset\b/i), texto.search(/\bwhere\b/i));
    for (const c of ['matricula', 'nome', 'grupo_homogeneo_id', 'data_nascimento', 'setor', 'funcao', 'cracha', 'telefone', 'situacao']) {
      assert.match(set, new RegExp(`${c}\\s*=`, 'i'));
    }
    assert.doesNotMatch(set, /empresa_id\s*=/i);
    assert.doesNotMatch(set, /criado_em\s*=/i);
    assert.doesNotMatch(set, /\bid\s*=/i);
    assert.doesNotMatch(set, /\bcpf\s*=/i, 'CPF é imutável: o UPDATE não tem cláusula para a coluna (ela só aparece na projeção RETURNING)');
    assert.deepEqual(valores, [EMPRESA_A, 70, null, 'Tício T.', false, null, false, null, false, null, false, null, false, null, false, null, null, false, null, false]);
  });

  test('o pedido legado ativo true/false grava situacao ATIVO/INATIVO (ativo é coluna gerada desde a 084); sem ativo, a situação não é tocada', async () => {
    for (const [pedido, esperado] of [[{ ativo: true }, 'ATIVO'], [{ ativo: false }, 'INATIVO'], [{ nome: 'X' }, null]]) {
      const executor = executorFalso([linha()]);
      await atualizar(executor, EMPRESA_A, 70, pedido);
      const { texto, valores } = executor.chamadas[0];
      assert.equal(valores[16], esperado, JSON.stringify(pedido));
      assert.match(texto, /situacao\s*=\s*COALESCE\(\$17::text, situacao\)/i);
      assert.doesNotMatch(texto.slice(texto.search(/\bset\b/i), texto.search(/\bwhere\b/i)), /\bativo\s*=/i, 'nunca escreve a coluna gerada');
    }
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

describe('C4 (25/09/2026) — datas como AAAA-MM-DD, admissão e CPF exato', () => {
  test('toda projeção formata data_nascimento e data_admissao no PostgreSQL (to_char), nunca como Date do Node', async () => {
    const executor = executorFalso([linha()]);
    await criar(executor, base);
    await buscarPorId(executor, EMPRESA_A, 70);
    await buscarPorIdParaAtualizacao(executor, EMPRESA_A, 70);
    await listarPorEmpresa(executor, EMPRESA_A);
    await atualizar(executor, EMPRESA_A, 70, { nome: 'X' });
    assert.equal(executor.chamadas.length, 5);
    for (const { texto } of executor.chamadas) {
      assert.match(texto, /to_char\(data_nascimento, 'YYYY-MM-DD'\) AS data_nascimento/, texto);
      assert.match(texto, /to_char\(data_admissao, 'YYYY-MM-DD'\) AS data_admissao/, texto);
    }
  });

  test('criar grava data_admissao como parâmetro; data inválida de tipo é recusada antes', async () => {
    const executor = executorFalso([linha()]);
    const f = await criar(executor, { ...base, dataAdmissao: '2020-06-01' });
    assert.match(executor.chamadas[0].texto, /data_admissao/);
    assert.equal(executor.chamadas[0].valores[10], '2020-06-01');
    assert.equal(f.dataAdmissao, '2020-06-01');
    await assert.rejects(() => criar(executorFalso([]), { ...base, dataAdmissao: 20200601 }), /admissão/i);
  });

  test('atualizar: dataAdmissao com flag distingue "não mexer" de "limpar"', async () => {
    const executor = executorFalso([linha()]);
    await atualizar(executor, EMPRESA_A, 70, { dataAdmissao: '2021-02-03', dataAdmissaoInformado: true });
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /data_admissao = CASE WHEN \$18::boolean THEN \$19 ELSE data_admissao END/);
    assert.deepEqual(valores.slice(17, 19), [true, '2021-02-03']);
    const limpar = executorFalso([linha()]);
    await atualizar(limpar, EMPRESA_A, 70, { dataAdmissao: null, dataAdmissaoInformado: true });
    assert.deepEqual(limpar.chamadas[0].valores.slice(17, 19), [true, null]);
  });

  test('CPF exato: igualdade (nunca ILIKE, nunca parcial), só 11 dígitos, mesma cláusula em listar e contar', async () => {
    const executor = executorFalso([linha()]);
    await listarPorEmpresa(executor, EMPRESA_A, { cpf: '52998224725' });
    await contarPorEmpresa(executor, EMPRESA_A, { cpf: '52998224725' });
    for (const { texto, valores } of executor.chamadas) {
      assert.match(texto, /\(\$5::text IS NULL OR cpf = \$5::text\)/);
      assert.doesNotMatch(texto, /cpf\s+ilike/i);
      assert.equal(valores[4], '52998224725');
      assert.equal(valores[0], EMPRESA_A, 'sempre filtrado pela empresa');
    }
    const recusa = executorFalso([]);
    for (const cpf of ['529.982.247-25', '5299822472', '', 52998224725]) {
      await assert.rejects(() => listarPorEmpresa(recusa, EMPRESA_A, { cpf }), /CPF/, String(cpf));
      await assert.rejects(() => contarPorEmpresa(recusa, EMPRESA_A, { cpf }), /CPF/, String(cpf));
    }
    assert.equal(recusa.chamadas.length, 0);
  });
});
