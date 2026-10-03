'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * Serviço das listagens da solicitação de EPI (12E-1), sem PostgreSQL: a
 * validação recusa antes de abrir transação, a leitura roda num retrato único
 * do banco e a montagem das linhas (situação derivada e quantidades) usa só o
 * que os repositórios devolvem. O conteúdo contra o banco real, o isolamento
 * entre empresas e a coerência com o detalhe são provados em
 * test/integracao/solicitacao-epi-consultas.integration.js.
 */

const servico = () => exigirModulo('src/services/solicitacao-epi-consulta.service');
const funcao = (nome) => {
  const modulo = servico();
  assert.equal(typeof modulo[nome], 'function', `função ainda não implementada: ${nome}`);
  return modulo[nome];
};
const consultaRepo = () => exigirModulo('src/repositories/solicitacao-epi-consulta.repository');
const itemRepo = () => exigirModulo('src/repositories/solicitacao-epi-item.repository');
const coberturaRepo = () => exigirModulo('src/repositories/solicitacao-epi-cobertura.repository');

const EMPRESA = 42;
const ATOR = 7;
const HOJE = '2026-10-03';
const CRIADA = new Date('2026-10-02T12:00:00Z');
const DECIDIDA = new Date('2026-10-02T13:00:00Z');

const poolFechado = { connect: async () => { throw new Error('não deve abrir transação'); }, query: async () => { throw new Error('não deve consultar'); } };

function poolFalso() {
  const comandos = [];
  const estado = { liberados: 0 };
  const client = {
    query: async (texto) => { comandos.push(texto); return { rows: [] }; },
    release: () => { estado.liberados += 1; },
  };
  return { comandos, estado, client, connect: async () => client };
}

const linha = (extra = {}) => ({
  id: 17,
  numero: 5,
  status: 'PENDENTE',
  solicitanteUsuarioId: ATOR,
  funcionarioId: 30,
  quantidadeItens: 1,
  criadaEm: CRIADA,
  decididaEm: null,
  canceladaEm: null,
  entregueEm: null,
  trabalhador: { nome: 'Trabalhador Fictício', matricula: 'T-1', ativo: true },
  ...extra,
});
const itemDe = (extra = {}) => ({
  id: 1, solicitacaoId: 17, materialId: 3, tamanho: '40', quantidade: 4, decisao: null, quantidadeAprovada: null, quantidadeEntregue: 0, ...extra,
});

describe('validação antes de qualquer acesso ao banco', () => {
  const dadosMinhas = (extra = {}) => ({ empresaId: EMPRESA, atorId: ATOR, pagina: 1, limite: 20, hoje: HOJE, ...extra });
  const dadosFila = (extra = {}) => ({ empresaId: EMPRESA, pagina: 1, limite: 20, ...extra });
  const dadosEntregaveis = (extra = {}) => ({ empresaId: EMPRESA, pagina: 1, limite: 20, hoje: HOJE, ...extra });

  test('listarMinhas: empresa e ator da sessão, status, página, limite e data válidos', async () => {
    const f = funcao('listarMinhas');
    for (const extra of [
      { empresaId: 0 }, { atorId: -1 }, { atorId: '7' }, { status: 'ABERTA' }, { status: '' }, { pagina: 0 }, { pagina: 1.5 }, { limite: 0 }, { limite: 101 }, { hoje: '2026-02-30' },
    ]) {
      await assert.rejects(f(poolFechado, dadosMinhas(extra)), TypeError, JSON.stringify(extra));
    }
    await assert.rejects(f(poolFechado, dadosMinhas()), /não deve abrir transação/);
    await assert.rejects(f(poolFechado, dadosMinhas({ status: 'ENTREGUE' })), /não deve abrir transação/);
    await assert.rejects(f(poolFechado, dadosMinhas({ hoje: undefined })), /não deve abrir transação/);
  });

  test('listarFila: empresa, página e limite válidos', async () => {
    const f = funcao('listarFila');
    for (const extra of [{ empresaId: 0 }, { empresaId: '42' }, { pagina: 0 }, { pagina: '1' }, { limite: 101 }, { limite: undefined }]) {
      await assert.rejects(f(poolFechado, dadosFila(extra)), TypeError, JSON.stringify(extra));
    }
    await assert.rejects(f(poolFechado, dadosFila()), /não deve abrir transação/);
  });

  test('listarEntregaveis: empresa, trabalhador opcional, página, limite e data válidos', async () => {
    const f = funcao('listarEntregaveis');
    for (const extra of [{ empresaId: 0 }, { funcionarioId: 0 }, { funcionarioId: '5' }, { pagina: -1 }, { limite: 101 }, { hoje: 'ontem' }]) {
      await assert.rejects(f(poolFechado, dadosEntregaveis(extra)), TypeError, JSON.stringify(extra));
    }
    await assert.rejects(f(poolFechado, dadosEntregaveis()), /não deve abrir transação/);
    await assert.rejects(f(poolFechado, dadosEntregaveis({ funcionarioId: 5 })), /não deve abrir transação/);
  });
});

