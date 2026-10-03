'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { gerador } = require('./helpers/gerador');
const { todasAsMigrations } = require('./helpers/entrega-epi');
const {
  montarMundoDoServico, chaveNova, comLimite, aguardarTravaAdvisoryPendente,
} = require('./helpers/solicitacao-epi-servico');
const { criarFerramentas, ACEITE } = require('./helpers/reserva-estoque');
const { baixarLote } = require('./helpers/solicitacao-epi');
const solicitacaoSvc = require('../../src/services/solicitacao-epi.service');
const entregaSolicitacaoSvc = require('../../src/services/entrega-solicitacao.service');
const estoqueSvc = require('../../src/services/estoque.service');
const parRepo = require('../../src/repositories/estoque-par.repository');
const { HttpError } = require('../../src/errors/HttpError');
const { chaveDoEvento, lockDaSupressao } = require('../../src/utils/supressao-auditoria');

/**
 * Saldo livre sob concorrência (12C-3): PostgreSQL real, conexões distintas,
 * cenários repetidos em várias rodadas, ordem de largada embaralhada com
 * semente. Cada rodada usa um material próprio (a posição é por empresa,
 * material e tamanho). Verificado em todas: saldo nunca negativo, reserva
 * nunca violada por ato discricionário ou entrega direta, baixa nunca em
 * dobro, físico real preservado, sem deadlock, idempotência e sem auditoria de
 * recusa duplicada. Quando o desfecho depende de quem chegou primeiro, a ordem
 * real é lida da auditoria (o id sai do mesmo transação que ainda segura a
 * trava do par) e o desfecho é conferido contra ela.
 */

// Padrão 6; RODADAS_SALDO_LIVRE maior serve para um estresse pontual.
const RODADAS = Number.parseInt(process.env.RODADAS_SALDO_LIVRE ?? '6', 10);
const DEADLOCK = '40P01';
const LIVRE = 'SALDO_LIVRE_INSUFICIENTE';

const dormir = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function resultadoDe(promessa) {
  try {
    return { ok: true, valor: await promessa };
  } catch (erro) {
    if (HttpError.ehHttpError(erro)) return { ok: false, status: erro.status, codigo: erro.codigo };
    return { ok: false, code: erro.code, mensagem: erro.message };
  }
}

