'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buscarPorId,
  buscarPorIdParaAtualizacao,
  listarPorUsuarioAcaoParaAtualizacao,
  listarPorUsuario,
  criar,
  listarDescendentes,
  excluir,
} = require('../../src/repositories/autorizacao-individual.repository');

/**
 * Contrato do repositório administrativo de usuario_autorizacoes. Não decide
 * nada: valida formato, monta SQL parametrizado, mapeia colunas para
 * camelCase e propaga erros do banco sem traduzir — a interpretação de
 * SQLSTATE é do serviço.
 */

const EMPRESA_A = 4242;
const EMPRESA_B = 8888;
const USUARIO = 77;
const CONCEDENTE = 5;
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

const linha = (extra = {}) => ({
  id: 15,
  empresa_id: EMPRESA_A,
  usuario_id: USUARIO,
  acao_codigo: ACAO,
  motivo: null,
  autorizado_por: CONCEDENTE,
  pode_delegar: false,
  origem_id: null,
  criado_em: new Date('2026-09-21T12:00:00Z'),
  ...extra,
});

const mapeada = {
  id: 15,
  empresaId: EMPRESA_A,
  usuarioId: USUARIO,
  acaoCodigo: ACAO,
  motivo: null,
  autorizadoPor: CONCEDENTE,
  podeDelegar: false,
  origemId: null,
  criadoEm: new Date('2026-09-21T12:00:00Z'),
};

describe('buscarPorId', () => {
  test('filtra por empresa E id, mapeia para camelCase, sem FOR UPDATE', async () => {
    const executor = executorFalso([linha()]);

    const resultado = await buscarPorId(executor, EMPRESA_A, 15);

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /from\s+usuario_autorizacoes/i);
    assert.match(texto, /empresa_id\s*=\s*\$1/i);
    assert.match(texto, /\bid\s*=\s*\$2/i);
    assert.doesNotMatch(texto, /for\s+update/i);
    assert.deepEqual(valores, [EMPRESA_A, 15]);
    assert.deepEqual(resultado, mapeada);
  });

  test('pode_delegar=false e origem_id=NULL são devolvidos como estão; TRUE e origem preenchida também', async () => {
    const delegada = await buscarPorId(executorFalso([linha({ pode_delegar: true, origem_id: 3 })]), EMPRESA_A, 15);

    assert.equal(delegada.podeDelegar, true);
    assert.equal(delegada.origemId, 3);
  });

  test('registro ausente devolve null', async () => {
    assert.equal(await buscarPorId(executorFalso([]), EMPRESA_B, 15), null);
  });

  test('recusa entrada inválida antes de consultar', async () => {
    const executor = executorFalso([]);
    await assert.rejects(() => buscarPorId(executor, 0, 15), /empresa/i);
    await assert.rejects(() => buscarPorId(executor, EMPRESA_A, 0), /autorização/i);
    assert.equal(executor.chamadas.length, 0);
  });
});

describe('buscarPorIdParaAtualizacao', () => {
  test('mesmo filtro de buscarPorId, terminando em FOR UPDATE', async () => {
    const executor = executorFalso([linha()]);

    const resultado = await buscarPorIdParaAtualizacao(executor, EMPRESA_A, 15);

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /empresa_id\s*=\s*\$1/i);
    assert.match(texto, /\bid\s*=\s*\$2/i);
    assert.match(texto, /for\s+update\s*$/i);
    assert.deepEqual(valores, [EMPRESA_A, 15]);
    assert.deepEqual(resultado, mapeada);
  });

  test('registro ausente (ex.: revogado por transação concorrente) devolve null', async () => {
    assert.equal(await buscarPorIdParaAtualizacao(executorFalso([]), EMPRESA_A, 15), null);
  });
});

