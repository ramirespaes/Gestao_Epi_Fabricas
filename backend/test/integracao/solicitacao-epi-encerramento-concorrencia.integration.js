'use strict';

const {
  describe, test, before, after, beforeEach,
} = require('node:test');
const assert = require('node:assert/strict');
const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { gerador } = require('./helpers/gerador');
const { todasAsMigrations } = require('./helpers/entrega-epi');
const {
  montarMundoDoServico, chaveNova, comLimite, portao, aguardarTravaAdvisoryPendente, aguardarEsperaPorTravaDeLinha,
} = require('./helpers/solicitacao-epi-servico');
const { criarFerramentas } = require('./helpers/reserva-estoque');
const itemRepo = require('../../src/repositories/solicitacao-epi-item.repository');
const coberturaRepo = require('../../src/repositories/solicitacao-epi-cobertura.repository');
const { lockDoPar } = require('../../src/utils/lock-par-estoque');
const { HttpError } = require('../../src/errors/HttpError');

/**
 * Encerramento da solicitação (12E-2) sob concorrência, com PostgreSQL real e
 * conexões distintas. O encerramento trava a solicitação (FOR NO KEY UPDATE) e
 * depois os pares com pendente (advisory, ordem canônica), na ordem global
 * (idempotência, solicitação, trabalhador, materiais, pares, lotes,
 * numeração): a entrega por solicitação, a decisão e o cancelamento também
 * começam pela solicitação, e a entrega DIRETA e a baixa nunca a tocam. Os
 * cenários usam portões (a primeira operação para com as travas tomadas) e
 * esperam no próprio PostgreSQL a segunda ficar bloqueada; nada depende de
 * tempo.
 */

const servico = () => exigirModulo('src/services/solicitacao-epi.service');
const entregaSvc = () => exigirModulo('src/services/entrega-solicitacao.service');
const DECLARACAO = 'Declaro que recebi os EPIs relacionados e fui orientado sobre o uso correto (texto fictício).';
const ACEITE = { modo: 'ACEITE_PRESENCIAL', declaracaoVersao: 'NR6-2026-09', declaracaoTexto: DECLARACAO };
const RODADAS = Number.parseInt(process.env.RODADAS_ENCERRAMENTO ?? '8', 10);
const DEADLOCK = '40P01';
const TRAVA_OCUPADA = '55P03';

async function resultadoDe(promessa) {
  try {
    return { ok: true, valor: await promessa };
  } catch (erro) {
    if (HttpError.ehHttpError(erro)) return { ok: false, status: erro.status, codigo: erro.codigo };
    return { ok: false, code: erro.code, mensagem: erro.message };
  }
}

