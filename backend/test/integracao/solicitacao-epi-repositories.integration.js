'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { abrirPoolTemporario, aguardarEsperaPeloLock } = require('./helpers/schema-temporario');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { HASH, todasAsMigrations, erroDe, transacao } = require('./helpers/entrega-epi');
const { montarCenario } = require('./helpers/solicitacao-epi');

/**
 * Repositórios da solicitação de EPI contra PostgreSQL real, usados como o
 * serviço da 12B vai usá-los: trava da chave, número, cabeçalho e itens na
 * mesma transação; trava da solicitação, decisão de todos os itens e do
 * cabeçalho no mesmo ato; cancelamento. Provo também o isolamento entre
 * empresas e as corridas que a trava da linha resolve.
 */

const VIOLACAO_FK = '23503';
const VIOLACAO_UNIQUE = '23505';
const VIOLACAO_CHECK = '23514';
const COERENCIA = 'trg_solicitacoes_epi_coerencia_decisao';
const ESPERA_MAXIMA_MS = 3000;

const sol = () => exigirModulo('src/repositories/solicitacao-epi.repository');
const itemRepo = () => exigirModulo('src/repositories/solicitacao-epi-item.repository');
const numeracao = () => exigirModulo('src/repositories/solicitacao-epi-numeracao.repository');

const comLimite = (promessa, rotulo) => Promise.race([
  promessa,
  new Promise((_, rejeitar) => { setTimeout(() => rejeitar(new Error(`${rotulo}: não resolveu em ${ESPERA_MAXIMA_MS} ms`)), ESPERA_MAXIMA_MS); }),
]);