describe('leitura em retrato único e montagem das linhas', () => {
  function simular(t, { minhas = [], fila = [], entregaveis = [], total = 0, itens = [], cobertura = [] } = {}) {
    const chamadas = { itens: [], cobertura: [], listas: [], contagens: [] };
    t.mock.method(consultaRepo(), 'listarMinhas', async (...args) => { chamadas.listas.push(['minhas', ...args]); return minhas; });
    t.mock.method(consultaRepo(), 'contarMinhas', async (...args) => { chamadas.contagens.push(['minhas', ...args]); return total; });
    t.mock.method(consultaRepo(), 'listarFila', async (...args) => { chamadas.listas.push(['fila', ...args]); return fila; });
    t.mock.method(consultaRepo(), 'contarFila', async (...args) => { chamadas.contagens.push(['fila', ...args]); return total; });
    t.mock.method(consultaRepo(), 'listarEntregaveis', async (...args) => { chamadas.listas.push(['entregaveis', ...args]); return entregaveis; });
    t.mock.method(consultaRepo(), 'contarEntregaveis', async (...args) => { chamadas.contagens.push(['entregaveis', ...args]); return total; });
    t.mock.method(itemRepo(), 'listarPorSolicitacoesComEntregue', async (...args) => { chamadas.itens.push(args); return itens; });
    t.mock.method(coberturaRepo(), 'listarCoberturaDasSolicitacoes', async (...args) => { chamadas.cobertura.push(args); return cobertura; });
    return chamadas;
  }

  test('roda em transação somente leitura de retrato único e libera a conexão', async (t) => {
    const pool = poolFalso();
    simular(t, { minhas: [linha()], total: 1, itens: [itemDe()] });
    await funcao('listarMinhas')(pool, { empresaId: EMPRESA, atorId: ATOR, pagina: 1, limite: 20, hoje: HOJE });
    assert.equal(pool.comandos[0], 'BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ');
    assert.equal(pool.comandos[pool.comandos.length - 1], 'COMMIT');
    assert.equal(pool.estado.liberados, 1);
  });

  test('o erro reverte e libera a conexão', async (t) => {
    const pool = poolFalso();
    t.mock.method(consultaRepo(), 'listarFila', async () => { throw new Error('falha de teste'); });
    await assert.rejects(funcao('listarFila')(pool, { empresaId: EMPRESA, pagina: 1, limite: 20 }), /falha de teste/);
    assert.equal(pool.comandos[pool.comandos.length - 1], 'ROLLBACK');
    assert.equal(pool.estado.liberados, 1);
  });

  test('os repositórios recebem a empresa e o ator da sessão; a resposta leva total, página e limite', async (t) => {
    const pool = poolFalso();
    const chamadas = simular(t, { minhas: [linha()], total: 41, itens: [itemDe()] });
    const resposta = await funcao('listarMinhas')(pool, {
      empresaId: EMPRESA, atorId: ATOR, status: 'PENDENTE', pagina: 3, limite: 20, hoje: HOJE,
    });
    assert.deepEqual(chamadas.listas[0].slice(1), [pool.client, EMPRESA, ATOR, { status: 'PENDENTE', pagina: 3, limite: 20 }]);
    assert.deepEqual(chamadas.contagens[0].slice(1), [pool.client, EMPRESA, ATOR, { status: 'PENDENTE' }]);
    assert.deepEqual([resposta.total, resposta.pagina, resposta.limite], [41, 3, 20]);
    assert.equal(resposta.solicitacoes.length, 1);
  });

  test('página vazia: devolve só o total, sem buscar itens nem cobertura', async (t) => {
    const pool = poolFalso();
    const chamadas = simular(t, { minhas: [], total: 3 });
    const resposta = await funcao('listarMinhas')(pool, { empresaId: EMPRESA, atorId: ATOR, pagina: 9, limite: 20, hoje: HOJE });
    assert.deepEqual(resposta, { solicitacoes: [], total: 3, pagina: 9, limite: 20 });
    assert.equal(chamadas.itens.length, 0);
    assert.equal(chamadas.cobertura.length, 0);
  });

  test('a fila e as pendentes não pedem cobertura; os itens vêm numa consulta só para a página inteira', async (t) => {
    const pool = poolFalso();
    const chamadas = simular(t, {
      fila: [linha({ id: 17 }), linha({ id: 18, numero: 6 })],
      total: 2,
      itens: [itemDe({ id: 1, solicitacaoId: 17, quantidade: 4 }), itemDe({ id: 2, solicitacaoId: 18, quantidade: 1 })],
    });
    const resposta = await funcao('listarFila')(pool, { empresaId: EMPRESA, pagina: 1, limite: 20 });
    assert.equal(chamadas.cobertura.length, 0);
    assert.equal(chamadas.itens.length, 1);
    assert.deepEqual(chamadas.itens[0].slice(1), [EMPRESA, [17, 18]]);
    assert.deepEqual(resposta.solicitacoes.map((s) => [s.id, s.status, s.situacaoOperacional, s.quantidades]), [
      [17, 'PENDENTE', null, { solicitada: 4, aprovada: null, entregue: null, restante: null }],
      [18, 'PENDENTE', null, { solicitada: 1, aprovada: null, entregue: null, restante: null }],
    ]);
  });

  test('a cobertura é pedida numa consulta só, apenas para as solicitações aprovadas da página, com a data operacional', async (t) => {
    const pool = poolFalso();
    const chamadas = simular(t, {
      minhas: [
        linha({ id: 17, status: 'PENDENTE' }),
        linha({ id: 18, status: 'APROVADA', decididaEm: DECIDIDA }),
        linha({ id: 19, status: 'ENTREGUE', decididaEm: DECIDIDA }),
        linha({ id: 20, status: 'APROVADA_PARCIAL', decididaEm: DECIDIDA }),
      ],
      total: 4,
      itens: [
        itemDe({ id: 1, solicitacaoId: 17 }),
        itemDe({ id: 2, solicitacaoId: 18, decisao: 'APROVADO', quantidadeAprovada: 4 }),
        itemDe({ id: 3, solicitacaoId: 19, decisao: 'APROVADO', quantidadeAprovada: 4, quantidadeEntregue: 4 }),
        itemDe({ id: 4, solicitacaoId: 20, decisao: 'APROVADO', quantidadeAprovada: 4 }),
      ],
      cobertura: [
        { itemId: 2, solicitacaoId: 18, coberta: 4 },
        { itemId: 4, solicitacaoId: 20, coberta: 1 },
      ],
    });
    await funcao('listarMinhas')(pool, { empresaId: EMPRESA, atorId: ATOR, pagina: 1, limite: 20, hoje: HOJE });
    assert.equal(chamadas.cobertura.length, 1);
    assert.deepEqual(chamadas.cobertura[0].slice(1), [EMPRESA, { hoje: HOJE, solicitacaoIds: [18, 20] }]);
  });

  test('situação derivada e quantidades por solicitação: pronta, parcialmente entregue, suspensa e entregue', async (t) => {
    const pool = poolFalso();
    simular(t, {
      entregaveis: [
        linha({ id: 18, status: 'APROVADA', decididaEm: DECIDIDA }),
        linha({ id: 20, status: 'APROVADA_PARCIAL', decididaEm: DECIDIDA }),
        linha({ id: 21, status: 'APROVADA', decididaEm: DECIDIDA, trabalhador: { nome: 'Inativo Fictício', matricula: 'T-9', ativo: false } }),
      ],
      total: 3,
      itens: [
        itemDe({ id: 2, solicitacaoId: 18, quantidade: 5, decisao: 'APROVADO', quantidadeAprovada: 4 }),
        itemDe({ id: 4, solicitacaoId: 20, quantidade: 5, decisao: 'APROVADO', quantidadeAprovada: 4, quantidadeEntregue: 1 }),
        itemDe({ id: 5, solicitacaoId: 20, materialId: 4, quantidade: 2, decisao: 'REPROVADO', quantidadeAprovada: 0 }),
        itemDe({ id: 6, solicitacaoId: 21, quantidade: 3, decisao: 'APROVADO', quantidadeAprovada: 3 }),
      ],
      cobertura: [
        { itemId: 2, solicitacaoId: 18, coberta: 4 },
        { itemId: 4, solicitacaoId: 20, coberta: 1 },
      ],
    });
    const { solicitacoes } = await funcao('listarEntregaveis')(pool, { empresaId: EMPRESA, pagina: 1, limite: 20, hoje: HOJE });
    assert.deepEqual(solicitacoes.map((s) => [s.id, s.situacaoOperacional, s.quantidades]), [
      [18, 'PRONTA_PARA_ENTREGA', { solicitada: 5, aprovada: 4, entregue: 0, restante: 4 }],
      [20, 'PARCIALMENTE_ENTREGUE', { solicitada: 7, aprovada: 4, entregue: 1, restante: 3 }],
      [21, 'SUSPENSA', { solicitada: 3, aprovada: 3, entregue: 0, restante: 3 }],
    ]);
    assert.deepEqual(solicitacoes[2].funcionario, { id: 30, nome: 'Inativo Fictício', matricula: 'T-9', ativo: false });
  });

  test('o filtro por trabalhador segue para o repositório; a lista pedida vem na ordem do repositório', async (t) => {
    const pool = poolFalso();
    const chamadas = simular(t, {
      entregaveis: [linha({ id: 30, status: 'APROVADA', decididaEm: DECIDIDA }), linha({ id: 18, status: 'APROVADA', decididaEm: DECIDIDA })],
      total: 2,
      itens: [
        itemDe({ id: 8, solicitacaoId: 30, decisao: 'APROVADO', quantidadeAprovada: 1 }),
        itemDe({ id: 2, solicitacaoId: 18, decisao: 'APROVADO', quantidadeAprovada: 1 }),
      ],
      cobertura: [{ itemId: 8, solicitacaoId: 30, coberta: 1 }, { itemId: 2, solicitacaoId: 18, coberta: 0 }],
    });
    const { solicitacoes } = await funcao('listarEntregaveis')(pool, {
      empresaId: EMPRESA, funcionarioId: 30, pagina: 2, limite: 10, hoje: HOJE,
    });
    assert.deepEqual(chamadas.listas[0].slice(1), [pool.client, EMPRESA, { funcionarioId: 30, pagina: 2, limite: 10 }]);
    assert.deepEqual(chamadas.contagens[0].slice(1), [pool.client, EMPRESA, { funcionarioId: 30 }]);
    assert.deepEqual(solicitacoes.map((s) => [s.id, s.situacaoOperacional]), [[30, 'PRONTA_PARA_ENTREGA'], [18, 'AGUARDANDO_ESTOQUE']]);
  });

  test('"minhas" publica a data do encerramento (12F-1); a fila e os entregáveis não têm a chave', async (t) => {
    const ENCERRADA_EM = new Date('2026-10-03T18:00:00Z');
    simular(t, {
      minhas: [linha({ id: 17, status: 'ENCERRADA', decididaEm: DECIDIDA, encerradaEm: ENCERRADA_EM }), linha({ id: 18, encerradaEm: null })],
      fila: [linha({ id: 19 })],
      entregaveis: [linha({ id: 20, status: 'APROVADA', decididaEm: DECIDIDA })],
      total: 2,
      itens: [
        itemDe({ id: 1, solicitacaoId: 17, decisao: 'APROVADO', quantidadeAprovada: 4, quantidadeEntregue: 1 }),
        itemDe({ id: 2, solicitacaoId: 18 }), itemDe({ id: 3, solicitacaoId: 19 }), itemDe({ id: 4, solicitacaoId: 20, decisao: 'APROVADO', quantidadeAprovada: 4 }),
      ],
      cobertura: [{ itemId: 4, solicitacaoId: 20, coberta: 0 }],
    });
    const minhas = await funcao('listarMinhas')(poolFalso(), { empresaId: EMPRESA, atorId: ATOR, pagina: 1, limite: 20, hoje: HOJE });
    assert.deepEqual(minhas.solicitacoes.map((s) => [s.id, s.encerradaEm, s.situacaoOperacional, s.quantidades.restante]), [[17, ENCERRADA_EM, null, 0], [18, null, null, null]]);
    const fila = await funcao('listarFila')(poolFalso(), { empresaId: EMPRESA, pagina: 1, limite: 20 });
    const entregaveis = await funcao('listarEntregaveis')(poolFalso(), { empresaId: EMPRESA, pagina: 1, limite: 20, hoje: HOJE });
    for (const s of [...fila.solicitacoes, ...entregaveis.solicitacoes]) assert.equal('encerradaEm' in s, false, String(s.id));
  });
});

