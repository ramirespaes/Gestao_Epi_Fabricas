'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { abrirPoolTemporario, aguardarEsperaPeloLock } = require('./helpers/schema-temporario');
const { gerador } = require('./helpers/gerador');
const {
  HASH, todasAsMigrations, transacao, inserir, criarFuncionario, criarMaterial, criarFicha, inserirEntrega, inserirItem, inserirOperacaoEntrega, inserirConfirmacao,
} = require('./helpers/entrega-epi');
const {
  CNPJ_A, montarCenario, criarSolicitacao, decidirSolicitacao, aprovar, criarLoteDeEntrada, entregueDoItem, entregarPorSolicitacao,
  gravarEntregaPorSolicitacao,
} = require('./helpers/solicitacao-epi');
const { comLimite } = require('./helpers/solicitacao-epi-servico');
const parRepo = require('../../src/repositories/estoque-par.repository');

/**
 * Migration 066 — ordem de locks e concorrência da entrega por solicitação,
 * com conexões distintas e PostgreSQL real.
 *
 * Ordem global aprovada: idempotência → solicitação (FOR NO KEY UPDATE) →
 * trabalhador (FOR NO KEY UPDATE) → materiais (FOR SHARE, ids crescentes) →
 * pares (advisory) → lotes (FOR UPDATE, ids crescentes) → numeração.
 *
 * Os gatilhos da 066 tomam a trava da solicitação (FOR NO KEY UPDATE) quando
 * gravam o item da entrega, isto é, DEPOIS de o chamador ter travado os lotes:
 * é preciso provar que nenhum caminho real segura a solicitação e espera um
 * lote. As provas:
 *   1. rodadas concorrentes de TODOS os caminhos que tocam esses recursos
 *      (entrega por solicitação, entrega DIRETA, baixa, entrada, aprovação e
 *      cancelamento), na ordem de locks de cada um, embaralhadas com
 *      semente fixa: nenhum deadlock, nenhum travamento, resultado exato;
 *   2. o gatilho, sozinho, é o árbitro quando o chamador não trava nada;
 *   3. a entrega DIRETA não espera a solicitação (o gatilho não a trava);
 *   4. entregas de solicitações diferentes não se serializam;
 *   5. controle positivo: o caminho inverso (lote antes da solicitação) forma
 *      ciclo e o PostgreSQL o detecta — é exatamente o que a ordem evita.
 *
 * O serviço da entrega por solicitação é da 12C-2: aqui a sequência de travas
 * dele é emulada com SQL, na ordem aprovada.
 */

const DEADLOCK = '40P01';
const VIOLACAO_CHECK = '23514';
// Padrão 10; RODADAS_LOCKS maior serve para um estresse pontual, sem mudar o teste.
const RODADAS = Number.parseInt(process.env.RODADAS_LOCKS ?? '10', 10);

class SemPendente extends Error {}

const dormir = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

