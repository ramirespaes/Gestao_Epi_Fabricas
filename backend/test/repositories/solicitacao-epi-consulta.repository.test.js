'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * Contrato das listagens da solicitação de EPI (12E-1): minhas solicitações,
 * fila de decisão da SST e solicitações entregáveis. A correção do conteúdo é
 * provada com PostgreSQL real na integração; aqui confiro o que não depende do
 * banco: leitura pura, filtro pela empresa em todas as tabelas, ausência do CPF
 * e de qualquer texto livre, ordenação determinística, parâmetros, mapeamento e
 * validação antes de consultar.
 */

const repo = () => exigirModulo('src/repositories/solicitacao-epi-consulta.repository');
const funcao = (nome) => {
  const modulo = repo();
  assert.equal(typeof modulo[nome], 'function', `função ainda não implementada: ${nome}`);
  return modulo[nome];
};

const EMPRESA = 4242;
const USUARIO = 7;
const CRIADA_EM = new Date('2026-10-02T12:00:00Z');
const DECIDIDA_EM = new Date('2026-10-02T15:00:00Z');

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
  id: 17,
  numero: 3,
  status: 'PENDENTE',
  solicitante_usuario_id: USUARIO,
  funcionario_id: 5,
  quantidade_itens: 2,
  criada_em: CRIADA_EM,
  decidida_em: null,
  cancelada_em: null,
  entregue_em: null,
  trabalhador_nome: 'Trabalhador Fictício',
  trabalhador_matricula: 'T-1',
  trabalhador_ativo: true,
  ...extra,
});

const linhaMapeada = (extra = {}) => ({
  id: 17,
  numero: 3,
  status: 'PENDENTE',
  solicitanteUsuarioId: USUARIO,
  funcionarioId: 5,
  quantidadeItens: 2,
  criadaEm: CRIADA_EM,
  decididaEm: null,
  canceladaEm: null,
  entregueEm: null,
  trabalhador: { nome: 'Trabalhador Fictício', matricula: 'T-1', ativo: true },
  ...extra,
});

const LISTAGENS = [
  ['listarMinhas', (executor, extra = {}) => funcao('listarMinhas')(executor, EMPRESA, USUARIO, { pagina: 1, limite: 20, ...extra })],
  ['listarFila', (executor, extra = {}) => funcao('listarFila')(executor, EMPRESA, { pagina: 1, limite: 20, ...extra })],
  ['listarEntregaveis', (executor, extra = {}) => funcao('listarEntregaveis')(executor, EMPRESA, { pagina: 1, limite: 20, ...extra })],
];
const CONTAGENS = [
  ['contarMinhas', (executor, extra = {}) => funcao('contarMinhas')(executor, EMPRESA, USUARIO, extra)],
  ['contarFila', (executor) => funcao('contarFila')(executor, EMPRESA)],
  ['contarEntregaveis', (executor, extra = {}) => funcao('contarEntregaveis')(executor, EMPRESA, extra)],
];

describe('constantes', () => {
  test('o limite máximo da página é 100 e os status aceitos no filtro são os do banco', () => {
    assert.equal(repo().LIMITE_MAXIMO, 100);
    assert.deepEqual([...repo().STATUS], ['PENDENTE', 'APROVADA', 'APROVADA_PARCIAL', 'REPROVADA', 'CANCELADA', 'ENTREGUE', 'ENCERRADA']);
  });
});

