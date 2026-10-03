'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { gerador } = require('./helpers/gerador');
const { todasAsMigrations, criarMaterial } = require('./helpers/entrega-epi');
const { criarLoteDeEntrada } = require('./helpers/solicitacao-epi');
const {
  montarMundoDoServico, vincularMaterialAoGhe, chaveNova, comLimite, aguardarTravaAdvisoryPendente, aguardarEsperaPorTravaDeLinha,
} = require('./helpers/solicitacao-epi-servico');
const solicitacaoSvc = require('../../src/services/solicitacao-epi.service');
const estoqueSvc = require('../../src/services/estoque.service');
const parRepo = require('../../src/repositories/estoque-par.repository');
const { HttpError } = require('../../src/errors/HttpError');
const { dataOperacional } = require('../../src/utils/data-operacional');

/**
 * Entrega por solicitação (12C-2): concorrência com PostgreSQL real e
 * conexões distintas. O serviço trava, nesta ordem: idempotência, solicitação,
 * trabalhador, materiais, pares, lotes, numeração, e recalcula a cobertura
 * depois das travas. Validado aqui:
 *   - duas entregas sobre o mesmo item: sem excesso;
 *   - solicitações diferentes no mesmo par: sem quebra de FIFO;
 *   - pares diferentes: sem espera entre si;
 *   - mesma chave simultânea: uma entrega só;
 *   - entrega × baixa, × entrada, × aprovação e × cancelamento: sem dupla
 *     baixa, sem deadlock e com resultado determinístico dentro das regras;
 *   - rodadas embaralhadas com todos os caminhos, repetidas.
 * Cada rodada usa material próprio: a cobertura é por empresa, material e tamanho.
 */

const servico = () => exigirModulo('src/services/entrega-solicitacao.service');
const HOJE = dataOperacional();
const DECLARACAO = 'Declaro que recebi os EPIs relacionados e fui orientado sobre o uso correto (texto fictício).';
const ACEITE = { modo: 'ACEITE_PRESENCIAL', declaracaoVersao: 'NR6-2026-09', declaracaoTexto: DECLARACAO };
// Padrão 8; RODADAS_ENTREGA maior serve para um estresse pontual, sem mudar o teste.
const RODADAS = Number.parseInt(process.env.RODADAS_ENTREGA ?? '8', 10);
const DEADLOCK = '40P01';

const dormir = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Resultado normalizado de uma chamada: { ok } ou { erro: { status, codigo } | { code } }.
async function resultadoDe(promessa) {
  try {
    return { ok: true, valor: await promessa };
  } catch (erro) {
    if (HttpError.ehHttpError(erro)) return { ok: false, status: erro.status, codigo: erro.codigo };
    return { ok: false, code: erro.code, mensagem: erro.message };
  }
}