describe('entrega por solicitação — ordem de locks e concorrência (PostgreSQL real)', () => {
  let contexto;
  let d;
  let trabalhadores;
  let fichas;
  let sequencia = 0;

  const pool = () => contexto.pool;
  const q = (sql, params) => pool().query(sql, params);

  before(async () => {
    contexto = await abrirPoolTemporario(todasAsMigrations());
    d = await montarCenario(contexto.pool);
    trabalhadores = [d.trabalhadorA, d.trabalhadorA2];
    for (let i = 3; i <= 6; i += 1) {
      trabalhadores.push(await criarFuncionario(contexto.pool, d.empresaA, { matricula: `A-${i}`, cpf: `${i}`.repeat(11) }));
    }
    // Uma ficha por trabalhador na empresa: criada uma vez, antes da concorrência (a numeração é o último passo da ordem de locks).
    fichas = {
      w1: await criarFicha(contexto.pool, d.empresaA, trabalhadores[0]),
      w2: await criarFicha(contexto.pool, d.empresaA, trabalhadores[1]),
    };
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  async function entradaDeLote(materialId, quantidade) {
    return criarLoteDeEntrada(pool(), { empresaId: d.empresaA, materialId, quantidade, usuarioId: d.aprovador });
  }

  // Cenário de uma rodada: um material, dois lotes, uma solicitação aprovada de 4 (a disputada) e duas PENDENTES (aprovar e cancelar).
  async function montarRodada({ aprovada = 4 } = {}) {
    sequencia += 1;
    const materialId = await criarMaterial(pool(), d.empresaA, `Material de trava ${sequencia}`);
    const lote1 = await entradaDeLote(materialId, 30);
    const lote2 = await entradaDeLote(materialId, 30);
    const nova = (trabalhador, quantidade) => criarSolicitacao(pool(), d, { funcionarioId: trabalhador, itens: [{ material_id: materialId, tamanho: '40', quantidade }] });
    const { solicitacao, itens } = await nova(trabalhadores[0], aprovada);
    const alvo = { solicitacao: await decidirSolicitacao(pool(), solicitacao, { status: 'APROVADA', decididaPor: d.aprovador, decisoes: [aprovar(itens[0])] }), item: itens[0], aprovada };
    const paraAprovar = await nova(trabalhadores[2], 1);
    const paraCancelar = await nova(trabalhadores[3], 1);
    return { materialId, lote1, lote2, alvo, paraAprovar, paraCancelar, fichas };
  }

  // A sequência de travas do serviço, na ordem aprovada. Cada caminho toma só o que o seu serviço tomaria.
  async function travar(c, { solicitacaoId = null, funcionarioId = null, materialId, materialPara = 'SHARE', tamanho = '40', loteIds = null }) {
    if (solicitacaoId !== null) await c.query('SELECT 1 FROM solicitacoes_epi WHERE empresa_id = $1 AND id = $2 FOR NO KEY UPDATE', [d.empresaA, solicitacaoId]);
    if (funcionarioId !== null) await c.query('SELECT 1 FROM funcionarios WHERE empresa_id = $1 AND id = $2 FOR NO KEY UPDATE', [d.empresaA, funcionarioId]);
    await c.query(`SELECT 1 FROM materiais WHERE empresa_id = $1 AND id = $2 ${materialPara === 'SHARE' ? 'FOR SHARE' : 'FOR UPDATE'}`, [d.empresaA, materialId]);
    if (materialPara === 'SHARE') await parRepo.travarPares(c, d.empresaA, [{ materialId, tamanho }]);
    if (loteIds !== null) await c.query('SELECT 1 FROM estoque_lotes WHERE empresa_id = $1 AND id = ANY($2::int[]) ORDER BY id FOR UPDATE', [d.empresaA, loteIds]);
  }

  const caminhos = (r) => ({
    // Entrega por solicitação: solicitação → trabalhador → material → par → lote; confere o pendente já com tudo travado.
    entregaPorSolicitacao: (quantidade, loteId) => () => transacao(pool(), async (c) => {
      await travar(c, { solicitacaoId: r.alvo.solicitacao.id, funcionarioId: trabalhadores[0], materialId: r.materialId, loteIds: [loteId] });
      const { rows: [{ status }] } = await c.query('SELECT status FROM solicitacoes_epi WHERE id = $1', [r.alvo.solicitacao.id]);
      if (status !== 'APROVADA' || r.alvo.aprovada - await entregueDoItem(c, r.alvo.item.id) < quantidade) throw new SemPendente('sem pendente');
      return gravarEntregaPorSolicitacao(c, {
        solicitacao: r.alvo.solicitacao, usuarioId: d.aprovador, fichaId: r.fichas.w1.id, itens: [{ item: r.alvo.item, loteId, quantidade }],
      });
    }),
    // Entrega DIRETA (Bloco 10 + par): trabalhador → material → par → lote; o gatilho da 066 não toma a solicitação.
    direta: () => transacao(pool(), async (c) => {
      await travar(c, { funcionarioId: trabalhadores[1], materialId: r.materialId, loteIds: [r.lote2] });
      const entrega = await inserirEntrega(c, { empresa_id: d.empresaA, ficha_id: r.fichas.w2.id, responsavel_id: d.aprovador, empresa_cnpj: CNPJ_A });
      const item = await inserirItem(c, { empresa_id: d.empresaA, entrega_id: entrega.id, material_id: r.materialId, lote_id: r.lote2, quantidade: 1 });
      await inserirOperacaoEntrega(c, { empresa_id: d.empresaA, lote_id: r.lote2, quantidade: 1, usuario_id: d.aprovador, entrega_item_id: item.id });
      await inserirConfirmacao(c, { empresa_id: d.empresaA, entrega_id: entrega.id });
    }),
    // Baixa (12C-3): material → par → lote.
    baixa: () => transacao(pool(), async (c) => {
      await travar(c, { materialId: r.materialId, loteIds: [r.lote1] });
      await inserir(c, 'estoque_operacoes', {
        empresa_id: d.empresaA, lote_id: r.lote1, tipo: 'BAIXA', quantidade: 1, motivo: 'AVARIA', usuario_id: d.aprovador,
        chave_idempotencia: crypto.randomUUID(), requisicao_hash: HASH,
      });
    }),
    // Entrada: material FOR UPDATE, sem par.
    entrada: () => transacao(pool(), async (c) => {
      await travar(c, { materialId: r.materialId, materialPara: 'UPDATE' });
      const lote = await inserir(c, 'estoque_lotes', {
        empresa_id: d.empresaA, material_id: r.materialId, tamanho: '40', ca_numero: '777', ca_validade: '2099-12-31', origem: 'ENTRADA', quantidade_entrada: 5,
      });
      await inserir(c, 'estoque_operacoes', {
        empresa_id: d.empresaA, lote_id: lote.id, tipo: 'ENTRADA', quantidade: 5, usuario_id: d.aprovador, chave_idempotencia: crypto.randomUUID(), requisicao_hash: HASH,
      });
    }),
    // Aprovação (12B): solicitação → trabalhador → material → par; decide os itens e o cabeçalho.
    aprovacao: () => transacao(pool(), async (c) => {
      await travar(c, { solicitacaoId: r.paraAprovar.solicitacao.id, funcionarioId: trabalhadores[2], materialId: r.materialId });
      await c.query("UPDATE solicitacoes_epi_itens SET decisao = 'APROVADO', quantidade_aprovada = 1 WHERE empresa_id = $1 AND id = $2", [d.empresaA, r.paraAprovar.itens[0].id]);
      await c.query(
        "UPDATE solicitacoes_epi SET status = 'APROVADA', decidida_por = $3, decidida_em = clock_timestamp() WHERE empresa_id = $1 AND id = $2",
        [d.empresaA, r.paraAprovar.solicitacao.id, d.aprovador],
      );
    }),
    // Cancelamento (12B): só a solicitação.
    cancelamento: () => transacao(pool(), async (c) => {
      await c.query('SELECT 1 FROM solicitacoes_epi WHERE empresa_id = $1 AND id = $2 FOR NO KEY UPDATE', [d.empresaA, r.paraCancelar.solicitacao.id]);
      await c.query(
        "UPDATE solicitacoes_epi SET status = 'CANCELADA', cancelada_por = $3, cancelada_em = clock_timestamp() WHERE empresa_id = $1 AND id = $2",
        [d.empresaA, r.paraCancelar.solicitacao.id, d.solicitante],
      );
    }),
  });

  test('rodadas concorrentes de todos os caminhos, na ordem de locks de cada um e embaralhadas: nenhum deadlock, nenhum travamento e o resultado exato', async () => {
    const sorteio = gerador(20261003);
    for (let rodada = 1; rodada <= RODADAS; rodada += 1) {
      const r = await montarRodada();
      const c = caminhos(r);
      const atores = [
        ['entrega A (2)', c.entregaPorSolicitacao(2, r.lote1)],
        ['entrega B (2)', c.entregaPorSolicitacao(2, r.lote2)],
        ['entrega C (2)', c.entregaPorSolicitacao(2, r.lote1)],
        ['direta', c.direta],
        ['baixa', c.baixa],
        ['entrada', c.entrada],
        ['aprovação', c.aprovacao],
        ['cancelamento', c.cancelamento],
      ];
      for (let i = atores.length - 1; i > 0; i -= 1) {
        const j = Math.floor(sorteio() * (i + 1));
        [atores[i], atores[j]] = [atores[j], atores[i]];
      }
      const resultados = await Promise.all(atores.map(async ([rotulo, iniciar]) => {
        await dormir(Math.floor(sorteio() * 4));
        try {
          await comLimite(iniciar(), `rodada ${rodada}, ${rotulo}`, 20000);
          return { rotulo, ok: true };
        } catch (erro) {
          return { rotulo, ok: false, erro };
        }
      }));

      const inesperadas = resultados.filter((x) => !x.ok && !(x.erro instanceof SemPendente));
      assert.deepEqual(inesperadas.map((x) => [x.rotulo, x.erro.code, x.erro.message]), [], `rodada ${rodada}: nenhuma falha além da recusa por falta de pendente (sem deadlock nem espera infinita)`);
      const entregas = resultados.filter((x) => x.rotulo.startsWith('entrega'));
      assert.equal(entregas.filter((x) => x.ok).length, 2, `rodada ${rodada}: duas entregas de 2 esgotam a aprovada de 4`);
      assert.equal(entregas.filter((x) => !x.ok).length, 1, `rodada ${rodada}: a terceira é recusada por falta de pendente`);

      assert.equal(await entregueDoItem(pool(), r.alvo.item.id), 4, `rodada ${rodada}: entregue = aprovada`);
      assert.equal((await q('SELECT status FROM solicitacoes_epi WHERE id = $1', [r.alvo.solicitacao.id])).rows[0].status, 'ENTREGUE');
      assert.equal((await q('SELECT status FROM solicitacoes_epi WHERE id = $1', [r.paraAprovar.solicitacao.id])).rows[0].status, 'APROVADA');
      assert.equal((await q('SELECT status FROM solicitacoes_epi WHERE id = $1', [r.paraCancelar.solicitacao.id])).rows[0].status, 'CANCELADA');
      const { rows: lotes } = await q('SELECT quantidade_entrada, quantidade_baixada, quantidade_entregue, saldo FROM estoque_lotes WHERE material_id = $1 ORDER BY id', [r.materialId]);
      for (const lote of lotes) assert.equal(lote.saldo, lote.quantidade_entrada - lote.quantidade_baixada - lote.quantidade_entregue);
      const { rows: [{ entregue }] } = await q("SELECT COALESCE(sum(quantidade_entregue), 0)::int AS entregue FROM estoque_lotes WHERE material_id = $1", [r.materialId]);
      assert.equal(entregue, 5, `rodada ${rodada}: 4 da solicitação e 1 da entrega direta saíram do físico, uma vez só`);
    }
  });

  test('sem nenhuma trava do chamador, o gatilho da 066 é o árbitro: três entregas simultâneas de 2 sobre 4 aprovadas dão duas confirmadas e uma recusada', async () => {
    const r = await montarRodada();
    const tentar = (loteId) => transacao(pool(), (c) => gravarEntregaPorSolicitacao(c, {
      solicitacao: r.alvo.solicitacao, usuarioId: d.aprovador, fichaId: r.fichas.w1.id, itens: [{ item: r.alvo.item, loteId, quantidade: 2 }],
    }));
    const resultados = await Promise.allSettled([
      comLimite(tentar(r.lote1), 'sem trava A', 20000),
      comLimite(tentar(r.lote2), 'sem trava B', 20000),
      comLimite(tentar(r.lote1), 'sem trava C', 20000),
    ]);
    const recusadas = resultados.filter((x) => x.status === 'rejected');
    assert.equal(resultados.filter((x) => x.status === 'fulfilled').length, 2);
    assert.equal(recusadas.length, 1);
    assert.deepEqual([recusadas[0].reason.code, recusadas[0].reason.constraint], [VIOLACAO_CHECK, 'vinculo_solicitacao_entregavel'], 'a terceira encontra a solicitação já fechada');
    assert.equal(await entregueDoItem(pool(), r.alvo.item.id), 4);
  });

  test('o gatilho espera a solicitação quando outra transação a segura e prossegue quando ela termina', async () => {
    const r = await montarRodada();
    const segurando = await pool().connect();
    try {
      await segurando.query('BEGIN');
      await segurando.query('SELECT 1 FROM solicitacoes_epi WHERE empresa_id = $1 AND id = $2 FOR NO KEY UPDATE', [d.empresaA, r.alvo.solicitacao.id]);
      const espera = comLimite(entregarPorSolicitacao(pool(), {
        solicitacao: r.alvo.solicitacao, usuarioId: d.aprovador, itens: [{ item: r.alvo.item, loteId: r.lote1, quantidade: 1 }],
      }), 'entrega à espera da solicitação', 20000);
      // A gravação do item fica esperando um lock (a solicitação segura): observável no próprio banco.
      let esperando = 0;
      for (let tentativa = 0; tentativa < 300 && esperando === 0; tentativa += 1) {
        esperando = (await q("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'")).rows[0].n;
        if (esperando === 0) await dormir(10);
      }
      assert.equal(esperando, 1, 'a entrega espera a solicitação travada');
      assert.equal(await entregueDoItem(pool(), r.alvo.item.id), 0, 'nada entra enquanto a solicitação está segura por outra transação');
      await segurando.query('COMMIT');
      const { itens } = await espera;
      assert.equal(itens[0].solicitacao_item_id, r.alvo.item.id);
      assert.equal(await entregueDoItem(pool(), r.alvo.item.id), 1);
    } finally {
      await segurando.query('ROLLBACK').catch(() => {});
      segurando.release();
    }
  });

  test('a entrega DIRETA não espera a solicitação: o gatilho só a trava quando o item tem vínculo', async () => {
    const r = await montarRodada();
    const segurando = await pool().connect();
    try {
      await segurando.query('BEGIN');
      await segurando.query('SELECT 1 FROM solicitacoes_epi WHERE empresa_id = $1 AND id = $2 FOR NO KEY UPDATE', [d.empresaA, r.alvo.solicitacao.id]);
      await comLimite(caminhos(r).direta(), 'direta com a solicitação segura', 5000);
      assert.equal(await entregueDoItem(pool(), r.alvo.item.id), 0);
    } finally {
      await segurando.query('ROLLBACK').catch(() => {});
      segurando.release();
    }
  });

  test('solicitações diferentes não se serializam: uma entrega aberta não segura a de outra solicitação, mesmo no mesmo material', async () => {
    const r1 = await montarRodada();
    const r2 = await montarRodada();
    const aberta = await pool().connect();
    try {
      await aberta.query('BEGIN');
      await travar(aberta, { solicitacaoId: r1.alvo.solicitacao.id, funcionarioId: trabalhadores[0], materialId: r1.materialId, loteIds: [r1.lote1] });
      await gravarEntregaPorSolicitacao(aberta, {
        solicitacao: r1.alvo.solicitacao, usuarioId: d.aprovador, fichaId: r1.fichas.w1.id, itens: [{ item: r1.alvo.item, loteId: r1.lote1, quantidade: 1 }],
      });
      await comLimite(entregarPorSolicitacao(pool(), {
        solicitacao: r2.alvo.solicitacao, usuarioId: d.aprovador, itens: [{ item: r2.alvo.item, loteId: r2.lote1, quantidade: 1 }],
      }), 'outra solicitação com a primeira aberta', 5000);
      assert.equal(await entregueDoItem(pool(), r2.alvo.item.id), 1);
      await aberta.query('COMMIT');
      assert.equal(await entregueDoItem(pool(), r1.alvo.item.id), 1);
    } finally {
      await aberta.query('ROLLBACK').catch(() => {});
      aberta.release();
    }
  });

  test('controle positivo: o caminho inverso (lote antes da solicitação) forma ciclo com a ordem do serviço e o PostgreSQL o detecta; nenhum caminho real faz isso', async () => {
    const r = await montarRodada();
    const servico = await pool().connect();
    const inverso = await pool().connect();
    try {
      // O serviço (ordem aprovada) já tem a solicitação e vai pedir o lote.
      await servico.query('BEGIN');
      await servico.query('SELECT 1 FROM solicitacoes_epi WHERE empresa_id = $1 AND id = $2 FOR NO KEY UPDATE', [d.empresaA, r.alvo.solicitacao.id]);
      // O inverso já tem o lote e vai gravar o item (o gatilho pede a solicitação).
      await inverso.query('BEGIN');
      await inverso.query('SELECT 1 FROM estoque_lotes WHERE empresa_id = $1 AND id = $2 FOR UPDATE', [d.empresaA, r.lote1]);
      const { rows: [{ pid }] } = await inverso.query('SELECT pg_backend_pid() AS pid');

      const noInverso = gravarEntregaPorSolicitacao(inverso, {
        solicitacao: r.alvo.solicitacao, usuarioId: d.aprovador, fichaId: r.fichas.w1.id, itens: [{ item: r.alvo.item, loteId: r.lote1, quantidade: 1 }],
      }).then(() => ({ ok: true }), (erro) => ({ ok: false, erro }));
      assert.ok(['transactionid', 'tuple'].includes(await aguardarEsperaPeloLock(pool(), pid)), 'o inverso espera a solicitação que o serviço segura');

      const noServico = servico.query('SELECT 1 FROM estoque_lotes WHERE empresa_id = $1 AND id = $2 FOR UPDATE', [d.empresaA, r.lote1])
        .then(() => ({ ok: true }), async (erro) => { await servico.query('ROLLBACK').catch(() => {}); return { ok: false, erro }; });

      const resultados = await comLimite(Promise.all([noInverso, noServico]), 'ciclo de locks', 20000);
      const falhas = resultados.filter((x) => !x.ok);
      assert.equal(falhas.length, 1, 'o PostgreSQL derruba exatamente um dos dois');
      assert.equal(falhas[0].erro.code, DEADLOCK);
    } finally {
      for (const cliente of [servico, inverso]) {
        await cliente.query('ROLLBACK').catch(() => {});
        cliente.release();
      }
    }
  });
});
