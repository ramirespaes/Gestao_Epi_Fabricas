'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * Contrato do repositório dos itens da solicitação de EPI. O banco é a
 * autoridade da coerência das decisões (CHECKs, gatilhos e conferência no
 * COMMIT), provada com PostgreSQL real na integração; aqui confiro
 * isolamento, SQL, parâmetros, validação de tipos e mapeamento.
 */

const repo = () => exigirModulo('src/repositories/solicitacao-epi-item.repository');

const EMPRESA = 4242;
const SOLICITACAO = 17;
const ASTRAL = '\u{1D400}';

const executorFalso = (...respostas) => {
  const chamadas = [];
  return {
    chamadas,
    query: async (texto, valores) => {
      chamadas.push({ texto, valores });
      return { rows: respostas.length > 0 ? respostas.shift() : [] };
    },
  };
};

const linha = (extra = {}) => ({
  id: 1, empresa_id: EMPRESA, solicitacao_id: SOLICITACAO, material_id: 30, tamanho: '40', quantidade: 4, motivo: 'ADMISSAO',
  justificativa: null, previsto_no_ghe: true, decisao: null, quantidade_aprovada: null, justificativa_decisao: null, ...extra,
});
const publica = (extra = {}) => ({
  id: 1, empresaId: EMPRESA, solicitacaoId: SOLICITACAO, materialId: 30, tamanho: '40', quantidade: 4, motivo: 'ADMISSAO',
  justificativa: null, previstoNoGhe: true, decisao: null, quantidadeAprovada: null, justificativaDecisao: null, ...extra,
});
const novo = (extra = {}) => ({
  empresaId: EMPRESA, solicitacaoId: SOLICITACAO, materialId: 30, tamanho: '40', quantidade: 4, motivo: 'ADMISSAO', previstoNoGhe: true, ...extra,
});

describe('constantes', () => {
  test('os motivos são os da entrega do Bloco 10 e as decisões são APROVADO e REPROVADO', () => {
    assert.deepEqual([...repo().MOTIVOS], ['ADMISSAO', 'SUBSTITUICAO_PRAZO', 'DESGASTE_DANO', 'PERDA_EXTRAVIO', 'OUTRO']);
    assert.deepEqual([...repo().DECISOES], ['APROVADO', 'REPROVADO']);
    assert.ok(Object.isFrozen(repo().MOTIVOS));
    assert.ok(Object.isFrozen(repo().DECISOES));
  });
});

describe('criar', () => {
  test('insere o item com SQL parametrizado, sem decisão, e devolve o item', async () => {
    const executor = executorFalso([linha()]);
    assert.deepEqual(await repo().criar(executor, novo()), publica());
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /^INSERT INTO solicitacoes_epi_itens\b/);
    assert.doesNotMatch(texto.split('VALUES')[0], /decisao|quantidade_aprovada|justificativa_decisao/, 'o item nasce sem decisão');
    assert.deepEqual(valores, [EMPRESA, SOLICITACAO, 30, '40', 4, 'ADMISSAO', null, true]);
  });

  test('tamanho e justificativa são opcionais; a justificativa conta caracteres', async () => {
    const executor = executorFalso([linha({ tamanho: null })], [linha()]);
    const semTamanho = await repo().criar(executor, novo({ tamanho: null }));
    assert.equal(semTamanho.tamanho, null);
    assert.equal(executor.chamadas[0].valores[3], null);
    await repo().criar(executor, novo({ motivo: 'OUTRO', justificativa: ASTRAL.repeat(500) }));
    assert.equal(executor.chamadas[1].valores[6], ASTRAL.repeat(500));
  });

  test('recusa identificadores, tamanho, quantidade, motivo, justificativa e previsão inválidos sem consultar', async () => {
    const vazio = executorFalso();
    const invalidos = [
      [{ empresaId: 0 }, /empresa/],
      [{ solicitacaoId: -1 }, /solicitação/],
      [{ materialId: 1.5 }, /material/],
      [{ tamanho: '' }, /tamanho/],
      [{ tamanho: 'x'.repeat(21) }, /tamanho/],
      [{ tamanho: 40 }, /tamanho/],
      [{ quantidade: 0 }, /quantidade/],
      [{ quantidade: -2 }, /quantidade/],
      [{ quantidade: 1.5 }, /quantidade/],
      [{ quantidade: 2147483648 }, /quantidade/],
      [{ motivo: 'CAPRICHO' }, /motivo/],
      [{ motivo: undefined }, /motivo/],
      [{ justificativa: '' }, /justificativa/],
      [{ justificativa: ASTRAL.repeat(501) }, /justificativa/],
      [{ previstoNoGhe: 'sim' }, /GHE/],
      [{ previstoNoGhe: undefined }, /GHE/],
    ];
    for (const [extra, mensagem] of invalidos) {
      await assert.rejects(() => repo().criar(vazio, novo(extra)), mensagem, JSON.stringify(extra));
    }
    assert.equal(vazio.chamadas.length, 0);
  });
});