describe('criar', () => {
  test('INSERT parametrizado com origem_id NULL e pode_delegar false por padrão (autorização direta)', async () => {
    const executor = executorFalso([linha()]);

    const criada = await criar(executor, { empresaId: EMPRESA_A, usuarioId: USUARIO, acaoCodigo: ACAO, autorizadoPor: CONCEDENTE });

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /insert\s+into\s+usuario_autorizacoes/i);
    assert.match(texto, /returning/i);
    assert.deepEqual(valores, [EMPRESA_A, USUARIO, ACAO, CONCEDENTE, false, null, null]);
    assert.deepEqual(criada, mapeada);
  });

  test('autorização delegada: origem_id e pode_delegar explícitos viajam como parâmetro', async () => {
    const executor = executorFalso([linha({ pode_delegar: true, origem_id: 3 })]);

    await criar(executor, {
      empresaId: EMPRESA_A, usuarioId: USUARIO, acaoCodigo: ACAO, autorizadoPor: CONCEDENTE, podeDelegar: true, origemId: 3, motivo: 'delegação',
    });

    assert.deepEqual(executor.chamadas[0].valores, [EMPRESA_A, USUARIO, ACAO, CONCEDENTE, true, 3, 'delegação']);
  });

  test('recusa entrada inválida antes de consultar', async () => {
    const executor = executorFalso([]);
    const base = { empresaId: EMPRESA_A, usuarioId: USUARIO, acaoCodigo: ACAO, autorizadoPor: CONCEDENTE };

    await assert.rejects(() => criar(executor, { ...base, empresaId: 0 }), /empresa/i);
    await assert.rejects(() => criar(executor, { ...base, usuarioId: 0 }), /usuário/i);
    await assert.rejects(() => criar(executor, { ...base, acaoCodigo: 'minuscula' }), /ação/i);
    await assert.rejects(() => criar(executor, { ...base, autorizadoPor: 0 }), /concedente/i);
    await assert.rejects(() => criar(executor, { ...base, podeDelegar: 'true' }), /pode_delegar/i);
    await assert.rejects(() => criar(executor, { ...base, origemId: 0 }), /origem/i);
    await assert.rejects(() => criar(executor, { ...base, motivo: 42 }), /motivo/i);
    assert.equal(executor.chamadas.length, 0);
  });

  test('violação de constraint propaga com o SQLSTATE original, sem tradução', async () => {
    const erro = Object.assign(new Error('duplicate key'), { code: '23505' });
    const executor = { query: async () => { throw erro; } };

    await assert.rejects(
      () => criar(executor, { empresaId: EMPRESA_A, usuarioId: USUARIO, acaoCodigo: ACAO, autorizadoPor: CONCEDENTE }),
      (e) => e === erro && e.code === '23505',
    );
  });
});

describe('listarDescendentes', () => {
  test('consulta recursiva a partir de origem_id, repetindo o filtro de empresa em cada nível', async () => {
    const executor = executorFalso([
      { id: 16, usuario_id: 8, acao_codigo: ACAO, autorizado_por: USUARIO, pode_delegar: true, origem_id: 15 },
      { id: 17, usuario_id: 9, acao_codigo: ACAO, autorizado_por: 8, pode_delegar: false, origem_id: 16 },
    ]);

    const descendentes = await listarDescendentes(executor, EMPRESA_A, 15);

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /with\s+recursive/i);
    assert.match(texto, /origem_id\s*=\s*\$2/i, 'âncora: filhos diretos da origem informada');
    assert.match(texto, /f\.origem_id\s*=\s*d\.id/i, 'passo recursivo: filhos dos já encontrados');
    assert.equal((texto.match(/empresa_id\s*=\s*\$1/gi) || []).length, 2, 'filtro de empresa na âncora E no passo recursivo');
    assert.deepEqual(valores, [EMPRESA_A, 15]);
    assert.deepEqual(descendentes, [
      { id: 16, usuarioId: 8, acaoCodigo: ACAO, autorizadoPor: USUARIO, podeDelegar: true, origemId: 15 },
      { id: 17, usuarioId: 9, acaoCodigo: ACAO, autorizadoPor: 8, podeDelegar: false, origemId: 16 },
    ]);
  });

  test('sem descendentes devolve lista vazia', async () => {
    assert.deepEqual(await listarDescendentes(executorFalso([]), EMPRESA_A, 15), []);
  });
});