describe('encerramento da solicitação — concorrência (PostgreSQL real)', () => {
  let contexto;
  let pool;
  let d;
  let f;

  const q = (sql, params) => pool.query(sql, params);
  const encerrar = (alvo, extra = {}) => {
    const modulo = servico();
    assert.equal(typeof modulo.encerrarSolicitacao, 'function', 'função ainda não implementada: encerrarSolicitacao');
    return modulo.encerrarSolicitacao(pool, {
      empresaId: d.empresaA, atorId: d.sst1, solicitacaoId: alvo.id, justificativa: 'Encerramento concorrente', hoje: f.HOJE, ...extra,
    });
  };
  const entregar = (alvo, loteId, quantidade) => entregaSvc().registrarEntregaPorSolicitacao(pool, {
    empresaId: d.empresaA, atorId: d.master, solicitacaoId: alvo.id, itens: [{ solicitacaoItemId: alvo.item, loteId, quantidade }], confirmacao: ACEITE, chaveIdempotencia: chaveNova(),
  });
  const statusDe = async (alvo) => (await q('SELECT status FROM solicitacoes_epi WHERE id = $1', [alvo.id])).rows[0].status;
  const entregueDe = async (alvo) => (await q('SELECT COALESCE(sum(quantidade), 0)::int AS n FROM entregas_epi_itens WHERE solicitacao_item_id = $1', [alvo.item])).rows[0].n;
  const encerramentosAuditados = async (alvo) => (await q(
    "SELECT count(*)::int AS n FROM logs_auditoria WHERE acao = 'SOLICITACAO_EPI_ENCERRADA' AND referencia = $1", [String(alvo.id)],
  )).rows[0].n;

  before(async () => {
    contexto = await abrirPoolTemporario(todasAsMigrations());
    pool = contexto.pool;
    d = await montarMundoDoServico(pool);
    f = criarFerramentas(pool, d);
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  // Sem o serviço, nenhum cenário começa: uma operação parada num portão seguraria travas até o fim da suíte.
  beforeEach(() => {
    assert.equal(typeof servico().encerrarSolicitacao, 'function', 'função ainda não implementada: encerrarSolicitacao');
  });

  describe('ordem das travas', () => {
    test('a solicitação é travada antes dos pares: parado depois da trava da solicitação, o par ainda está livre; parado depois dos pares, os dois estão presos', async (t) => {
      const m = await f.material();
      await f.estoque(m, 2);
      const alvo = await f.aprovada({ materialId: m, quantidade: 2 });
      const parLivre = async () => (await q('SELECT pg_try_advisory_xact_lock($1::bigint) AS livre', [lockDoPar(d.empresaA, m, '40')])).rows[0].livre;
      const solicitacaoPresa = async () => {
        const cliente = await pool.connect();
        try {
          await cliente.query('BEGIN');
          const erro = await cliente.query('SELECT 1 FROM solicitacoes_epi WHERE id = $1 FOR NO KEY UPDATE NOWAIT', [alvo.id]).then(() => null, (e) => e);
          return erro?.code === TRAVA_OCUPADA;
        } finally {
          await cliente.query('ROLLBACK').catch(() => {});
          cliente.release();
        }
      };

      const depoisDaSolicitacao = portao(t, itemRepo, 'listarPorSolicitacaoComEntregue');
      const depoisDosPares = portao(t, coberturaRepo, 'lerPosicoes');
      const ato = resultadoDe(comLimite(encerrar(alvo), 'encerramento com portões', 30000));
      await depoisDaSolicitacao.chegada;
      assert.deepEqual([await solicitacaoPresa(), await parLivre()], [true, true], 'só a solicitação está presa');
      depoisDaSolicitacao.liberar();
      await depoisDosPares.chegada;
      assert.deepEqual([await solicitacaoPresa(), await parLivre()], [true, false], 'solicitação e par presos');
      depoisDosPares.liberar();
      const r = await ato;
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(await statusDe(alvo), 'ENCERRADA');
    });
  });

  describe('os quatro cenários', () => {
    test('A) o encerramento vence: a entrega que chega depois espera a solicitação e é recusada (SOLICITACAO_NAO_ENTREGAVEL), sem gravar nada', async (t) => {
      const m = await f.material();
      const loteId = await f.estoque(m, 3);
      const alvo = await f.aprovada({ materialId: m, quantidade: 3 });
      const gate = portao(t, itemRepo, 'listarPorSolicitacaoComEntregue');
      const ato = resultadoDe(comLimite(encerrar(alvo), 'encerramento', 30000));
      await gate.chegada;
      const entrega = resultadoDe(comLimite(entregar(alvo, loteId, 1), 'entrega à espera', 30000));
      await aguardarEsperaPorTravaDeLinha(pool);
      gate.liberar();
      const [rEncerrar, rEntrega] = await Promise.all([ato, entrega]);
      assert.equal(rEncerrar.ok, true, JSON.stringify(rEncerrar));
      assert.deepEqual([rEntrega.ok, rEntrega.status, rEntrega.codigo], [false, 409, 'SOLICITACAO_NAO_ENTREGAVEL'], JSON.stringify(rEntrega));
      assert.equal(await statusDe(alvo), 'ENCERRADA');
      assert.equal(await entregueDe(alvo), 0);
      assert.deepEqual(await f.lote(loteId), { entrada: 3, baixada: 0, entregue: 0, saldo: 3 });
      assert.deepEqual(f.numeros(await f.posicao(m)), [3, 0, 0, 3, 0]);
    });

    test('B) a entrega parcial vence: ela é preservada e o encerramento que esperava encerra só o restante', async (t) => {
      const m = await f.material();
      const loteId = await f.estoque(m, 5);
      const alvo = await f.aprovada({ materialId: m, quantidade: 3 });
      const gate = portao(t, coberturaRepo, 'listarCobertura');
      const entrega = resultadoDe(comLimite(entregar(alvo, loteId, 1), 'entrega parcial', 30000));
      await gate.chegada;
      const ato = resultadoDe(comLimite(encerrar(alvo), 'encerramento à espera', 30000));
      await aguardarEsperaPorTravaDeLinha(pool);
      gate.liberar();
      const [rEntrega, rEncerrar] = await Promise.all([entrega, ato]);
      assert.equal(rEntrega.ok, true, JSON.stringify(rEntrega));
      assert.equal(rEncerrar.ok, true, JSON.stringify(rEncerrar));
      assert.equal(await statusDe(alvo), 'ENCERRADA');
      assert.equal(await entregueDe(alvo), 1);
      assert.deepEqual(await f.lote(loteId), { entrada: 5, baixada: 0, entregue: 1, saldo: 4 });
      assert.deepEqual(f.numeros(await f.posicao(m)), [4, 0, 0, 4, 0]);
      assert.deepEqual(rEncerrar.valor.itens.map((i) => [i.quantidadeEntregue, i.quantidadePendente]), [[1, 0]]);
      const { rows: [registro] } = await q("SELECT contexto FROM logs_auditoria WHERE acao = 'SOLICITACAO_EPI_ENCERRADA' AND referencia = $1", [String(alvo.id)]);
      assert.deepEqual([registro.contexto.quantidadeEntregue, registro.contexto.quantidadeLiberada], [1, 2]);
    });

    test('C) a entrega final vence: a solicitação fecha ENTREGUE e o encerramento que esperava é recusado (SOLICITACAO_NAO_ENCERRAVEL)', async (t) => {
      const m = await f.material();
      const loteId = await f.estoque(m, 3);
      const alvo = await f.aprovada({ materialId: m, quantidade: 3 });
      const gate = portao(t, coberturaRepo, 'listarCobertura');
      const entrega = resultadoDe(comLimite(entregar(alvo, loteId, 3), 'entrega final', 30000));
      await gate.chegada;
      const ato = resultadoDe(comLimite(encerrar(alvo), 'encerramento à espera', 30000));
      await aguardarEsperaPorTravaDeLinha(pool);
      gate.liberar();
      const [rEntrega, rEncerrar] = await Promise.all([entrega, ato]);
      assert.equal(rEntrega.ok, true, JSON.stringify(rEntrega));
      assert.deepEqual([rEncerrar.ok, rEncerrar.status, rEncerrar.codigo], [false, 409, 'SOLICITACAO_NAO_ENCERRAVEL'], JSON.stringify(rEncerrar));
      assert.equal(await statusDe(alvo), 'ENTREGUE');
      assert.equal(await entregueDe(alvo), 3);
      assert.equal(await encerramentosAuditados(alvo), 0);
    });

    test('D) dois encerramentos ao mesmo tempo: um conclui; o outro espera e recebe SOLICITACAO_NAO_ENCERRAVEL; uma auditoria só', async (t) => {
      const m = await f.material();
      await f.estoque(m, 1);
      const alvo = await f.aprovada({ materialId: m, quantidade: 2 });
      const gate = portao(t, itemRepo, 'listarPorSolicitacaoComEntregue');
      const primeiro = resultadoDe(comLimite(encerrar(alvo), 'primeiro encerramento', 30000));
      await gate.chegada;
      const segundo = resultadoDe(comLimite(encerrar(alvo, { atorId: d.sst2, justificativa: 'Segunda tentativa' }), 'segundo encerramento', 30000));
      await aguardarEsperaPorTravaDeLinha(pool);
      gate.liberar();
      const [r1, r2] = await Promise.all([primeiro, segundo]);
      assert.equal(r1.ok, true, JSON.stringify(r1));
      assert.deepEqual([r2.ok, r2.status, r2.codigo], [false, 409, 'SOLICITACAO_NAO_ENCERRAVEL'], JSON.stringify(r2));
      const { rows: [lida] } = await q('SELECT encerrada_por, justificativa_encerramento FROM solicitacoes_epi WHERE id = $1', [alvo.id]);
      assert.deepEqual([lida.encerrada_por, lida.justificativa_encerramento], [d.sst1, 'Encerramento concorrente']);
      assert.equal(await encerramentosAuditados(alvo), 1);
      assert.deepEqual(f.numeros(await f.posicao(m)), [1, 0, 0, 1, 0]);
    });
  });

  describe('com o estoque', () => {
    test('a entrega DIRETA do mesmo par espera a trava do encerramento e, depois dele, usa o saldo liberado', async (t) => {
      const m = await f.material();
      const loteId = await f.estoque(m, 2);
      const alvo = await f.aprovada({ materialId: m, quantidade: 2 });
      assert.deepEqual(f.numeros(await f.posicao(m)), [2, 2, 2, 0, 0]);
      const gate = portao(t, coberturaRepo, 'lerPosicoes');
      const ato = resultadoDe(comLimite(encerrar(alvo), 'encerramento segurando o par', 30000));
      await gate.chegada;
      const direta = resultadoDe(comLimite(f.direta([[m, loteId, 2]]), 'DIRETA à espera do par', 30000));
      await aguardarTravaAdvisoryPendente(pool);
      assert.deepEqual(await f.lote(loteId), { entrada: 2, baixada: 0, entregue: 0, saldo: 2 }, 'nada saiu do lote enquanto o par estava preso');
      gate.liberar();
      const [rEncerrar, rDireta] = await Promise.all([ato, direta]);
      assert.equal(rEncerrar.ok, true, JSON.stringify(rEncerrar));
      assert.equal(rDireta.ok, true, JSON.stringify(rDireta));
      assert.deepEqual(await f.lote(loteId), { entrada: 2, baixada: 0, entregue: 2, saldo: 0 });
      assert.deepEqual(f.numeros(await f.posicao(m)), [0, 0, 0, 0, 0]);
    });

    test('rodadas embaralhadas: encerramento × entrega por solicitação × DIRETA × baixa × aprovação de outra solicitação do par, sem deadlock e sem quebrar as regras', async () => {
      for (let rodada = 1; rodada <= RODADAS; rodada += 1) {
        const m = await f.material();
        const loteId = await f.estoque(m, 6);
        const alvo = await f.aprovada({ materialId: m, quantidade: 3 });
        const outra = await servico().criarSolicitacao(pool, {
          empresaId: d.empresaA, atorId: d.solicitante, funcionarioId: d.trabalhador3, itens: [{ materialId: m, tamanho: '40', quantidade: 2, motivo: 'ADMISSAO' }], chaveIdempotencia: chaveNova(),
        });
        const tarefas = [
          () => encerrar(alvo),
          () => entregar(alvo, loteId, 1),
          () => f.direta([[m, loteId, 1]]),
          () => f.baixa(loteId, 1, 'AVARIA'),
          () => servico().decidirSolicitacao(pool, {
            empresaId: d.empresaA, atorId: d.sst2, solicitacaoId: outra.solicitacao.id, decisoes: [{ itemId: outra.itens[0].id, decisao: 'APROVADO' }], hoje: f.HOJE,
          }),
        ];
        const sorteio = gerador(4200 + rodada);
        const ordem = tarefas.map((tarefa, i) => [tarefa, i]).sort(() => sorteio() - 0.5);
        const resultados = new Array(tarefas.length);
        await Promise.all(ordem.map(async ([tarefa, i]) => {
          resultados[i] = await resultadoDe(comLimite(tarefa(), `rodada ${rodada} #${i}`, 30000));
        }));
        for (const r of resultados) {
          assert.notEqual(r.code, DEADLOCK, `rodada ${rodada}: deadlock`);
          assert.ok(!r.mensagem?.includes('não resolveu'), `rodada ${rodada}: travou`);
          assert.ok(r.ok || r.status !== undefined, `rodada ${rodada}: erro fora do domínio ${JSON.stringify(r)}`);
        }
        assert.equal(resultados[0].ok, true, `rodada ${rodada}: o encerramento sempre conclui (${JSON.stringify(resultados[0])})`);
        assert.equal(resultados[4].ok, true, `rodada ${rodada}: a aprovação de outra solicitação não depende do encerramento`);
        assert.equal(await statusDe(alvo), 'ENCERRADA');
        const entregue = await entregueDe(alvo);
        assert.ok([0, 1].includes(entregue), `rodada ${rodada}: entregue ${entregue}`);
        assert.equal(resultados[1].ok, entregue === 1, `rodada ${rodada}: a entrega por solicitação só existe se veio antes do encerramento`);
        const lote = await f.lote(loteId);
        assert.ok(lote.saldo >= 0);
        assert.equal(lote.entrada - lote.baixada - lote.entregue, lote.saldo);
        const p = await f.posicao(m);
        assert.equal(p.demandaPendente, 2, `rodada ${rodada}: só a outra solicitação compõe D`);
        assert.equal(await encerramentosAuditados(alvo), 1);
      }
    });
  });
});