describe('repositórios da solicitação de EPI — PostgreSQL real', () => {
  let contexto;
  let d;

  const pool = () => contexto.pool;
  const par = (erro) => [erro?.code, erro?.constraint];

  before(async () => {
    contexto = await abrirPoolTemporario(todasAsMigrations());
    d = await montarCenario(contexto.pool);
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  const pedido = (extra = {}) => ({ materialId: d.botina, tamanho: '40', quantidade: 2, motivo: 'ADMISSAO', previstoNoGhe: true, ...extra });

  // O fluxo de criação da 12B: chave, número, cabeçalho e itens na mesma transação.
  async function criar({
    empresaId = d.empresaA, funcionarioId = d.trabalhadorA, solicitanteId = d.solicitante, origem = 'USUARIO_INTERNO',
    itens = [pedido()], chave = crypto.randomUUID(), gheId = null, observacao = null,
  } = {}) {
    return transacao(pool(), async (c) => {
      await sol().travarChave(c, empresaId, chave);
      const numero = await numeracao().proximoNumero(c, empresaId);
      const solicitacao = await sol().criar(c, {
        empresaId, numero, funcionarioId, gheId, origemSolicitacao: origem,
        solicitanteUsuarioId: origem === 'USUARIO_INTERNO' ? solicitanteId : null,
        quantidadeItens: itens.length, observacao, chave, requisicaoHash: HASH,
      });
      const criados = [];
      for (const item of itens) criados.push(await itemRepo().criar(c, { empresaId, solicitacaoId: solicitacao.id, ...item }));
      return { solicitacao, itens: criados };
    });
  }

  const aprovarItem = (item, quantidadeAprovada = item.quantidade, justificativa = null) => ({
    itemId: item.id, decisao: 'APROVADO', quantidadeAprovada, justificativa,
  });
  const reprovarItem = (item, justificativa = 'Sem necessidade comprovada') => ({
    itemId: item.id, decisao: 'REPROVADO', quantidadeAprovada: 0, justificativa,
  });

  // O ato de decidir da 12B: trava a solicitação, confere o estado, decide todos os itens e o cabeçalho.
  async function decidir(solicitacao, { status, decisoes, decididaPor = d.aprovador }) {
    return transacao(pool(), async (c) => {
      const travada = await sol().travarPorId(c, solicitacao.empresaId, solicitacao.id);
      if (travada === null || travada.status !== 'PENDENTE') return { recusada: travada?.status ?? 'INEXISTENTE' };
      const decididos = await itemRepo().decidirTodos(c, solicitacao.empresaId, solicitacao.id, decisoes);
      const atualizada = await sol().registrarDecisao(c, solicitacao.empresaId, solicitacao.id, { status, decididaPor });
      return { decididos, atualizada };
    });
  }

  async function cancelarPendente(solicitacao, { canceladaPor = d.solicitante, justificativa = null } = {}) {
    return transacao(pool(), async (c) => {
      const travada = await sol().travarPorId(c, solicitacao.empresaId, solicitacao.id);
      if (travada === null || travada.status !== 'PENDENTE') return { recusada: travada?.status ?? 'INEXISTENTE' };
      return { cancelada: await sol().cancelar(c, solicitacao.empresaId, solicitacao.id, { canceladaPor, justificativa }) };
    });
  }

  describe('numeração', () => {
    test('sequencial por empresa, independente entre empresas; o ROLLBACK não deixa lacuna', async () => {
      const antesA = await numeracao().proximoNumero(pool(), d.empresaA);
      assert.equal(await numeracao().proximoNumero(pool(), d.empresaA), antesA + 1);
      const antesB = await numeracao().proximoNumero(pool(), d.empresaB);
      assert.equal(await numeracao().proximoNumero(pool(), d.empresaB), antesB + 1);
      const falha = await erroDe(transacao(pool(), async (c) => {
        await numeracao().proximoNumero(c, d.empresaA);
        throw new Error('falha depois de pegar o número');
      }));
      assert.equal(falha.message, 'falha depois de pegar o número');
      assert.equal(await numeracao().proximoNumero(pool(), d.empresaA), antesA + 2, 'o número da transação revertida voltou');
    });

    test('criações simultâneas pelo fluxo completo recebem números consecutivos, sem repetir nem pular', async () => {
      const { rows: [{ ultimo }] } = await pool().query('SELECT COALESCE(max(ultimo_numero), 0)::int AS ultimo FROM solicitacoes_epi_numeracao WHERE empresa_id = $1', [d.empresaB]);
      const criacoes = Array.from({ length: 12 }, () => criar({
        empresaId: d.empresaB, funcionarioId: d.trabalhadorB, solicitanteId: d.usuarioB, itens: [pedido({ materialId: d.botinaB })],
      }));
      const resultados = await Promise.all(criacoes);
      const numeros = resultados.map((r) => r.solicitacao.numero).sort((a, b) => a - b);
      assert.deepEqual(numeros, Array.from({ length: 12 }, (_, i) => ultimo + 1 + i));
    });
  });

  describe('criação e leitura', () => {
    test('cabeçalho e itens voltam mapeados; buscarPorId, buscarPorChave e listarPorSolicitacao enxergam o mesmo registro', async () => {
      const chave = crypto.randomUUID();
      const { solicitacao, itens } = await criar({
        chave, gheId: d.gheA, observacao: 'Admissão do trabalhador',
        itens: [pedido(), pedido({ materialId: d.capacete, tamanho: null, quantidade: 1, previstoNoGhe: false })],
      });
      assert.equal(solicitacao.status, 'PENDENTE');
      assert.deepEqual(
        [solicitacao.empresaId, solicitacao.funcionarioId, solicitacao.gheId, solicitacao.origemSolicitacao, solicitacao.solicitanteUsuarioId, solicitacao.quantidadeItens, solicitacao.observacao],
        [d.empresaA, d.trabalhadorA, d.gheA, 'USUARIO_INTERNO', d.solicitante, 2, 'Admissão do trabalhador'],
      );
      assert.ok(solicitacao.criadaEm instanceof Date);
      assert.deepEqual(
        [solicitacao.decididaPor, solicitacao.decididaEm, solicitacao.canceladaPor, solicitacao.canceladaEm, solicitacao.justificativaCancelamento, solicitacao.entregueEm],
        [null, null, null, null, null, null],
      );
      assert.equal(solicitacao.chaveIdempotencia, chave);
      assert.equal(solicitacao.requisicaoHash, HASH);
      assert.deepEqual(await sol().buscarPorId(pool(), d.empresaA, solicitacao.id), solicitacao);
      assert.deepEqual(await sol().buscarPorChave(pool(), d.empresaA, chave), solicitacao);
      const lidos = await itemRepo().listarPorSolicitacao(pool(), d.empresaA, solicitacao.id);
      assert.deepEqual(lidos, itens);
      assert.deepEqual(lidos.map((i) => [i.tamanho, i.previstoNoGhe, i.decisao]), [['40', true, null], [null, false, null]]);
      assert.ok(lidos[0].id < lidos[1].id);
    });

    test('AUTOATENDIMENTO é gravado sem solicitante interno', async () => {
      const { solicitacao } = await criar({ origem: 'AUTOATENDIMENTO' });
      assert.deepEqual([solicitacao.origemSolicitacao, solicitacao.solicitanteUsuarioId], ['AUTOATENDIMENTO', null]);
    });

    test('a hora de criação é do banco, e a solicitação nasce PENDENTE sem o chamador escolher', async () => {
      const { solicitacao } = await criar();
      const { rows: [{ recente }] } = await pool().query("SELECT criada_em >= now() - interval '1 minute' AS recente FROM solicitacoes_epi WHERE id = $1", [solicitacao.id]);
      assert.equal(recente, true);
      assert.equal(solicitacao.status, 'PENDENTE');
    });

    test('isolamento: outra empresa não encontra, não trava, não decide, não cancela nem lista nada', async () => {
      const chave = crypto.randomUUID();
      const { solicitacao, itens } = await criar({ chave });
      assert.equal(await sol().buscarPorId(pool(), d.empresaB, solicitacao.id), null);
      assert.equal(await sol().buscarPorChave(pool(), d.empresaB, chave), null);
      assert.equal(await sol().travarPorId(pool(), d.empresaB, solicitacao.id), null);
      assert.deepEqual(await itemRepo().listarPorSolicitacao(pool(), d.empresaB, solicitacao.id), []);
      assert.equal(await sol().registrarDecisao(pool(), d.empresaB, solicitacao.id, { status: 'REPROVADA', decididaPor: d.usuarioB }), null);
      assert.equal(await sol().cancelar(pool(), d.empresaB, solicitacao.id, { canceladaPor: d.usuarioB }), null);
      assert.deepEqual(await itemRepo().decidirTodos(pool(), d.empresaB, solicitacao.id, [reprovarItem(itens[0])]), []);
      const intacta = await sol().buscarPorId(pool(), d.empresaA, solicitacao.id);
      assert.equal(intacta.status, 'PENDENTE');
      assert.deepEqual((await itemRepo().listarPorSolicitacao(pool(), d.empresaA, solicitacao.id))[0].decisao, null);
    });

    test('FKs compostas: trabalhador, GHE, solicitante e material de outra empresa são recusados na criação', async () => {
      assert.deepEqual(par(await erroDe(criar({ funcionarioId: d.trabalhadorB }))), [VIOLACAO_FK, 'fk_solicitacoes_epi_funcionario_mesma_empresa']);
      assert.deepEqual(par(await erroDe(criar({ gheId: d.gheB }))), [VIOLACAO_FK, 'fk_solicitacoes_epi_ghe_mesma_empresa']);
      assert.deepEqual(par(await erroDe(criar({ solicitanteId: d.usuarioB }))), [VIOLACAO_FK, 'fk_solicitacoes_epi_solicitante_mesma_empresa']);
      assert.deepEqual(par(await erroDe(criar({ itens: [pedido({ materialId: d.botinaB })] }))), [VIOLACAO_FK, 'fk_solicitacoes_epi_itens_material_mesma_empresa']);
    });

    test('a mesma chave não cria duas solicitações; buscarPorChave devolve a primeira com o hash para o serviço comparar', async () => {
      const chave = crypto.randomUUID();
      const primeira = await criar({ chave });
      assert.deepEqual(par(await erroDe(criar({ chave }))), [VIOLACAO_UNIQUE, 'uq_solicitacoes_epi_idempotencia']);
      const encontrada = await sol().buscarPorChave(pool(), d.empresaA, chave);
      assert.equal(encontrada.id, primeira.solicitacao.id);
      assert.equal(encontrada.requisicaoHash, HASH);
      // Outra empresa pode usar a mesma chave.
      const outra = await criar({ empresaId: d.empresaB, funcionarioId: d.trabalhadorB, solicitanteId: d.usuarioB, itens: [pedido({ materialId: d.botinaB })], chave });
      assert.notEqual(outra.solicitacao.id, primeira.solicitacao.id);
    });
  });

  describe('trava da chave e da solicitação', () => {
    let clientes;

    const abrir = async () => {
      const c = await pool().connect();
      clientes.push(c);
      const { rows: [{ pid }] } = await c.query('SELECT pg_backend_pid() AS pid');
      await c.query('BEGIN');
      return { c, pid };
    };
    const encerrar = async () => {
      await Promise.all(clientes.map((c) => c.query('ROLLBACK').catch(() => {})));
      clientes.forEach((c) => c.release());
    };

    test('travarChave: a mesma chave na mesma empresa espera; outra chave ou outra empresa passa; libera no COMMIT', async () => {
      clientes = [];
      try {
        const chave = crypto.randomUUID();
        const um = await abrir();
        const dois = await abrir();
        const tres = await abrir();
        await sol().travarChave(um.c, d.empresaA, chave);
        const espera = sol().travarChave(dois.c, d.empresaA, chave);
        assert.equal(await aguardarEsperaPeloLock(pool(), dois.pid), 'advisory');
        await comLimite(sol().travarChave(tres.c, d.empresaA, crypto.randomUUID()), 'outra chave');
        await comLimite(sol().travarChave(tres.c, d.empresaB, chave), 'outra empresa');
        await um.c.query('COMMIT');
        await comLimite(espera, 'segunda trava da chave');
      } finally {
        await encerrar();
      }
    });

    test('travarPorId: segunda transação espera a linha; FOR NO KEY UPDATE não bloqueia a FK dos filhos (item inserido por outra transação passa)', async () => {
      clientes = [];
      try {
        const { solicitacao } = await criar();
        const um = await abrir();
        const dois = await abrir();
        const tres = await abrir();
        assert.equal((await sol().travarPorId(um.c, d.empresaA, solicitacao.id)).id, solicitacao.id);
        const espera = sol().travarPorId(dois.c, d.empresaA, solicitacao.id);
        assert.ok(['tuple', 'transactionid'].includes(await aguardarEsperaPeloLock(pool(), dois.pid)));
        await comLimite(
          tres.c.query(
            `INSERT INTO solicitacoes_epi_itens (empresa_id, solicitacao_id, material_id, tamanho, quantidade, motivo, previsto_no_ghe)
             VALUES ($1, $2, $3, '41', 1, 'ADMISSAO', true)`,
            [d.empresaA, solicitacao.id, d.botina],
          ),
          'insert de item filho durante a trava da linha',
        );
        await tres.c.query('ROLLBACK');
        await um.c.query('COMMIT');
        assert.equal((await comLimite(espera, 'segunda trava da linha')).id, solicitacao.id);
        await dois.c.query('COMMIT');
      } finally {
        await encerrar();
      }
    });
  });

  describe('decisão de todos os itens e do cabeçalho no mesmo ato', () => {
    const tresItens = () => [pedido({ quantidade: 4 }), pedido({ materialId: d.luva, quantidade: 2 }), pedido({ materialId: d.capacete, tamanho: null, quantidade: 1 })];

    test('aprovação integral: itens decididos, cabeçalho APROVADA, quem decidiu e a hora do banco', async () => {
      const { solicitacao, itens } = await criar({ itens: tresItens() });
      const { decididos, atualizada } = await decidir(solicitacao, { status: 'APROVADA', decisoes: itens.map((i) => aprovarItem(i)) });
      assert.deepEqual(decididos.map((i) => [i.decisao, i.quantidadeAprovada]), [['APROVADO', 4], ['APROVADO', 2], ['APROVADO', 1]]);
      assert.deepEqual([atualizada.status, atualizada.decididaPor], ['APROVADA', d.aprovador]);
      assert.ok(atualizada.decididaEm >= atualizada.criadaEm);
      const { rows: [{ recente }] } = await pool().query("SELECT decidida_em >= now() - interval '1 minute' AS recente FROM solicitacoes_epi WHERE id = $1", [solicitacao.id]);
      assert.equal(recente, true);
      assert.deepEqual((await sol().buscarPorId(pool(), d.empresaA, solicitacao.id)).status, 'APROVADA');
    });

    test('aprovação parcial (um item reprovado e outro com quantidade reduzida): APROVADA_PARCIAL; os itens voltam ordenados por id', async () => {
      const { solicitacao, itens } = await criar({ itens: tresItens() });
      const { decididos, atualizada } = await decidir(solicitacao, {
        status: 'APROVADA_PARCIAL',
        decisoes: [reprovarItem(itens[2]), aprovarItem(itens[0], 3, 'Estoque curto'), aprovarItem(itens[1])],
      });
      assert.deepEqual(decididos.map((i) => i.id), itens.map((i) => i.id));
      assert.deepEqual(decididos.map((i) => [i.decisao, i.quantidadeAprovada, i.justificativaDecisao]), [
        ['APROVADO', 3, 'Estoque curto'], ['APROVADO', 2, null], ['REPROVADO', 0, 'Sem necessidade comprovada'],
      ]);
      assert.equal(atualizada.status, 'APROVADA_PARCIAL');
    });

    test('todos reprovados: REPROVADA', async () => {
      const { solicitacao, itens } = await criar({ itens: tresItens() });
      const { atualizada } = await decidir(solicitacao, { status: 'REPROVADA', decisoes: itens.map((i) => reprovarItem(i)) });
      assert.equal(atualizada.status, 'REPROVADA');
    });

    test('resultado incoerente com os itens não passa do COMMIT e nada fica gravado', async () => {
      const { solicitacao, itens } = await criar({ itens: tresItens() });
      const erro = await erroDe(decidir(solicitacao, {
        status: 'APROVADA', decisoes: [aprovarItem(itens[0]), aprovarItem(itens[1]), reprovarItem(itens[2])],
      }));
      assert.deepEqual(par(erro), [VIOLACAO_CHECK, COERENCIA]);
      assert.equal((await sol().buscarPorId(pool(), d.empresaA, solicitacao.id)).status, 'PENDENTE');
      assert.deepEqual((await itemRepo().listarPorSolicitacao(pool(), d.empresaA, solicitacao.id)).map((i) => i.decisao), [null, null, null]);
    });

    test('não existe decisão em duas chamadas: só os itens, ou só o cabeçalho, não passam do COMMIT', async () => {
      const { solicitacao, itens } = await criar({ itens: tresItens() });
      const soItens = await erroDe(transacao(pool(), (c) => itemRepo().decidirTodos(c, d.empresaA, solicitacao.id, itens.map((i) => aprovarItem(i)))));
      assert.deepEqual(par(soItens), [VIOLACAO_CHECK, COERENCIA]);
      const soCabecalho = await erroDe(transacao(pool(), (c) => sol().registrarDecisao(c, d.empresaA, solicitacao.id, { status: 'APROVADA', decididaPor: d.aprovador })));
      assert.deepEqual(par(soCabecalho), [VIOLACAO_CHECK, COERENCIA]);
      const parcial = await erroDe(transacao(pool(), (c) => itemRepo().decidirTodos(c, d.empresaA, solicitacao.id, [aprovarItem(itens[0])])));
      assert.deepEqual(par(parcial), [VIOLACAO_CHECK, COERENCIA]);
    });

    test('decidirTodos só atualiza itens da solicitação informada e ainda sem decisão; a segunda chamada devolve vazio e registrarDecisao devolve null', async () => {
      const a = await criar({ itens: tresItens() });
      const b = await criar({ itens: tresItens() });
      const { decididos } = await decidir(a.solicitacao, {
        status: 'APROVADA', decisoes: [...a.itens.map((i) => aprovarItem(i)), aprovarItem(b.itens[0])],
      });
      assert.deepEqual(decididos.map((i) => i.id), a.itens.map((i) => i.id), 'o item de outra solicitação ficou de fora');
      assert.deepEqual((await itemRepo().listarPorSolicitacao(pool(), d.empresaA, b.solicitacao.id)).map((i) => i.decisao), [null, null, null]);
      assert.deepEqual(await itemRepo().decidirTodos(pool(), d.empresaA, a.solicitacao.id, a.itens.map((i) => reprovarItem(i))), []);
      assert.equal(await sol().registrarDecisao(pool(), d.empresaA, a.solicitacao.id, { status: 'REPROVADA', decididaPor: d.aprovador }), null);
      assert.equal((await sol().buscarPorId(pool(), d.empresaA, a.solicitacao.id)).status, 'APROVADA');
    });

    test('o banco barra o que o repositório deixa passar: autodecisão, reprovação sem justificativa, redução e item fora do GHE sem justificativa', async () => {
      const { solicitacao, itens } = await criar({ itens: [pedido({ quantidade: 4 }), pedido({ materialId: d.luva, quantidade: 4, previstoNoGhe: false })] });
      const propria = await erroDe(decidir(solicitacao, { status: 'APROVADA', decisoes: itens.map((i) => aprovarItem(i, 4, 'Justificado')), decididaPor: d.solicitante }));
      assert.deepEqual(par(propria), [VIOLACAO_CHECK, 'chk_solicitacoes_epi_decisor_diferente_do_solicitante']);
      const foraDoGhe = await erroDe(decidir(solicitacao, { status: 'APROVADA', decisoes: [aprovarItem(itens[0]), aprovarItem(itens[1])] }));
      assert.deepEqual(par(foraDoGhe), [VIOLACAO_CHECK, 'chk_solicitacoes_epi_itens_fora_do_ghe_justificado']);
      const reducao = await erroDe(decidir(solicitacao, { status: 'APROVADA_PARCIAL', decisoes: [aprovarItem(itens[0], 2), reprovarItem(itens[1])] }));
      assert.deepEqual(par(reducao), [VIOLACAO_CHECK, 'chk_solicitacoes_epi_itens_reducao_justificada']);
      const semJustificativa = await erroDe(decidir(solicitacao, { status: 'REPROVADA', decisoes: [{ itemId: itens[0].id, decisao: 'REPROVADO', quantidadeAprovada: 0, justificativa: null }, reprovarItem(itens[1])] }));
      assert.deepEqual(par(semJustificativa), [VIOLACAO_CHECK, 'chk_solicitacoes_epi_itens_reprovado_justificado']);
      assert.equal((await sol().buscarPorId(pool(), d.empresaA, solicitacao.id)).status, 'PENDENTE');
    });
  });

  describe('cancelamento', () => {
    test('PENDENTE é cancelada com quem cancelou, a hora do banco e a justificativa opcional', async () => {
      const comTexto = await criar();
      const { cancelada } = await cancelarPendente(comTexto.solicitacao, { justificativa: 'Pedido em duplicidade' });
      assert.deepEqual([cancelada.status, cancelada.canceladaPor, cancelada.justificativaCancelamento], ['CANCELADA', d.solicitante, 'Pedido em duplicidade']);
      assert.ok(cancelada.canceladaEm >= cancelada.criadaEm);
      const semTexto = await criar();
      assert.equal((await cancelarPendente(semTexto.solicitacao)).cancelada.justificativaCancelamento, null);
    });

    test('depois de decidida ou cancelada, não cancela de novo: o repositório devolve null e o estado não muda', async () => {
      const aprovada = await criar();
      await decidir(aprovada.solicitacao, { status: 'APROVADA', decisoes: aprovada.itens.map((i) => aprovarItem(i)) });
      assert.equal(await sol().cancelar(pool(), d.empresaA, aprovada.solicitacao.id, { canceladaPor: d.solicitante }), null);
      assert.equal((await sol().buscarPorId(pool(), d.empresaA, aprovada.solicitacao.id)).status, 'APROVADA');
      const cancelada = await criar();
      await cancelarPendente(cancelada.solicitacao);
      assert.equal(await sol().cancelar(pool(), d.empresaA, cancelada.solicitacao.id, { canceladaPor: d.solicitante }), null);
      assert.equal(await sol().registrarDecisao(pool(), d.empresaA, cancelada.solicitacao.id, { status: 'APROVADA', decididaPor: d.aprovador }), null);
    });
  });

  describe('corridas pela trava da linha', () => {
    let clientes;

    test('decisão × cancelamento: a segunda transação espera a linha, vê o estado novo e desiste; vence quem travou primeiro (nas duas ordens)', async () => {
      for (const primeiro of ['decisao', 'cancelamento']) {
        clientes = [];
        try {
          const { solicitacao, itens } = await criar();
          const um = await pool().connect();
          const dois = await pool().connect();
          clientes.push(um, dois);
          const { rows: [{ pid }] } = await dois.query('SELECT pg_backend_pid() AS pid');
          await um.query('BEGIN');
          await dois.query('BEGIN');

          const agir = {
            decisao: async (c) => {
              const travada = await sol().travarPorId(c, d.empresaA, solicitacao.id);
              if (travada.status !== 'PENDENTE') return 'recusada';
              await itemRepo().decidirTodos(c, d.empresaA, solicitacao.id, itens.map((i) => aprovarItem(i)));
              await sol().registrarDecisao(c, d.empresaA, solicitacao.id, { status: 'APROVADA', decididaPor: d.aprovador });
              return 'decidida';
            },
            cancelamento: async (c) => {
              const travada = await sol().travarPorId(c, d.empresaA, solicitacao.id);
              if (travada.status !== 'PENDENTE') return 'recusada';
              await sol().cancelar(c, d.empresaA, solicitacao.id, { canceladaPor: d.solicitante });
              return 'cancelada';
            },
          };
          const segundo = primeiro === 'decisao' ? 'cancelamento' : 'decisao';
          const vencedora = await agir[primeiro](um);
          const perdedora = agir[segundo](dois);
          await aguardarEsperaPeloLock(pool(), pid);
          await um.query('COMMIT');
          assert.equal(await comLimite(perdedora, 'transação perdedora'), 'recusada');
          await dois.query('COMMIT');
          assert.equal(vencedora, primeiro === 'decisao' ? 'decidida' : 'cancelada');
          const final = await sol().buscarPorId(pool(), d.empresaA, solicitacao.id);
          assert.equal(final.status, primeiro === 'decisao' ? 'APROVADA' : 'CANCELADA');
        } finally {
          await Promise.all(clientes.map((c) => c.query('ROLLBACK').catch(() => {})));
          clientes.forEach((c) => c.release());
        }
      }
    });

    test('oito decisões simultâneas sobre a mesma solicitação: exatamente uma vence e as outras sete desistem', async () => {
      const { solicitacao, itens } = await criar();
      const resultados = await Promise.all(Array.from({ length: 8 }, (_, i) => decidir(solicitacao, {
        status: i % 2 === 0 ? 'APROVADA' : 'REPROVADA',
        decisoes: itens.map((item) => (i % 2 === 0 ? aprovarItem(item) : reprovarItem(item))),
      })));
      assert.equal(resultados.filter((r) => r.atualizada).length, 1);
      assert.equal(resultados.filter((r) => r.recusada).length, 7);
      const final = await sol().buscarPorId(pool(), d.empresaA, solicitacao.id);
      const decisoes = await itemRepo().listarPorSolicitacao(pool(), d.empresaA, solicitacao.id);
      assert.equal(final.status === 'APROVADA', decisoes[0].decisao === 'APROVADO', 'cabeçalho e itens da mesma decisão vencedora');
    });
  });
});