describe('excluir', () => {
  test('DELETE filtrado por empresa E id, devolvendo a linha excluída', async () => {
    const executor = executorFalso([linha()]);

    const excluida = await excluir(executor, EMPRESA_A, 15);

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /delete\s+from\s+usuario_autorizacoes/i);
    assert.match(texto, /empresa_id\s*=\s*\$1/i);
    assert.match(texto, /\bid\s*=\s*\$2/i);
    assert.match(texto, /returning/i);
    assert.deepEqual(valores, [EMPRESA_A, 15]);
    assert.deepEqual(excluida, mapeada);
  });

  test('nada excluído (id inexistente nesta empresa) devolve null', async () => {
    assert.equal(await excluir(executorFalso([]), EMPRESA_B, 15), null);
  });

  test('não percorre descendentes: é um único DELETE — a cascata é da FK da migration 023', async () => {
    const executor = executorFalso([linha()]);

    await excluir(executor, EMPRESA_A, 15);

    assert.equal(executor.chamadas.length, 1);
    // origem_id aparece no RETURNING (projeção da linha excluída), o que é
    // legítimo; o que não pode existir é recursão ou filtro por origem_id.
    assert.doesNotMatch(executor.chamadas[0].texto, /with\s+recursive/i);
    assert.doesNotMatch(executor.chamadas[0].texto, /origem_id\s*=/i);
  });
});

// ─────────────────────────────────────────────────────────────────────
// listarPorUsuario — a leitura que a tela da 3V usa
// ─────────────────────────────────────────────────────────────────────

const linhaComNomes = (extra = {}) => ({
  id: 100, empresa_id: 4242, usuario_id: 9, acao_codigo: 'MOVIMENTAR_ESTOQUE',
  motivo: null, autorizado_por: 1, pode_delegar: true, origem_id: null,
  criado_em: new Date('2026-09-22T10:00:00Z'),
  usuario_nome: 'Ana Souza', autorizado_por_nome: 'Master da Empresa',
  acao_nome: 'Movimentar estoque', acao_ativa: true, acao_exige_sst: false,
  acao_modo: 'ALTERNATIVA', ...extra,
});

