'use strict';

const { describe, test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { ATENDIMENTO_INVALIDO, cookieDoAtendimentoNaResposta } = require('./helpers/token-atendimento');
const { CHAVES_DO_PEDIDO } = require('./helpers/token-pedido');
const {
  SOLICITACOES, CHAVES_DA_RESPOSTA, CHAVES_DO_ITEM, SITUACOES, abrirAmbienteSolicitacoes,
} = require('./helpers/token-solicitacoes');
const { lerSetCookie, cookieDoTabletNaResposta } = require('./helpers/token-tablet');
const solicitacaoSvc = require('../../src/services/solicitacao-epi.service');
const consultaSvc = require('../../src/services/solicitacao-epi-consulta.service');
const itemRepo = require('../../src/repositories/solicitacao-epi-item.repository');
const coberturaRepo = require('../../src/repositories/solicitacao-epi-cobertura.repository');
const { situacaoDoItem } = require('../../src/services/solicitacao-epi-situacao');
const { dataOperacional } = require('../../src/utils/data-operacional');

/**
 * Atendimento Token — Etapa G (RED): consulta das solicitações EXISTENTES do funcionário do atendimento atual, pelo fluxo REAL da 12G-6.
 * PostgreSQL real, schema temporário com TODAS as migrations; nenhuma migration nova. Contrato proposto em helpers/token-solicitacoes.js.
 *
 * Três grupos, separados de propósito:
 *  1. CONTROLES (K): provam, no fluxo real da 12G-6 e da Etapa F, os fatos em que o contrato se apoia (passavam já no RED).
 *  2. ENDPOINT NOVO (G1–G29): no RED falhavam pela ausência da rota (404 ROTA_NAO_ENCONTRADA); no GREEN G verificam a implementação real.
 *  3. DUPLICIDADE ENTRE ATENDIMENTOS (G13, G16*, G30*): no RED os que afirmam o BLOQUEIO eram `todo` (contrato pendente). Com a regra aprovada
 *     (GREEN G) são testes EFETIVOS, com as mesmas asserções; os de NÃO-bloqueio (outro material, outro tamanho, pedido encerrado, item
 *     reprovado, item já entregue) continuam passando. O G30k substitui a caracterização "a F aceita a duplicata" (comportamento anterior à G)
 *     por "o canal interno não é bloqueado" (a 12G-6 não mudou; exceções operacionais ficam no fluxo interno).
 */

const aviso = (r) => `${r.status} ${JSON.stringify(r.body)}`;
const NAO_AUTORIZADO = [401, 'DISPOSITIVO_NAO_AUTORIZADO'];
const LIMITE_DE_SEGURANCA_MS = 10000;
const NOMES = { botina: 'G Botina', protetor: 'G Protetor', capacete: 'G Capacete' };

describe('Atendimento Token — G: consulta das solicitações existentes do funcionário (PostgreSQL real)', () => {
  let a;
  let app;
  let gestor;

  before(async () => {
    a = await abrirAmbienteSolicitacoes();
    app = a.criarApp();
    gestor = await a.usuario(a.d.empresaA, { operacoes: ['visualizar', 'criar', 'editar'], acoes: ['TOKEN_REVOGAR_DISPOSITIVO', 'TOKEN_GERAR_ATIVACAO'] });
    esperadoPelaDozeG.pool = a.ctx.pool;
    esperadoPelaDozeG.empresaId = a.d.empresaA;
  });
  after(async () => { if (a) await a.encerrar(); });
  beforeEach(async () => { await a.redes(a.redeDeTeste); });

  const A = () => a.d.empresaA;
  const forcarRestante = (id, segundos) => a.q(`UPDATE token_atendimentos SET iniciado_em = LEAST(iniciado_em, now() - interval '200 seconds'), expira_em = now() + make_interval(secs => $2::int) WHERE id = $1`, [id, segundos]);
  const gerarCodigo = async (tabletId) => (await a.comoAdmin(app, gestor).post(`/api/atendimento-token/dispositivos/${tabletId}/ativacao`)).body.ativacao.codigo;
  const esperando = async (pid) => (await a.q('SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pid])).rows[0].n;
  const L = (materialId, nome, tamanho, situacao, quantidade, retiradaParcial = false) => ({ materialId, nome, tamanho, situacao, quantidade, retiradaParcial });

  /** Cenário padrão: GHE com botina (grade P/M/G), protetor e capacete (sem tamanho), funcionário do GHE e atendimento aberto. */
  async function montar({ funcionario = {} } = {}) {
    const ghe = await a.ghe(A());
    const botina = await a.material(A(), { nome: NOMES.botina, exigeTamanho: true, grade: ['P', 'M', 'G'] });
    const protetor = await a.material(A(), { nome: NOMES.protetor, exigeTamanho: false });
    const capacete = await a.material(A(), { nome: NOMES.capacete, exigeTamanho: false });
    for (const m of [botina, protetor, capacete]) await a.vincularMaterial(A(), ghe, m);
    const c = await a.cenario(app, { gheId: ghe, funcionario });
    return { ghe, botina, protetor, capacete, ...c };
  }

  /** A consulta do atendimento atual de `c`; exige 200 e devolve o corpo. */
  async function ler(c, aplicacao = app) {
    const r = await a.consultarSolicitacoes(aplicacao, c.t, c.token);
    assert.equal(r.status, 200, aviso(r));
    return r.body;
  }

  /** Pedido do TOTEM pelo fluxo real da Etapa F; o atendimento termina e um NOVO atendimento do mesmo funcionário é aberto em `c`. */
  async function pedidoDoTotem(c, itens) {
    const r = await a.finalizar(app, c.t, c.token, a.corpo(itens));
    assert.equal(r.status, 201, aviso(r));
    const lista = await a.solicitacoesDe(c.f.id);
    const sol = lista[lista.length - 1];
    const gravados = await a.itensDe(sol.id);
    const novo = await a.reabrir(app, c);
    Object.assign(c, { token: novo.token, atendimentoId: novo.atendimentoId });
    // ids dos itens na ORDEM DE ENTRADA do carrinho (o serviço grava em ordem canônica de material e tamanho)
    const naOrdemDeEntrada = itens.map((i) => gravados.find((g) => g.material_id === i.materialId && (g.tamanho ?? null) === (i.tamanho ?? null)).id);
    return { id: sol.id, itens: naOrdemDeEntrada, solicitante: null, resposta: r };
  }

  // ───────────── controles (devem passar já no RED): fatos da 12G-6 e da Etapa F em que o contrato se apoia ─────────────
  describe('controles (devem passar já no RED)', () => {
    test('K1 — o pedido do Totem tem solicitante nulo: NÃO aparece em "minhas" de ninguém, aparece na fila da SST (PENDENTE) e, aprovado, na lista de entregáveis POR TRABALHADOR; por isso a consulta do funcionário precisa de uma leitura nova (não há função da 12G-6 que liste os pedidos em aberto de um trabalhador)', async () => {
      const c = await montar();
      const p = await pedidoDoTotem(c, [a.item(c.protetor, { quantidade: 2 })]);
      for (const usuario of [a.d.master, gestor, await a.novoUsuario()]) {
        const minhas = await consultaSvc.listarMinhas(a.ctx.pool, { empresaId: A(), atorId: usuario, pagina: 1, limite: 100 });
        assert.equal(minhas.solicitacoes.some((s) => s.id === p.id), false, 'sem solicitante, nunca é "minha"');
      }
      const fila = await consultaSvc.listarFila(a.ctx.pool, { empresaId: A(), pagina: 1, limite: 100 });
      assert.equal(fila.solicitacoes.some((s) => s.id === p.id), true);
      await a.decidir(p, [true]);
      const entregaveis = await consultaSvc.listarEntregaveis(a.ctx.pool, { empresaId: A(), funcionarioId: c.f.id, pagina: 1, limite: 100 });
      assert.deepEqual(entregaveis.solicitacoes.map((s) => [s.id, s.status, s.situacaoOperacional]), [[p.id, 'APROVADA', 'AGUARDANDO_ESTOQUE']]);
      const outro = await a.funcionarioNoGhe(A(), c.ghe);
      assert.equal((await consultaSvc.listarEntregaveis(a.ctx.pool, { empresaId: A(), funcionarioId: outro.id, pagina: 1, limite: 100 })).solicitacoes.length, 0);
    });

    test('K2 — a derivação da 12G-6 (situação do item, quantidade entregue derivada, cobertura FIFO) é a fonte: aprovada 5 com 2 em estoque tem coberta 2; entregue 2, pendente 3 e situação PARCIALMENTE_ENTREGUE; nada disso é gravado', async () => {
      const c = await montar();
      const s = await a.criarInterna(c.f.id, [{ materialId: c.protetor, quantidade: 5 }]);
      await a.decidir(s, [true]);
      const lote = await a.repor(c.protetor, null, 2);
      const cobertura = await coberturaRepo.listarCoberturaDasSolicitacoes(a.ctx.pool, A(), { hoje: dataOperacional(), solicitacaoIds: [s.id] });
      assert.deepEqual(cobertura.map((x) => [x.quantidadePendente, x.coberta, x.semCobertura]), [[5, 2, 3]]);
      assert.equal(situacaoDoItem({ decisao: 'APROVADO', quantidadeAprovada: 5, quantidadeEntregue: 0, coberta: 2 }), 'PARCIALMENTE_COBERTA');
      await a.entregar(s, [{ itemId: s.itens[0], loteId: lote, quantidade: 2 }]);
      const [item] = await itemRepo.listarPorSolicitacoesComEntregue(a.ctx.pool, A(), [s.id]);
      assert.equal(item.quantidadeEntregue, 2);
      assert.equal((await a.q('SELECT status FROM solicitacoes_epi WHERE id = $1', [s.id])).rows[0].status, 'APROVADA', 'a entrega parcial não muda o status gravado');
      const colunas = (await a.q("SELECT column_name FROM information_schema.columns WHERE table_name = 'solicitacoes_epi_itens' AND table_schema = current_schema()")).rows.map((r) => r.column_name);
      assert.equal(colunas.some((n) => /entregue|coberta|reserva|pendente/.test(n)), false, 'nenhuma coluna de contador');
    });

    test('K3 — o pedido do Totem percorre o fluxo real até a entrega física: aprovado, reposto e entregue pelo serviço da 12G-6 vira ENTREGUE (a consulta da G nunca baixa estoque nem escreve na ficha)', async () => {
      const c = await montar();
      const p = await pedidoDoTotem(c, [a.item(c.protetor, { quantidade: 2 })]);
      await a.decidir(p, [true]);
      const lote = await a.repor(c.protetor, null, 4);
      const antes = await a.fotografia();
      await a.entregar(p, [{ itemId: p.itens[0], loteId: lote, quantidade: 2 }]);
      assert.equal((await a.q('SELECT status FROM solicitacoes_epi WHERE id = $1', [p.id])).rows[0].status, 'ENTREGUE');
      const depois = await a.fotografia();
      assert.equal(depois.entregas, antes.entregas + 1);
      assert.ok(depois.fichas >= antes.fichas);
    });

    test('K4 — NÃO é preciso migration: a consulta por funcionário em aberto é atendida pelo índice existente (empresa, funcionário, criada_em DESC, id DESC) e a numeração/estruturas da 065/066/086 bastam', async () => {
      const r = await a.q("SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_solicitacoes_epi_funcionario'");
      assert.equal(r.rows.length, 1);
      const status = (await a.q("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'chk_solicitacoes_epi_status'")).rows[0].def;
      for (const s of ['PENDENTE', 'APROVADA', 'APROVADA_PARCIAL', 'REPROVADA', 'CANCELADA', 'ENTREGUE', 'ENCERRADA']) assert.ok(status.includes(s), s);
    });

    test('K5 — o contrato da Etapa F continua o mesmo com a G montada ao lado: 201 com as chaves de sempre, resultado pela chave só no atendimento original e o catálogo da E intacto', async () => {
      const c = await montar();
      const payload = a.corpo([a.item(c.protetor)]);
      const r = await a.finalizar(app, c.t, c.token, payload);
      assert.equal(r.status, 201, aviso(r));
      assert.deepEqual(Object.keys(r.body.pedido).sort(), [...CHAVES_DO_PEDIDO]);
      const original = await a.resultado(app, c.t, c.token, payload.chaveIdempotencia);
      assert.deepEqual([original.status, original.body.pedido.estado], [200, 'REGISTRADO']);
      const novo = await a.reabrir(app, c);
      const outroAtendimento = await a.resultado(app, c.t, novo.token, payload.chaveIdempotencia);
      assert.deepEqual([outroAtendimento.status, outroAtendimento.body.codigo], [404, 'PEDIDO_NAO_ENCONTRADO'], 'a recuperação da F continua vinculada ao atendimento original');
      assert.equal((await a.catalogo(app, c.t, novo.token)).status, 200);
    });
  });

  // ───────────── endpoint novo: o que o funcionário vê ─────────────
  describe('consulta das solicitações existentes (endpoint novo)', () => {
    test('G1 — funcionário ATIVO com pedidos existentes: 200 com a forma exata (temDisponiveis, itens) e só os campos mínimos de cada item; mistura disponível (pedido interno) e aguardando aprovação (pedido do Totem)', async () => {
      const c = await montar();
      const interna = await a.criarInterna(c.f.id, [{ materialId: c.protetor, quantidade: 2 }]);
      await a.decidir(interna, [true]);
      await a.repor(c.protetor, null, 5);
      await pedidoDoTotem(c, [a.item(c.botina, { tamanho: 'M', quantidade: 1, motivo: 'DESGASTE_DANO' })]);
      const corpo = await ler(c);
      assert.deepEqual(Object.keys(corpo).sort(), [...CHAVES_DA_RESPOSTA]);
      assert.equal(corpo.status, 'ok');
      assert.equal(corpo.temDisponiveis, true);
      for (const item of corpo.itens) assert.deepEqual(Object.keys(item).sort(), [...CHAVES_DO_ITEM]);
      assert.deepEqual(corpo.itens, [
        L(c.protetor, NOMES.protetor, null, 'DISPONIVEL_PARA_RETIRADA', 2),
        L(c.botina, NOMES.botina, 'M', 'AGUARDANDO_APROVACAO', 1),
      ]);
    });

    test('G2 — funcionário SEM pedidos: 200 com lista vazia e temDisponiveis false (não é erro, não é 404)', async () => {
      const c = await montar();
      const r = await a.consultarSolicitacoes(app, c.t, c.token);
      assert.equal(r.status, 200, aviso(r));
      assert.deepEqual(r.body, { status: 'ok', temDisponiveis: false, itens: [] });
    });

    test('G3 — pedido AGUARDANDO APROVAÇÃO da SST (PENDENTE): linha AGUARDANDO_APROVACAO com a quantidade solicitada; nunca como disponível', async () => {
      const c = await montar();
      await pedidoDoTotem(c, [a.item(c.botina, { tamanho: 'G', quantidade: 3 })]);
      const corpo = await ler(c);
      assert.deepEqual(corpo.itens, [L(c.botina, NOMES.botina, 'G', 'AGUARDANDO_APROVACAO', 3)]);
      assert.equal(corpo.temDisponiveis, false);
    });

    test('G4 — pedido APROVADO SEM ESTOQUE: linha AGUARDANDO_ESTOQUE com a quantidade pendente; temDisponiveis false (aprovar não cria disponibilidade)', async () => {
      const c = await montar();
      const s = await a.criarInterna(c.f.id, [{ materialId: c.protetor, quantidade: 3 }]);
      await a.decidir(s, [true]);
      const corpo = await ler(c);
      assert.deepEqual(corpo.itens, [L(c.protetor, NOMES.protetor, null, 'AGUARDANDO_ESTOQUE', 3)]);
      assert.equal(corpo.temDisponiveis, false);
    });

    test('G5 — MATERIAL DISPONÍVEL para retirada: aprovado com estoque do MESMO material e tamanho vira DISPONIVEL_PARA_RETIRADA (temDisponiveis true); estoque de outro tamanho ou de outro material não conta', async () => {
      const c = await montar();
      const s = await a.criarInterna(c.f.id, [{ materialId: c.botina, tamanho: 'M', quantidade: 2 }, { materialId: c.protetor, quantidade: 1 }]);
      await a.decidir(s, [true, true]);
      await a.repor(c.botina, 'G', 10); // outro tamanho
      await a.repor(c.capacete, null, 10); // outro material
      let corpo = await ler(c);
      assert.equal(corpo.temDisponiveis, false);
      assert.deepEqual(corpo.itens.map((i) => i.situacao), ['AGUARDANDO_ESTOQUE', 'AGUARDANDO_ESTOQUE']);
      await a.repor(c.botina, 'M', 2);
      corpo = await ler(c);
      assert.equal(corpo.temDisponiveis, true);
      assert.deepEqual(corpo.itens, [L(c.botina, NOMES.botina, 'M', 'DISPONIVEL_PARA_RETIRADA', 2), L(c.protetor, NOMES.protetor, null, 'AGUARDANDO_ESTOQUE', 1)]);
    });

    test('G6 — pedido PARCIALMENTE ATENDIDO: aprovado 5 com 2 em estoque são DUAS linhas (2 disponíveis e 3 aguardando estoque); depois de entregar 2, restam 3 com retiradaParcial true, primeiro sem estoque e depois disponíveis com a reposição', async () => {
      const c = await montar();
      const s = await a.criarInterna(c.f.id, [{ materialId: c.protetor, quantidade: 5 }]);
      await a.decidir(s, [true]);
      const lote = await a.repor(c.protetor, null, 2);
      let corpo = await ler(c);
      assert.deepEqual(corpo.itens, [L(c.protetor, NOMES.protetor, null, 'DISPONIVEL_PARA_RETIRADA', 2), L(c.protetor, NOMES.protetor, null, 'AGUARDANDO_ESTOQUE', 3)]);
      assert.equal(corpo.temDisponiveis, true);
      await a.entregar(s, [{ itemId: s.itens[0], loteId: lote, quantidade: 2 }]);
      corpo = await ler(c);
      assert.deepEqual(corpo.itens, [L(c.protetor, NOMES.protetor, null, 'AGUARDANDO_ESTOQUE', 3, true)]);
      assert.equal(corpo.temDisponiveis, false);
      await a.repor(c.protetor, null, 5);
      corpo = await ler(c);
      assert.deepEqual(corpo.itens, [L(c.protetor, NOMES.protetor, null, 'DISPONIVEL_PARA_RETIRADA', 3, true)]);
    });

    test('G7 — pedido ENTREGUE (inteiramente) sai da consulta, e só depois da entrega física efetiva: antes, com estoque, ainda é disponível; o do Totem, entregue, também some', async () => {
      const c = await montar();
      const s = await a.criarInterna(c.f.id, [{ materialId: c.protetor, quantidade: 2 }]);
      await a.decidir(s, [true]);
      const lote = await a.repor(c.protetor, null, 2);
      assert.deepEqual((await ler(c)).itens.map((i) => i.situacao), ['DISPONIVEL_PARA_RETIRADA'], 'antes da entrega física continua disponível');
      await a.entregar(s, [{ itemId: s.itens[0], loteId: lote, quantidade: 2 }]);
      assert.deepEqual(await ler(c), { status: 'ok', temDisponiveis: false, itens: [] });
      const p = await pedidoDoTotem(c, [a.item(c.capacete, { quantidade: 1 })]);
      await a.decidir(p, [true]);
      const outroLote = await a.repor(c.capacete, null, 1);
      await a.entregar(p, [{ itemId: p.itens[0], loteId: outroLote, quantidade: 1 }]);
      assert.deepEqual(await ler(c), { status: 'ok', temDisponiveis: false, itens: [] });
    });

    test('G8 — pedido CANCELADO, REPROVADO ou ENCERRADO não aparece (nada em aberto), e nenhum deles é apresentado como disponível', async () => {
      const c = await montar();
      const cancelada = await a.criarInterna(c.f.id, [{ materialId: c.protetor, quantidade: 1 }]);
      await a.cancelar(cancelada);
      const reprovada = await a.criarInterna(c.f.id, [{ materialId: c.capacete, quantidade: 1 }]);
      await a.decidir(reprovada, [false]);
      const encerrada = await a.criarInterna(c.f.id, [{ materialId: c.botina, tamanho: 'P', quantidade: 1 }]);
      await a.decidir(encerrada, [true]);
      await a.repor(c.botina, 'P', 3);
      await a.encerrarPedido(encerrada);
      await a.repor(c.protetor, null, 3);
      await a.repor(c.capacete, null, 3);
      assert.deepEqual(await ler(c), { status: 'ok', temDisponiveis: false, itens: [] });
    });

    test('G9 — pedido com VÁRIOS ITENS: cada item tem a sua situação; o item reprovado dentro do pedido aprovado não aparece; vários pedidos somam por material, tamanho e situação', async () => {
      const c = await montar();
      const s = await a.criarInterna(c.f.id, [{ materialId: c.protetor, quantidade: 1 }, { materialId: c.capacete, quantidade: 2 }, { materialId: c.botina, tamanho: 'G', quantidade: 1 }]);
      await a.decidir(s, [true, true, false]); // na ordem de entrada: protetor, capacete, botina (reprovada)
      await a.repor(c.protetor, null, 5);
      // Pedido interno (e não do Totem) de propósito: a regra futura de duplicidade vale para o canal AUTOATENDIMENTO, e este teste soma pedidos do mesmo material.
      await a.criarInterna(c.f.id, [{ materialId: c.botina, tamanho: 'P', quantidade: 1 }, { materialId: c.capacete, quantidade: 4 }]);
      const outra = await a.criarInterna(c.f.id, [{ materialId: c.capacete, quantidade: 3 }]);
      await a.decidir(outra, [true]);
      const corpo = await ler(c);
      assert.deepEqual(corpo.itens, [
        L(c.protetor, NOMES.protetor, null, 'DISPONIVEL_PARA_RETIRADA', 1),
        L(c.capacete, NOMES.capacete, null, 'AGUARDANDO_ESTOQUE', 5),
        L(c.botina, NOMES.botina, 'P', 'AGUARDANDO_APROVACAO', 1),
        L(c.capacete, NOMES.capacete, null, 'AGUARDANDO_APROVACAO', 4),
      ]);
    });

    test('G10 — MESMO material com TAMANHOS diferentes são linhas separadas, na ordem do tamanho; cada tamanho usa o estoque do seu próprio tamanho', async () => {
      const c = await montar();
      const s = await a.criarInterna(c.f.id, [{ materialId: c.botina, tamanho: 'P', quantidade: 1 }, { materialId: c.botina, tamanho: 'M', quantidade: 2 }, { materialId: c.botina, tamanho: 'G', quantidade: 3 }]);
      await a.decidir(s, [true, true, true]);
      await a.repor(c.botina, 'M', 2);
      const corpo = await ler(c);
      assert.deepEqual(corpo.itens, [
        L(c.botina, NOMES.botina, 'M', 'DISPONIVEL_PARA_RETIRADA', 2),
        L(c.botina, NOMES.botina, 'G', 'AGUARDANDO_ESTOQUE', 3),
        L(c.botina, NOMES.botina, 'P', 'AGUARDANDO_ESTOQUE', 1),
      ]);
    });

    test('G11 — material SEM exigência de tamanho: tamanho é null (a chave existe e é null, nunca texto vazio nem ausente)', async () => {
      const c = await montar();
      await pedidoDoTotem(c, [a.item(c.protetor, { quantidade: 2 })]);
      const [item] = (await ler(c)).itens;
      assert.ok(Object.prototype.hasOwnProperty.call(item, 'tamanho'));
      assert.strictEqual(item.tamanho, null);
    });

    test('G12 — QUANTIDADE parcialmente entregue: aprovado 3, entregue 1 → o item mostra a quantidade que ainda falta (2), marca retiradaParcial, e a cobertura é calculada sobre o PENDENTE', async () => {
      const c = await montar();
      const s = await a.criarInterna(c.f.id, [{ materialId: c.protetor, quantidade: 3 }]);
      await a.decidir(s, [true]);
      const lote = await a.repor(c.protetor, null, 3);
      await a.entregar(s, [{ itemId: s.itens[0], loteId: lote, quantidade: 1 }]);
      const corpo = await ler(c);
      assert.deepEqual(corpo.itens, [L(c.protetor, NOMES.protetor, null, 'DISPONIVEL_PARA_RETIRADA', 2, true)]);
    });

    test('G12b — item TOTALMENTE entregue dentro de um pedido que ainda tem outro item pendente sai da consulta (só o pendente aparece); depois de entregue o resto, o pedido todo some', async () => {
      const c = await montar();
      const s = await a.criarInterna(c.f.id, [{ materialId: c.protetor, quantidade: 2 }, { materialId: c.capacete, quantidade: 1 }]);
      await a.decidir(s, [true, true]);
      const lote = await a.repor(c.protetor, null, 2);
      await a.entregar(s, [{ itemId: s.itens[0], loteId: lote, quantidade: 2 }]);
      assert.deepEqual((await ler(c)).itens, [L(c.capacete, NOMES.capacete, null, 'AGUARDANDO_ESTOQUE', 1)]);
      const loteCapacete = await a.repor(c.capacete, null, 1);
      assert.deepEqual((await ler(c)).itens, [L(c.capacete, NOMES.capacete, null, 'DISPONIVEL_PARA_RETIRADA', 1)]);
      await a.entregar(s, [{ itemId: s.itens[1], loteId: loteCapacete, quantidade: 1 }]);
      assert.deepEqual(await ler(c), { status: 'ok', temDisponiveis: false, itens: [] });
    });

    test('G17 — ISOLAMENTO multiempresa: pedidos, materiais e estoque de mesmo nome na empresa B nunca aparecem para o funcionário da A, e vice-versa', async () => {
      const c = await montar();
      const s = await a.criarInterna(c.f.id, [{ materialId: c.protetor, quantidade: 2 }]);
      await a.decidir(s, [true]);
      const gheB = await a.ghe(a.d.empresaB);
      const protetorB = await a.material(a.d.empresaB, { nome: NOMES.protetor, exigeTamanho: false });
      await a.vincularMaterial(a.d.empresaB, gheB, protetorB);
      await a.redes({ A: a.redeDeTeste.A, B: a.redeDeTeste.A });
      const cb = await a.cenario(app, { empresaId: a.d.empresaB, gheId: gheB });
      const usuarioB = await a.usuario(a.d.empresaB);
      const sb = await solicitacaoSvc.criarSolicitacao(a.ctx.pool, {
        empresaId: a.d.empresaB, atorId: usuarioB, funcionarioId: cb.f.id, itens: [{ materialId: protetorB, tamanho: null, quantidade: 7, motivo: 'ADMISSAO' }], chaveIdempotencia: a.chave(),
      });
      await solicitacaoSvc.decidirSolicitacao(a.ctx.pool, { empresaId: a.d.empresaB, atorId: a.d.sstB, solicitacaoId: sb.solicitacao.id, decisoes: [{ itemId: sb.itens[0].id, decisao: 'APROVADO' }], hoje: dataOperacional() });
      await a.repor(protetorB, null, 9, { empresaId: a.d.empresaB });
      assert.deepEqual((await ler(c)).itens, [L(c.protetor, NOMES.protetor, null, 'AGUARDANDO_ESTOQUE', 2)]);
      assert.deepEqual((await ler(cb)).itens, [L(protetorB, NOMES.protetor, null, 'DISPONIVEL_PARA_RETIRADA', 7)]);
    });

    test('G18 — OUTRO funcionário não é consultável: o pedido de outro trabalhador do mesmo GHE nunca aparece; cpf, matrícula, funcionarioId, empresaId, gheId ou atendimentoId na consulta são 400 VALIDACAO e cabeçalhos x-* não mudam o dono', async () => {
      const c = await montar();
      const outro = await a.funcionarioNoGhe(A(), c.ghe);
      const dele = await a.criarInterna(outro.id, [{ materialId: c.capacete, quantidade: 9 }]);
      await a.decidir(dele, [true]);
      await a.repor(c.capacete, null, 9);
      assert.deepEqual(await ler(c), { status: 'ok', temDisponiveis: false, itens: [] });
      for (const query of [`funcionarioId=${outro.id}`, `cpf=${outro.cpf}`, `matricula=${outro.matricula}`, `empresaId=${A()}`, `gheId=${c.ghe}`, `atendimentoId=${c.atendimentoId}`, 'incluirEntregues=true', 'pagina=1']) {
        const r = await a.consultarComQuery(app, c.t, c.token, query);
        assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], `${query}: ${aviso(r)}`);
      }
      const disfarce = await a.consultarSolicitacoes(app, c.t, c.token, { 'x-funcionario-id': String(outro.id), 'x-empresa-id': String(A()) });
      assert.equal(disfarce.status, 200, aviso(disfarce));
      assert.deepEqual(disfarce.body.itens, []);
    });

    test('G19 — tablet REVOGADO: 401 DISPOSITIVO_NAO_AUTORIZADO (a consulta não distingue o motivo) e nada é lido do funcionário', async () => {
      const c = await montar();
      assert.equal((await a.comoAdmin(app, gestor).post(`/api/atendimento-token/dispositivos/${c.t.id}/revogar`)).status, 200);
      const r = await a.consultarSolicitacoes(app, c.t, c.token);
      assert.deepEqual([r.status, r.body.codigo], NAO_AUTORIZADO, aviso(r));
      assert.equal(JSON.stringify(r.body).includes('itens'), false);
    });

    test('G20 — atendimento EXPIRADO, ENCERRADO, inexistente, sem cookie ou de funcionário INATIVADO: 401 ATENDIMENTO_INVALIDO, sem dado algum; a consulta não fecha nem reabre o atendimento', async () => {
      const expirado = await montar();
      await forcarRestante(expirado.atendimentoId, -10);
      const r1 = await a.consultarSolicitacoes(app, expirado.t, expirado.token);
      assert.deepEqual([r1.status, r1.body.codigo], ATENDIMENTO_INVALIDO, aviso(r1));
      assert.equal((await a.atendimento(expirado.atendimentoId)).encerrado_em, null, 'a consulta não fecha o vencido (quem fecha é a Etapa D)');

      const encerrado = await montar();
      await a.finalizar(app, encerrado.t, encerrado.token, a.corpo([a.item(encerrado.protetor)])); // PEDIDO_ENVIADO
      const r2 = await a.consultarSolicitacoes(app, encerrado.t, encerrado.token);
      assert.deepEqual([r2.status, r2.body.codigo], ATENDIMENTO_INVALIDO, aviso(r2));

      const c = await montar();
      const r3 = await a.consultarSolicitacoes(app, c.t, null);
      assert.deepEqual([r3.status, r3.body.codigo], ATENDIMENTO_INVALIDO, aviso(r3));
      const r4 = await a.consultarSolicitacoes(app, c.t, 'a'.repeat(43));
      assert.deepEqual([r4.status, r4.body.codigo], ATENDIMENTO_INVALIDO, aviso(r4));
      await a.q("UPDATE funcionarios SET situacao = 'INATIVO' WHERE id = $1", [c.f.id]);
      const r5 = await a.consultarSolicitacoes(app, c.t, c.token);
      assert.deepEqual([r5.status, r5.body.codigo], ATENDIMENTO_INVALIDO, aviso(r5));
    });

    test('G21 — atendimento SUBSTITUÍDO: o token antigo recebe 401 e nunca vê os pedidos do funcionário seguinte; o novo atendimento vê só os do seu funcionário', async () => {
      const c = await montar();
      const s = await a.criarInterna(c.f.id, [{ materialId: c.protetor, quantidade: 1 }]);
      await a.decidir(s, [true]);
      const seguinte = await a.funcionarioNoGhe(A(), c.ghe);
      const dele = await a.criarInterna(seguinte.id, [{ materialId: c.capacete, quantidade: 5 }]);
      await a.decidir(dele, [true]);
      const r = await a.identificar(app, c.t.credencial, { tipo: 'CPF', valor: seguinte.cpf });
      assert.equal(r.status, 201, aviso(r));
      const tokenNovo = cookieDoAtendimentoNaResposta(r).valor;
      const antigo = await a.consultarSolicitacoes(app, c.t, c.token);
      assert.deepEqual([antigo.status, antigo.body.codigo], ATENDIMENTO_INVALIDO, aviso(antigo));
      const novo = await a.consultarSolicitacoes(app, c.t, tokenNovo);
      assert.deepEqual(novo.body.itens, [L(c.capacete, NOMES.capacete, null, 'AGUARDANDO_ESTOQUE', 5)]);
    });

    test('G22 — REATIVAÇÃO administrativa do tablet: o atendimento aberto ANTES da reativação é 401 com a credencial nova; um atendimento aberto depois consulta normalmente; a credencial antiga é 401', async () => {
      const c = await montar();
      const nova = cookieDoTabletNaResposta(await a.ativar(app, await gerarCodigo(c.t.id))).valor;
      const antiga = await a.consultarSolicitacoes(app, c.t, c.token);
      assert.deepEqual([antiga.status, antiga.body.codigo], NAO_AUTORIZADO, aviso(antiga));
      const anterior = await a.consultarSolicitacoes(app, { credencial: nova }, c.token);
      assert.deepEqual([anterior.status, anterior.body.codigo], ATENDIMENTO_INVALIDO, aviso(anterior));
      const depois = await a.identificar(app, nova, { tipo: 'CPF', valor: c.f.cpf });
      assert.equal(depois.status, 201, aviso(depois));
      const ok = await a.consultarSolicitacoes(app, { credencial: nova }, cookieDoAtendimentoNaResposta(depois).valor);
      assert.equal(ok.status, 200, aviso(ok));
    });

    test('G23 — a consulta NÃO renova os 60 s: várias consultas (e o polling) deixam expira_em intocado, não emitem nem renovam cookie; só a atividade da Etapa D renova', async () => {
      const c = await montar();
      await forcarRestante(c.atendimentoId, 20);
      const antes = JSON.stringify(await a.atendimento(c.atendimentoId));
      for (let i = 0; i < 6; i += 1) {
        const r = await a.consultarSolicitacoes(app, c.t, c.token);
        assert.equal(r.status, 200, aviso(r));
        assert.deepEqual(lerSetCookie(r), [], 'nenhuma consulta emite ou renova cookie');
      }
      assert.equal(JSON.stringify(await a.atendimento(c.atendimentoId)), antes);
      const atividade = await a.prorrogar(app, c.t, c.token);
      assert.ok(atividade.body.atendimento.restanteSegundos > 55);
    });

    test('G24 — a consulta NÃO ALTERA nada: pedidos, decisões, estoque, entregas, ficha, auditoria e o atendimento ficam idênticos, com dados em todos os estados', async () => {
      const c = await montar();
      const s = await a.criarInterna(c.f.id, [{ materialId: c.protetor, quantidade: 5 }, { materialId: c.botina, tamanho: 'M', quantidade: 1 }]);
      await a.decidir(s, [true, true]);
      await a.repor(c.protetor, null, 2);
      await pedidoDoTotem(c, [a.item(c.capacete)]);
      const antes = await a.fotografiaDaConsulta(c.atendimentoId);
      for (let i = 0; i < 3; i += 1) assert.equal((await a.consultarSolicitacoes(app, c.t, c.token)).status, 200);
      assert.deepEqual(await a.fotografiaDaConsulta(c.atendimentoId), antes);
    });

    test('G25 — ESTADOS DERIVADOS corretamente da 12G-6: numa matriz de cenários (pendente, aprovado sem/com/parcial estoque, parcialmente entregue, FIFO entre trabalhadores; a suspensão por material inativo é exercitada em G28) a resposta é exatamente o derivado pelas funções reais da 12G-6', async () => {
      const c = await montar();
      const outro = await a.funcionarioNoGhe(A(), c.ghe);
      const antigo = await a.criarInterna(outro.id, [{ materialId: c.protetor, quantidade: 2 }]); // mais antigo: consome o estoque primeiro (FIFO)
      await a.decidir(antigo, [true]);
      const meu1 = await a.criarInterna(c.f.id, [{ materialId: c.protetor, quantidade: 3 }, { materialId: c.botina, tamanho: 'P', quantidade: 2 }]);
      await a.decidir(meu1, [true, true]);
      const meu2 = await a.criarInterna(c.f.id, [{ materialId: c.capacete, quantidade: 4 }]);
      await a.decidir(meu2, [true]);
      await a.repor(c.protetor, null, 3); // 2 do antigo + 1 do meu
      await a.repor(c.botina, 'P', 1);
      await a.repor(c.capacete, null, 4);
      const lote = (await a.q('SELECT id FROM estoque_lotes WHERE material_id = $1', [c.capacete])).rows[0].id;
      await a.entregar(meu2, [{ itemId: meu2.itens[0], loteId: lote, quantidade: 1 }]);
      await pedidoDoTotem(c, [a.item(c.botina, { tamanho: 'G' })]);
      const semEstoque = await a.criarInterna(c.f.id, [{ materialId: c.botina, tamanho: 'M', quantidade: 1 }]);
      await a.decidir(semEstoque, [true]);

      const esperado = await esperadoPelaDozeG(c.f.id);
      assert.ok(esperado.length >= 4, 'a matriz precisa exercitar vários estados');
      assert.deepEqual((await ler(c)).itens, esperado);
    });

    test('G26 — SEM VAZAMENTO de dados: nenhum CPF, matrícula, nome do funcionário, número ou id de solicitação/item, justificativa, observação, decisor, solicitante, empresa, GHE, estoque ou credencial na resposta; só as chaves do contrato em qualquer nível', async () => {
      const c = await montar({ funcionario: { nome: 'Zeferino Quintanilha Ferreira' } });
      const s = await a.criarInterna(c.f.id, [{ materialId: c.protetor, quantidade: 2 }]);
      await a.decidir(s, [true]);
      await a.repor(c.protetor, null, 50);
      await pedidoDoTotem(c, [a.item(c.botina, { tamanho: 'M' })]);
      const r = await a.consultarSolicitacoes(app, c.t, c.token);
      assert.equal(r.status, 200, aviso(r));
      const texto = JSON.stringify(r.body);
      for (const proibido of [c.f.cpf, c.f.matricula, 'Zeferino', 'Quintanilha', 'numero', 'solicitacaoId', 'itemId', 'justificativa', 'observacao', 'decis', 'solicitante', 'empresa', 'ghe', 'saldo', 'lote', 'token', 'credencial', 'cpf', 'matricula', 'funcionario', 'origem']) {
        assert.equal(texto.toLowerCase().includes(String(proibido).toLowerCase()), false, `a resposta não pode conter "${proibido}"`);
      }
      assert.deepEqual(Object.keys(r.body).sort(), [...CHAVES_DA_RESPOSTA]);
      for (const item of r.body.itens) {
        assert.deepEqual(Object.keys(item).sort(), [...CHAVES_DO_ITEM]);
        assert.ok(SITUACOES.includes(item.situacao));
      }
      assert.equal(r.body.itens.some((i) => i.quantidade === 50), false, 'a quantidade em estoque (50) nunca aparece, só a que cabe ao funcionário (2)');
    });

    test('G27 — compatível com a ETAPA F congelada: o pedido registrado pelo fluxo da F aparece na consulta do atendimento seguinte (AGUARDANDO_APROVACAO), o atendimento do pedido segue encerrado e a recuperação da F continua só no atendimento original', async () => {
      const c = await montar();
      const payload = a.corpo([a.item(c.botina, { tamanho: 'P', quantidade: 2, motivo: 'PERDA_EXTRAVIO' })]);
      const feito = await a.finalizar(app, c.t, c.token, payload);
      assert.equal(feito.status, 201, aviso(feito));
      assert.equal((await a.atendimento(c.atendimentoId)).motivo_encerramento, 'PEDIDO_ENVIADO');
      const novo = await a.reabrir(app, c);
      const corpo = await ler({ ...c, token: novo.token });
      assert.deepEqual(corpo.itens, [L(c.botina, NOMES.botina, 'P', 'AGUARDANDO_APROVACAO', 2)]);
      const alheio = await a.resultado(app, c.t, novo.token, payload.chaveIdempotencia);
      assert.deepEqual([alheio.status, alheio.body.codigo], [404, 'PEDIDO_NAO_ENCONTRADO'], 'consultar os pedidos não é recuperar a resposta original');
    });

    test('G28 — o aviso de retirada vem SÓ de disponibilidade verdadeira: CA vencido, estoque consumido por pedido mais antigo (FIFO), material inativado e estoque de outro tamanho NÃO geram temDisponiveis; só coberta > 0 gera', async () => {
      const c = await montar();
      const outro = await a.funcionarioNoGhe(A(), c.ghe);
      const antigo = await a.criarInterna(outro.id, [{ materialId: c.capacete, quantidade: 3 }]);
      await a.decidir(antigo, [true]);
      await a.repor(c.capacete, null, 3); // todo o estoque é do pedido mais antigo
      const meu = await a.criarInterna(c.f.id, [{ materialId: c.capacete, quantidade: 1 }, { materialId: c.protetor, quantidade: 1 }, { materialId: c.botina, tamanho: 'G', quantidade: 1 }]);
      await a.decidir(meu, [true, true, true]);
      await a.repor(c.protetor, null, 5, { caValidade: '2000-01-01' }); // CA vencido: não é utilizável
      await a.repor(c.botina, 'P', 5); // outro tamanho
      let corpo = await ler(c);
      assert.equal(corpo.temDisponiveis, false);
      assert.deepEqual(corpo.itens.map((i) => i.situacao), ['AGUARDANDO_ESTOQUE', 'AGUARDANDO_ESTOQUE', 'AGUARDANDO_ESTOQUE']);

      await a.repor(c.botina, 'G', 1);
      corpo = await ler(c);
      assert.equal(corpo.temDisponiveis, true);
      assert.deepEqual(corpo.itens.filter((i) => i.situacao === 'DISPONIVEL_PARA_RETIRADA'), [L(c.botina, NOMES.botina, 'G', 'DISPONIVEL_PARA_RETIRADA', 1)]);

      await a.q('UPDATE materiais SET ativo = false WHERE id = $1', [c.botina]);
      corpo = await ler(c);
      assert.equal(corpo.temDisponiveis, false, 'material inativado: não há retirada');
      assert.deepEqual(corpo.itens.filter((i) => i.materialId === c.botina), [L(c.botina, NOMES.botina, 'G', 'INDISPONIVEL', 1)]);
    });

    test('G29 — o funcionário CONTINUA podendo solicitar outros materiais autorizados: com pedidos em aberto, o catálogo segue completo e um pedido de outro material é aceito (201) pelo fluxo da F', async () => {
      const c = await montar();
      await pedidoDoTotem(c, [a.item(c.botina, { tamanho: 'M' })]);
      const catalogo = await a.catalogo(app, c.t, c.token);
      assert.equal(catalogo.status, 200, aviso(catalogo));
      assert.deepEqual(catalogo.body.catalogo.materiais.map((m) => m.id).sort((x, y) => x - y), [c.botina, c.protetor, c.capacete].sort((x, y) => x - y));
      const novo = await a.finalizar(app, c.t, c.token, a.corpo([a.item(c.protetor, { quantidade: 2 })]));
      assert.equal(novo.status, 201, aviso(novo));
    });
  });

  // ───────────── duplicidade entre atendimentos: não-bloqueios (passam já) e bloqueios (contrato pendente) ─────────────
  describe('prevenção de duplicidade entre atendimentos', () => {
    test('G14 — MATERIAL DIFERENTE é permitido com outro pendente (controle que deve continuar passando depois da regra)', async () => {
      const c = await montar();
      await pedidoDoTotem(c, [a.item(c.botina, { tamanho: 'M' })]);
      const r = await a.finalizar(app, c.t, c.token, a.corpo([a.item(c.capacete), a.item(c.protetor)]));
      assert.equal(r.status, 201, aviso(r));
    });

    test('G15 — pedido ANTIGO ENCERRADO não bloqueia novo (entregue, cancelado, reprovado e encerrado do mesmo material e tamanho): 201 em todos', async () => {
      for (const fim of ['entregue', 'cancelado', 'reprovado', 'encerrado']) {
        const c = await montar();
        const s = await a.criarInterna(c.f.id, [{ materialId: c.protetor, quantidade: 1 }]);
        if (fim === 'cancelado') await a.cancelar(s);
        else if (fim === 'reprovado') await a.decidir(s, [false]);
        else {
          await a.decidir(s, [true]);
          if (fim === 'entregue') { const lote = await a.repor(c.protetor, null, 1); await a.entregar(s, [{ itemId: s.itens[0], loteId: lote, quantidade: 1 }]); } else await a.encerrarPedido(s);
        }
        const r = await a.finalizar(app, c.t, c.token, a.corpo([a.item(c.protetor)]));
        assert.equal(r.status, 201, `${fim}: ${aviso(r)}`);
      }
    });

    test('G30f — OUTRO TAMANHO do mesmo material não é duplicidade, e item REPROVADO dentro de um pedido aprovado não bloqueia (controles: passam já e devem continuar passando)', async () => {
      const c = await montar();
      const s = await a.criarInterna(c.f.id, [{ materialId: c.protetor, quantidade: 1 }, { materialId: c.botina, tamanho: 'M', quantidade: 1 }]);
      await a.decidir(s, [true, false]); // protetor aprovado, botina M reprovada
      const r = await a.finalizar(app, c.t, c.token, a.corpo([a.item(c.botina, { tamanho: 'M' }), a.item(c.capacete)]));
      assert.equal(r.status, 201, aviso(r));
      const d = await montar();
      await pedidoDoTotem(d, [a.item(d.botina, { tamanho: 'M' })]);
      const outroTamanho = await a.finalizar(app, d.t, d.token, a.corpo([a.item(d.botina, { tamanho: 'G' })]));
      assert.equal(outroTamanho.status, 201, aviso(outroTamanho));
    });

    test('G30k — o canal INTERNO não é bloqueado (a 12G-6 permanece como está; exceções operacionais ficam no fluxo interno): um pedido interno do mesmo material e tamanho já pendente é aceito pelo serviço da 12G-6', async () => {
      const c = await montar();
      await pedidoDoTotem(c, [a.item(c.protetor)]);
      const interna = await a.criarInterna(c.f.id, [{ materialId: c.protetor, quantidade: 1 }]);
      assert.ok(interna.id);
      assert.equal((await a.solicitacoesDe(c.f.id)).length, 2);
    });

    const exigirBloqueio = (r, rotulo = '') => assert.deepEqual([r.status, r.body.codigo], [409, 'ITEM_JA_SOLICITADO'], `${rotulo} ${aviso(r)}`);

    test('G13 — MESMO material e tamanho com pedido PENDENTE (aguardando aprovação): o novo pedido do Totem é recusado com 409 ITEM_JA_SOLICITADO no caminho do item, sem criar nada nem consumir número, e o atendimento segue aberto', async () => {
      const c = await montar();
      await pedidoDoTotem(c, [a.item(c.botina, { tamanho: 'M', quantidade: 1 })]);
      const antes = await a.fotografia();
      const r = await a.finalizar(app, c.t, c.token, a.corpo([a.item(c.botina, { tamanho: 'M', quantidade: 2 })]));
      exigirBloqueio(r);
      assert.equal(r.body.detalhes?.[0]?.campo, 'body.itens[0].materialId');
      assert.deepEqual(await a.fotografia(), antes);
      assert.equal((await a.atendimento(c.atendimentoId)).encerrado_em, null);
    });

    test('G16 — duas finalizações SIMULTÂNEAS do mesmo funcionário em atendimentos de TABLETS diferentes (mesmo material e tamanho), determinístico (pool instrumentado, sem sleep): a primeira pausada dentro da transação, a segunda ESPERA a trava do trabalhador e, depois do COMMIT, é recusada com ITEM_JA_SOLICITADO; existe UM pedido só', async () => {
      const c = await montar();
      const t2 = await a.tabletNovo(A());
      const r2 = await a.identificar(app, t2.credencial, { tipo: 'CPF', valor: c.f.cpf });
      assert.equal(r2.status, 201, aviso(r2));
      const token2 = cookieDoAtendimentoNaResposta(r2).valor;
      const instr = a.poolInstrumentado([{ nome: 'gravando', casa: /INSERT INTO solicitacoes_epi\s*\(/, acao: 'pausar' }]);
      const lenta = a.criarApp({ pool: instr.pool });
      const primeira = a.finalizar(lenta, c.t, c.token, a.corpo([a.item(c.protetor)])).then((x) => x);
      let segunda;
      try {
        await Promise.race([instr.pausado('gravando'), primeira.then((x) => assert.fail(`a primeira terminou sem gravar: ${aviso(x)}`)), new Promise((_, rej) => setTimeout(() => rej(new Error('a primeira não chegou a gravar')), LIMITE_DE_SEGURANCA_MS))]);
        segunda = a.finalizar(app, t2, token2, a.corpo([a.item(c.protetor)])).then((x) => x);
        const prazo = Date.now() + LIMITE_DE_SEGURANCA_MS;
        let terminou = false;
        segunda.then(() => { terminou = true; });
        while (!terminou && (await esperando(instr.pid('gravando'))) === 0) {
          if (Date.now() > prazo) assert.fail('a segunda finalização não chegou a esperar a primeira');
          await new Promise((resolver) => setImmediate(resolver));
        }
        assert.equal(terminou, false, 'a segunda deveria ESPERAR a primeira terminar');
      } finally { instr.liberar('gravando'); }
      const [p1, p2] = [await primeira, await segunda];
      assert.equal(p1.status, 201, aviso(p1));
      exigirBloqueio(p2, 'segunda');
      assert.equal((await a.solicitacoesDe(c.f.id)).length, 1);
    });

    test('G30a — pedido APROVADO aguardando estoque ou já DISPONÍVEL para entrega também bloqueia o mesmo material e tamanho', async () => {
      const c = await montar();
      const s = await a.criarInterna(c.f.id, [{ materialId: c.protetor, quantidade: 1 }]);
      await a.decidir(s, [true]);
      exigirBloqueio(await a.finalizar(app, c.t, c.token, a.corpo([a.item(c.protetor)])), 'aguardando estoque');
      await a.repor(c.protetor, null, 1);
      exigirBloqueio(await a.finalizar(app, c.t, c.token, a.corpo([a.item(c.protetor)])), 'disponível');
    });

    test('G30b — pedido PARCIALMENTE entregue com pendente > 0 bloqueia; com pendente 0 (entregue) NÃO bloqueia', async () => {
      const c = await montar();
      const s = await a.criarInterna(c.f.id, [{ materialId: c.protetor, quantidade: 3 }]);
      await a.decidir(s, [true]);
      const lote = await a.repor(c.protetor, null, 3);
      await a.entregar(s, [{ itemId: s.itens[0], loteId: lote, quantidade: 1 }]);
      exigirBloqueio(await a.finalizar(app, c.t, c.token, a.corpo([a.item(c.protetor)])), 'pendente 2');
      await a.entregar(s, [{ itemId: s.itens[0], loteId: lote, quantidade: 2 }]);
      assert.equal((await a.finalizar(app, c.t, c.token, a.corpo([a.item(c.protetor)]))).status, 201, 'sem pendente não bloqueia');
    });

    test('G30c — pedido INTERNO (USUARIO_INTERNO) em aberto do mesmo material e tamanho conta como pendente para o Totem', async () => {
      const c = await montar();
      await a.criarInterna(c.f.id, [{ materialId: c.botina, tamanho: 'G', quantidade: 1 }]);
      exigirBloqueio(await a.finalizar(app, c.t, c.token, a.corpo([a.item(c.botina, { tamanho: 'G' })])));
    });

    test('G16b — CONCORRÊNCIA ENTRE CANAIS, determinística: um pedido INTERNO em criação (pausado dentro da transação, já com a trava do trabalhador) e um pedido do TOTEM equivalente: o Totem ESPERA a mesma trava do trabalhador e, depois do COMMIT interno, é recusado com ITEM_JA_SOLICITADO; só o pedido interno existe', async () => {
      const c = await montar();
      const instr = a.poolInstrumentado([{ nome: 'gravando', casa: /INSERT INTO solicitacoes_epi\s*\(/, acao: 'pausar' }]);
      const interna = solicitacaoSvc.criarSolicitacao(instr.pool, {
        empresaId: A(), atorId: await a.novoUsuario(), funcionarioId: c.f.id, itens: [{ materialId: c.protetor, tamanho: null, quantidade: 1, motivo: 'ADMISSAO' }], chaveIdempotencia: a.chave(),
      }).then((x) => x);
      let totem;
      try {
        await Promise.race([instr.pausado('gravando'), interna.then(() => assert.fail('a criação interna terminou sem gravar')), new Promise((_, rej) => setTimeout(() => rej(new Error('a criação interna não chegou a gravar')), LIMITE_DE_SEGURANCA_MS))]);
        totem = a.finalizar(app, c.t, c.token, a.corpo([a.item(c.protetor, { quantidade: 3 })])).then((x) => x);
        const prazo = Date.now() + LIMITE_DE_SEGURANCA_MS;
        let terminou = false;
        totem.then(() => { terminou = true; });
        while (!terminou && (await esperando(instr.pid('gravando'))) === 0) {
          if (Date.now() > prazo) assert.fail('o pedido do Totem não chegou a esperar a trava do trabalhador');
          await new Promise((resolver) => setImmediate(resolver));
        }
        assert.equal(terminou, false, 'o Totem deveria ESPERAR a criação interna (mesma trava do trabalhador)');
      } finally { instr.liberar('gravando'); }
      await interna;
      exigirBloqueio(await totem, 'Totem depois do interno');
      assert.equal((await a.solicitacoesDe(c.f.id)).length, 1, 'só o pedido interno foi persistido');
      assert.equal((await a.atendimento(c.atendimentoId)).encerrado_em, null, 'o atendimento do Totem segue aberto');
    });

    test('G16c — o inverso, por DESENHO (a 12G-6 não foi alterada e o fluxo interno é onde ficam as exceções): com o pedido do Totem em criação (pausado), a criação INTERNA espera a mesma trava e depois é aceita; os dois existem. A prevenção vale para o Totem, que nunca persiste uma duplicata de pedido já confirmado', async () => {
      const c = await montar();
      const instr = a.poolInstrumentado([{ nome: 'gravando', casa: /INSERT INTO solicitacoes_epi\s*\(/, acao: 'pausar' }]);
      const lenta = a.criarApp({ pool: instr.pool });
      const totem = a.finalizar(lenta, c.t, c.token, a.corpo([a.item(c.protetor)])).then((x) => x);
      let interna;
      try {
        await Promise.race([instr.pausado('gravando'), totem.then((x) => assert.fail(`o Totem terminou sem gravar: ${aviso(x)}`)), new Promise((_, rej) => setTimeout(() => rej(new Error('o Totem não chegou a gravar')), LIMITE_DE_SEGURANCA_MS))]);
        interna = a.criarInterna(c.f.id, [{ materialId: c.protetor, quantidade: 1 }]).then((x) => x);
        const prazo = Date.now() + LIMITE_DE_SEGURANCA_MS;
        let terminou = false;
        interna.then(() => { terminou = true; });
        while (!terminou && (await esperando(instr.pid('gravando'))) === 0) {
          if (Date.now() > prazo) assert.fail('a criação interna não chegou a esperar a trava do trabalhador');
          await new Promise((resolver) => setImmediate(resolver));
        }
        assert.equal(terminou, false, 'a criação interna deveria ESPERAR o Totem (mesma trava do trabalhador)');
      } finally { instr.liberar('gravando'); }
      assert.equal((await totem).status, 201);
      assert.ok((await interna).id);
      assert.equal((await a.solicitacoesDe(c.f.id)).length, 2);
    });

    test('G16d — QUATRO atendimentos (quatro tablets) do MESMO funcionário enviam o mesmo material e tamanho ao mesmo tempo: exatamente UM pedido é persistido, os outros recebem ITEM_JA_SOLICITADO (nunca 500, nunca 401), o número não tem lacuna e nenhum item duplicado existe', async () => {
      const c = await montar();
      const contextos = [{ t: c.t, token: c.token }];
      for (let i = 0; i < 3; i += 1) {
        const t = await a.tabletNovo(A());
        const r = await a.identificar(app, t.credencial, { tipo: 'CPF', valor: c.f.cpf });
        assert.equal(r.status, 201, aviso(r));
        contextos.push({ t, token: cookieDoAtendimentoNaResposta(r).valor });
      }
      const respostas = await Promise.all(contextos.map((x) => a.finalizar(app, x.t, x.token, a.corpo([a.item(c.botina, { tamanho: 'G' })]))));
      assert.equal(respostas.filter((r) => r.status === 201).length, 1, respostas.map((r) => `${r.status}:${r.body.codigo ?? ''}`).join(' '));
      for (const r of respostas.filter((x) => x.status !== 201)) exigirBloqueio(r);
      const pedidos = await a.solicitacoesDe(c.f.id);
      assert.equal(pedidos.length, 1);
      assert.equal((await a.itensDe(pedidos[0].id)).length, 1);
      assert.equal((await a.q('SELECT max(ultimo_numero)::int AS v FROM solicitacoes_epi_numeracao')).rows[0].v >= 1, true);
    });

    test('G30e — duplicidade POR ITEM: num pedido com dois itens aprovados em que um já foi TOTALMENTE entregue e o outro ainda tem pendente, o Totem pode pedir o item entregue (201) e NÃO pode pedir o que ainda está pendente (409)', async () => {
      for (const alvo of ['entregue', 'pendente']) {
        const c = await montar();
        const s = await a.criarInterna(c.f.id, [{ materialId: c.protetor, quantidade: 2 }, { materialId: c.capacete, quantidade: 1 }]);
        await a.decidir(s, [true, true]);
        const lote = await a.repor(c.protetor, null, 2);
        await a.entregar(s, [{ itemId: s.itens[0], loteId: lote, quantidade: 2 }]);
        const r = await a.finalizar(app, c.t, c.token, a.corpo([a.item(alvo === 'entregue' ? c.protetor : c.capacete)]));
        if (alvo === 'entregue') assert.equal(r.status, 201, `item já entregue não bloqueia: ${aviso(r)}`);
        else exigirBloqueio(r, 'item ainda pendente');
      }
    });

    test('G30g — o 409 só ocorre com duplicidade CONFIRMADA e a repetição idempotente não é duplicidade: depois de aceito, o MESMO envio (mesma chave, mesmo atendimento) devolve 200 repetida:true com o pedido original, apesar de o item agora estar em aberto; outro funcionário com o mesmo material pendente não bloqueia', async () => {
      const c = await montar();
      const payload = a.corpo([a.item(c.protetor, { quantidade: 2 })]);
      const primeira = await a.finalizar(app, c.t, c.token, payload);
      assert.equal(primeira.status, 201, aviso(primeira));
      const repeticao = await a.finalizar(app, c.t, c.token, payload);
      assert.equal(repeticao.status, 200, aviso(repeticao));
      assert.deepEqual([repeticao.body.repetida, repeticao.body.pedido], [true, primeira.body.pedido]);
      assert.equal((await a.solicitacoesDe(c.f.id)).length, 1);

      const outro = await a.cenario(app, { gheId: c.ghe });
      const dele = await a.finalizar(app, outro.t, outro.token, a.corpo([a.item(c.protetor)]));
      assert.equal(dele.status, 201, `outro funcionário não é bloqueado pelo pedido de ${c.f.id}: ${aviso(dele)}`);
    });

    test('G30l — a duplicidade é avaliada ITEM A ITEM: com vários itens no carrinho, o 409 aponta o item duplicado (qualquer posição, inclusive o último) e só ele', async () => {
      const c = await montar();
      await pedidoDoTotem(c, [a.item(c.capacete)]); // o capacete é o último material criado: o último na ordem canônica do carrinho
      const r = await a.finalizar(app, c.t, c.token, a.corpo([a.item(c.botina, { tamanho: 'P' }), a.item(c.protetor), a.item(c.capacete)]));
      exigirBloqueio(r);
      assert.deepEqual(r.body.detalhes.map((d) => d.campo), ['body.itens[2].materialId']);
      const livre = await a.finalizar(app, c.t, c.token, a.corpo([a.item(c.botina, { tamanho: 'P' }), a.item(c.protetor)]));
      assert.equal(livre.status, 201, aviso(livre));
    });

    test('G30d — a recusa não revela o pedido existente: o corpo do 409 não traz número, id, origem, quem pediu nem a situação; um carrinho com um item bloqueado e outro livre é recusado inteiro (atômico)', async () => {
      const c = await montar();
      await pedidoDoTotem(c, [a.item(c.protetor)]);
      const antes = await a.fotografia();
      const r = await a.finalizar(app, c.t, c.token, a.corpo([a.item(c.capacete), a.item(c.protetor)]));
      exigirBloqueio(r);
      const texto = JSON.stringify(r.body).toLowerCase();
      for (const proibido of ['numero', 'origem', 'solicitante', 'aguardando', 'pendente', 'aprovad']) assert.equal(texto.includes(proibido), false, proibido);
      assert.deepEqual(await a.fotografia(), antes, 'nenhum item do carrinho foi gravado');
    });
  });
});

/**
 * ORÁCULO DO TESTE (G25): o derivado por funções REAIS da 12G-6 — itens com entregue derivada, cobertura FIFO contra a fila inteira da empresa,
 * situação do item — agregado por material, tamanho e situação. Não é a implementação da G: só lê o que a 12G-6 já calcula.
 */
async function esperadoPelaDozeG(funcionarioId) {
  const { rows: pedidos } = await esperadoPelaDozeG.pool.query(
    `SELECT id, status FROM solicitacoes_epi WHERE empresa_id = $1 AND funcionario_id = $2 AND status IN ('PENDENTE', 'APROVADA', 'APROVADA_PARCIAL') ORDER BY id`,
    [esperadoPelaDozeG.empresaId, funcionarioId],
  );
  const ids = pedidos.map((p) => p.id);
  const itens = await itemRepo.listarPorSolicitacoesComEntregue(esperadoPelaDozeG.pool, esperadoPelaDozeG.empresaId, ids);
  const aprovados = pedidos.filter((p) => p.status !== 'PENDENTE').map((p) => p.id);
  const cobertura = await coberturaRepo.listarCoberturaDasSolicitacoes(esperadoPelaDozeG.pool, esperadoPelaDozeG.empresaId, { hoje: dataOperacional(), solicitacaoIds: aprovados });
  const porItem = new Map(cobertura.map((c) => [c.itemId, c]));
  const nomes = new Map((await esperadoPelaDozeG.pool.query('SELECT id, nome FROM materiais WHERE empresa_id = $1', [esperadoPelaDozeG.empresaId])).rows.map((m) => [m.id, m.nome]));
  const grupos = new Map();
  const somar = (item, situacao, quantidade, parcial) => {
    if (quantidade <= 0) return;
    const chave = `${item.materialId}\n${item.tamanho ?? ''}\n${situacao}`;
    const g = grupos.get(chave) ?? { materialId: item.materialId, nome: nomes.get(item.materialId), tamanho: item.tamanho, situacao, quantidade: 0, retiradaParcial: false };
    g.quantidade += quantidade;
    g.retiradaParcial = g.retiradaParcial || parcial;
    grupos.set(chave, g);
  };
  for (const item of itens) {
    const pedido = pedidos.find((p) => p.id === item.solicitacaoId);
    if (pedido.status === 'PENDENTE') { somar(item, 'AGUARDANDO_APROVACAO', item.quantidade, false); continue; }
    if (item.decisao !== 'APROVADO') continue;
    const pendente = item.quantidadeAprovada - item.quantidadeEntregue;
    if (pendente === 0) continue;
    const c = porItem.get(item.id) ?? null;
    const situacao = situacaoDoItem({ decisao: 'APROVADO', quantidadeAprovada: item.quantidadeAprovada, quantidadeEntregue: item.quantidadeEntregue, coberta: c === null ? null : c.coberta });
    const parcial = item.quantidadeEntregue > 0;
    if (situacao === 'SUSPENSA') { somar(item, 'INDISPONIVEL', pendente, parcial); continue; }
    somar(item, 'DISPONIVEL_PARA_RETIRADA', c.coberta, parcial);
    somar(item, 'AGUARDANDO_ESTOQUE', c.semCobertura, parcial);
  }
  const ordem = (s) => SITUACOES.indexOf(s);
  return [...grupos.values()].sort((x, y) => ordem(x.situacao) - ordem(y.situacao) || (x.nome < y.nome ? -1 : x.nome > y.nome ? 1 : 0) || String(x.tamanho ?? '').localeCompare(String(y.tamanho ?? '')));
}
