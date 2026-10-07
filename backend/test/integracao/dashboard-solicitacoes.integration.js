'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { montarAmbiente12f } = require('./helpers/ambiente-http-12f');
const { sessaoDeTeste, CABECALHO } = require('./helpers/ambiente-http-12d2');
const { chaveNova, vincularMaterialAoGhe } = require('./helpers/solicitacao-epi-servico');
const { ACEITE } = require('./helpers/reserva-estoque');
const { criarAppTeste } = require('../helpers/app-teste');
const { criarDashboardController } = require('../../src/controllers/dashboard.controller');
const { criarDashboardRoutes } = require('../../src/routes/dashboard.routes');
const solicitacaoSvc = require('../../src/services/solicitacao-epi.service');
const entregaSolicitacaoSvc = require('../../src/services/entrega-solicitacao.service');

/**
 * 12G-6 — GET /api/dashboard/indicadores com os três indicadores das
 * solicitações, contra PostgreSQL real:
 *   solicitacoesAguardandoSst      PENDENTE (APROVAR_SOLICITACAO);
 *   solicitacoesAguardandoEstoque  APROVADA ou APROVADA_PARCIAL com pendente na
 *                                  fila e NENHUM item com cobertura > 0 agora
 *                                  (REALIZAR_ENTREGA ou ENCERRAR_SOLICITACAO);
 *   disponiveisParaEntrega         APROVADA ou APROVADA_PARCIAL com ALGUM item
 *                                  pendente com cobertura > 0 agora
 *                                  (REALIZAR_ENTREGA).
 * As duas últimas são populações exclusivas. O item suspenso (trabalhador ou
 * material inativo) está fora da fila e não tem cobertura: a solicitação toda
 * suspensa não aguarda estoque nem está disponível. Sem a ação, { permitido:
 * false }; "Pendências sem estoque" (semCobertura) continua igual.
 */

const ROTA = '/api/dashboard/indicadores';
const NEGADO = { permitido: false };
const NOVOS = ['solicitacoesAguardandoSst', 'solicitacoesAguardandoEstoque', 'disponiveisParaEntrega'];

