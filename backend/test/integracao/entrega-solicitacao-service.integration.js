'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { todasAsMigrations, criarMaterial, criarLote } = require('./helpers/entrega-epi');
const { criarLoteDeEntrada } = require('./helpers/solicitacao-epi');
const {
  montarMundoDoServico, vincularMaterialAoGhe, chaveNova, esperarHttpError,
} = require('./helpers/solicitacao-epi-servico');
const solicitacaoSvc = require('../../src/services/solicitacao-epi.service');
const direta = require('../../src/services/entrega-epi.service');
const entregaRepo = require('../../src/repositories/entrega-epi.repository');
const itemRepo = require('../../src/repositories/entrega-epi-item.repository');
const confirmacaoRepo = require('../../src/repositories/entrega-epi-confirmacao.repository');
const fichaRepo = require('../../src/repositories/ficha-epi.repository');
const auditoriaRepo = require('../../src/repositories/auditoria.repository');
const { dataOperacional } = require('../../src/utils/data-operacional');

/**
 * Entrega por solicitação (12C-2) contra PostgreSQL real: o fluxo interno
 * solicitação aprovada → cobertura FIFO → lote escolhido → entrega física →
 * estoque → ficha → confirmação → auditoria → fechamento ENTREGUE.
 *
 * As solicitações nascem e são aprovadas pelos serviços da 12B, e o serviço
 * da entrega lê tudo o que precisa do que está gravado: o teste só informa
 * solicitação, itens (item da solicitação, lote e quantidade) e confirmação.
 * Cada cenário usa materiais próprios, porque a cobertura é por empresa,
 * material e tamanho.
 */

const servico = () => exigirModulo('src/services/entrega-solicitacao.service');
const HOJE = dataOperacional();
const DECLARACAO = 'Declaro que recebi os EPIs relacionados e fui orientado sobre o uso correto (texto fictício).';
const ACEITE = { modo: 'ACEITE_PRESENCIAL', declaracaoVersao: 'NR6-2026-09', declaracaoTexto: DECLARACAO };
const DESENHO = { modo: 'DESENHO', tracos: [[[10, 10], [20, 12]], [[40, 40]]], declaracaoVersao: 'NR6-2026-09', declaracaoTexto: DECLARACAO };