describe('listagens — mapeamento', () => {
  for (const [nome, chamar] of LISTAGENS) {
    // "Minhas" traz a data do encerramento (12F-1); a fila e os entregáveis nunca têm ENCERRADA e não a trazem.
    const comEncerramento = nome === 'listarMinhas';
    const esperada = (extra = {}) => (comEncerramento ? linhaMapeada({ encerradaEm: null, ...extra }) : linhaMapeada(extra));
    test(`${nome}: mapeia a linha sem o CPF e sem texto livre; o trabalhador sai só com nome, matrícula e situação`, async () => {
      const executor = executorFalso([
        linha(comEncerramento ? { encerrada_em: null } : {}),
        linha({
          id: 18, numero: 4, status: 'APROVADA', decidida_em: DECIDIDA_EM, funcionario_id: 6, trabalhador_nome: 'Outro Trabalhador', trabalhador_matricula: 'T-2', trabalhador_ativo: false,
          ...(comEncerramento ? { encerrada_em: null } : {}),
        }),
      ]);
      const linhas = await chamar(executor);
      assert.deepEqual(linhas, [
        esperada(),
        esperada({
          id: 18, numero: 4, status: 'APROVADA', decididaEm: DECIDIDA_EM, funcionarioId: 6, trabalhador: { nome: 'Outro Trabalhador', matricula: 'T-2', ativo: false },
        }),
      ]);
      for (const l of linhas) {
        assert.deepEqual(Object.keys(l).sort(), [
          'canceladaEm', 'criadaEm', 'decididaEm', ...(comEncerramento ? ['encerradaEm'] : []), 'entregueEm', 'funcionarioId', 'id', 'numero', 'quantidadeItens',
          'solicitanteUsuarioId', 'status', 'trabalhador',
        ]);
        assert.deepEqual(Object.keys(l.trabalhador).sort(), ['ativo', 'matricula', 'nome']);
      }
    });

    test(`${nome}: sem resultado devolve lista vazia`, async () => {
      assert.deepEqual(await chamar(executorFalso([])), []);
    });
  }

  test('a solicitação de autoatendimento (sem solicitante interno) mantém solicitanteUsuarioId nulo', async () => {
    const executor = executorFalso([linha({ solicitante_usuario_id: null })]);
    const [l] = await funcao('listarFila')(executor, EMPRESA, { pagina: 1, limite: 20 });
    assert.equal(l.solicitanteUsuarioId, null);
  });
});

describe('contagens — mapeamento', () => {
  for (const [nome, chamar] of CONTAGENS) {
    test(`${nome}: devolve o total como número`, async () => {
      assert.equal(await chamar(executorFalso([{ total: 7 }])), 7);
      assert.equal(await chamar(executorFalso([{ total: '12' }])), 12);
    });
  }
});

describe('parâmetros', () => {
  test('listarMinhas: empresa, solicitante, status opcional, limite e deslocamento', async () => {
    const executor = executorFalso([], []);
    await funcao('listarMinhas')(executor, EMPRESA, USUARIO, { pagina: 3, limite: 20 });
    await funcao('listarMinhas')(executor, EMPRESA, USUARIO, { status: 'APROVADA', pagina: 1, limite: 5 });
    assert.deepEqual(executor.chamadas[0].valores, [EMPRESA, USUARIO, null, 20, 40]);
    assert.deepEqual(executor.chamadas[1].valores, [EMPRESA, USUARIO, 'APROVADA', 5, 0]);
  });

  test('contarMinhas: os mesmos filtros da lista, sem paginação', async () => {
    const executor = executorFalso([{ total: 0 }], [{ total: 0 }]);
    await funcao('contarMinhas')(executor, EMPRESA, USUARIO, {});
    await funcao('contarMinhas')(executor, EMPRESA, USUARIO, { status: 'ENTREGUE' });
    assert.deepEqual(executor.chamadas[0].valores, [EMPRESA, USUARIO, null]);
    assert.deepEqual(executor.chamadas[1].valores, [EMPRESA, USUARIO, 'ENTREGUE']);
  });

  test('listarFila e contarFila: só a empresa e a paginação', async () => {
    const executor = executorFalso([], [{ total: 0 }]);
    await funcao('listarFila')(executor, EMPRESA, { pagina: 2, limite: 10 });
    await funcao('contarFila')(executor, EMPRESA);
    assert.deepEqual(executor.chamadas[0].valores, [EMPRESA, 10, 10]);
    assert.deepEqual(executor.chamadas[1].valores, [EMPRESA]);
  });

  test('listarEntregaveis e contarEntregaveis: trabalhador opcional', async () => {
    const executor = executorFalso([], [], [{ total: 0 }], [{ total: 0 }]);
    await funcao('listarEntregaveis')(executor, EMPRESA, { pagina: 1, limite: 20 });
    await funcao('listarEntregaveis')(executor, EMPRESA, { funcionarioId: 5, pagina: 2, limite: 20 });
    await funcao('contarEntregaveis')(executor, EMPRESA, {});
    await funcao('contarEntregaveis')(executor, EMPRESA, { funcionarioId: 5 });
    assert.deepEqual(executor.chamadas.map((c) => c.valores), [
      [EMPRESA, null, 20, 0],
      [EMPRESA, 5, 20, 20],
      [EMPRESA, null],
      [EMPRESA, 5],
    ]);
  });
});