describe('buscarDetalhe — quem vê o detalhe (12F-1)', () => {
  const autorizacao = () => require('../../src/middleware/autorizacao');
  const solicitacaoSvc = () => require('../../src/services/solicitacao-epi.service');
  const dados = (extra = {}) => ({ empresaId: EMPRESA, usuarioId: ATOR, perfil: 'USUARIO', solicitacaoId: 17, hoje: HOJE, ...extra });
  const visao = () => ({
    solicitacao: { id: 17, status: 'APROVADA', solicitanteUsuarioId: ATOR, encerramento: null, situacaoOperacional: 'PARCIALMENTE_COBERTA' },
    itens: [
      {
        id: 1, quantidade: 5, decisao: 'APROVADO', quantidadeAprovada: 4, quantidadeEntregue: 1, quantidadePendente: 3, situacao: 'PARCIALMENTE_COBERTA',
        cobertura: { coberta: 1, semCobertura: 2, acumuladoAnterior: 0, fisicoUtilizavel: 1 },
        posicao: { fisicoUtilizavel: 1, demandaPendente: 3, comprometido: 1, saldoLivre: 0, semCobertura: 2 },
      },
      {
        id: 2, quantidade: 2, decisao: 'REPROVADO', quantidadeAprovada: 0, quantidadeEntregue: 0, quantidadePendente: null, situacao: null, cobertura: null, posicao: null,
      },
    ],
  });

  function simular(t, { acoes = [], visualizar = false, resultado = visao() } = {}) {
    const avaliadas = { acoes: [], recursos: [] };
    const leituras = [];
    t.mock.method(autorizacao(), 'avaliarPermissaoAcao', async (pool, contexto, acao) => { avaliadas.acoes.push([contexto, acao]); return acoes.includes(acao); });
    t.mock.method(autorizacao(), 'avaliarPermissaoRecurso', async (pool, contexto, recurso) => {
      avaliadas.recursos.push([contexto, recurso]);
      return {
        visualizar, criar: false, editar: false, excluir: false,
      };
    });
    t.mock.method(solicitacaoSvc(), 'buscarSolicitacao', async (pool, filtro) => { leituras.push(filtro); return resultado; });
    return { avaliadas, leituras };
  }

  test('validação antes de qualquer consulta: empresa, usuário, perfil e solicitação da sessão e da rota', async (t) => {
    const { avaliadas, leituras } = simular(t);
    for (const extra of [{ empresaId: 0 }, { usuarioId: -1 }, { usuarioId: '9' }, { perfil: '' }, { perfil: undefined }, { solicitacaoId: 1.5 }, { hoje: '2026-02-30' }]) {
      await assert.rejects(funcao('buscarDetalhe')(poolFalso(), dados(extra)), TypeError, JSON.stringify(extra));
    }
    assert.deepEqual([avaliadas.acoes.length, avaliadas.recursos.length, leituras.length], [0, 0, 0]);
  });

  for (const acao of ['APROVAR_SOLICITACAO', 'REPROVAR_SOLICITACAO', 'ENCERRAR_SOLICITACAO', 'REALIZAR_ENTREGA']) {
    test(`autoridade funcional por ${acao}: qualquer solicitação da empresa, com cobertura e posição; o recurso não é consultado`, async (t) => {
      const { avaliadas, leituras } = simular(t, { acoes: [acao] });
      const detalhe = await funcao('buscarDetalhe')(poolFalso(), dados());
      assert.deepEqual(leituras, [{
        empresaId: EMPRESA, solicitacaoId: 17, hoje: HOJE, solicitanteUsuarioId: null,
      }]);
      assert.equal(avaliadas.recursos.length, 0);
      assert.deepEqual(avaliadas.acoes.map(([contexto]) => contexto), avaliadas.acoes.map(() => ({ empresaId: EMPRESA, usuarioId: ATOR, perfil: 'USUARIO' })));
      assert.equal(avaliadas.acoes.at(-1)[1], acao, 'para na primeira ação concedida');
      assert.deepEqual(detalhe.itens[0].cobertura, visao().itens[0].cobertura);
      assert.deepEqual(detalhe.itens[0].posicao, visao().itens[0].posicao);
    });
  }

  test('só o recurso `request` (sem autoridade funcional): só as próprias, e sem cobertura nem posição do estoque', async (t) => {
    const { avaliadas, leituras } = simular(t, { visualizar: true });
    const detalhe = await funcao('buscarDetalhe')(poolFalso(), dados());
    assert.deepEqual(avaliadas.acoes.map(([, a]) => a), ['APROVAR_SOLICITACAO', 'REPROVAR_SOLICITACAO', 'ENCERRAR_SOLICITACAO', 'REALIZAR_ENTREGA']);
    assert.deepEqual(avaliadas.recursos, [[{ empresaId: EMPRESA, usuarioId: ATOR, perfil: 'USUARIO' }, 'request']]);
    assert.deepEqual(leituras, [{
      empresaId: EMPRESA, solicitacaoId: 17, hoje: HOJE, solicitanteUsuarioId: ATOR,
    }]);
    for (const item of detalhe.itens) {
      assert.equal('cobertura' in item, false);
      assert.equal('posicao' in item, false);
    }
    assert.deepEqual(detalhe.itens.map((i) => [i.id, i.quantidadeEntregue, i.quantidadePendente, i.situacao]), [[1, 1, 3, 'PARCIALMENTE_COBERTA'], [2, 0, null, null]]);
  });

  test('sem autoridade funcional e sem o recurso: 403 PERMISSAO_NEGADA, a mesma resposta do middleware, antes de ler a solicitação', async (t) => {
    const { leituras } = simular(t);
    await assert.rejects(funcao('buscarDetalhe')(poolFalso(), dados()), (erro) => {
      assert.deepEqual([erro.status, erro.codigo, erro.message], [403, 'PERMISSAO_NEGADA', autorizacao().MENSAGEM_PERMISSAO_NEGADA]);
      return true;
    });
    assert.equal(leituras.length, 0);
  });

  test('as quantidades da solicitação vêm da mesma derivação das listas: solicitada, aprovada, entregue e restante', async (t) => {
    simular(t, { acoes: ['APROVAR_SOLICITACAO'] });
    const detalhe = await funcao('buscarDetalhe')(poolFalso(), dados());
    assert.deepEqual(detalhe.solicitacao.quantidades, {
      solicitada: 7, aprovada: 4, entregue: 1, restante: 3,
    });
    assert.equal(detalhe.solicitacao.situacaoOperacional, 'PARCIALMENTE_COBERTA');
  });

  test('o "não encontrada" do serviço sobe intacto', async (t) => {
    simular(t, { visualizar: true });
    const erro = Object.assign(new Error('Solicitação não encontrada'), { status: 404, codigo: 'SOLICITACAO_NAO_ENCONTRADA' });
    solicitacaoSvc().buscarSolicitacao.mock.mockImplementation(async () => { throw erro; });
    await assert.rejects(funcao('buscarDetalhe')(poolFalso(), dados()), erro);
  });
});