describe('12G-6 — Dashboard: aguardando SST, aguardando estoque e disponíveis para entrega', () => {
  let env;
  let pool;
  let d;
  let f;
  let app;
  const u = {};

  const indicadores = async (usuarioId) => {
    const r = await request(app).get(ROTA).set(CABECALHO, String(usuarioId));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.indicadores;
  };
  const pendente = async (materialId) => solicitacaoSvc.criarSolicitacao(pool, {
    empresaId: d.empresaA, atorId: d.solicitante, funcionarioId: d.trabalhador, itens: [{ materialId, tamanho: '40', quantidade: 1, motivo: 'ADMISSAO' }], chaveIdempotencia: chaveNova(),
  });
  // Pedido com vários itens, decididos um a um (APROVADO ou REPROVADO).
  async function decidida(itens, funcionarioId = d.trabalhador) {
    const criada = await solicitacaoSvc.criarSolicitacao(pool, {
      empresaId: d.empresaA, atorId: d.solicitante, funcionarioId, chaveIdempotencia: chaveNova(),
      itens: itens.map(({ materialId, quantidade }) => ({ materialId, tamanho: '40', quantidade, motivo: 'ADMISSAO' })),
    });
    const decisoes = criada.itens.map((item, i) => (itens[i].decisao === 'REPROVADO'
      ? { itemId: item.id, decisao: 'REPROVADO', justificativa: 'Não previsto (fictício)' }
      : { itemId: item.id, decisao: 'APROVADO' }));
    const visao = await solicitacaoSvc.decidirSolicitacao(pool, {
      empresaId: d.empresaA, atorId: d.sst1, solicitacaoId: criada.solicitacao.id, decisoes, hoje: f.HOJE,
    });
    return { id: criada.solicitacao.id, status: visao.solicitacao.status };
  }
  const entregar = (alvo, loteId, quantidade) => entregaSolicitacaoSvc.registrarEntregaPorSolicitacao(pool, {
    empresaId: d.empresaA, atorId: d.master, solicitacaoId: alvo.id, itens: [{ solicitacaoItemId: alvo.item, loteId, quantidade }], confirmacao: ACEITE, chaveIdempotencia: chaveNova(),
  });

  before(async () => {
    env = await montarAmbiente12f();
    ({ pool, d, f } = env);
    app = criarAppTeste((a) => {
      a.use('/api', criarDashboardRoutes({ controller: criarDashboardController({ pool }), exigirSessao: sessaoDeTeste(pool), pool }));
    });
    const painel = { dashboard: ['visualizar'], availableItems: ['visualizar'] };
    u.sst = await env.usuarioCom(d.empresaA, { recursos: painel, acoes: ['APROVAR_SOLICITACAO'], sst: true });
    u.soReprova = await env.usuarioCom(d.empresaA, { recursos: painel, acoes: ['REPROVAR_SOLICITACAO'], sst: true });
    u.encerra = await env.usuarioCom(d.empresaA, { recursos: painel, acoes: ['ENCERRAR_SOLICITACAO'], sst: true });
    u.entrega = await env.usuarioCom(d.empresaA, { recursos: painel, acoes: ['REALIZAR_ENTREGA'] });
    u.semAcao = await env.usuarioCom(d.empresaA, { recursos: painel });
    u.entregaB = await env.usuarioCom(d.empresaB, { recursos: painel, acoes: ['REALIZAR_ENTREGA', 'APROVAR_SOLICITACAO'], sst: true });

    // Empresa A — aguardando estoque: A1, A7, A10; disponíveis: A2, A3, A8, A9; fora: A4, A5, A6 e as pendentes e a cancelada.
    await pendente(await f.material()); // P1
    await pendente(await f.material()); // P2
    await f.aprovada({ materialId: await f.material(), quantidade: 3 }); // A1: APROVADA sem estoque
    const m2 = await f.material();
    await f.estoque(m2, 1);
    await f.aprovada({ materialId: m2, quantidade: 3 }); // A2: cobertura parcial (1 de 3)
    const m3 = await f.material();
    const lote3 = await f.estoque(m3, 2);
    const a3 = await f.aprovada({ materialId: m3, quantidade: 2 });
    await entregar(a3, lote3, 1); // A3: entrega parcial, 1 pendente e coberto
    const m4 = await f.material();
    const lote4 = await f.estoque(m4, 1);
    const a4 = await f.aprovada({ materialId: m4, quantidade: 1 });
    await entregar(a4, lote4, 1); // A4: ENTREGUE, fora
    const a5 = await f.aprovada({ materialId: await f.material(), quantidade: 1 });
    await solicitacaoSvc.encerrarSolicitacao(pool, {
      empresaId: d.empresaA, atorId: d.master, solicitacaoId: a5.id, justificativa: 'Não será mais entregue (fictício)', hoje: f.HOJE,
    }); // A5: ENCERRADA, fora
    const m6 = await f.material();
    await f.estoque(m6, 5);
    const trabalhadorSuspenso = await d.novoTrabalhador(d.empresaA, { gheId: d.gheA });
    await f.aprovada({ materialId: m6, quantidade: 1, funcionarioId: trabalhadorSuspenso });
    await pool.query('UPDATE funcionarios SET ativo = false WHERE id = $1', [trabalhadorSuspenso]); // A6: toda suspensa, fora das duas
    const a7 = await decidida([{ materialId: await f.material(), quantidade: 2 }, { materialId: await f.material(), quantidade: 1, decisao: 'REPROVADO' }]); // A7: APROVADA_PARCIAL sem estoque
    assert.equal(a7.status, 'APROVADA_PARCIAL');
    const m8 = await f.material();
    await f.estoque(m8, 5);
    const a8 = await decidida([{ materialId: m8, quantidade: 1 }, { materialId: await f.material(), quantidade: 1, decisao: 'REPROVADO' }]); // A8: APROVADA_PARCIAL coberta
    assert.equal(a8.status, 'APROVADA_PARCIAL');
    const m9x = await f.material();
    await f.estoque(m9x, 1);
    await decidida([{ materialId: m9x, quantidade: 1 }, { materialId: await f.material(), quantidade: 1 }]); // A9: um item coberto e outro sem estoque → disponível
    const m10inativo = await f.material();
    await f.estoque(m10inativo, 3);
    await decidida([{ materialId: m10inativo, quantidade: 1 }, { materialId: await f.material(), quantidade: 2 }]);
    await pool.query('UPDATE materiais SET ativo = false WHERE id = $1', [m10inativo]); // A10: um item suspenso e outro aguardando → aguardando estoque
    const cancelada = await pendente(await f.material());
    await solicitacaoSvc.cancelarSolicitacao(pool, { empresaId: d.empresaA, atorId: d.solicitante, solicitacaoId: cancelada.solicitacao.id, justificativa: null, hoje: f.HOJE });

    // Empresa B: uma PENDENTE e uma aprovada com estoque.
    await vincularMaterialAoGhe(pool, d.empresaB, d.gheB, d.botinaB);
    for (let i = 0; i < 2; i += 1) {
      const criada = await solicitacaoSvc.criarSolicitacao(pool, {
        empresaId: d.empresaB, atorId: d.usuarioB, funcionarioId: d.trabalhadorB, itens: [{ materialId: d.botinaB, tamanho: '40', quantidade: 1, motivo: 'ADMISSAO' }], chaveIdempotencia: chaveNova(),
      });
      if (i === 1) {
        await solicitacaoSvc.decidirSolicitacao(pool, {
          empresaId: d.empresaB, atorId: d.sstB, solicitacaoId: criada.solicitacao.id, decisoes: [{ itemId: criada.itens[0].id, decisao: 'APROVADO' }], hoje: f.HOJE,
        });
      }
    }
    await f.estoque(d.botinaB, 3, { empresaId: d.empresaB, usuarioId: d.masterB });
  });
  after(async () => { if (env) await env.encerrar(); });

  test('quem aprova vê as que aguardam a SST: as duas PENDENTE da empresa (cancelada e de outra empresa fora)', async () => {
    const i = await indicadores(u.sst);
    assert.deepEqual(i.solicitacoesAguardandoSst, { permitido: true, valor: 2 });
    assert.deepEqual(i.solicitacoesAguardandoEstoque, NEGADO);
    assert.deepEqual(i.disponiveisParaEntrega, NEGADO);
  });

  test('quem entrega: aguardando estoque = nenhum item coberto (APROVADA, APROVADA_PARCIAL, e a com um item suspenso e outro sem estoque); disponíveis = algum item coberto (parcial, entrega parcial, APROVADA_PARCIAL e o pedido misto)', async () => {
    const i = await indicadores(u.entrega);
    assert.deepEqual(i.solicitacoesAguardandoEstoque, { permitido: true, valor: 3 });
    assert.deepEqual(i.disponiveisParaEntrega, { permitido: true, valor: 4 });
    assert.deepEqual(i.solicitacoesAguardandoSst, NEGADO);
    assert.equal('solicitacoesAguardandoEntrega' in i, false, 'o indicador antigo não existe mais');
  });

  test('populações exclusivas: o pedido com um item coberto e outro sem estoque entra só em disponíveis; somadas, as duas são as aprovadas com pendente na fila (a toda suspensa fica fora)', async () => {
    const antes = await indicadores(u.entrega);
    const mCoberto = await f.material();
    await f.estoque(mCoberto, 1);
    await decidida([{ materialId: mCoberto, quantidade: 1 }, { materialId: await f.material(), quantidade: 4 }]);
    const depois = await indicadores(u.entrega);
    assert.equal(depois.disponiveisParaEntrega.valor, antes.disponiveisParaEntrega.valor + 1);
    assert.equal(depois.solicitacoesAguardandoEstoque.valor, antes.solicitacoesAguardandoEstoque.valor, 'não entra em aguardando estoque');
    const { rows: [{ n }] } = await pool.query(
      "SELECT count(*)::int AS n FROM solicitacoes_epi WHERE empresa_id = $1 AND status IN ('APROVADA', 'APROVADA_PARCIAL')", [d.empresaA],
    );
    assert.equal(depois.disponiveisParaEntrega.valor + depois.solicitacoesAguardandoEstoque.valor, n - 1, 'todas as aprovadas, menos a toda suspensa');
  });

  test('quem só encerra vê aguardando estoque, mas não disponíveis para entrega', async () => {
    const i = await indicadores(u.encerra);
    assert.equal(i.solicitacoesAguardandoEstoque.permitido, true);
    assert.deepEqual(i.disponiveisParaEntrega, NEGADO);
  });

  test('só reprovar não abre a fila da SST; sem nenhuma ação, os três negados (nunca zero)', async () => {
    assert.deepEqual((await indicadores(u.soReprova)).solicitacoesAguardandoSst, NEGADO);
    const i = await indicadores(u.semAcao);
    for (const chave of NOVOS) assert.deepEqual(i[chave], NEGADO, chave);
  });

  test('MASTER: só o que as permissões efetivas dão (REALIZAR_ENTREGA provisionada; sem APROVAR nem ENCERRAR)', async () => {
    const i = await indicadores(d.master);
    assert.deepEqual(i.solicitacoesAguardandoSst, NEGADO);
    assert.equal(i.solicitacoesAguardandoEstoque.permitido, true);
    assert.equal(i.disponiveisParaEntrega.permitido, true);
  });

  test('"Pendências sem estoque" continua a demanda sem cobertura da posição (unidades), independente dos novos cartões', async () => {
    const i = await indicadores(u.entrega);
    const { rows: [{ g }] } = await pool.query(
      `SELECT COALESCE(sum(GREATEST(0, demanda - fisico)), 0)::int AS g FROM (
         SELECT p.demanda, p.fisico FROM (
           SELECT i.material_id, i.tamanho, sum(i.quantidade_aprovada - COALESCE((SELECT sum(ei.quantidade) FROM entregas_epi_itens ei WHERE ei.solicitacao_item_id = i.id), 0)) AS demanda,
                  (SELECT COALESCE(sum(l.saldo), 0) FROM estoque_lotes l WHERE l.empresa_id = $1 AND l.material_id = i.material_id AND l.tamanho = i.tamanho) AS fisico
             FROM solicitacoes_epi_itens i
             JOIN solicitacoes_epi s ON s.id = i.solicitacao_id AND s.status IN ('APROVADA', 'APROVADA_PARCIAL')
             JOIN funcionarios fu ON fu.id = s.funcionario_id AND fu.ativo
             JOIN materiais m ON m.id = i.material_id AND m.ativo
            WHERE i.empresa_id = $1 AND i.decisao = 'APROVADO'
            GROUP BY i.material_id, i.tamanho) p) x`,
      [d.empresaA],
    );
    assert.deepEqual(i.semCobertura, { permitido: true, valor: g });
  });

  test('multiempresa: B vê só as suas (uma aguardando SST, nenhuma aguardando estoque, uma disponível)', async () => {
    const i = await indicadores(u.entregaB);
    assert.deepEqual(i.solicitacoesAguardandoSst, { permitido: true, valor: 1 });
    assert.deepEqual(i.solicitacoesAguardandoEstoque, { permitido: true, valor: 0 });
    assert.deepEqual(i.disponiveisParaEntrega, { permitido: true, valor: 1 });
  });

  test('derivado a cada leitura: a entrada de estoque tira o pedido de "aguardando estoque" e o põe em "disponíveis", sem gravar nada', async () => {
    const m = await f.material();
    await f.aprovada({ materialId: m, quantidade: 1 });
    const antes = await indicadores(u.entrega);
    await f.estoque(m, 1);
    const depois = await indicadores(u.entrega);
    assert.equal(depois.solicitacoesAguardandoEstoque.valor, antes.solicitacoesAguardandoEstoque.valor - 1);
    assert.equal(depois.disponiveisParaEntrega.valor, antes.disponiveisParaEntrega.valor + 1);
  });
});