describe('saldo livre — concorrência (PostgreSQL real)', () => {
  let contexto;
  let pool;
  let d;
  let f;
  let trabalhadores;

  const q = (sql, params) => pool.query(sql, params);

  before(async () => {
    contexto = await abrirPoolTemporario(todasAsMigrations());
    pool = contexto.pool;
    d = await montarMundoDoServico(pool);
    f = criarFerramentas(pool, d);
    trabalhadores = [d.trabalhador, d.trabalhador2, d.trabalhador3];
    for (let i = 0; i < 3; i += 1) trabalhadores.push(await d.novoTrabalhador(d.empresaA, { gheId: d.gheA }));
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  async function emParalelo(tarefas, { semente = 1, rotulo = 'rodada' } = {}) {
    const sorteio = gerador(semente);
    const ordem = tarefas.map((t, i) => [t, i]);
    for (let i = ordem.length - 1; i > 0; i -= 1) {
      const j = Math.floor(sorteio() * (i + 1));
      [ordem[i], ordem[j]] = [ordem[j], ordem[i]];
    }
    const resultados = new Array(tarefas.length);
    await Promise.all(ordem.map(async ([tarefa, indice]) => {
      await dormir(Math.floor(sorteio() * 4));
      resultados[indice] = await resultadoDe(comLimite(tarefa(), `${rotulo} #${indice}`, 30000));
    }));
    for (const r of resultados) assert.notEqual(r.code, DEADLOCK, `${rotulo}: deadlock`);
    for (const r of resultados) assert.ok(!r.mensagem?.includes('não resolveu'), `${rotulo}: travou: ${r.mensagem}`);
    for (const r of resultados) assert.ok(r.ok || r.status === 409, `${rotulo}: erro inesperado ${JSON.stringify(r)}`);
    return resultados;
  }

  // Espera por estado, sem dormir no teste: devolve o pid da sessão que aguarda exatamente esta trava advisory (bigint).
  async function aguardarSessaoNaTrava(trava, { tentativas = 500, intervaloMs = 10 } = {}) {
    for (let i = 0; i < tentativas; i += 1) {
      const { rows } = await q(
        `SELECT pid FROM pg_locks
          WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
            AND ((classid::bigint << 32) | objid::bigint) = $1::bigint`,
        [trava],
      );
      if (rows.length > 0) return rows[0].pid;
      await dormir(intervaloMs);
    }
    throw new Error('nenhuma sessão ficou esperando pela trava da supressão');
  }

  const aprovadas = (r) => r.filter((x) => x.ok).length;
  const recusadasPor = (r, codigo) => r.filter((x) => !x.ok && x.codigo === codigo).length;

  // Entrega por solicitação (12C-2) contra o par.
  const porSolicitacao = (alvo, loteId, quantidade) => entregaSolicitacaoSvc.registrarEntregaPorSolicitacao(pool, {
    empresaId: d.empresaA,
    atorId: d.master,
    solicitacaoId: alvo.id,
    itens: [{ solicitacaoItemId: alvo.item, loteId, quantidade }],
    confirmacao: ACEITE,
    chaveIdempotencia: chaveNova(),
  });

  const entrada = (materialId, quantidade) => estoqueSvc.registrarEntrada(pool, {
    empresaId: d.empresaA, atorId: d.master, materialId, tamanho: '40', quantidade, caNumero: '54321', caValidade: '2099-12-31', chaveIdempotencia: chaveNova(), hoje: f.HOJE,
  });

  // Aprovação de uma solicitação nova, pendente de decisão, criada antes da corrida.
  async function pendenteDeDecisao(materialId, quantidade, funcionarioId) {
    const criada = await solicitacaoSvc.criarSolicitacao(pool, {
      empresaId: d.empresaA, atorId: d.solicitante, funcionarioId, itens: [{ materialId, tamanho: '40', quantidade, motivo: 'ADMISSAO' }], chaveIdempotencia: chaveNova(),
    });
    return { id: criada.solicitacao.id, item: criada.itens[0].id };
  }
  const decidir = (alvo) => solicitacaoSvc.decidirSolicitacao(pool, {
    empresaId: d.empresaA, atorId: d.sst1, solicitacaoId: alvo.id, decisoes: [{ itemId: alvo.item, decisao: 'APROVADO' }], hoje: f.HOJE,
  });

  // Ordem real de chegada ao par: o id da auditoria sai ainda sob a trava do par.
  const idDaAuditoria = async (sql, params) => {
    const { rows } = await q(sql, params);
    return rows.length === 0 ? null : BigInt(rows[0].id);
  };
  const idDaDireta = (materialId) => idDaAuditoria(
    "SELECT id FROM logs_auditoria WHERE acao = 'ENTREGA_REGISTRADA' AND contexto->'itens' @> jsonb_build_array(jsonb_build_object('materialId', $1::int)) ORDER BY id LIMIT 1", [materialId],
  );
  const idDaBaixa = (loteId) => idDaAuditoria("SELECT id FROM logs_auditoria WHERE acao = 'ESTOQUE_BAIXA' AND referencia = $1 ORDER BY id LIMIT 1", [String(loteId)]);
  const idDaDecisao = (alvo) => idDaAuditoria("SELECT id FROM logs_auditoria WHERE acao = 'SOLICITACAO_EPI_DECIDIDA' AND referencia = $1 ORDER BY id LIMIT 1", [String(alvo.id)]);

  // Invariantes físicos de todo lote do material: saldo = entrada − baixada − entregue, nunca negativo.
  async function fisicoConsistente(materialId, rotulo) {
    const { rows } = await q('SELECT id, quantidade_entrada AS e, quantidade_baixada AS b, quantidade_entregue AS g, saldo FROM estoque_lotes WHERE material_id = $1', [materialId]);
    for (const lote of rows) {
      assert.ok(lote.saldo >= 0, `${rotulo}: saldo negativo no lote ${lote.id}`);
      assert.equal(lote.saldo, lote.e - lote.b - lote.g, `${rotulo}: saldo do lote ${lote.id} diverge do histórico`);
    }
    const { rows: [{ baixadoNosLotes, baixadoNasOperacoes }] } = await q(
      `SELECT (SELECT COALESCE(sum(quantidade_baixada), 0) FROM estoque_lotes WHERE material_id = $1)::int AS "baixadoNosLotes",
              (SELECT COALESCE(sum(o.quantidade), 0) FROM estoque_operacoes o JOIN estoque_lotes l ON l.id = o.lote_id WHERE l.material_id = $1 AND o.tipo = 'BAIXA')::int AS "baixadoNasOperacoes"`, [materialId],
    );
    assert.equal(baixadoNasOperacoes, baixadoNosLotes, `${rotulo}: baixa em dobro ou perdida`);
  }

  const recusasDo = async (materialId, operacao) => (await f.recusas(materialId, { operacao })).length;

  describe('DIRETA × DIRETA no mesmo par', () => {
    test('U5 D2 L3: duas de 2 — exatamente uma passa, a outra é SALDO_LIVRE_INSUFICIENTE, em qualquer ordem', async () => {
      for (let rodada = 1; rodada <= RODADAS; rodada += 1) {
        const m = await f.material();
        await f.aprovada({ materialId: m, quantidade: 2 });
        const lote = await f.estoque(m, 5);
        const r = await emParalelo([() => f.direta([[m, lote, 2]]), () => f.direta([[m, lote, 2]])], { semente: rodada, rotulo: `D×D ${rodada}` });
        assert.equal(aprovadas(r), 1, `rodada ${rodada}`);
        assert.equal(recusadasPor(r, LIVRE), 1);
        assert.deepEqual(f.numeros(await f.posicao(m)), [3, 2, 2, 1, 0]);
        await fisicoConsistente(m, `D×D ${rodada}`);
      }
    });

    test('U5 D2 L3: três de 1 passam, a quarta não cabe — nunca passa do livre, com lotes diferentes inclusive', async () => {
      for (let rodada = 1; rodada <= RODADAS; rodada += 1) {
        const m = await f.material();
        await f.aprovada({ materialId: m, quantidade: 2 });
        const a = await f.estoque(m, 3);
        const b = await f.estoque(m, 2);
        const r = await emParalelo([() => f.direta([[m, a, 1]]), () => f.direta([[m, b, 1]]), () => f.direta([[m, a, 1]]), () => f.direta([[m, b, 1]])], { semente: 50 + rodada, rotulo: `D×D×D×D ${rodada}` });
        assert.equal(aprovadas(r), 3, `rodada ${rodada}`);
        assert.equal(recusadasPor(r, LIVRE), 1);
        assert.deepEqual(f.numeros(await f.posicao(m)), [2, 2, 2, 0, 0]);
        await fisicoConsistente(m, `quatro ${rodada}`);
      }
    });

    test('a soma por par vale também com dois itens do mesmo ato disputando com outro ato: 2+2 contra 3 livres nunca passa inteiro', async () => {
      for (let rodada = 1; rodada <= RODADAS; rodada += 1) {
        const m = await f.material();
        await f.aprovada({ materialId: m, quantidade: 2 });
        const a = await f.estoque(m, 3);
        const b = await f.estoque(m, 2);
        const r = await emParalelo([() => f.direta([[m, a, 2], [m, b, 2]]), () => f.direta([[m, a, 1]])], { semente: 80 + rodada, rotulo: `agregado ${rodada}` });
        assert.ok(r.some((x) => x.ok), 'a de 1 sempre cabe');
        assert.ok(!r[0].ok, `rodada ${rodada}: o ato de 2+2 nunca cabe em 3 livres`);
        assert.equal(r[0].codigo, LIVRE);
        const p = await f.posicao(m);
        assert.ok(p.saldoLivre >= 0 && p.comprometido === Math.min(p.fisicoUtilizavel, p.demandaPendente));
        assert.equal(p.comprometido, 2);
        await fisicoConsistente(m, `agregado ${rodada}`);
      }
    });
  });

  describe('DIRETA × aprovação no mesmo par', () => {
    test('U3 D1, DIRETA 2 contra a aprovação de mais 2: se a aprovação chegou primeiro a DIRETA é recusada; se a DIRETA chegou primeiro, ambas passam', async () => {
      for (let rodada = 1; rodada <= RODADAS; rodada += 1) {
        const m = await f.material();
        await f.aprovada({ materialId: m, quantidade: 1 });
        const lote = await f.estoque(m, 3);
        const nova = await pendenteDeDecisao(m, 2, trabalhadores[3]);
        const r = await emParalelo([() => f.direta([[m, lote, 2]]), () => decidir(nova)], { semente: 120 + rodada, rotulo: `D×aprovação ${rodada}` });
        assert.ok(r[1].ok, 'a aprovação não depende de estoque');
        const idDireta = await idDaDireta(m);
        const idDecisao = await idDaDecisao(nova);
        if (r[0].ok) {
          assert.ok(idDireta < idDecisao, `rodada ${rodada}: a DIRETA só passa se chegou ao par antes da aprovação`);
          assert.deepEqual(f.numeros(await f.posicao(m)), [1, 3, 1, 0, 2]);
        } else {
          assert.equal(r[0].codigo, LIVRE);
          assert.equal(idDireta, null);
          assert.deepEqual(f.numeros(await f.posicao(m)), [3, 3, 3, 0, 0], 'a reserva da aprovação ficou intacta');
        }
        await fisicoConsistente(m, `D×aprovação ${rodada}`);
      }
    });
  });

  describe('DIRETA × entrega por solicitação no mesmo par', () => {
    test('U5 D2, DIRETA 3 contra a entrega de 2 da solicitação: as duas passam em qualquer ordem e a reserva é mantida até o fim', async () => {
      for (let rodada = 1; rodada <= RODADAS; rodada += 1) {
        const m = await f.material();
        const alvo = await f.aprovada({ materialId: m, quantidade: 2 });
        const lote = await f.estoque(m, 5);
        const r = await emParalelo([() => f.direta([[m, lote, 3]]), () => porSolicitacao(alvo, lote, 2)], { semente: 160 + rodada, rotulo: `D×solicitação ${rodada}` });
        assert.deepEqual(r.map((x) => x.ok), [true, true], `rodada ${rodada}: ${JSON.stringify(r)}`);
        assert.deepEqual(f.numeros(await f.posicao(m)), [0, 0, 0, 0, 0]);
        assert.equal((await q("SELECT status FROM solicitacoes_epi WHERE id = $1", [alvo.id])).rows[0].status, 'ENTREGUE');
        await fisicoConsistente(m, `D×solicitação ${rodada}`);
      }
    });

    test('U5 D2, DIRETA 4 contra a entrega de 2: a DIRETA é recusada em qualquer ordem (por saldo livre ou, se a entrega chegou antes, pelo saldo do lote) e a entrega passa', async () => {
      for (let rodada = 1; rodada <= RODADAS; rodada += 1) {
        const m = await f.material();
        const alvo = await f.aprovada({ materialId: m, quantidade: 2 });
        const lote = await f.estoque(m, 5);
        const r = await emParalelo([() => f.direta([[m, lote, 4]]), () => porSolicitacao(alvo, lote, 2)], { semente: 190 + rodada, rotulo: `D4×solicitação ${rodada}` });
        assert.equal(r[0].ok, false);
        // Com a entrega por solicitação na frente o lote fica com 3 e o saldo do lote (que vem antes) recusa; senão, o saldo livre.
        assert.ok([LIVRE, 'SALDO_INSUFICIENTE'].includes(r[0].codigo), r[0].codigo);
        assert.equal(r[1].ok, true);
        assert.deepEqual(f.numeros(await f.posicao(m)), [3, 0, 0, 3, 0]);
        await fisicoConsistente(m, `D4×solicitação ${rodada}`);
      }
    });
  });

  describe('DIRETA × baixa', () => {
    test('físico: U5 D2, DIRETA 3 contra AVARIA 1 — a baixa física sempre passa; a DIRETA só passa se chegou antes dela, e reduziuCobertura acompanha a ordem real', async () => {
      for (let rodada = 1; rodada <= RODADAS; rodada += 1) {
        const m = await f.material();
        await f.aprovada({ materialId: m, quantidade: 2 });
        const lote = await f.estoque(m, 5);
        const r = await emParalelo([() => f.direta([[m, lote, 3]]), () => f.baixa(lote, 1, 'AVARIA')], { semente: 220 + rodada, rotulo: `D×física ${rodada}` });
        assert.ok(r[1].ok, 'a realidade física nunca é recusada pela reserva');
        const [auditoria] = await f.baixasAuditadas(lote);
        if (r[0].ok) {
          assert.ok((await idDaDireta(m)) < (await idDaBaixa(lote)), `rodada ${rodada}: a DIRETA só passa se chegou ao par antes da baixa`);
          assert.equal(auditoria.reduziuCobertura, true, 'U2 D2 → U1: a cobertura caiu de 2 para 1');
          assert.deepEqual(f.numeros(await f.posicao(m)), [1, 2, 1, 0, 1]);
        } else {
          assert.equal(r[0].codigo, LIVRE);
          assert.equal(auditoria.reduziuCobertura, false, 'U5 D2 → U4: a cobertura continua 2');
          assert.deepEqual(f.numeros(await f.posicao(m)), [4, 2, 2, 2, 0]);
        }
        await fisicoConsistente(m, `D×física ${rodada}`);
      }
    });

    test('discricionária: U5 D2 L3, DIRETA 3 contra OUTRO 2 — exatamente uma passa (nunca as duas)', async () => {
      for (let rodada = 1; rodada <= RODADAS; rodada += 1) {
        const m = await f.material();
        await f.aprovada({ materialId: m, quantidade: 2 });
        const lote = await f.estoque(m, 5);
        const r = await emParalelo([() => f.direta([[m, lote, 3]]), () => f.baixa(lote, 2, 'OUTRO')], { semente: 250 + rodada, rotulo: `D×discricionária ${rodada}` });
        assert.equal(aprovadas(r), 1, `rodada ${rodada}: ${JSON.stringify(r)}`);
        assert.equal(recusadasPor(r, LIVRE), 1);
        const p = await f.posicao(m);
        assert.ok(p.saldoLivre >= 0 && p.comprometido === 2, 'a reserva da solicitação ficou intacta');
        await fisicoConsistente(m, `D×discricionária ${rodada}`);
      }
    });

    test('discricionária: DIRETA 1 e OUTRO 2 cabem juntas em 3 livres — as duas passam em qualquer ordem', async () => {
      for (let rodada = 1; rodada <= RODADAS; rodada += 1) {
        const m = await f.material();
        await f.aprovada({ materialId: m, quantidade: 2 });
        const lote = await f.estoque(m, 5);
        const r = await emParalelo([() => f.direta([[m, lote, 1]]), () => f.baixa(lote, 2, 'DEVOLUCAO_FORNECEDOR')], { semente: 280 + rodada, rotulo: `D+discricionária ${rodada}` });
        assert.deepEqual(r.map((x) => x.ok), [true, true], `rodada ${rodada}`);
        assert.deepEqual(f.numeros(await f.posicao(m)), [2, 2, 2, 0, 0]);
        await fisicoConsistente(m, `D+discricionária ${rodada}`);
      }
    });
  });

  describe('a posição é lida depois da trava do par, nunca antes', () => {
    // Outra transação segura o par e consome estoque por fora; o ato que esperava a trava tem de ver o estoque de depois.
    async function comParTravadoEConsumido(materialId, loteId, consumo, ato) {
      const segurando = await pool.connect();
      try {
        await segurando.query('BEGIN');
        await parRepo.travarPares(segurando, d.empresaA, [{ materialId, tamanho: '40' }]);
        await baixarLote(segurando, { empresaId: d.empresaA, loteId, quantidade: consumo, usuarioId: d.master, motivo: 'AVARIA' });
        const espera = resultadoDe(ato());
        await aguardarTravaAdvisoryPendente(pool);
        await segurando.query('COMMIT');
        return await comLimite(espera, 'ato que esperava o par', 10000);
      } finally {
        await segurando.query('ROLLBACK').catch(() => {});
        segurando.release();
      }
    }

    test('DIRETA: U5 D2 L3, mas outra transação consome 2 enquanto ela espera o par; a DIRETA de 3 vê U3 L1 e é recusada', async () => {
      for (let rodada = 1; rodada <= Math.min(RODADAS, 3); rodada += 1) {
        const m = await f.material();
        await f.aprovada({ materialId: m, quantidade: 2 });
        const lote = await f.estoque(m, 5);
        const r = await comParTravadoEConsumido(m, lote, 2, () => f.direta([[m, lote, 3]]));
        assert.deepEqual([r.ok, r.codigo], [false, LIVRE], `rodada ${rodada}`);
        assert.deepEqual(await f.lote(lote), { entrada: 5, baixada: 2, entregue: 0, saldo: 3 });
        const [registro] = await f.recusas(m);
        assert.deepEqual([registro.contexto.fisicoUtilizavel, registro.contexto.saldoLivre], [3, 1], 'a recusa traz a posição lida depois da trava');
      }
    });

    test('baixa: a posição de antes registrada na auditoria é a de depois da trava', async () => {
      for (let rodada = 1; rodada <= Math.min(RODADAS, 3); rodada += 1) {
        const m = await f.material();
        await f.aprovada({ materialId: m, quantidade: 2 });
        const lote = await f.estoque(m, 5);
        const r = await comParTravadoEConsumido(m, lote, 2, () => f.baixa(lote, 1, 'AVARIA'));
        assert.equal(r.ok, true, `rodada ${rodada}`);
        const [auditoria] = await f.baixasAuditadas(lote);
        assert.equal(auditoria.posicaoAntes.fisicoUtilizavel, 3, 'U5 menos os 2 consumidos por fora');
        assert.equal(auditoria.posicaoDepois.fisicoUtilizavel, 2);
        assert.equal(auditoria.reduziuCobertura, false, 'U3 D2 → U2 D2: a cobertura continua 2');
      }
    });
  });

  describe('entrega por solicitação × baixa', () => {
    test('físico, lote com folga: U3 D2, entrega de 2 e AVARIA 1 passam juntas em qualquer ordem', async () => {
      for (let rodada = 1; rodada <= RODADAS; rodada += 1) {
        const m = await f.material();
        const alvo = await f.aprovada({ materialId: m, quantidade: 2 });
        const lote = await f.estoque(m, 3);
        const r = await emParalelo([() => porSolicitacao(alvo, lote, 2), () => f.baixa(lote, 1, 'AVARIA')], { semente: 310 + rodada, rotulo: `solicitação×física folga ${rodada}` });
        assert.deepEqual(r.map((x) => x.ok), [true, true], `rodada ${rodada}: ${JSON.stringify(r)}`);
        assert.deepEqual(await f.lote(lote), { entrada: 3, baixada: 1, entregue: 2, saldo: 0 });
        await fisicoConsistente(m, `solicitação×física folga ${rodada}`);
      }
    });

    test('físico, disputa pelo mesmo estoque: U3 D2, entrega de 2 e AVARIA 2 — exatamente uma passa; a baixa nunca é dobrada nem o saldo negativo', async () => {
      for (let rodada = 1; rodada <= RODADAS; rodada += 1) {
        const m = await f.material();
        const alvo = await f.aprovada({ materialId: m, quantidade: 2 });
        const lote = await f.estoque(m, 3);
        const r = await emParalelo([() => porSolicitacao(alvo, lote, 2), () => f.baixa(lote, 2, 'AVARIA')], { semente: 340 + rodada, rotulo: `solicitação×física ${rodada}` });
        assert.equal(aprovadas(r), 1, `rodada ${rodada}: ${JSON.stringify(r)}`);
        const recusada = r.find((x) => !x.ok);
        assert.ok(['QUANTIDADE_ACIMA_DA_COBERTURA', 'SALDO_LOTE_INSUFICIENTE', 'SALDO_INSUFICIENTE'].includes(recusada.codigo), recusada.codigo);
        await fisicoConsistente(m, `solicitação×física ${rodada}`);
      }
    });

    test('discricionária: U3 D2 L1, entrega de 2 e OUTRO 1 passam juntas (a entrega não muda o livre)', async () => {
      for (let rodada = 1; rodada <= RODADAS; rodada += 1) {
        const m = await f.material();
        const alvo = await f.aprovada({ materialId: m, quantidade: 2 });
        const lote = await f.estoque(m, 3);
        const r = await emParalelo([() => porSolicitacao(alvo, lote, 2), () => f.baixa(lote, 1, 'OUTRO')], { semente: 370 + rodada, rotulo: `solicitação×discricionária ${rodada}` });
        assert.deepEqual(r.map((x) => x.ok), [true, true], `rodada ${rodada}: ${JSON.stringify(r)}`);
        assert.deepEqual(await f.lote(lote), { entrada: 3, baixada: 1, entregue: 2, saldo: 0 });
        await fisicoConsistente(m, `solicitação×discricionária ${rodada}`);
      }
    });

    test('discricionária: U3 D2 L1, entrega de 2 e OUTRO 2 — a entrega passa e a baixa é sempre recusada (nunca consome o comprometido)', async () => {
      for (let rodada = 1; rodada <= RODADAS; rodada += 1) {
        const m = await f.material();
        const alvo = await f.aprovada({ materialId: m, quantidade: 2 });
        const lote = await f.estoque(m, 3);
        const r = await emParalelo([() => porSolicitacao(alvo, lote, 2), () => f.baixa(lote, 2, 'OUTRO')], { semente: 400 + rodada, rotulo: `solicitação×discricionária 2 ${rodada}` });
        assert.equal(r[0].ok, true, `rodada ${rodada}: ${JSON.stringify(r)}`);
        assert.equal(r[1].ok, false);
        assert.ok([LIVRE, 'SALDO_LOTE_INSUFICIENTE'].includes(r[1].codigo), r[1].codigo);
        assert.deepEqual(await f.lote(lote), { entrada: 3, baixada: 0, entregue: 2, saldo: 1 });
        await fisicoConsistente(m, `solicitação×discricionária 2 ${rodada}`);
      }
    });
  });

  describe('baixas no mesmo par', () => {
    test('duas discricionárias: U5 D2 L3, OUTRO 2 e DEVOLUCAO_FORNECEDOR 2 — exatamente uma passa', async () => {
      for (let rodada = 1; rodada <= RODADAS; rodada += 1) {
        const m = await f.material();
        await f.aprovada({ materialId: m, quantidade: 2 });
        const lote = await f.estoque(m, 5);
        const r = await emParalelo([() => f.baixa(lote, 2, 'OUTRO'), () => f.baixa(lote, 2, 'DEVOLUCAO_FORNECEDOR')], { semente: 430 + rodada, rotulo: `duas discricionárias ${rodada}` });
        assert.equal(aprovadas(r), 1, `rodada ${rodada}: ${JSON.stringify(r)}`);
        assert.equal(recusadasPor(r, LIVRE), 1);
        assert.deepEqual(f.numeros(await f.posicao(m)), [3, 2, 2, 1, 0]);
        await fisicoConsistente(m, `duas discricionárias ${rodada}`);
      }
    });

    test('duas discricionárias que cabem juntas (2 + 1 = 3): as duas passam', async () => {
      for (let rodada = 1; rodada <= RODADAS; rodada += 1) {
        const m = await f.material();
        await f.aprovada({ materialId: m, quantidade: 2 });
        const lote = await f.estoque(m, 5);
        const r = await emParalelo([() => f.baixa(lote, 2, 'OUTRO'), () => f.baixa(lote, 1, 'DEVOLUCAO_FORNECEDOR')], { semente: 460 + rodada, rotulo: `discricionárias que cabem ${rodada}` });
        assert.deepEqual(r.map((x) => x.ok), [true, true], `rodada ${rodada}`);
        assert.deepEqual(f.numeros(await f.posicao(m)), [2, 2, 2, 0, 0]);
        await fisicoConsistente(m, `discricionárias que cabem ${rodada}`);
      }
    });

    test('duas baixas físicas que reduzem a cobertura: U2 D2, AVARIA 1 e PERDA 1 — as duas passam, a posição é serializada e cada auditoria encadeia na outra', async () => {
      for (let rodada = 1; rodada <= RODADAS; rodada += 1) {
        const m = await f.material();
        await f.aprovada({ materialId: m, quantidade: 2 });
        const lote = await f.estoque(m, 2);
        const r = await emParalelo([() => f.baixa(lote, 1, 'AVARIA'), () => f.baixa(lote, 1, 'PERDA')], { semente: 490 + rodada, rotulo: `duas físicas ${rodada}` });
        assert.deepEqual(r.map((x) => x.ok), [true, true], `rodada ${rodada}`);
        const auditorias = await f.baixasAuditadas(lote);
        assert.deepEqual(auditorias.map((a) => a.reduziuCobertura), [true, true]);
        assert.deepEqual(auditorias.map((a) => [a.posicaoAntes.fisicoUtilizavel, a.posicaoDepois.fisicoUtilizavel]), [[2, 1], [1, 0]], 'posição encadeada: o depois da primeira é o antes da segunda');
        assert.deepEqual(f.numeros(await f.posicao(m)), [0, 2, 0, 0, 2]);
        await fisicoConsistente(m, `duas físicas ${rodada}`);
      }
    });

    test('baixa física × baixa discricionária: a física sempre passa e a discricionária respeita o livre da posição em que entrou', async () => {
      for (let rodada = 1; rodada <= RODADAS; rodada += 1) {
        const m = await f.material();
        await f.aprovada({ materialId: m, quantidade: 2 });
        const lote = await f.estoque(m, 4);
        const r = await emParalelo([() => f.baixa(lote, 1, 'PERDA'), () => f.baixa(lote, 2, 'OUTRO')], { semente: 520 + rodada, rotulo: `física×discricionária ${rodada}` });
        assert.ok(r[0].ok);
        const p = await f.posicao(m);
        assert.equal(p.comprometido, Math.min(p.fisicoUtilizavel, 2));
        if (r[1].ok) {
          assert.equal(p.fisicoUtilizavel, 1, 'a discricionária chegou primeiro (U4, L2) e a perda veio depois: 4 − 2 − 1');
        } else {
          assert.equal(r[1].codigo, LIVRE, 'a perda chegou primeiro e deixou só 1 livre (U3)');
          assert.equal(p.fisicoUtilizavel, 3);
        }
        await fisicoConsistente(m, `física×discricionária ${rodada}`);
      }
    });
  });

  describe('entrada concorrente', () => {
    test('a entrada nunca espera a trava do par: com o par travado por outra transação ela conclui', async () => {
      const m = await f.material();
      await f.aprovada({ materialId: m, quantidade: 2 });
      await f.estoque(m, 3);
      const segurando = await pool.connect();
      try {
        await segurando.query('BEGIN');
        await parRepo.travarPares(segurando, d.empresaA, [{ materialId: m, tamanho: '40' }]);
        const r = await comLimite(entrada(m, 4), 'entrada com o par travado', 5000);
        assert.ok(r);
        await segurando.query('COMMIT');
      } finally {
        await segurando.query('ROLLBACK').catch(() => {});
        segurando.release();
      }
      assert.deepEqual(f.numeros(await f.posicao(m)), [7, 2, 2, 5, 0]);
    });

    test('DIRETA 1 e entrada de 4 sobre U3 D2: as duas passam, o físico fecha em 6 e a reserva continua inteira', async () => {
      for (let rodada = 1; rodada <= RODADAS; rodada += 1) {
        const m = await f.material();
        await f.aprovada({ materialId: m, quantidade: 2 });
        const lote = await f.estoque(m, 3);
        const r = await emParalelo([() => f.direta([[m, lote, 1]]), () => entrada(m, 4)], { semente: 550 + rodada, rotulo: `D×entrada ${rodada}` });
        assert.deepEqual(r.map((x) => x.ok), [true, true], `rodada ${rodada}: ${JSON.stringify(r)}`);
        assert.deepEqual(f.numeros(await f.posicao(m)), [6, 2, 2, 4, 0]);
        await fisicoConsistente(m, `D×entrada ${rodada}`);
      }
    });

    test('DIRETA 2 e entrada de 4 sobre U3 D2 (L1): a entrada sempre passa; a DIRETA passa só se viu a entrada, e a reserva nunca fica abaixo da demanda', async () => {
      for (let rodada = 1; rodada <= RODADAS; rodada += 1) {
        const m = await f.material();
        await f.aprovada({ materialId: m, quantidade: 2 });
        const lote = await f.estoque(m, 3);
        const r = await emParalelo([() => f.direta([[m, lote, 2]]), () => entrada(m, 4)], { semente: 580 + rodada, rotulo: `D2×entrada ${rodada}` });
        assert.ok(r[1].ok);
        if (!r[0].ok) assert.equal(r[0].codigo, LIVRE);
        const p = await f.posicao(m);
        assert.equal(p.fisicoUtilizavel, r[0].ok ? 5 : 7);
        assert.equal(p.comprometido, 2);
        assert.ok(p.saldoLivre >= 0);
        await fisicoConsistente(m, `D2×entrada ${rodada}`);
      }
    });

    test('baixa discricionária × entrada: a entrada passa e a baixa decide pelo livre que viu, nunca por um livre inexistente', async () => {
      for (let rodada = 1; rodada <= RODADAS; rodada += 1) {
        const m = await f.material();
        await f.aprovada({ materialId: m, quantidade: 2 });
        const lote = await f.estoque(m, 3);
        const r = await emParalelo([() => f.baixa(lote, 2, 'OUTRO'), () => entrada(m, 4)], { semente: 610 + rodada, rotulo: `baixa×entrada ${rodada}` });
        assert.ok(r[1].ok);
        if (!r[0].ok) assert.equal(r[0].codigo, LIVRE);
        const p = await f.posicao(m);
        assert.equal(p.comprometido, 2);
        assert.ok(p.saldoLivre >= 0);
        await fisicoConsistente(m, `baixa×entrada ${rodada}`);
      }
    });
  });

  describe('pares diferentes não se bloqueiam', () => {
    test('com o par A travado, DIRETA e baixa no par B concluem; no par A esperam e concluem depois de liberar', async () => {
      const a = await f.material();
      const b = await f.material();
      const loteA = await f.estoque(a, 5);
      const loteB = await f.estoque(b, 5);
      const segurando = await pool.connect();
      try {
        await segurando.query('BEGIN');
        await parRepo.travarPares(segurando, d.empresaA, [{ materialId: a, tamanho: '40' }]);
        await comLimite(f.direta([[b, loteB, 1]]), 'DIRETA no par B', 5000);
        await comLimite(f.baixa(loteB, 1, 'OUTRO'), 'baixa no par B', 5000);
        const direta = f.direta([[a, loteA, 1]]);
        const baixa = f.baixa(loteA, 1, 'AVARIA');
        await aguardarTravaAdvisoryPendente(pool);
        assert.equal(await f.saldoDoMaterial(a), 5, 'nada foi gravado no par A enquanto ele esteve travado');
        await segurando.query('COMMIT');
        await comLimite(Promise.all([direta, baixa]), 'par A depois de liberar', 10000);
        assert.equal(await f.saldoDoMaterial(a), 3);
      } finally {
        await segurando.query('ROLLBACK').catch(() => {});
        segurando.release();
      }
    });

    test('atos cruzados com os mesmos dois pares em ordens opostas: sem deadlock e com o resultado certo', async () => {
      for (let rodada = 1; rodada <= RODADAS; rodada += 1) {
        const a = await f.material();
        const b = await f.material();
        const loteA = await f.estoque(a, 5);
        const loteB = await f.estoque(b, 5);
        const r = await emParalelo([
          () => f.direta([[a, loteA, 1], [b, loteB, 1]]),
          () => f.direta([[b, loteB, 1], [a, loteA, 1]]),
          () => f.baixa(loteA, 1, 'AVARIA'),
          () => f.baixa(loteB, 1, 'AVARIA'),
        ], { semente: 640 + rodada, rotulo: `cruzados ${rodada}` });
        assert.deepEqual(r.map((x) => x.ok), [true, true, true, true], `rodada ${rodada}`);
        assert.equal(await f.saldoDoMaterial(a), 2);
        assert.equal(await f.saldoDoMaterial(b), 2);
      }
    });
  });

  describe('mesma chave simultânea', () => {
    test('DIRETA: a mesma chave em quatro chamadas simultâneas produz uma entrega só; as demais devolvem a original', async () => {
      for (let rodada = 1; rodada <= RODADAS; rodada += 1) {
        const m = await f.material();
        const lote = await f.estoque(m, 5);
        const chaveIdempotencia = chaveNova();
        const r = await emParalelo([0, 1, 2, 3].map(() => () => f.direta([[m, lote, 2]], { chaveIdempotencia })), { semente: 670 + rodada, rotulo: `chave DIRETA ${rodada}` });
        assert.ok(r.every((x) => x.ok), `rodada ${rodada}`);
        assert.equal(r.filter((x) => !x.valor.repetida).length, 1);
        assert.equal(new Set(r.map((x) => x.valor.entrega.id)).size, 1);
        assert.equal(await f.saldoDoMaterial(m), 3, 'o estoque saiu uma vez só');
        await fisicoConsistente(m, `chave DIRETA ${rodada}`);
      }
    });

    test('baixa: a mesma chave em quatro chamadas simultâneas produz uma baixa só', async () => {
      for (let rodada = 1; rodada <= RODADAS; rodada += 1) {
        const m = await f.material();
        const lote = await f.estoque(m, 5);
        const chaveIdempotencia = chaveNova();
        const r = await emParalelo([0, 1, 2, 3].map(() => () => f.baixa(lote, 2, 'OUTRO', { chaveIdempotencia })), { semente: 700 + rodada, rotulo: `chave baixa ${rodada}` });
        assert.ok(r.every((x) => x.ok), `rodada ${rodada}`);
        assert.equal(r.filter((x) => !x.valor.repetida).length, 1);
        assert.deepEqual(await f.lote(lote), { entrada: 5, baixada: 2, entregue: 0, saldo: 3 });
        assert.equal((await f.baixasAuditadas(lote)).length, 1, 'uma auditoria só');
      }
    });

    test('a mesma chave com recusa: todas devolvem SALDO_LIVRE_INSUFICIENTE e a auditoria da recusa é uma só', async () => {
      for (let rodada = 1; rodada <= RODADAS; rodada += 1) {
        const m = await f.material();
        await f.aprovada({ materialId: m, quantidade: 2 });
        const lote = await f.estoque(m, 2);
        const chaveIdempotencia = chaveNova();
        const r = await emParalelo([0, 1, 2].map(() => () => f.direta([[m, lote, 1]], { chaveIdempotencia })), { semente: 730 + rodada, rotulo: `chave recusa ${rodada}` });
        assert.equal(recusadasPor(r, LIVRE), 3, `rodada ${rodada}`);
        assert.equal(await recusasDo(m, 'ENTREGA_DIRETA'), 1);
      }
    });
  });

  describe('recusas simultâneas e a supressão da auditoria', () => {
    test('quatro recusas simultâneas do mesmo ator no mesmo par: quatro erros, um registro', async () => {
      for (let rodada = 1; rodada <= RODADAS; rodada += 1) {
        const m = await f.material();
        await f.aprovada({ materialId: m, quantidade: 2 });
        const lote = await f.estoque(m, 2);
        const r = await emParalelo([0, 1, 2, 3].map(() => () => f.direta([[m, lote, 1]])), { semente: 760 + rodada, rotulo: `recusas ${rodada}` });
        assert.equal(recusadasPor(r, LIVRE), 4, `rodada ${rodada}`);
        assert.equal(await recusasDo(m, 'ENTREGA_DIRETA'), 1, `rodada ${rodada}: a supressão é serializada por trava`);
      }
    });

    test('recusa de DIRETA e recusa de baixa no mesmo par ao mesmo tempo: um registro de cada tipo', async () => {
      for (let rodada = 1; rodada <= RODADAS; rodada += 1) {
        const m = await f.material();
        await f.aprovada({ materialId: m, quantidade: 2 });
        const lote = await f.estoque(m, 2);
        const r = await emParalelo([
          () => f.direta([[m, lote, 1]]), () => f.baixa(lote, 1, 'OUTRO'), () => f.direta([[m, lote, 1]]), () => f.baixa(lote, 1, 'DEVOLUCAO_FORNECEDOR'),
        ], { semente: 790 + rodada, rotulo: `recusas mistas ${rodada}` });
        assert.equal(recusadasPor(r, LIVRE), 4);
        assert.equal(await recusasDo(m, 'ENTREGA_DIRETA'), 1);
        assert.equal(await recusasDo(m, 'BAIXA'), 1);
      }
    });

    test('atores diferentes recusados juntos: um registro por ator', async () => {
      for (let rodada = 1; rodada <= RODADAS; rodada += 1) {
        const m = await f.material();
        await f.aprovada({ materialId: m, quantidade: 2 });
        const lote = await f.estoque(m, 2);
        const r = await emParalelo([
          () => f.direta([[m, lote, 1]]), () => f.direta([[m, lote, 1]], { atorId: d.sst1 }), () => f.direta([[m, lote, 1]]), () => f.direta([[m, lote, 1]], { atorId: d.sst1 }),
        ], { semente: 820 + rodada, rotulo: `atores ${rodada}` });
        assert.equal(recusadasPor(r, LIVRE), 4);
        const registros = await f.recusas(m);
        assert.deepEqual(registros.map((x) => x.usuario_id).sort(), [d.master, d.sst1].sort());
      }
    });

    test('atos com dois pares insuficientes em ordens opostas: sem deadlock, um registro por par', async () => {
      for (let rodada = 1; rodada <= RODADAS; rodada += 1) {
        const a = await f.material();
        const b = await f.material();
        await f.aprovada({ materialId: a, quantidade: 2 });
        await f.aprovada({ materialId: b, quantidade: 2 });
        const loteA = await f.estoque(a, 2);
        const loteB = await f.estoque(b, 2);
        const r = await emParalelo([
          () => f.direta([[a, loteA, 1], [b, loteB, 1]]), () => f.direta([[b, loteB, 1], [a, loteA, 1]]), () => f.direta([[a, loteA, 1], [b, loteB, 1]]),
        ], { semente: 850 + rodada, rotulo: `dois pares ${rodada}` });
        assert.equal(recusadasPor(r, LIVRE), 3);
        assert.equal(await recusasDo(a, 'ENTREGA_DIRETA'), 1, `rodada ${rodada}`);
        assert.equal(await recusasDo(b, 'ENTREGA_DIRETA'), 1);
      }
    });

    // Interleaving controlado: a DIRETA de 4 roda sozinha (lote 5, demanda 2, livre 3), então só pode ser recusada por saldo livre.
    // A trava da supressão, ocupada pelo teste, deixa a auditoria parada depois do ROLLBACK; só então as outras operações largam.
    test('a recusa não segura o par: enquanto a auditoria da recusa corre, outra operação no mesmo par conclui', async () => {
      const m = await f.material();
      await f.aprovada({ materialId: m, quantidade: 2 });
      const lote = await f.estoque(m, 5);
      const trava = lockDaSupressao(d.empresaA, d.master, chaveDoEvento('ENTREGA_DIRETA', m, '40'));
      const segurando = await pool.connect();
      let alvoResolvido = false;
      let alvo = null;
      try {
        await segurando.query('BEGIN');
        await segurando.query('SELECT pg_advisory_xact_lock($1::bigint)', [trava]);
        alvo = resultadoDe(f.direta([[m, lote, 4]])).then((r) => { alvoResolvido = true; return r; });
        const pidDaAuditoria = await aguardarSessaoNaTrava(trava);

        assert.equal(alvoResolvido, false, 'a recusa só termina depois da auditoria');
        assert.deepEqual(await f.lote(lote), { entrada: 5, baixada: 0, entregue: 0, saldo: 5 }, 'a recusa fez ROLLBACK: nada foi gravado');
        assert.deepEqual(await f.recusas(m), [], 'a auditoria vem depois do ROLLBACK e ainda não gravou');
        const { rows: [{ n }] } = await q("SELECT count(*)::int AS n FROM pg_locks WHERE pid = $1 AND locktype = 'advisory' AND granted", [pidDaAuditoria]);
        assert.equal(n, 0, 'a auditoria parada não segura nenhuma trava advisory, nem a do par');

        const outras = await comLimite(
          Promise.all([resultadoDe(f.direta([[m, lote, 1]])), resultadoDe(f.baixa(lote, 1, 'AVARIA'))]),
          'operações no par com a auditoria parada',
          8000,
        );
        for (const r of outras) assert.ok(r.ok, JSON.stringify(r));
        assert.equal(alvoResolvido, false, 'a auditoria seguia parada enquanto as outras operações concluíam');

        await segurando.query('COMMIT');
        const r = await comLimite(alvo, 'recusa depois de liberada a auditoria', 8000);
        assert.deepEqual([r.ok, r.status, r.codigo], [false, 409, LIVRE]);
      } finally {
        await segurando.query('ROLLBACK').catch(() => {});
        segurando.release();
        if (alvo !== null) await comLimite(alvo, 'recusa pendente ao encerrar', 8000).catch(() => {});
      }

      assert.deepEqual(await f.lote(lote), { entrada: 5, baixada: 1, entregue: 1, saldo: 3 });
      assert.deepEqual(f.numeros(await f.posicao(m)), [3, 2, 2, 1, 0]);
      const registros = await f.recusas(m);
      assert.equal(registros.length, 1);
      assert.deepEqual(
        [registros[0].contexto.operacao, registros[0].contexto.quantidadeSolicitada, registros[0].contexto.fisicoUtilizavel, registros[0].contexto.demandaPendente, registros[0].contexto.saldoLivre],
        ['ENTREGA_DIRETA', 4, 5, 2, 3],
        'no instante da recusa havia físico para 4 e livre para 3',
      );
    });
  });

  describe('rodadas embaralhadas com todos os caminhos', () => {
    test('DIRETA, baixas físicas e discricionárias, entrega por solicitação, aprovação e entrada no mesmo par: invariantes preservados, sem deadlock', async () => {
      for (let rodada = 1; rodada <= RODADAS; rodada += 1) {
        const m = await f.material();
        const alvo = await f.aprovada({ materialId: m, quantidade: 2 });
        const nova = await pendenteDeDecisao(m, 1, trabalhadores[4]);
        const lote = await f.estoque(m, 8);
        const r = await emParalelo([
          () => f.direta([[m, lote, 2]]),
          () => f.direta([[m, lote, 3]]),
          () => f.baixa(lote, 1, 'AVARIA'),
          () => f.baixa(lote, 2, 'OUTRO'),
          () => f.baixa(lote, 1, 'DEVOLUCAO_FORNECEDOR'),
          () => porSolicitacao(alvo, lote, 2),
          () => decidir(nova),
          () => entrada(m, 2),
        ], { semente: 900 + rodada, rotulo: `embaralhada ${rodada}` });
        for (const x of r) if (!x.ok) assert.ok([LIVRE, 'SALDO_INSUFICIENTE', 'SALDO_LOTE_INSUFICIENTE', 'QUANTIDADE_ACIMA_DA_COBERTURA', 'QUANTIDADE_ACIMA_DO_PENDENTE'].includes(x.codigo), JSON.stringify(x));
        assert.ok(r[2].ok || r[2].codigo === 'SALDO_LOTE_INSUFICIENTE', 'a baixa física só falha pelo saldo do lote');
        assert.ok(r[6].ok && r[7].ok, 'aprovação e entrada nunca dependem do estoque');
        const p = await f.posicao(m);
        assert.equal(p.comprometido, Math.min(p.fisicoUtilizavel, p.demandaPendente));
        assert.ok(p.saldoLivre >= 0);
        await fisicoConsistente(m, `embaralhada ${rodada}`);
        for (const registro of await f.recusas(m)) assert.ok(['ENTREGA_DIRETA', 'BAIXA'].includes(registro.contexto.operacao));
        assert.ok((await f.recusas(m)).length <= 4, 'a supressão limita o ruído: no máximo um por ator, operação e par');
      }
    });
  });
});