describe('listarPorUsuario', () => {
  test('mapeia a autorização e acrescenta os nomes legíveis', async () => {
    const executor = executorFalso([linhaComNomes()]);

    const [autorizacao] = await listarPorUsuario(executor, 4242, 9);

    assert.equal(autorizacao.id, 100);
    assert.equal(autorizacao.usuarioId, 9);
    assert.equal(autorizacao.acaoCodigo, 'MOVIMENTAR_ESTOQUE');
    assert.equal(autorizacao.autorizadoPor, 1);
    assert.equal(autorizacao.podeDelegar, true);
    assert.equal(autorizacao.origemId, null);
    assert.equal(autorizacao.usuarioNome, 'Ana Souza');
    assert.equal(autorizacao.autorizadoPorNome, 'Master da Empresa');
    assert.equal(autorizacao.acaoNome, 'Movimentar estoque');
    assert.equal(autorizacao.acaoModo, 'ALTERNATIVA');
    assert.equal(autorizacao.acaoExigeSst, false);
    assert.equal(autorizacao.acaoAtiva, true);
  });

  test('delegada preserva origemId; direta preserva null — não se confundem', async () => {
    const delegada = await listarPorUsuario(executorFalso([linhaComNomes({ origem_id: 55 })]), 4242, 9);
    const direta = await listarPorUsuario(executorFalso([linhaComNomes({ origem_id: null })]), 4242, 9);

    assert.equal(delegada[0].origemId, 55);
    assert.equal(direta[0].origemId, null);
  });

  test('podeDelegar false é preservado, não vira ausência', async () => {
    const [autorizacao] = await listarPorUsuario(executorFalso([linhaComNomes({ pode_delegar: false })]), 4242, 9);

    assert.equal(autorizacao.podeDelegar, false);
  });

  test('sem resultado devolve lista vazia, não null', async () => {
    assert.deepEqual(await listarPorUsuario(executorFalso([]), 4242, 9), []);
  });

  test('filtra por empresa E usuário, com parâmetros separados', async () => {
    const executor = executorFalso([]);

    await listarPorUsuario(executor, 8888, 77);

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /a\.empresa_id\s*=\s*\$1/i);
    assert.match(texto, /a\.usuario_id\s*=\s*\$2/i);
    assert.equal(valores[0], 8888);
    assert.equal(valores[1], 77);
    assert.equal(texto.includes('8888'), false, 'nada concatenado');
  });

  test('sem concedidasPor, o terceiro parâmetro é null e o filtro não se aplica', async () => {
    const executor = executorFalso([]);

    await listarPorUsuario(executor, 4242, 9);

    assert.equal(executor.chamadas[0].valores[2], null);
    assert.match(executor.chamadas[0].texto, /\$3::integer IS NULL/i);
  });

  test('com concedidasPor, restringe pelo concedente — também parametrizado', async () => {
    const executor = executorFalso([]);

    await listarPorUsuario(executor, 4242, 9, { concedidasPor: 5 });

    const { texto, valores } = executor.chamadas[0];
    assert.equal(valores[2], 5);
    assert.match(texto, /a\.autorizado_por\s*=\s*\$3/i);
  });

  test('as junções com usuarios casam também por empresa, não só por id', async () => {
    const executor = executorFalso([]);

    await listarPorUsuario(executor, 4242, 9);

    const { texto } = executor.chamadas[0];
    assert.match(texto, /beneficiario\.empresa_id\s*=\s*a\.empresa_id/i);
    assert.match(texto, /concedente\.empresa_id\s*=\s*a\.empresa_id/i);
  });

  test('é somente leitura e SEM FOR UPDATE: não é o caminho transacional', async () => {
    const executor = executorFalso([]);

    await listarPorUsuario(executor, 4242, 9);

    const { texto } = executor.chamadas[0];
    assert.doesNotMatch(texto, /for\s+update/i, 'lock no caminho de consulta seria defeito');
    assert.doesNotMatch(texto, /\b(insert|update|delete|drop|alter)\b/i);
  });

  test('a variante travada continua existindo e continua travando', async () => {
    const executor = executorFalso([]);

    await listarPorUsuarioAcaoParaAtualizacao(executor, 4242, 9, 'MOVIMENTAR_ESTOQUE');

    assert.match(executor.chamadas[0].texto, /for\s+update/i, 'o caminho de escrita não foi afetado');
  });

  test('não devolve senha nem hash: a projeção não os pede', async () => {
    const executor = executorFalso([linhaComNomes()]);

    const [autorizacao] = await listarPorUsuario(executor, 4242, 9);

    assert.doesNotMatch(executor.chamadas[0].texto, /senha/i);
    assert.equal('senha_hash' in autorizacao, false);
    assert.equal('email' in autorizacao, false, 'a tela precisa do nome, não do e-mail');
  });

  test('ordena por ação e depois por criação, para a tela não parecer aleatória', async () => {
    const executor = executorFalso([]);

    await listarPorUsuario(executor, 4242, 9);

    assert.match(executor.chamadas[0].texto, /order\s+by\s+acao\.codigo,\s*a\.criado_em,\s*a\.id/i);
  });

  test('recusa entrada inválida antes de consultar', async () => {
    for (const [empresa, usuarioId, opcoes] of [
      [0, 9, undefined], [-1, 9, undefined], [null, 9, undefined],
      [4242, 0, undefined], [4242, '9', undefined], [4242, 1.5, undefined],
      [4242, 9, { concedidasPor: 0 }], [4242, 9, { concedidasPor: '5' }],
    ]) {
      const executor = executorFalso([]);
      await assert.rejects(() => listarPorUsuario(executor, empresa, usuarioId, opcoes), TypeError);
      assert.equal(executor.chamadas.length, 0);
    }
  });

  test('erro inesperado do banco propaga', async () => {
    const executor = { query: async () => { throw new Error('falha ao consultar autorizacoes'); } };

    await assert.rejects(() => listarPorUsuario(executor, 4242, 9), /falha ao consultar/);
  });
});