describe('listarPorSolicitacao', () => {
  test('lista os itens da solicitação da empresa, em ordem de id; vazio quando não há', async () => {
    const executor = executorFalso([linha({ id: 1 }), linha({ id: 2, tamanho: null, material_id: 31 })], []);
    assert.deepEqual(await repo().listarPorSolicitacao(executor, EMPRESA, SOLICITACAO), [publica({ id: 1 }), publica({ id: 2, tamanho: null, materialId: 31 })]);
    assert.deepEqual(await repo().listarPorSolicitacao(executor, EMPRESA, SOLICITACAO), []);
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /WHERE empresa_id = \$1 AND solicitacao_id = \$2\s+ORDER BY id$/);
    assert.deepEqual(valores, [EMPRESA, SOLICITACAO]);
  });

  test('mapeia a decisão do item quando existe', async () => {
    const executor = executorFalso([linha({ decisao: 'APROVADO', quantidade_aprovada: 3, justificativa_decisao: 'Estoque curto' })]);
    const [item] = await repo().listarPorSolicitacao(executor, EMPRESA, SOLICITACAO);
    assert.deepEqual([item.decisao, item.quantidadeAprovada, item.justificativaDecisao], ['APROVADO', 3, 'Estoque curto']);
  });

  test('recusa empresa ou solicitação inválidas sem consultar', async () => {
    const vazio = executorFalso();
    await assert.rejects(() => repo().listarPorSolicitacao(vazio, 0, SOLICITACAO), /empresa/);
    await assert.rejects(() => repo().listarPorSolicitacao(vazio, EMPRESA, '17'), /solicitação/);
    assert.equal(vazio.chamadas.length, 0);
  });
});