describe('SQL', () => {
  const consultas = [
    ['listarMinhas', async () => { const e = executorFalso([]); await funcao('listarMinhas')(e, EMPRESA, USUARIO, { pagina: 1, limite: 20 }); return e.chamadas[0].texto; }],
    ['contarMinhas', async () => { const e = executorFalso([{ total: 0 }]); await funcao('contarMinhas')(e, EMPRESA, USUARIO, {}); return e.chamadas[0].texto; }],
    ['listarFila', async () => { const e = executorFalso([]); await funcao('listarFila')(e, EMPRESA, { pagina: 1, limite: 20 }); return e.chamadas[0].texto; }],
    ['contarFila', async () => { const e = executorFalso([{ total: 0 }]); await funcao('contarFila')(e, EMPRESA); return e.chamadas[0].texto; }],
    ['listarEntregaveis', async () => { const e = executorFalso([]); await funcao('listarEntregaveis')(e, EMPRESA, { pagina: 1, limite: 20 }); return e.chamadas[0].texto; }],
    ['contarEntregaveis', async () => { const e = executorFalso([{ total: 0 }]); await funcao('contarEntregaveis')(e, EMPRESA, {}); return e.chamadas[0].texto; }],
  ];

  for (const [nome, texto] of consultas) {
    test(`${nome}: leitura pura, filtrada pela empresa, sem CPF nem texto livre`, async () => {
      const sql = await texto();
      assert.match(sql, /^\s*SELECT\b/);
      assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
      assert.doesNotMatch(sql, /\bFOR\s+(NO KEY\s+)?(UPDATE|SHARE)\b/i);
      assert.match(sql, /s\.empresa_id = \$1/);
      assert.doesNotMatch(sql, /cpf/i);
      assert.doesNotMatch(sql, /observacao|justificativa|chave_idempotencia|requisicao_hash/i);
    });
  }

  for (const nome of ['listarMinhas', 'listarFila', 'listarEntregaveis']) {
    test(`${nome}: o trabalhador é ligado pela chave composta da empresa`, async () => {
      const e = executorFalso([]);
      if (nome === 'listarMinhas') await funcao(nome)(e, EMPRESA, USUARIO, { pagina: 1, limite: 20 });
      else await funcao(nome)(e, EMPRESA, { pagina: 1, limite: 20 });
      assert.match(e.chamadas[0].texto, /JOIN funcionarios f ON f\.empresa_id = s\.empresa_id AND f\.id = s\.funcionario_id/);
    });
  }

  test('minhas: do solicitante interno, das mais recentes para as antigas, com desempate por id', async () => {
    const e = executorFalso([]);
    await funcao('listarMinhas')(e, EMPRESA, USUARIO, { pagina: 1, limite: 20 });
    const sql = e.chamadas[0].texto;
    assert.match(sql, /s\.solicitante_usuario_id = \$2/);
    assert.match(sql, /\$3::text IS NULL OR s\.status = \$3::text/);
    assert.match(sql, /ORDER BY s\.criada_em DESC, s\.id DESC\s+LIMIT \$4 OFFSET \$5/);
  });

  test('a data do encerramento (12F-1) só é lida em "minhas"; a fila e os entregáveis não a selecionam; a justificativa não é lida em nenhuma', async () => {
    const minhas = executorFalso([]);
    await funcao('listarMinhas')(minhas, EMPRESA, USUARIO, { pagina: 1, limite: 20 });
    assert.match(minhas.chamadas[0].texto, /s\.encerrada_em/);
    for (const [nome, chamar] of LISTAGENS.filter(([n]) => n !== 'listarMinhas')) {
      const e = executorFalso([]);
      await chamar(e);
      assert.doesNotMatch(e.chamadas[0].texto, /encerrada/, nome);
    }
    for (const [nome, chamar] of LISTAGENS) {
      const e = executorFalso([]);
      await chamar(e);
      assert.doesNotMatch(e.chamadas[0].texto, /justificativa_encerramento|encerrada_por/, nome);
    }
  });

  test('fila: só PENDENTE, da mais antiga para a mais nova, com desempate por id (o predicado literal casa com o índice parcial)', async () => {
    const e = executorFalso([]);
    await funcao('listarFila')(e, EMPRESA, { pagina: 1, limite: 20 });
    const sql = e.chamadas[0].texto;
    assert.match(sql, /s\.status = 'PENDENTE'/);
    assert.match(sql, /ORDER BY s\.criada_em, s\.id\s+LIMIT \$2 OFFSET \$3/);
  });

  test('entregáveis: só APROVADA e APROVADA_PARCIAL (predicado literal do índice parcial), na ordem da fila de cobertura', async () => {
    const e = executorFalso([]);
    await funcao('listarEntregaveis')(e, EMPRESA, { pagina: 1, limite: 20 });
    const sql = e.chamadas[0].texto;
    assert.match(sql, /s\.status IN \('APROVADA', 'APROVADA_PARCIAL'\)/);
    assert.match(sql, /\$2::int IS NULL OR s\.funcionario_id = \$2::int/);
    assert.match(sql, /ORDER BY s\.decidida_em, s\.id\s+LIMIT \$3 OFFSET \$4/);
  });

  test('as contagens usam o mesmo filtro da lista', async () => {
    const minhas = executorFalso([{ total: 0 }]);
    await funcao('contarMinhas')(minhas, EMPRESA, USUARIO, {});
    assert.match(minhas.chamadas[0].texto, /s\.solicitante_usuario_id = \$2/);
    assert.match(minhas.chamadas[0].texto, /\$3::text IS NULL OR s\.status = \$3::text/);
    const fila = executorFalso([{ total: 0 }]);
    await funcao('contarFila')(fila, EMPRESA);
    assert.match(fila.chamadas[0].texto, /s\.status = 'PENDENTE'/);
    const entregaveis = executorFalso([{ total: 0 }]);
    await funcao('contarEntregaveis')(entregaveis, EMPRESA, {});
    assert.match(entregaveis.chamadas[0].texto, /s\.status IN \('APROVADA', 'APROVADA_PARCIAL'\)/);
    assert.match(entregaveis.chamadas[0].texto, /\$2::int IS NULL OR s\.funcionario_id = \$2::int/);
  });
});