describe('entrega por solicitação — serviço transacional (PostgreSQL real)', () => {
  let contexto;
  let pool;
  let d;
  let sequencia = 0;

  const q = (sql, params) => pool.query(sql, params);
  const contar = async (sql, params = []) => (await q(sql, params)).rows[0].n;

  async function material({ previsto = true, ...opcoes } = {}) {
    sequencia += 1;
    const id = await criarMaterial(pool, d.empresaA, `Material de entrega ${sequencia}`, { exigeTamanho: true, ...opcoes });
    if (previsto) await vincularMaterialAoGhe(pool, d.empresaA, d.gheA, id);
    return id;
  }
  const estoque = (materialId, quantidade, extra = {}) => criarLoteDeEntrada(pool, {
    empresaId: d.empresaA, materialId, quantidade, usuarioId: d.master, ...extra,
  });

  // Solicitação criada e aprovada pelos serviços da 12B. `itens`: { materialId, tamanho, quantidade, aprovada, motivo, justificativa, justificativaDecisao }.
  async function aprovada({ funcionarioId = d.trabalhador, itens, reprovar = [] }) {
    const criada = await solicitacaoSvc.criarSolicitacao(pool, {
      empresaId: d.empresaA,
      atorId: d.solicitante,
      funcionarioId,
      itens: itens.map((i) => ({
        materialId: i.materialId, tamanho: 'tamanho' in i ? i.tamanho : '40', quantidade: i.quantidade, motivo: i.motivo ?? 'ADMISSAO', ...(i.justificativa ? { justificativa: i.justificativa } : {}),
      })),
      chaveIdempotencia: chaveNova(),
    });
    const decisoes = criada.itens.map((item, indice) => {
      const origem = itens[indice];
      if (reprovar.includes(indice)) return { itemId: item.id, decisao: 'REPROVADO', justificativa: 'Sem necessidade comprovada' };
      const reduzida = origem.aprovada !== undefined && origem.aprovada < origem.quantidade;
      const justificativa = origem.justificativaDecisao ?? (reduzida ? 'Quantidade reduzida pela SST' : undefined);
      return { itemId: item.id, decisao: 'APROVADO', ...(reduzida ? { quantidadeAprovada: origem.aprovada } : {}), ...(justificativa ? { justificativa } : {}) };
    });
    await solicitacaoSvc.decidirSolicitacao(pool, {
      empresaId: d.empresaA, atorId: d.sst1, solicitacaoId: criada.solicitacao.id, decisoes, hoje: HOJE,
    });
    return { id: criada.solicitacao.id, itens: criada.itens.map((i) => i.id), funcionarioId };
  }

  // `referencia`: o índice do item na solicitação (número) ou { id } para um id de item explícito.
  const entregar = (solicitacao, itens, extra = {}) => servico().registrarEntregaPorSolicitacao(pool, {
    empresaId: d.empresaA,
    atorId: d.master,
    solicitacaoId: solicitacao.id,
    itens: itens.map(([referencia, loteId, quantidade]) => ({
      solicitacaoItemId: typeof referencia === 'number' ? solicitacao.itens[referencia] : referencia.id, loteId, quantidade,
    })),
    confirmacao: ACEITE,
    chaveIdempotencia: chaveNova(),
    ip: '203.0.113.10',
    dispositivo: 'Navegador de teste',
    ...extra,
  });
  const lida = (solicitacao) => solicitacaoSvc.buscarSolicitacao(pool, { empresaId: d.empresaA, solicitacaoId: solicitacao.id, hoje: HOJE });
  const estoqueSvcBaixa = (loteId, quantidade, motivo = 'AVARIA') => require('../../src/services/estoque.service').registrarBaixa(pool, {
    empresaId: d.empresaA, atorId: d.master, loteId, quantidade, motivo, chaveIdempotencia: chaveNova(),
  });
  const statusDe = async (solicitacao) => (await q('SELECT status, entregue_em FROM solicitacoes_epi WHERE id = $1', [solicitacao.id])).rows[0];
  const lote = async (id) => (await q('SELECT quantidade_entregue AS entregue, saldo FROM estoque_lotes WHERE id = $1', [id])).rows[0];
  const retrato = async () => (await q(
    `SELECT (SELECT count(*) FROM fichas_epi)::int AS fichas, (SELECT count(*) FROM entregas_epi)::int AS entregas,
            (SELECT count(*) FROM entregas_epi_itens)::int AS itens, (SELECT count(*) FROM entregas_epi_confirmacoes)::int AS confirmacoes,
            (SELECT count(*) FROM estoque_operacoes WHERE tipo = 'ENTREGA')::int AS operacoes,
            (SELECT COALESCE(sum(quantidade_entregue), 0) FROM estoque_lotes)::int AS entregue,
            (SELECT count(*) FROM logs_auditoria WHERE acao IN ('ENTREGA_REGISTRADA', 'SOLICITACAO_EPI_ENTREGUE'))::int AS auditorias,
            (SELECT COALESCE(max(ultimo_numero), 0) FROM fichas_epi_numeracao)::int AS contador`,
  )).rows[0];
  const auditorias = async (acao, referencia) => (await q(
    'SELECT usuario_id, referencia, contexto, dados_anteriores, dados_novos FROM logs_auditoria WHERE acao = $1 AND referencia = $2 ORDER BY id',
    [acao, String(referencia)],
  )).rows;

  before(async () => {
    contexto = await abrirPoolTemporario(todasAsMigrations());
    pool = contexto.pool;
    d = await montarMundoDoServico(pool);
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  describe('o fluxo feliz', () => {
    test('entrega completa: uma entrega SOLICITACAO com ficha, item ligado, operação ENTREGA, confirmação e fechamento ENTREGUE na mesma transação', async () => {
      const m = await material();
      const solicitacao = await aprovada({ itens: [{ materialId: m, quantidade: 2 }] });
      const loteId = await estoque(m, 5);
      const antes = await retrato();

      const r = await entregar(solicitacao, [[0, loteId, 2]], { confirmacao: DESENHO });

      assert.equal(r.repetida, false);
      assert.equal(r.entrega.origem, 'SOLICITACAO');
      assert.deepEqual([r.ficha.numero, r.ficha.funcionarioId], [antes.contador + 1, d.trabalhador]);
      assert.equal(r.itens.length, 1);
      assert.deepEqual([r.itens[0].solicitacaoItemId, r.itens[0].loteId, r.itens[0].quantidade, r.itens[0].motivo], [solicitacao.itens[0], loteId, 2, 'ADMISSAO']);
      assert.ok(r.itens[0].operacaoId !== null, 'a operação ENTREGA do item');
      assert.equal(r.confirmacao.modo, 'DESENHO');
      assert.deepEqual([r.solicitacao.id, r.solicitacao.status], [solicitacao.id, 'ENTREGUE']);
      assert.ok(r.solicitacao.entregueEm instanceof Date);

      assert.deepEqual(await lote(loteId), { entregue: 2, saldo: 3 });
      const fechada = await statusDe(solicitacao);
      assert.equal(fechada.status, 'ENTREGUE');
      assert.ok(fechada.entregue_em instanceof Date);
      const depois = await retrato();
      assert.deepEqual(depois, {
        ...antes, fichas: antes.fichas + 1, entregas: antes.entregas + 1, itens: antes.itens + 1, confirmacoes: antes.confirmacoes + 1, operacoes: antes.operacoes + 1,
        entregue: antes.entregue + 2, auditorias: antes.auditorias + 2, contador: antes.contador + 1,
      });
      const { rows: [entrega] } = await q('SELECT origem, ghe_id, responsavel_id FROM entregas_epi WHERE id = $1', [r.entrega.id]);
      assert.deepEqual([entrega.origem, entrega.ghe_id, entrega.responsavel_id], ['SOLICITACAO', d.gheA, d.master], 'o GHE do trabalhador vem do cadastro, não do chamador');
    });

    test('entrega parcial: entrega 1 de 3, a solicitação continua aberta com o mesmo status decisório e a situação derivada PARCIALMENTE_ENTREGUE', async () => {
      const m = await material();
      const solicitacao = await aprovada({ itens: [{ materialId: m, quantidade: 3 }] });
      const loteId = await estoque(m, 3);
      const r = await entregar(solicitacao, [[0, loteId, 1]]);
      assert.equal(r.solicitacao.status, 'APROVADA');
      assert.equal(r.solicitacao.entregueEm, null);
      assert.equal((await statusDe(solicitacao)).status, 'APROVADA');
      const vista = await lida(solicitacao);
      assert.equal(vista.solicitacao.status, 'APROVADA');
      assert.equal(vista.solicitacao.situacaoOperacional, 'PARCIALMENTE_ENTREGUE');
      assert.deepEqual([vista.itens[0].situacao, vista.itens[0].quantidadeEntregue, vista.itens[0].quantidadePendente], ['PARCIALMENTE_ENTREGUE', 1, 2]);
      assert.equal(await contar("SELECT count(*)::int AS n FROM logs_auditoria WHERE acao = 'SOLICITACAO_EPI_ENTREGUE' AND referencia = $1", [String(solicitacao.id)]), 0, 'sem fechamento, sem o evento');
    });

    test('a segunda entrega completa o item: reutiliza a ficha sem gastar numeração, fecha a solicitação e cada ato é uma entrega com chave, confirmação e operação próprias', async () => {
      const m = await material();
      const solicitacao = await aprovada({ itens: [{ materialId: m, quantidade: 3 }] });
      const loteId = await estoque(m, 3);
      const primeira = await entregar(solicitacao, [[0, loteId, 1]]);
      const contadorDepoisDaPrimeira = (await retrato()).contador;
      const segunda = await entregar(solicitacao, [[0, loteId, 2]], { confirmacao: DESENHO });
      assert.equal(segunda.ficha.id, primeira.ficha.id);
      assert.equal((await retrato()).contador, contadorDepoisDaPrimeira, 'a numeração só avança quando a ficha é criada');
      assert.notEqual(segunda.entrega.id, primeira.entrega.id);
      assert.equal(segunda.solicitacao.status, 'ENTREGUE');
      assert.equal((await statusDe(solicitacao)).status, 'ENTREGUE');
      assert.deepEqual(await lote(loteId), { entregue: 3, saldo: 0 });
      const { rows } = await q(
        `SELECT e.id, e.chave_idempotencia, c.modo FROM entregas_epi e JOIN entregas_epi_itens i ON i.entrega_id = e.id
           JOIN entregas_epi_confirmacoes c ON c.entrega_id = e.id WHERE i.solicitacao_item_id = $1 ORDER BY e.id`,
        [solicitacao.itens[0]],
      );
      assert.deepEqual(rows.map((x) => x.modo), ['ACEITE_PRESENCIAL', 'DESENHO']);
      assert.notEqual(rows[0].chave_idempotencia, rows[1].chave_idempotencia);
    });

    test('vários lotes no mesmo item: um item da entrega por lote, todos ligados ao mesmo item da solicitação, uma operação por lote', async () => {
      const m = await material();
      const solicitacao = await aprovada({ itens: [{ materialId: m, quantidade: 5 }] });
      const lote1 = await estoque(m, 3);
      const lote2 = await estoque(m, 4);
      const r = await entregar(solicitacao, [[0, lote2, 2], [0, lote1, 3]]);
      assert.deepEqual(r.itens.map((i) => [i.loteId, i.quantidade, i.solicitacaoItemId]), [[lote1, 3, solicitacao.itens[0]], [lote2, 2, solicitacao.itens[0]]], 'em ordem de lote');
      assert.equal(await contar('SELECT count(*)::int AS n FROM estoque_operacoes WHERE entrega_item_id = ANY($1)', [r.itens.map((i) => i.id)]), 2);
      assert.deepEqual(await lote(lote1), { entregue: 3, saldo: 0 });
      assert.deepEqual(await lote(lote2), { entregue: 2, saldo: 2 });
      assert.equal(r.solicitacao.status, 'ENTREGUE');
    });

    test('vários itens da mesma solicitação num ato só: uma entrega, um item por lote, fecha quando todos os aprovados estão completos', async () => {
      const a = await material();
      const b = await material({ exigeTamanho: false });
      const solicitacao = await aprovada({ itens: [{ materialId: a, quantidade: 2 }, { materialId: b, tamanho: null, quantidade: 1 }] });
      const loteA = await estoque(a, 2);
      const loteB = await estoque(b, 1, { tamanho: null });
      const r = await entregar(solicitacao, [[0, loteA, 2], [1, loteB, 1]]);
      assert.equal(r.itens.length, 2);
      assert.deepEqual(r.itens.map((i) => i.solicitacaoItemId).sort(), [...solicitacao.itens].sort());
      assert.equal(r.solicitacao.status, 'ENTREGUE');
      assert.equal(await contar('SELECT count(DISTINCT entrega_id)::int AS n FROM entregas_epi_itens WHERE solicitacao_item_id = ANY($1)', [solicitacao.itens]), 1);
    });

    test('item reprovado não entra na conta do fechamento: entregar o aprovado fecha a solicitação APROVADA_PARCIAL', async () => {
      const a = await material();
      const b = await material();
      const solicitacao = await aprovada({ itens: [{ materialId: a, quantidade: 2 }, { materialId: b, quantidade: 1 }], reprovar: [1] });
      const loteA = await estoque(a, 2);
      const r = await entregar(solicitacao, [[0, loteA, 2]]);
      assert.equal(r.solicitacao.status, 'ENTREGUE');
      const antes = await retrato();
      await esperarHttpError(entregar(solicitacao, [[1, loteA, 1]]), 409, 'SOLICITACAO_NAO_ENTREGAVEL');
      assert.deepEqual(await retrato(), antes);
    });
  });

  describe('a solicitação tem de estar entregável', () => {
    test('PENDENTE, REPROVADA, CANCELADA e ENTREGUE recusam com SOLICITACAO_NAO_ENTREGAVEL, sem tocar em nada', async () => {
      const m = await material();
      const loteId = await estoque(m, 10);
      const nova = () => solicitacaoSvc.criarSolicitacao(pool, {
        empresaId: d.empresaA, atorId: d.solicitante, funcionarioId: d.trabalhador, itens: [{ materialId: m, tamanho: '40', quantidade: 1, motivo: 'ADMISSAO' }], chaveIdempotencia: chaveNova(),
      });
      const pendente = await nova();
      const cancelada = await nova();
      await solicitacaoSvc.cancelarSolicitacao(pool, { empresaId: d.empresaA, atorId: d.solicitante, solicitacaoId: cancelada.solicitacao.id });
      const reprovada = await nova();
      await solicitacaoSvc.decidirSolicitacao(pool, {
        empresaId: d.empresaA, atorId: d.sst1, solicitacaoId: reprovada.solicitacao.id, decisoes: [{ itemId: reprovada.itens[0].id, decisao: 'REPROVADO', justificativa: 'Sem necessidade comprovada' }], hoje: HOJE,
      });
      const entregue = await aprovada({ itens: [{ materialId: m, quantidade: 1 }] });
      await entregar(entregue, [[0, loteId, 1]]);
      const antes = await retrato();
      for (const { solicitacao, itens } of [pendente, cancelada, reprovada]) {
        await esperarHttpError(entregar({ id: solicitacao.id, itens: itens.map((i) => i.id) }, [[0, loteId, 1]]), 409, 'SOLICITACAO_NAO_ENTREGAVEL');
      }
      await esperarHttpError(entregar(entregue, [[0, loteId, 1]]), 409, 'SOLICITACAO_NAO_ENTREGAVEL');
      assert.deepEqual(await retrato(), antes);
    });

    test('trabalhador inativo: SOLICITACAO_NAO_ENTREGAVEL, o status histórico não muda, e reativar volta a entregar', async () => {
      const m = await material();
      const trabalhador = await d.novoTrabalhador(d.empresaA, { gheId: d.gheA });
      const solicitacao = await aprovada({ funcionarioId: trabalhador, itens: [{ materialId: m, quantidade: 2 }] });
      const loteId = await estoque(m, 5);
      await q('UPDATE funcionarios SET ativo = false WHERE id = $1', [trabalhador]);
      const antes = await retrato();
      await esperarHttpError(entregar(solicitacao, [[0, loteId, 1]]), 409, 'SOLICITACAO_NAO_ENTREGAVEL');
      assert.deepEqual(await retrato(), antes);
      assert.equal((await statusDe(solicitacao)).status, 'APROVADA');
      await q('UPDATE funcionarios SET ativo = true WHERE id = $1', [trabalhador]);
      assert.equal((await entregar(solicitacao, [[0, loteId, 1]])).solicitacao.status, 'APROVADA');
    });

    test('material sem prazo de uso ou óculos sem classificação de grau: a solicitação nasce e é aprovada, mas a entrega recusa como a DIRETA, sem tocar em nada', async () => {
      const semPrazo = await material({ prazo: null });
      const oculos = await material({ exigeTamanho: false, tipo: 'Óculos de proteção' });
      const solicitacaoPrazo = await aprovada({ itens: [{ materialId: semPrazo, quantidade: 1 }] });
      const solicitacaoOculos = await aprovada({ itens: [{ materialId: oculos, tamanho: null, quantidade: 1 }] });
      const lotePrazo = await estoque(semPrazo, 2);
      const loteOculos = await estoque(oculos, 2, { tamanho: null });
      const antes = await retrato();
      await esperarHttpError(entregar(solicitacaoPrazo, [[0, lotePrazo, 1]]), 409, 'MATERIAL_PRAZO_NAO_CLASSIFICADO');
      await esperarHttpError(entregar(solicitacaoOculos, [[0, loteOculos, 1]]), 409, 'MATERIAL_OCULOS_NAO_CLASSIFICADO');
      assert.deepEqual(await retrato(), antes);
      await q('UPDATE materiais SET prazo_uso_dias = 180 WHERE id = $1', [semPrazo]);
      assert.equal((await entregar(solicitacaoPrazo, [[0, lotePrazo, 1]])).solicitacao.status, 'ENTREGUE');
    });

    test('material inativo: SOLICITACAO_NAO_ENTREGAVEL, só para o item do material inativo; o status histórico não muda', async () => {
      const a = await material();
      const b = await material();
      const solicitacao = await aprovada({ itens: [{ materialId: a, quantidade: 1 }, { materialId: b, quantidade: 1 }] });
      const loteA = await estoque(a, 2);
      const loteB = await estoque(b, 2);
      await q('UPDATE materiais SET ativo = false WHERE id = $1', [a]);
      await esperarHttpError(entregar(solicitacao, [[0, loteA, 1]]), 409, 'SOLICITACAO_NAO_ENTREGAVEL');
      assert.equal((await statusDe(solicitacao)).status, 'APROVADA');
      const r = await entregar(solicitacao, [[1, loteB, 1]]);
      assert.equal(r.solicitacao.status, 'APROVADA', 'o item do material ativo é entregue; o outro continua pendente');
    });
  });

  describe('o item da solicitação', () => {
    test('item reprovado: ITEM_NAO_APROVADO', async () => {
      const a = await material();
      const b = await material();
      const solicitacao = await aprovada({ itens: [{ materialId: a, quantidade: 1 }, { materialId: b, quantidade: 1 }], reprovar: [1] });
      const loteB = await estoque(b, 2);
      await esperarHttpError(entregar(solicitacao, [[1, loteB, 1]]), 409, 'ITEM_NAO_APROVADO');
    });

    test('item inexistente, de outra solicitação ou de outra empresa: ITEM_SOLICITACAO_NAO_ENCONTRADO, sem revelar qual; solicitação de outra empresa: SOLICITACAO_NAO_ENCONTRADA', async () => {
      const m = await material();
      const alvo = await aprovada({ itens: [{ materialId: m, quantidade: 1 }] });
      const outra = await aprovada({ itens: [{ materialId: m, quantidade: 1 }] });
      const loteId = await estoque(m, 5);
      await esperarHttpError(entregar(alvo, [[{ id: 2147483000 }, loteId, 1]]), 404, 'ITEM_SOLICITACAO_NAO_ENCONTRADO');
      await esperarHttpError(entregar(alvo, [[{ id: outra.itens[0] }, loteId, 1]]), 404, 'ITEM_SOLICITACAO_NAO_ENCONTRADO');
      await esperarHttpError(servico().registrarEntregaPorSolicitacao(pool, {
        empresaId: d.empresaB, atorId: d.masterB, solicitacaoId: alvo.id, itens: [{ solicitacaoItemId: alvo.itens[0], loteId, quantidade: 1 }], confirmacao: ACEITE, chaveIdempotencia: chaveNova(),
      }), 404, 'SOLICITACAO_NAO_ENCONTRADA');
      await esperarHttpError(entregar({ id: 2147483000, itens: [1] }, [[0, loteId, 1]]), 404, 'SOLICITACAO_NAO_ENCONTRADA');
    });

    test('mistura de solicitações: item de outra solicitação do mesmo trabalhador é recusado antes da barreira do banco, e nada é gravado', async () => {
      const m = await material();
      const n = await material();
      const a = await aprovada({ itens: [{ materialId: m, quantidade: 2 }] });
      const b = await aprovada({ itens: [{ materialId: n, quantidade: 2 }] });
      const loteM = await estoque(m, 5);
      const loteN = await estoque(n, 5);
      const antes = await retrato();
      await esperarHttpError(entregar(a, [[0, loteM, 1], [{ id: b.itens[0] }, loteN, 1]]), 404, 'ITEM_SOLICITACAO_NAO_ENCONTRADO');
      assert.deepEqual(await retrato(), antes);
    });
  });

  describe('o lote escolhido pelo operador', () => {
    test('lote de material divergente e lote de tamanho divergente: LOTE_DIVERGENTE_DO_ITEM; lote inexistente ou de outra empresa: LOTE_NAO_ENCONTRADO', async () => {
      const m = await material();
      const outro = await material();
      const solicitacao = await aprovada({ itens: [{ materialId: m, quantidade: 2 }] });
      await estoque(m, 5);
      const loteOutroMaterial = await estoque(outro, 5);
      const lote41 = await estoque(m, 5, { tamanho: '41' });
      const loteB = await criarLoteDeEntrada(pool, { empresaId: d.empresaB, materialId: d.botinaB, quantidade: 5, usuarioId: d.masterB });
      await esperarHttpError(entregar(solicitacao, [[0, loteOutroMaterial, 1]]), 409, 'LOTE_DIVERGENTE_DO_ITEM');
      await esperarHttpError(entregar(solicitacao, [[0, lote41, 1]]), 409, 'LOTE_DIVERGENTE_DO_ITEM');
      await esperarHttpError(entregar(solicitacao, [[0, 2147483000, 1]]), 404, 'LOTE_NAO_ENCONTRADO');
      await esperarHttpError(entregar(solicitacao, [[0, loteB, 1]]), 404, 'LOTE_NAO_ENCONTRADO');
    });

    test('CA vencido e CA ausente são recusados; o CA que vence hoje vale até o fim do dia', async () => {
      const m = await material();
      const solicitacao = await aprovada({ itens: [{ materialId: m, quantidade: 3 }] });
      const bom = await estoque(m, 5);
      const vencido = await criarLote(pool, { empresaId: d.empresaA, materialId: m, quantidade: 5, caNumero: '9', caValidade: '2020-01-01' });
      const semCa = await criarLote(pool, { empresaId: d.empresaA, materialId: m, quantidade: 5, caNumero: null, caValidade: null });
      const venceHoje = await criarLote(pool, { empresaId: d.empresaA, materialId: m, quantidade: 5, caNumero: '10', caValidade: HOJE });
      await esperarHttpError(entregar(solicitacao, [[0, vencido, 1]]), 409, 'CA_VENCIDO');
      await esperarHttpError(entregar(solicitacao, [[0, semCa, 1]]), 409, 'CA_AUSENTE');
      assert.equal((await entregar(solicitacao, [[0, venceHoje, 1], [0, bom, 1]])).itens.length, 2);
    });

    test('saldo de lote insuficiente: SALDO_INSUFICIENTE, mesmo quando a cobertura do par seria suficiente com outro lote', async () => {
      const m = await material();
      const solicitacao = await aprovada({ itens: [{ materialId: m, quantidade: 4 }] });
      const pequeno = await estoque(m, 1);
      await estoque(m, 10);
      await esperarHttpError(entregar(solicitacao, [[0, pequeno, 2]]), 409, 'SALDO_INSUFICIENTE');
      assert.deepEqual(await lote(pequeno), { entregue: 0, saldo: 1 });
    });
  });

  describe('quantidade: pendente, cobertura FIFO e soma por item', () => {
    test('acima do pendente: QUANTIDADE_ACIMA_DO_PENDENTE; a aprovada reduzida vale pela aprovada, não pelo pedido', async () => {
      const m = await material();
      const solicitacao = await aprovada({ itens: [{ materialId: m, quantidade: 5, aprovada: 3 }] });
      const loteId = await estoque(m, 10);
      await esperarHttpError(entregar(solicitacao, [[0, loteId, 4]]), 409, 'QUANTIDADE_ACIMA_DO_PENDENTE');
      await entregar(solicitacao, [[0, loteId, 2]]);
      await esperarHttpError(entregar(solicitacao, [[0, loteId, 2]]), 409, 'QUANTIDADE_ACIMA_DO_PENDENTE');
      assert.equal((await entregar(solicitacao, [[0, loteId, 1]])).solicitacao.status, 'ENTREGUE');
    });

    test('dividir a quantidade entre lotes não contorna a validação: a soma por item do ato é que conta', async () => {
      const m = await material();
      const solicitacao = await aprovada({ itens: [{ materialId: m, quantidade: 3 }] });
      const lote1 = await estoque(m, 10);
      const lote2 = await estoque(m, 10);
      await entregar(solicitacao, [[0, lote1, 2]]);
      const antes = await retrato();
      await esperarHttpError(entregar(solicitacao, [[0, lote1, 1], [0, lote2, 1]]), 409, 'QUANTIDADE_ACIMA_DO_PENDENTE');
      assert.deepEqual(await retrato(), antes);
    });

    test('acima da cobertura: QUANTIDADE_ACIMA_DA_COBERTURA quando o estoque do par cobre menos que o pendente', async () => {
      const m = await material();
      const solicitacao = await aprovada({ itens: [{ materialId: m, quantidade: 3 }] });
      const loteId = await estoque(m, 2);
      const antes = await retrato();
      await esperarHttpError(entregar(solicitacao, [[0, loteId, 3]]), 409, 'QUANTIDADE_ACIMA_DA_COBERTURA');
      assert.deepEqual(await retrato(), antes);
      assert.equal((await entregar(solicitacao, [[0, loteId, 2]])).solicitacao.status, 'APROVADA', 'a parte coberta pode ser entregue');
    });

    test('FIFO: a solicitação posterior não consome a cobertura da anterior, e a anterior continua podendo entregar tudo o que lhe cabe', async () => {
      const m = await material();
      const primeira = await aprovada({ funcionarioId: d.trabalhador, itens: [{ materialId: m, quantidade: 2 }] });
      const segunda = await aprovada({ funcionarioId: d.trabalhador2, itens: [{ materialId: m, quantidade: 2 }] });
      const loteId = await estoque(m, 3);
      await esperarHttpError(entregar(segunda, [[0, loteId, 2]]), 409, 'QUANTIDADE_ACIMA_DA_COBERTURA');
      assert.equal((await entregar(segunda, [[0, loteId, 1]])).solicitacao.status, 'APROVADA', 'a segunda só cobre 1');
      assert.equal((await entregar(primeira, [[0, loteId, 2]])).solicitacao.status, 'ENTREGUE', 'a primeira mantém os seus 2');
    });

    test('sem cobertura: a solicitação posterior com o estoque todo comprometido recusa QUANTIDADE_ACIMA_DA_COBERTURA, mesmo com saldo no lote', async () => {
      const m = await material();
      const primeira = await aprovada({ funcionarioId: d.trabalhador, itens: [{ materialId: m, quantidade: 2 }] });
      const segunda = await aprovada({ funcionarioId: d.trabalhador2, itens: [{ materialId: m, quantidade: 1 }] });
      const loteId = await estoque(m, 2);
      const antes = await retrato();
      await esperarHttpError(entregar(segunda, [[0, loteId, 1]]), 409, 'QUANTIDADE_ACIMA_DA_COBERTURA');
      assert.deepEqual(await retrato(), antes);
      assert.deepEqual(await lote(loteId), { entregue: 0, saldo: 2 });
      assert.equal((await lida(segunda)).itens[0].situacao, 'AGUARDANDO_ESTOQUE');
      assert.equal((await entregar(primeira, [[0, loteId, 2]])).solicitacao.status, 'ENTREGUE');
    });

    test('a baixa física reduz a cobertura e a validação a enxerga: com o lote ainda tendo saldo, o que antes cabia vira QUANTIDADE_ACIMA_DA_COBERTURA', async () => {
      const m = await material();
      const antiga = await aprovada({ funcionarioId: d.trabalhador, itens: [{ materialId: m, quantidade: 2 }] });
      const posterior = await aprovada({ funcionarioId: d.trabalhador2, itens: [{ materialId: m, quantidade: 3 }] });
      const loteId = await estoque(m, 5);
      assert.equal((await lida(posterior)).itens[0].cobertura.coberta, 3);
      await estoqueSvcBaixa(loteId, 3);
      assert.deepEqual(await lote(loteId), { entregue: 0, saldo: 2 });
      await esperarHttpError(entregar(posterior, [[0, loteId, 1]]), 409, 'QUANTIDADE_ACIMA_DA_COBERTURA');
      assert.equal((await entregar(antiga, [[0, loteId, 2]])).solicitacao.status, 'ENTREGUE', 'a mais antiga continua coberta');
    });

    test('o ato entregue consome da cobertura e do físico juntos: as solicitações seguintes mantêm a cobertura que já tinham', async () => {
      const m = await material();
      const a = await aprovada({ funcionarioId: d.trabalhador, itens: [{ materialId: m, quantidade: 2 }] });
      const b = await aprovada({ funcionarioId: d.trabalhador2, itens: [{ materialId: m, quantidade: 2 }] });
      const c = await aprovada({ funcionarioId: d.trabalhador3, itens: [{ materialId: m, quantidade: 2 }] });
      const loteId = await estoque(m, 3);
      const coberturas = async () => [await lida(a), await lida(b), await lida(c)].map((v) => v.itens[0].cobertura?.coberta ?? null);
      assert.deepEqual(await coberturas(), [2, 1, 0]);
      await entregar(a, [[0, loteId, 1]]);
      assert.deepEqual(await coberturas(), [1, 1, 0]);
      await entregar(a, [[0, loteId, 1]]);
      assert.deepEqual(await coberturas(), [null, 1, 0], 'a entregue sai da fila');
    });
  });

  describe('o que vem da solicitação, nunca do operador', () => {
    test('motivo e justificativa funcional do item da solicitação são os da entrega; o trabalhador, o material e o GHE também', async () => {
      const m = await material();
      const solicitacao = await aprovada({ itens: [{ materialId: m, quantidade: 1, motivo: 'OUTRO', justificativa: 'Admissão de aprendiz em turno extra' }] });
      const loteId = await estoque(m, 2);
      const r = await entregar(solicitacao, [[0, loteId, 1]]);
      assert.deepEqual([r.itens[0].motivo, r.itens[0].justificativa, r.itens[0].materialId], ['OUTRO', 'Admissão de aprendiz em turno extra', m]);
      assert.equal(r.ficha.funcionarioId, d.trabalhador);
      assert.deepEqual([r.entrega.ghe.id, r.itens[0].previstoNoGhe, r.itens[0].justificativaForaGhe], [d.gheA, true, null]);
    });

    test('item aprovado fora do GHE: a justificativa técnica da SST já gravada é reutilizada, sem pedir outra e sem copiá-la para a auditoria', async () => {
      const m = await material({ previsto: false });
      const textoSst = 'Exceção técnica autorizada pela Segurança do Trabalho para a atividade';
      const solicitacao = await aprovada({ itens: [{ materialId: m, quantidade: 1, justificativaDecisao: textoSst }] });
      const loteId = await estoque(m, 2);
      const r = await entregar(solicitacao, [[0, loteId, 1]]);
      assert.deepEqual([r.itens[0].previstoNoGhe, r.itens[0].justificativaForaGhe], [false, textoSst]);
      const [auditoria] = await auditorias('ENTREGA_REGISTRADA', r.entrega.id);
      assert.doesNotMatch(JSON.stringify(auditoria), /Exceção técnica autorizada/);
      assert.equal(auditoria.contexto.itens[0].previstoNoGhe, false);
    });
  });

  describe('idempotência', () => {
    test('a repetição da mesma chave e do mesmo conteúdo devolve a entrega original e não grava nada de novo, mesmo depois do fechamento', async () => {
      const m = await material();
      const solicitacao = await aprovada({ itens: [{ materialId: m, quantidade: 2 }] });
      const loteId = await estoque(m, 5);
      const chaveIdempotencia = chaveNova();
      const original = await entregar(solicitacao, [[0, loteId, 2]], { chaveIdempotencia });
      assert.equal(original.solicitacao.status, 'ENTREGUE');
      const antes = await retrato();
      const repetida = await entregar(solicitacao, [[0, loteId, 2]], { chaveIdempotencia });
      assert.equal(repetida.repetida, true);
      assert.equal(repetida.entrega.id, original.entrega.id);
      assert.deepEqual(repetida.itens.map((i) => i.id), original.itens.map((i) => i.id));
      assert.equal(repetida.confirmacao.hashConteudo, original.confirmacao.hashConteudo);
      assert.deepEqual(await retrato(), antes);
      assert.deepEqual(await lote(loteId), { entregue: 2, saldo: 3 });
    });

    test('a mesma chave com conteúdo diferente (quantidade, lote, solicitação, confirmação ou entrega DIRETA) é IDEMPOTENCIA_CONFLITO', async () => {
      const m = await material();
      const solicitacao = await aprovada({ itens: [{ materialId: m, quantidade: 3 }] });
      const outra = await aprovada({ itens: [{ materialId: m, quantidade: 3 }] });
      const lote1 = await estoque(m, 10);
      const lote2 = await estoque(m, 10);
      const chaveIdempotencia = chaveNova();
      await entregar(solicitacao, [[0, lote1, 1]], { chaveIdempotencia });
      const antes = await retrato();
      for (const tentativa of [
        () => entregar(solicitacao, [[0, lote1, 2]], { chaveIdempotencia }),
        () => entregar(solicitacao, [[0, lote2, 1]], { chaveIdempotencia }),
        () => entregar(outra, [[0, lote1, 1]], { chaveIdempotencia }),
        () => entregar(solicitacao, [[0, lote1, 1]], { chaveIdempotencia, confirmacao: DESENHO }),
        () => direta.registrarEntrega(pool, {
          empresaId: d.empresaA, atorId: d.master, funcionarioId: d.trabalhador, itens: [{ materialId: m, loteId: lote1, quantidade: 1, motivo: 'ADMISSAO' }], confirmacao: ACEITE, chaveIdempotencia,
        }),
      ]) {
        await esperarHttpError(tentativa(), 409, 'IDEMPOTENCIA_CONFLITO');
      }
      assert.deepEqual(await retrato(), antes);
    });

    test('a chave é conferida antes das regras mutáveis: repetir o ato já feito funciona mesmo com o trabalhador inativado depois', async () => {
      const m = await material();
      const trabalhador = await d.novoTrabalhador(d.empresaA, { gheId: d.gheA });
      const solicitacao = await aprovada({ funcionarioId: trabalhador, itens: [{ materialId: m, quantidade: 2 }] });
      const loteId = await estoque(m, 5);
      const chaveIdempotencia = chaveNova();
      const original = await entregar(solicitacao, [[0, loteId, 1]], { chaveIdempotencia });
      await q('UPDATE funcionarios SET ativo = false WHERE id = $1', [trabalhador]);
      const repetida = await entregar(solicitacao, [[0, loteId, 1]], { chaveIdempotencia });
      assert.deepEqual([repetida.repetida, repetida.entrega.id], [true, original.entrega.id]);
    });
  });

  describe('auditoria e hash histórico', () => {
    test('ENTREGA_REGISTRADA da solicitação: origem, solicitação, item da solicitação, lote, quantidade, pendente e cobertura antes e depois, e entrega parcial; sem texto livre', async () => {
      const m = await material();
      const solicitacao = await aprovada({ itens: [{ materialId: m, quantidade: 3 }] });
      const lote1 = await estoque(m, 1);
      const lote2 = await estoque(m, 1);
      const r = await entregar(solicitacao, [[0, lote1, 1], [0, lote2, 1]]);
      const [auditoria] = await auditorias('ENTREGA_REGISTRADA', r.entrega.id);
      assert.equal(auditoria.usuario_id, d.master);
      const { contexto: c } = auditoria;
      assert.equal(c.origem, 'SOLICITACAO');
      assert.equal(c.solicitacaoId, solicitacao.id);
      assert.equal(c.entregaParcial, true);
      assert.deepEqual(c.itens.map((i) => [i.solicitacaoItemId, i.loteId, i.quantidade]), [[solicitacao.itens[0], lote1, 1], [solicitacao.itens[0], lote2, 1]]);
      assert.deepEqual(c.solicitacaoItens, [{ solicitacaoItemId: solicitacao.itens[0], quantidade: 2, quantidadePendenteAntes: 3, coberturaAntes: 2, quantidadePendenteDepois: 1 }]);
      assert.deepEqual(auditoria.dados_anteriores.saldos.map((s) => s.saldo), [1, 1]);
      assert.deepEqual(auditoria.dados_novos.saldos.map((s) => s.saldo), [0, 0]);
      assert.doesNotMatch(JSON.stringify(auditoria), /Declaro que recebi/);
    });

    test('SOLICITACAO_EPI_ENTREGUE só na transição real: uma vez, com os identificadores mínimos, na mesma transação do ato que fecha', async () => {
      const m = await material();
      const solicitacao = await aprovada({ itens: [{ materialId: m, quantidade: 2 }] });
      const loteId = await estoque(m, 5);
      const primeira = await entregar(solicitacao, [[0, loteId, 1]]);
      assert.deepEqual(await auditorias('SOLICITACAO_EPI_ENTREGUE', solicitacao.id), []);
      assert.equal((await auditorias('ENTREGA_REGISTRADA', primeira.entrega.id))[0].contexto.entregaParcial, true);
      const ultima = await entregar(solicitacao, [[0, loteId, 1]]);
      const eventos = await auditorias('SOLICITACAO_EPI_ENTREGUE', solicitacao.id);
      assert.equal(eventos.length, 1);
      assert.equal(eventos[0].usuario_id, d.master);
      assert.deepEqual(eventos[0].contexto, {
        solicitacaoId: solicitacao.id, entregaId: ultima.entrega.id, funcionarioId: d.trabalhador, itens: [{ solicitacaoItemId: solicitacao.itens[0], quantidadeAprovada: 2, quantidadeEntregue: 2 }],
      });
      assert.deepEqual([eventos[0].dados_anteriores, eventos[0].dados_novos], [{ status: 'APROVADA' }, { status: 'ENTREGUE' }]);
      assert.equal((await auditorias('ENTREGA_REGISTRADA', ultima.entrega.id))[0].contexto.entregaParcial, false);
    });

    test('o hash de conteúdo gravado protege o vínculo: recalculado dos dados persistidos bate; trocar só o solicitacaoItemId não bate', async () => {
      const m = await material();
      const solicitacao = await aprovada({ itens: [{ materialId: m, quantidade: 1 }] });
      const loteId = await estoque(m, 2);
      const r = await entregar(solicitacao, [[0, loteId, 1]]);
      const entrega = await entregaRepo.buscarPorId(pool, d.empresaA, r.entrega.id);
      const ficha = await fichaRepo.buscarPorId(pool, d.empresaA, entrega.fichaId);
      const itens = await itemRepo.listarPorEntrega(pool, d.empresaA, entrega.id);
      const confirmacao = await confirmacaoRepo.buscarPorEntrega(pool, d.empresaA, entrega.id);
      const recalculado = direta.calcularHashConteudo({ entrega, ficha, itens, confirmacao });
      assert.equal(confirmacao.hashConteudo, recalculado);
      const adulterado = direta.calcularHashConteudo({ entrega, ficha, itens: itens.map((i) => ({ ...i, solicitacaoItemId: i.solicitacaoItemId + 1 })), confirmacao });
      assert.notEqual(confirmacao.hashConteudo, adulterado);
    });

    test('a entrega DIRETA continua com o hash e a auditoria de sempre: sem origem nem vínculo no contexto, vínculo nulo no item', async () => {
      const m = await material({ exigeTamanho: false });
      const loteId = await estoque(m, 3, { tamanho: null });
      const r = await direta.registrarEntrega(pool, {
        empresaId: d.empresaA, atorId: d.master, funcionarioId: d.trabalhador, itens: [{ materialId: m, loteId, quantidade: 1, motivo: 'ADMISSAO' }], confirmacao: ACEITE, chaveIdempotencia: chaveNova(),
      });
      assert.equal(r.entrega.origem, 'DIRETA');
      assert.equal(r.itens[0].solicitacaoItemId, null);
      const [auditoria] = await auditorias('ENTREGA_REGISTRADA', r.entrega.id);
      assert.equal('origem' in auditoria.contexto, false);
      assert.equal('solicitacaoId' in auditoria.contexto, false);
      const entrega = await entregaRepo.buscarPorId(pool, d.empresaA, r.entrega.id);
      const ficha = await fichaRepo.buscarPorId(pool, d.empresaA, entrega.fichaId);
      const itens = await itemRepo.listarPorEntrega(pool, d.empresaA, entrega.id);
      const confirmacao = await confirmacaoRepo.buscarPorEntrega(pool, d.empresaA, entrega.id);
      assert.equal(confirmacao.hashConteudo, direta.calcularHashConteudo({ entrega, ficha, itens, confirmacao }));
    });
  });

  describe('atomicidade e isolamento', () => {
    test('falha depois de gravar entrega e itens desfaz tudo: ficha, numeração, operações, saldo, auditoria e o fechamento', async (t) => {
      const m = await material();
      const trabalhador = await d.novoTrabalhador(d.empresaA, { gheId: d.gheA });
      const solicitacao = await aprovada({ funcionarioId: trabalhador, itens: [{ materialId: m, quantidade: 1 }] });
      const loteId = await estoque(m, 3);
      const antes = await retrato();
      t.mock.method(auditoriaRepo, 'registrar', async () => { throw new Error('falha simulada na auditoria'); });
      await assert.rejects(entregar(solicitacao, [[0, loteId, 1]]), /falha simulada/);
      t.mock.restoreAll();
      assert.deepEqual(await retrato(), antes);
      assert.deepEqual(await lote(loteId), { entregue: 0, saldo: 3 });
      assert.equal((await statusDe(solicitacao)).status, 'APROVADA', 'o fechamento também foi desfeito');
      assert.equal((await entregar(solicitacao, [[0, loteId, 1]])).solicitacao.status, 'ENTREGUE', 'e o ato pode ser refeito');
    });

    test('responsável inexistente na empresa: RESPONSAVEL_NAO_ENCONTRADO; o ator de outra empresa não entrega', async () => {
      const m = await material();
      const solicitacao = await aprovada({ itens: [{ materialId: m, quantidade: 1 }] });
      const loteId = await estoque(m, 2);
      await esperarHttpError(entregar(solicitacao, [[0, loteId, 1]], { atorId: d.masterB }), 404, 'RESPONSAVEL_NAO_ENCONTRADO');
      await esperarHttpError(entregar(solicitacao, [[0, loteId, 1]], { atorId: 2147483000 }), 404, 'RESPONSAVEL_NAO_ENCONTRADO');
    });

    test('a ficha do trabalhador mostra a entrega por solicitação, na ordem da ficha, com a origem', async () => {
      const m = await material();
      const trabalhador = await d.novoTrabalhador(d.empresaA, { gheId: d.gheA });
      const solicitacao = await aprovada({ funcionarioId: trabalhador, itens: [{ materialId: m, quantidade: 2 }] });
      const loteId = await estoque(m, 5);
      const r = await entregar(solicitacao, [[0, loteId, 1]]);
      const doTrabalhador = await entregaRepo.listarPorFicha(pool, d.empresaA, r.ficha.id, { pagina: 1, limite: 10 });
      assert.deepEqual(doTrabalhador.map((e) => [e.id, e.origem]), [[r.entrega.id, 'SOLICITACAO']]);
      assert.equal(await entregaRepo.contarPorFicha(pool, d.empresaA, r.ficha.id, {}), 1);
    });
  });
});