describe('decidirTodos', () => {
  const decisoes = () => [
    { itemId: 1, decisao: 'APROVADO', quantidadeAprovada: 4, justificativa: null },
    { itemId: 2, decisao: 'APROVADO', quantidadeAprovada: 2, justificativa: 'Estoque curto' },
    { itemId: 3, decisao: 'REPROVADO', quantidadeAprovada: 0, justificativa: 'Sem necessidade' },
  ];

  test('decide todos os itens numa única instrução UPDATE, só os ainda sem decisão, da solicitação da empresa', async () => {
    const executor = executorFalso([
      linha({ id: 3, decisao: 'REPROVADO', quantidade_aprovada: 0, justificativa_decisao: 'Sem necessidade' }),
      linha({ id: 1, decisao: 'APROVADO', quantidade_aprovada: 4 }),
      linha({ id: 2, decisao: 'APROVADO', quantidade_aprovada: 2, justificativa_decisao: 'Estoque curto' }),
    ]);
    const decididos = await repo().decidirTodos(executor, EMPRESA, SOLICITACAO, decisoes());
    assert.deepEqual(decididos.map((i) => i.id), [1, 2, 3], 'ordenados por id, qualquer que seja a ordem do banco');
    assert.deepEqual(decididos.map((i) => i.decisao), ['APROVADO', 'APROVADO', 'REPROVADO']);
    assert.equal(executor.chamadas.length, 1, 'uma instrução só');
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /^UPDATE solicitacoes_epi_itens AS i\b/);
    assert.match(texto, /unnest\(\$3::int\[\], \$4::text\[\], \$5::int\[\], \$6::text\[\]\)/);
    assert.match(texto, /i\.empresa_id = \$1/);
    assert.match(texto, /i\.solicitacao_id = \$2/);
    assert.match(texto, /i\.decisao IS NULL/);
    assert.match(texto, /RETURNING /);
    assert.deepEqual(valores, [
      EMPRESA, SOLICITACAO, [1, 2, 3], ['APROVADO', 'APROVADO', 'REPROVADO'], [4, 2, 0], [null, 'Estoque curto', 'Sem necessidade'],
    ]);
  });

  test('devolve só as linhas realmente atualizadas: item já decidido ou de outra solicitação não volta (o serviço compara a contagem)', async () => {
    const executor = executorFalso([linha({ id: 1, decisao: 'APROVADO', quantidade_aprovada: 4 })]);
    const decididos = await repo().decidirTodos(executor, EMPRESA, SOLICITACAO, decisoes());
    assert.equal(decididos.length, 1);
  });

  test('recusa decisões vazias, itens repetidos, decisão fora de APROVADO/REPROVADO, quantidade ou justificativa inválidas, sem consultar', async () => {
    const vazio = executorFalso();
    const base = () => decisoes();
    const casos = [
      [[], /decisões/],
      ['x', /decisões/],
      [[...base(), { itemId: 1, decisao: 'REPROVADO', quantidadeAprovada: 0, justificativa: 'Repetido' }], /repetido/],
      [[{ itemId: 0, decisao: 'APROVADO', quantidadeAprovada: 1, justificativa: null }], /item/],
      [[{ itemId: 1, decisao: 'TALVEZ', quantidadeAprovada: 1, justificativa: null }], /decisão/],
      [[{ itemId: 1, decisao: null, quantidadeAprovada: 1, justificativa: null }], /decisão/],
      [[{ itemId: 1, decisao: 'APROVADO', quantidadeAprovada: -1, justificativa: null }], /quantidade/],
      [[{ itemId: 1, decisao: 'APROVADO', quantidadeAprovada: 1.5, justificativa: null }], /quantidade/],
      [[{ itemId: 1, decisao: 'APROVADO', quantidadeAprovada: null, justificativa: null }], /quantidade/],
      [[{ itemId: 1, decisao: 'APROVADO', quantidadeAprovada: 1, justificativa: '' }], /justificativa/],
      [[{ itemId: 1, decisao: 'REPROVADO', quantidadeAprovada: 0, justificativa: ASTRAL.repeat(501) }], /justificativa/],
      [[{ itemId: 1, decisao: 'REPROVADO', quantidadeAprovada: 0, justificativa: 5 }], /justificativa/],
    ];
    for (const [entrada, mensagem] of casos) {
      await assert.rejects(() => repo().decidirTodos(vazio, EMPRESA, SOLICITACAO, entrada), mensagem, JSON.stringify(entrada).slice(0, 60));
    }
    await assert.rejects(() => repo().decidirTodos(vazio, 0, SOLICITACAO, base()), /empresa/);
    await assert.rejects(() => repo().decidirTodos(vazio, EMPRESA, 0, base()), /solicitação/);
    assert.equal(vazio.chamadas.length, 0);
  });

  test('o repositório não valida a regra de negócio da decisão: a coerência entre decisão e quantidade é do banco', async () => {
    const executor = executorFalso([]);
    await repo().decidirTodos(executor, EMPRESA, SOLICITACAO, [{ itemId: 1, decisao: 'APROVADO', quantidadeAprovada: 0, justificativa: null }]);
    assert.equal(executor.chamadas.length, 1, 'o valor incoerente chega ao banco, que recusa por CHECK');
  });
});

describe('o repositório não toca outras tabelas', () => {
  test('só solicitacoes_epi_itens', async () => {
    const executor = executorFalso([linha()], [linha()], [linha()]);
    await repo().criar(executor, novo());
    await repo().listarPorSolicitacao(executor, EMPRESA, SOLICITACAO);
    await repo().decidirTodos(executor, EMPRESA, SOLICITACAO, [{ itemId: 1, decisao: 'REPROVADO', quantidadeAprovada: 0, justificativa: 'Sem necessidade' }]);
    for (const { texto } of executor.chamadas) {
      assert.doesNotMatch(texto, /estoque_|fichas_epi|entregas_epi|FROM solicitacoes_epi\b(?!_itens)/);
    }
  });
});