describe('entrega por solicitação — concorrência (PostgreSQL real)', () => {
  let contexto;
  let pool;
  let d;
  let trabalhadores;
  let sequencia = 0;

  const q = (sql, params) => pool.query(sql, params);

  before(async () => {
    contexto = await abrirPoolTemporario(todasAsMigrations());
    pool = contexto.pool;
    d = await montarMundoDoServico(pool);
    trabalhadores = [d.trabalhador, d.trabalhador2, d.trabalhador3];
    for (let i = 0; i < 4; i += 1) trabalhadores.push(await d.novoTrabalhador(d.empresaA, { gheId: d.gheA }));
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  async function material() {
    sequencia += 1;
    const id = await criarMaterial(pool, d.empresaA, `Material de concorrência ${sequencia}`, { exigeTamanho: true });
    await vincularMaterialAoGhe(pool, d.empresaA, d.gheA, id);
    return id;
  }
  const estoque = (materialId, quantidade) => criarLoteDeEntrada(pool, { empresaId: d.empresaA, materialId, quantidade, usuarioId: d.master });

  async function aprovada(materialId, quantidade, funcionarioId) {
    const criada = await solicitacaoSvc.criarSolicitacao(pool, {
      empresaId: d.empresaA, atorId: d.solicitante, funcionarioId, itens: [{ materialId, tamanho: '40', quantidade, motivo: 'ADMISSAO' }], chaveIdempotencia: chaveNova(),
    });
    await solicitacaoSvc.decidirSolicitacao(pool, {
      empresaId: d.empresaA, atorId: d.sst1, solicitacaoId: criada.solicitacao.id, decisoes: [{ itemId: criada.itens[0].id, decisao: 'APROVADO' }], hoje: HOJE,
    });
    return { id: criada.solicitacao.id, item: criada.itens[0].id };
  }
  async function pendente(materialId, funcionarioId) {
    const criada = await solicitacaoSvc.criarSolicitacao(pool, {
      empresaId: d.empresaA, atorId: d.solicitante, funcionarioId, itens: [{ materialId, tamanho: '40', quantidade: 1, motivo: 'ADMISSAO' }], chaveIdempotencia: chaveNova(),
    });
    return { id: criada.solicitacao.id, item: criada.itens[0].id };
  }

  const entregar = (alvo, loteId, quantidade, extra = {}) => servico().registrarEntregaPorSolicitacao(pool, {
    empresaId: d.empresaA,
    atorId: d.master,
    solicitacaoId: alvo.id,
    itens: [{ solicitacaoItemId: alvo.item, loteId, quantidade }],
    confirmacao: ACEITE,
    chaveIdempotencia: chaveNova(),
    ...extra,
  });
  const entregueDe = async (alvo) => (await q('SELECT COALESCE(sum(quantidade), 0)::int AS n FROM entregas_epi_itens WHERE solicitacao_item_id = $1', [alvo.item])).rows[0].n;
  const statusDe = async (alvo) => (await q('SELECT status FROM solicitacoes_epi WHERE id = $1', [alvo.id])).rows[0].status;
  const saldosDe = async (materialId) => (await q(
    'SELECT quantidade_entrada AS entrada, quantidade_baixada AS baixada, quantidade_entregue AS entregue, saldo FROM estoque_lotes WHERE material_id = $1 ORDER BY id', [materialId],
  )).rows;
  const entregasDe = async (alvo) => (await q('SELECT count(DISTINCT entrega_id)::int AS n FROM entregas_epi_itens WHERE solicitacao_item_id = $1', [alvo.item])).rows[0].n;

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
    return resultados;
  }

  describe('o mesmo item', () => {
    test('duas entregas de 2 sobre 3 aprovadas: uma passa e a outra é QUANTIDADE_ACIMA_DO_PENDENTE, em qualquer ordem, em várias rodadas', async () => {
      for (let rodada = 1; rodada <= RODADAS; rodada += 1) {
        const m = await material();
        const alvo = await aprovada(m, 3, trabalhadores[0]);
        const loteId = await estoque(m, 20);
        const r = await emParalelo([() => entregar(alvo, loteId, 2), () => entregar(alvo, loteId, 2)], { semente: rodada, rotulo: `mesmo item ${rodada}` });
        assert.equal(r.filter((x) => x.ok).length, 1, `rodada ${rodada}`);
        const recusada = r.find((x) => !x.ok);
        assert.deepEqual([recusada.status, recusada.codigo], [409, 'QUANTIDADE_ACIMA_DO_PENDENTE']);
        assert.equal(await entregueDe(alvo), 2);
        assert.equal(await statusDe(alvo), 'APROVADA');
        assert.deepEqual(await saldosDe(m), [{ entrada: 20, baixada: 0, entregue: 2, saldo: 18 }]);
      }
    });

    test('2 e 1 sobre 3 aprovadas: as duas passam, a solicitação fecha uma vez só e o saldo sai uma vez só', async () => {
      for (let rodada = 1; rodada <= RODADAS; rodada += 1) {
        const m = await material();
        const alvo = await aprovada(m, 3, trabalhadores[0]);
        const loteId = await estoque(m, 20);
        const r = await emParalelo([() => entregar(alvo, loteId, 2), () => entregar(alvo, loteId, 1)], { semente: 100 + rodada, rotulo: `2+1 ${rodada}` });
        assert.deepEqual(r.map((x) => x.ok), [true, true], `rodada ${rodada}`);
        assert.equal(await entregueDe(alvo), 3);
        assert.equal(await statusDe(alvo), 'ENTREGUE');
        assert.equal(await entregasDe(alvo), 2);
        assert.equal((await q("SELECT count(*)::int AS n FROM logs_auditoria WHERE acao = 'SOLICITACAO_EPI_ENTREGUE' AND referencia = $1", [String(alvo.id)])).rows[0].n, 1, 'o fechamento é auditado uma vez');
        assert.deepEqual(await saldosDe(m), [{ entrada: 20, baixada: 0, entregue: 3, saldo: 17 }]);
      }
    });

    test('três entregas de 2 sobre 4 aprovadas: exatamente duas passam e a terceira é recusada; nunca passa da aprovada', async () => {
      for (let rodada = 1; rodada <= RODADAS; rodada += 1) {
        const m = await material();
        const alvo = await aprovada(m, 4, trabalhadores[0]);
        const loteId = await estoque(m, 20);
        const r = await emParalelo([0, 1, 2].map(() => () => entregar(alvo, loteId, 2)), { semente: 200 + rodada, rotulo: `três ${rodada}` });
        assert.equal(r.filter((x) => x.ok).length, 2, `rodada ${rodada}`);
        const recusada = r.find((x) => !x.ok);
        assert.equal(recusada.status, 409);
        assert.ok(['SOLICITACAO_NAO_ENTREGAVEL', 'QUANTIDADE_ACIMA_DO_PENDENTE'].includes(recusada.codigo), recusada.codigo);
        assert.equal(await entregueDe(alvo), 4);
        assert.equal(await statusDe(alvo), 'ENTREGUE');
      }
    });
  });

  describe('o mesmo par, solicitações diferentes (FIFO)', () => {
    test('a mais antiga não perde a cobertura: com estoque 3, a de 2 sempre entrega os seus 2 e a posterior de 2 sempre é recusada', async () => {
      for (let rodada = 1; rodada <= RODADAS; rodada += 1) {
        const m = await material();
        const antiga = await aprovada(m, 2, trabalhadores[0]);
        const posterior = await aprovada(m, 2, trabalhadores[1]);
        const loteId = await estoque(m, 3);
        const r = await emParalelo([() => entregar(posterior, loteId, 2), () => entregar(antiga, loteId, 2)], { semente: 300 + rodada, rotulo: `FIFO ${rodada}` });
        assert.equal(r[1].ok, true, `rodada ${rodada}: a mais antiga entrega`);
        assert.deepEqual([r[0].ok, r[0].codigo], [false, 'QUANTIDADE_ACIMA_DA_COBERTURA'], `rodada ${rodada}: a posterior não passa`);
        assert.deepEqual([await entregueDe(antiga), await entregueDe(posterior)], [2, 0]);
        assert.deepEqual(await saldosDe(m), [{ entrada: 3, baixada: 0, entregue: 2, saldo: 1 }]);
      }
    });

    test('três solicitações de 2 com estoque 3 e pedidos de 1: as duas primeiras passam e a terceira, sem cobertura, é recusada, em qualquer ordem', async () => {
      for (let rodada = 1; rodada <= RODADAS; rodada += 1) {
        const m = await material();
        const s1 = await aprovada(m, 2, trabalhadores[0]);
        const s2 = await aprovada(m, 2, trabalhadores[1]);
        const s3 = await aprovada(m, 2, trabalhadores[2]);
        const loteId = await estoque(m, 3);
        const r = await emParalelo([() => entregar(s3, loteId, 1), () => entregar(s1, loteId, 1), () => entregar(s2, loteId, 1)], { semente: 400 + rodada, rotulo: `FIFO3 ${rodada}` });
        assert.deepEqual([r[1].ok, r[2].ok], [true, true], `rodada ${rodada}`);
        assert.deepEqual([r[0].ok, r[0].codigo], [false, 'QUANTIDADE_ACIMA_DA_COBERTURA']);
        assert.deepEqual(await saldosDe(m), [{ entrada: 3, baixada: 0, entregue: 2, saldo: 1 }]);
      }
    });

    test('a solicitação posterior com pedido que cabe na sua cobertura passa junto com a mais antiga', async () => {
      for (let rodada = 1; rodada <= RODADAS; rodada += 1) {
        const m = await material();
        const antiga = await aprovada(m, 2, trabalhadores[0]);
        const posterior = await aprovada(m, 2, trabalhadores[1]);
        const loteId = await estoque(m, 3);
        const r = await emParalelo([() => entregar(posterior, loteId, 1), () => entregar(antiga, loteId, 2)], { semente: 500 + rodada, rotulo: `FIFO-ok ${rodada}` });
        assert.deepEqual(r.map((x) => x.ok), [true, true], `rodada ${rodada}`);
        assert.deepEqual(await saldosDe(m), [{ entrada: 3, baixada: 0, entregue: 3, saldo: 0 }]);
      }
    });
  });

  describe('a ficha do trabalhador', () => {
    test('duas solicitações do mesmo trabalhador, ainda sem ficha, entregues ao mesmo tempo: uma ficha só, numeração sem lacuna e as duas entregas na mesma ficha', async () => {
      for (let rodada = 1; rodada <= RODADAS; rodada += 1) {
        const trabalhador = await d.novoTrabalhador(d.empresaA, { gheId: d.gheA });
        const m1 = await material();
        const m2 = await material();
        const s1 = await aprovada(m1, 1, trabalhador);
        const s2 = await aprovada(m2, 1, trabalhador);
        const lote1 = await estoque(m1, 2);
        const lote2 = await estoque(m2, 2);
        const antes = (await q('SELECT COALESCE(max(ultimo_numero), 0)::int AS n FROM fichas_epi_numeracao')).rows[0].n;
        const r = await emParalelo([() => entregar(s1, lote1, 1), () => entregar(s2, lote2, 1)], { semente: 1200 + rodada, rotulo: `ficha ${rodada}` });
        assert.deepEqual(r.map((x) => x.ok), [true, true], `rodada ${rodada}`);
        assert.equal(r[0].valor.ficha.id, r[1].valor.ficha.id);
        assert.equal((await q('SELECT count(*)::int AS n FROM fichas_epi WHERE funcionario_id = $1', [trabalhador])).rows[0].n, 1);
        assert.equal((await q('SELECT COALESCE(max(ultimo_numero), 0)::int AS n FROM fichas_epi_numeracao')).rows[0].n, antes + 1, 'o contador avançou uma vez só');
      }
    });
  });

  describe('pares diferentes e a trava do par', () => {
    test('quem espera a trava de um par não bloqueia a entrega de outro par; ao liberar, a primeira conclui', async () => {
      const m1 = await material();
      const m2 = await material();
      const s1 = await aprovada(m1, 1, trabalhadores[0]);
      const s2 = await aprovada(m2, 1, trabalhadores[1]);
      const lote1 = await estoque(m1, 2);
      const lote2 = await estoque(m2, 2);
      const segurando = await pool.connect();
      try {
        await segurando.query('BEGIN');
        await parRepo.travarPares(segurando, d.empresaA, [{ materialId: m1, tamanho: '40' }]);
        const esperando = comLimite(entregar(s1, lote1, 1), 'par travado', 30000);
        await aguardarTravaAdvisoryPendente(pool);
        await comLimite(entregar(s2, lote2, 1), 'outro par com o primeiro travado', 10000);
        assert.equal(await entregueDe(s2), 1, 'o outro par não esperou');
        assert.equal(await entregueDe(s1), 0, 'o par travado continua esperando');
        await segurando.query('COMMIT');
        await esperando;
        assert.equal(await entregueDe(s1), 1);
      } finally {
        await segurando.query('ROLLBACK').catch(() => {});
        segurando.release();
      }
    });
  });

  describe('a mesma chave simultânea', () => {
    test('quatro pedidos idênticos ao mesmo tempo: uma entrega, as demais devolvem a original', async () => {
      for (let rodada = 1; rodada <= RODADAS; rodada += 1) {
        const m = await material();
        const alvo = await aprovada(m, 5, trabalhadores[0]);
        const loteId = await estoque(m, 20);
        const chaveIdempotencia = chaveNova();
        const r = await emParalelo([0, 1, 2, 3].map(() => () => entregar(alvo, loteId, 2, { chaveIdempotencia })), { semente: 600 + rodada, rotulo: `chave ${rodada}` });
        assert.deepEqual(r.map((x) => x.ok), [true, true, true, true], `rodada ${rodada}`);
        assert.equal(r.filter((x) => x.valor.repetida === false).length, 1);
        assert.equal(new Set(r.map((x) => x.valor.entrega.id)).size, 1);
        assert.equal(await entregasDe(alvo), 1);
        assert.deepEqual(await saldosDe(m), [{ entrada: 20, baixada: 0, entregue: 2, saldo: 18 }]);
      }
    });

    test('a mesma chave com conteúdos diferentes ao mesmo tempo: um vence, o outro é IDEMPOTENCIA_CONFLITO', async () => {
      for (let rodada = 1; rodada <= RODADAS; rodada += 1) {
        const m = await material();
        const alvo = await aprovada(m, 5, trabalhadores[0]);
        const loteId = await estoque(m, 20);
        const chaveIdempotencia = chaveNova();
        const r = await emParalelo([() => entregar(alvo, loteId, 1, { chaveIdempotencia }), () => entregar(alvo, loteId, 2, { chaveIdempotencia })], { semente: 700 + rodada, rotulo: `conflito ${rodada}` });
        assert.equal(r.filter((x) => x.ok).length, 1, `rodada ${rodada}`);
        assert.deepEqual([r.find((x) => !x.ok).status, r.find((x) => !x.ok).codigo], [409, 'IDEMPOTENCIA_CONFLITO']);
        assert.equal(await entregasDe(alvo), 1);
      }
    });
  });

  describe('entrega × outras operações do estoque e da solicitação', () => {
    test('entrega × baixa do mesmo lote: exatamente uma sai; sem dupla baixa, saldo nunca negativo, nenhum deadlock', async () => {
      for (let rodada = 1; rodada <= RODADAS; rodada += 1) {
        const m = await material();
        const alvo = await aprovada(m, 3, trabalhadores[0]);
        const loteId = await estoque(m, 3);
        const baixa = () => estoqueSvc.registrarBaixa(pool, { empresaId: d.empresaA, atorId: d.master, loteId, quantidade: 1, motivo: 'AVARIA', chaveIdempotencia: chaveNova() });
        const r = await emParalelo([() => entregar(alvo, loteId, 3), baixa], { semente: 800 + rodada, rotulo: `entrega×baixa ${rodada}` });
        assert.equal(r.filter((x) => x.ok).length, 1, `rodada ${rodada}: ${JSON.stringify(r.map((x) => x.codigo ?? 'ok'))}`);
        const [lote] = await saldosDe(m);
        if (r[0].ok) {
          assert.deepEqual([lote.entregue, lote.baixada, lote.saldo], [3, 0, 0]);
          assert.equal(r[1].codigo, 'SALDO_LOTE_INSUFICIENTE');
        } else {
          assert.equal(r[0].codigo, 'QUANTIDADE_ACIMA_DA_COBERTURA', 'a baixa física reduziu a cobertura antes da entrega');
          assert.deepEqual([lote.entregue, lote.baixada, lote.saldo], [0, 1, 2]);
        }
        assert.ok(lote.saldo >= 0);
      }
    });

    test('determinístico: a baixa que termina enquanto a entrega espera o lote é vista pela validação, que responde com erro de domínio e não com a violação do CHECK do estoque', async () => {
      const m = await material();
      const alvo = await aprovada(m, 3, trabalhadores[0]);
      const loteId = await estoque(m, 3);
      const segurando = await pool.connect();
      try {
        await segurando.query('BEGIN');
        await segurando.query('SELECT 1 FROM estoque_lotes WHERE empresa_id = $1 AND id = $2 FOR UPDATE', [d.empresaA, loteId]);
        const espera = resultadoDe(comLimite(entregar(alvo, loteId, 3), 'entrega à espera do lote', 30000));
        await aguardarEsperaPorTravaDeLinha(pool);
        // Baixa física de 1 unidade, na transação que tem o lote: a entrega só enxerga o saldo depois dela.
        await segurando.query(
          `INSERT INTO estoque_operacoes (empresa_id, lote_id, tipo, quantidade, motivo, usuario_id, chave_idempotencia, requisicao_hash)
           VALUES ($1, $2, 'BAIXA', 1, 'AVARIA', $3, $4, $5)`,
          [d.empresaA, loteId, d.master, chaveNova(), 'a'.repeat(64)],
        );
        await segurando.query('COMMIT');
        const r = await espera;
        assert.deepEqual([r.ok, r.status, r.codigo], [false, 409, 'QUANTIDADE_ACIMA_DA_COBERTURA'], JSON.stringify(r));
        assert.deepEqual(await saldosDe(m), [{ entrada: 3, baixada: 1, entregue: 0, saldo: 2 }]);
        assert.equal(await entregueDe(alvo), 0);
      } finally {
        await segurando.query('ROLLBACK').catch(() => {});
        segurando.release();
      }
    });

    test('entrega × baixa de outro lote do mesmo par: as duas passam, e a baixa física sempre é aceita', async () => {
      for (let rodada = 1; rodada <= RODADAS; rodada += 1) {
        const m = await material();
        const alvo = await aprovada(m, 3, trabalhadores[0]);
        const lote1 = await estoque(m, 3);
        const lote2 = await estoque(m, 5);
        const baixa = () => estoqueSvc.registrarBaixa(pool, { empresaId: d.empresaA, atorId: d.master, loteId: lote2, quantidade: 5, motivo: 'PERDA', chaveIdempotencia: chaveNova() });
        const r = await emParalelo([() => entregar(alvo, lote1, 3), baixa], { semente: 900 + rodada, rotulo: `entrega×baixa-outro-lote ${rodada}` });
        assert.deepEqual(r.map((x) => x.ok), [true, true], `rodada ${rodada}`);
        assert.deepEqual(await saldosDe(m), [{ entrada: 3, baixada: 0, entregue: 3, saldo: 0 }, { entrada: 5, baixada: 5, entregue: 0, saldo: 0 }]);
      }
    });

    test('entrega × entrada, × aprovação de outra solicitação do par e × cancelamento: tudo passa, sem espera infinita', async () => {
      for (let rodada = 1; rodada <= RODADAS; rodada += 1) {
        const m = await material();
        const alvo = await aprovada(m, 2, trabalhadores[0]);
        const loteId = await estoque(m, 2);
        const paraAprovar = await pendente(m, trabalhadores[1]);
        const paraCancelar = await pendente(m, trabalhadores[2]);
        const entrada = () => estoqueSvc.registrarEntrada(pool, {
          empresaId: d.empresaA, atorId: d.master, materialId: m, tamanho: '40', quantidade: 4, caNumero: '7777', caValidade: '2099-12-31', chaveIdempotencia: chaveNova(), hoje: HOJE,
        });
        const aprovar = () => solicitacaoSvc.decidirSolicitacao(pool, {
          empresaId: d.empresaA, atorId: d.sst1, solicitacaoId: paraAprovar.id, decisoes: [{ itemId: paraAprovar.item, decisao: 'APROVADO' }], hoje: HOJE,
        });
        const cancelar = () => solicitacaoSvc.cancelarSolicitacao(pool, { empresaId: d.empresaA, atorId: d.solicitante, solicitacaoId: paraCancelar.id });
        const r = await emParalelo([() => entregar(alvo, loteId, 2), entrada, aprovar, cancelar], { semente: 1000 + rodada, rotulo: `entrega×outros ${rodada}` });
        assert.deepEqual(r.map((x) => x.ok), [true, true, true, true], `rodada ${rodada}: ${JSON.stringify(r.map((x) => x.codigo ?? 'ok'))}`);
        assert.equal(await statusDe(alvo), 'ENTREGUE');
        assert.equal(await statusDe(paraAprovar), 'APROVADA');
        assert.equal(await statusDe(paraCancelar), 'CANCELADA');
      }
    });
  });

  describe('todos os caminhos juntos, embaralhados e repetidos', () => {
    test('entregas do mesmo item, de outra solicitação do par e de outro par, baixa, entrada, aprovação e cancelamento: sem deadlock, sem excesso, resultado exato', async () => {
      for (let rodada = 1; rodada <= RODADAS; rodada += 1) {
        const m = await material();
        const outroPar = await material();
        const alvo = await aprovada(m, 4, trabalhadores[0]);
        const vizinha = await aprovada(m, 2, trabalhadores[1]);
        const distante = await aprovada(outroPar, 1, trabalhadores[2]);
        const lote1 = await estoque(m, 30);
        const lote2 = await estoque(m, 30);
        const loteDistante = await estoque(outroPar, 5);
        const paraAprovar = await pendente(m, trabalhadores[3]);
        const paraCancelar = await pendente(m, trabalhadores[4]);
        const tarefas = [
          () => entregar(alvo, lote1, 2),
          () => entregar(alvo, lote2, 2),
          () => entregar(alvo, lote1, 2),
          () => entregar(vizinha, lote2, 1),
          () => entregar(distante, loteDistante, 1),
          () => estoqueSvc.registrarBaixa(pool, { empresaId: d.empresaA, atorId: d.master, loteId: lote1, quantidade: 1, motivo: 'AVARIA', chaveIdempotencia: chaveNova() }),
          () => estoqueSvc.registrarEntrada(pool, {
            empresaId: d.empresaA, atorId: d.master, materialId: m, tamanho: '40', quantidade: 3, caNumero: '8888', caValidade: '2099-12-31', chaveIdempotencia: chaveNova(), hoje: HOJE,
          }),
          () => solicitacaoSvc.decidirSolicitacao(pool, {
            empresaId: d.empresaA, atorId: d.sst1, solicitacaoId: paraAprovar.id, decisoes: [{ itemId: paraAprovar.item, decisao: 'APROVADO' }], hoje: HOJE,
          }),
          () => solicitacaoSvc.cancelarSolicitacao(pool, { empresaId: d.empresaA, atorId: d.solicitante, solicitacaoId: paraCancelar.id }),
        ];
        const r = await emParalelo(tarefas, { semente: 1100 + rodada, rotulo: `todos ${rodada}` });

        const entregasDoAlvo = r.slice(0, 3);
        assert.equal(entregasDoAlvo.filter((x) => x.ok).length, 2, `rodada ${rodada}: duas de 2 esgotam as 4 aprovadas`);
        const recusada = entregasDoAlvo.find((x) => !x.ok);
        assert.equal(recusada.status, 409);
        assert.ok(['SOLICITACAO_NAO_ENTREGAVEL', 'QUANTIDADE_ACIMA_DO_PENDENTE'].includes(recusada.codigo), recusada.codigo);
        for (const indice of [3, 4, 5, 6, 7, 8]) assert.equal(r[indice].ok, true, `rodada ${rodada}, tarefa ${indice}: ${r[indice].codigo ?? r[indice].mensagem}`);
        assert.equal(await statusDe(paraAprovar), 'APROVADA');
        assert.equal(await statusDe(paraCancelar), 'CANCELADA');
        assert.deepEqual([await entregueDe(alvo), await statusDe(alvo)], [4, 'ENTREGUE']);
        assert.deepEqual([await entregueDe(vizinha), await entregueDe(distante)], [1, 1]);
        for (const lote of await saldosDe(m)) assert.equal(lote.saldo, lote.entrada - lote.baixada - lote.entregue);
        const { rows: [{ entregue, operacoes }] } = await q(
          `SELECT COALESCE(sum(l.quantidade_entregue), 0)::int AS entregue,
                  (SELECT COALESCE(sum(o.quantidade), 0)::int FROM estoque_operacoes o JOIN estoque_lotes l2 ON l2.id = o.lote_id WHERE o.tipo = 'ENTREGA' AND l2.material_id = $1) AS operacoes
             FROM estoque_lotes l WHERE l.material_id = $1`,
          [m],
        );
        assert.equal(entregue, 5, `rodada ${rodada}: 4 do alvo + 1 da vizinha saíram do físico, uma vez só`);
        assert.equal(operacoes, entregue, 'cada unidade entregue tem a sua operação, sem dupla baixa');
      }
    });
  });
});