describe('validação — recusa sem consultar', () => {
  test('empresa, solicitante, trabalhador, status, página e limite inválidos', async () => {
    const vazio = executorFalso();
    const minhas = (empresa, usuario, opcoes) => funcao('listarMinhas')(vazio, empresa, usuario, opcoes);
    await assert.rejects(() => minhas(0, USUARIO, { pagina: 1, limite: 20 }), /empresa/);
    await assert.rejects(() => minhas(EMPRESA, '7', { pagina: 1, limite: 20 }), /solicitante/);
    await assert.rejects(() => minhas(EMPRESA, USUARIO, { status: 'ABERTA', pagina: 1, limite: 20 }), /status/);
    await assert.rejects(() => minhas(EMPRESA, USUARIO, { status: '', pagina: 1, limite: 20 }), /status/);
    await assert.rejects(() => funcao('contarMinhas')(vazio, EMPRESA, USUARIO, { status: 'ABERTA' }), /status/);
    await assert.rejects(() => funcao('listarEntregaveis')(vazio, EMPRESA, { funcionarioId: 0, pagina: 1, limite: 20 }), /funcionário/);
    await assert.rejects(() => funcao('contarEntregaveis')(vazio, EMPRESA, { funcionarioId: '5' }), /funcionário/);
    for (const [, chamar] of LISTAGENS) {
      for (const pagina of [0, -1, 1.5, '1', undefined]) {
        await assert.rejects(() => chamar(vazio, { pagina }), /página/, `página ${String(pagina)}`);
      }
      for (const limite of [0, -1, 101, 1.5, '20', undefined]) {
        await assert.rejects(() => chamar(vazio, { limite }), /limite/, `limite ${String(limite)}`);
      }
    }
    assert.equal(vazio.chamadas.length, 0);
  });

  test('empresa inválida em cada função', async () => {
    const vazio = executorFalso();
    await assert.rejects(() => funcao('listarFila')(vazio, -1, { pagina: 1, limite: 20 }), /empresa/);
    await assert.rejects(() => funcao('contarFila')(vazio, 1.5), /empresa/);
    await assert.rejects(() => funcao('listarEntregaveis')(vazio, null, { pagina: 1, limite: 20 }), /empresa/);
    await assert.rejects(() => funcao('contarEntregaveis')(vazio, 0, {}), /empresa/);
    await assert.rejects(() => funcao('contarMinhas')(vazio, 'a', USUARIO, {}), /empresa/);
    assert.equal(vazio.chamadas.length, 0);
  });
});
