'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { exigirModulo } = require('../helpers/exigir-modulo');
const {
  todasAsMigrations, criarUsuario, criarFuncionario, criarMaterial, criarLote,
} = require('./helpers/entrega-epi');
const {
  CNPJ_A, montarCenario, criarSolicitacao, decidirSolicitacao, aprovar, reprovar, criarLoteDeEntrada, baixarLote, entregarDireta, entregarPorSolicitacao,
} = require('./helpers/solicitacao-epi');

/**
 * Posição de estoque e cobertura FIFO (Modelo A) com PostgreSQL real:
 *
 *   U = físico utilizável   D = demanda aprovada pendente
 *   C = min(U, D)           L = max(0, U − D)           G = max(0, D − U)
 *
 * A reserva é lógica e derivada: nada é gravado, e a cobertura muda sozinha
 * com a entrada, a baixa, a entrega, a validade do CA (data operacional), a
 * inativação e o cancelamento. Cada cenário usa um material próprio, porque
 * a posição é por empresa, material e tamanho.
 */

const HOJE = '2026-10-02';
const AMANHA = '2026-10-03';

const posicaoRepo = () => exigirModulo('src/repositories/solicitacao-epi-cobertura.repository');

describe('posição e cobertura FIFO — PostgreSQL real', () => {
  let contexto;
  let d;
  let trabalhadores;
  let sequencia = 0;

  const pool = () => contexto.pool;

  before(async () => {
    contexto = await abrirPoolTemporario(todasAsMigrations());
    d = await montarCenario(contexto.pool);
    trabalhadores = [d.trabalhadorA, d.trabalhadorA2];
    for (let i = 3; i <= 8; i += 1) {
      trabalhadores.push(await criarFuncionario(contexto.pool, d.empresaA, { matricula: `A-${i}`, cpf: `${i}`.repeat(11) }));
    }
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  const novoMaterial = (opcoes = {}) => {
    sequencia += 1;
    return criarMaterial(pool(), d.empresaA, `Material de teste ${sequencia}`, opcoes);
  };

  // Uma solicitação aprovada de um item. `aprovada` menor que `quantidade` dá APROVADA_PARCIAL.
  async function aprovada({ materialId, tamanho = '40', quantidade = 1, aprovada: qtd = quantidade, trabalhador = trabalhadores[0], decididaEm = null }) {
    const { solicitacao, itens } = await criarSolicitacao(pool(), d, {
      funcionarioId: trabalhador, itens: [{ material_id: materialId, tamanho, quantidade }],
    });
    const reduzida = qtd < quantidade;
    const decidida = await decidirSolicitacao(pool(), solicitacao, {
      status: reduzida ? 'APROVADA_PARCIAL' : 'APROVADA',
      decididaPor: d.aprovador,
      decisoes: [reduzida ? aprovar(itens[0], qtd, 'Quantidade reduzida pela SST') : aprovar(itens[0])],
      decididaEm,
    });
    return { solicitacao: decidida, item: itens[0] };
  }

  const posicao = async (materialId, tamanho = '40', hoje = HOJE, empresaId = d.empresaA) => {
    const [linha] = await posicaoRepo().lerPosicoes(pool(), empresaId, [{ materialId, tamanho }], { hoje });
    return linha;
  };
  const coberturaDe = async (materialId, hoje = HOJE) => (await posicaoRepo().listarCobertura(pool(), d.empresaA, { hoje }))
    .filter((i) => i.materialId === materialId);
  const numeros = (p) => [p.fisicoUtilizavel, p.demandaPendente, p.comprometido, p.saldoLivre, p.semCobertura];
  const entrada = (materialId, quantidade, extra = {}) => criarLoteDeEntrada(pool(), {
    empresaId: d.empresaA, materialId, quantidade, usuarioId: d.aprovador, ...extra,
  });

  test('exemplo 4 — sem estoque: duas aprovações de 1, físico 0 → U0 D2 C0 L0 G2, nenhuma coberta', async () => {
    const m = await novoMaterial();
    await aprovada({ materialId: m, trabalhador: trabalhadores[0] });
    await aprovada({ materialId: m, trabalhador: trabalhadores[1] });
    assert.deepEqual(numeros(await posicao(m)), [0, 2, 0, 0, 2]);
    assert.deepEqual((await coberturaDe(m)).map((i) => [i.quantidadePendente, i.coberta, i.semCobertura]), [[1, 0, 1], [1, 0, 1]]);
  });

  test('exemplo 5 — entrada parcial: com 1 unidade a mais antiga é coberta; com a segunda, a outra', async () => {
    const m = await novoMaterial();
    const primeira = await aprovada({ materialId: m, trabalhador: trabalhadores[0] });
    const segunda = await aprovada({ materialId: m, trabalhador: trabalhadores[1] });
    await entrada(m, 1);
    assert.deepEqual(numeros(await posicao(m)), [1, 2, 1, 0, 1]);
    const parcial = await coberturaDe(m);
    assert.deepEqual(parcial.map((i) => [i.solicitacaoId, i.coberta]), [[primeira.solicitacao.id, 1], [segunda.solicitacao.id, 0]]);
    await entrada(m, 1);
    assert.deepEqual(numeros(await posicao(m)), [2, 2, 2, 0, 0]);
    assert.deepEqual((await coberturaDe(m)).map((i) => i.coberta), [1, 1]);
  });

  test('exemplo 6 — entrada suficiente: a entrada de 5 fica ENTRADA +5 e a posição vira U5 D2 C2 L3 G0', async () => {
    const m = await novoMaterial();
    await aprovada({ materialId: m, trabalhador: trabalhadores[0] });
    await aprovada({ materialId: m, trabalhador: trabalhadores[1] });
    const lote = await entrada(m, 5);
    assert.deepEqual(numeros(await posicao(m)), [5, 2, 2, 3, 0]);
    const { rows: operacoes } = await pool().query('SELECT tipo, quantidade FROM estoque_operacoes WHERE lote_id = $1', [lote]);
    assert.deepEqual(operacoes, [{ tipo: 'ENTRADA', quantidade: 5 }], 'a reserva não altera nem acrescenta operação');
    const { rows: [l] } = await pool().query('SELECT quantidade_entrada, quantidade_baixada, quantidade_entregue, saldo FROM estoque_lotes WHERE id = $1', [lote]);
    assert.deepEqual(l, { quantidade_entrada: 5, quantidade_baixada: 0, quantidade_entregue: 0, saldo: 5 });
  });

  test('exemplo 7 — depois da entrega: o físico cai pela ENTREGA e a demanda cai pelas solicitações entregues; sobram U3 D0 L3', async () => {
    const m = await novoMaterial();
    const a = await aprovada({ materialId: m, trabalhador: trabalhadores[0] });
    const b = await aprovada({ materialId: m, trabalhador: trabalhadores[1] });
    const lote = await entrada(m, 5);
    assert.deepEqual(numeros(await posicao(m)), [5, 2, 2, 3, 0]);
    // Entrega real, ligada ao item da solicitação: a ENTREGA baixa o físico, a pendente do item zera e a solicitação fecha.
    for (const alvo of [a, b]) {
      await entregarPorSolicitacao(pool(), { solicitacao: alvo.solicitacao, usuarioId: d.aprovador, itens: [{ item: alvo.item, loteId: lote, quantidade: 1 }] });
    }
    assert.deepEqual(numeros(await posicao(m)), [3, 0, 0, 3, 0]);
    assert.deepEqual(await coberturaDe(m), []);
    const { rows: operacoes } = await pool().query('SELECT tipo, quantidade FROM estoque_operacoes WHERE lote_id = $1 ORDER BY id', [lote]);
    assert.deepEqual(operacoes, [{ tipo: 'ENTRADA', quantidade: 5 }, { tipo: 'ENTREGA', quantidade: 1 }, { tipo: 'ENTREGA', quantidade: 1 }]);
  });

  test('exemplo 8 — o saldo livre mostra o que a entrega DIRETA pode usar: L3 antes; depois de uma direta de 3, U2 D2 L0', async () => {
    const m = await novoMaterial();
    await aprovada({ materialId: m, trabalhador: trabalhadores[0] });
    await aprovada({ materialId: m, trabalhador: trabalhadores[1] });
    const lote = await entrada(m, 5);
    const antes = await posicao(m);
    assert.equal(antes.saldoLivre, 3, 'uma direta de 4 passaria do livre; uma de até 3 cabe');
    await entregarDireta(pool(), { empresaId: d.empresaA, funcionarioId: trabalhadores[2], usuarioId: d.aprovador, materialId: m, loteId: lote, quantidade: 3, cnpj: CNPJ_A });
    assert.deepEqual(numeros(await posicao(m)), [2, 2, 2, 0, 0]);
  });

  test('exemplo 9 — perda ou avaria: a baixa física é registrada mesmo abaixo da demanda e a cobertura é recalculada', async () => {
    const m3 = await novoMaterial();
    await aprovada({ materialId: m3, trabalhador: trabalhadores[0] });
    await aprovada({ materialId: m3, trabalhador: trabalhadores[1] });
    const lote3 = await entrada(m3, 5);
    await baixarLote(pool(), { empresaId: d.empresaA, loteId: lote3, quantidade: 3, usuarioId: d.aprovador, motivo: 'AVARIA' });
    assert.deepEqual(numeros(await posicao(m3)), [2, 2, 2, 0, 0], 'avaria de 3: as duas ainda estão cobertas');

    const m4 = await novoMaterial();
    await aprovada({ materialId: m4, trabalhador: trabalhadores[0] });
    await aprovada({ materialId: m4, trabalhador: trabalhadores[1] });
    const lote4 = await entrada(m4, 5);
    await baixarLote(pool(), { empresaId: d.empresaA, loteId: lote4, quantidade: 4, usuarioId: d.aprovador, motivo: 'PERDA' });
    assert.deepEqual(numeros(await posicao(m4)), [1, 2, 1, 0, 1], 'perda de 4: a mais nova volta a aguardar estoque');
    assert.deepEqual((await coberturaDe(m4)).map((i) => i.coberta), [1, 0]);
    await baixarLote(pool(), { empresaId: d.empresaA, loteId: lote4, quantidade: 1, usuarioId: d.aprovador, motivo: 'AJUSTE_INVENTARIO' });
    assert.deepEqual(numeros(await posicao(m4)), [0, 2, 0, 0, 2]);
  });

  test('exemplo 10 — CA vencendo: a cobertura muda com a data operacional, sem nenhuma escrita; lote sem CA não cobre material que exige CA', async () => {
    const m = await novoMaterial();
    for (let i = 0; i < 4; i += 1) await aprovada({ materialId: m, trabalhador: trabalhadores[i] });
    await entrada(m, 3, { caNumero: '11111', caValidade: HOJE });
    await entrada(m, 2, { caNumero: '22222', caValidade: '2099-12-31' });
    await criarLote(pool(), { empresaId: d.empresaA, materialId: m, quantidade: 4, tamanho: '40', caNumero: null, caValidade: null });
    assert.deepEqual(numeros(await posicao(m, '40', HOJE)), [5, 4, 4, 1, 0], 'o CA vence no fim do dia da validade; o lote sem CA não conta');
    assert.deepEqual((await coberturaDe(m, HOJE)).map((i) => i.coberta), [1, 1, 1, 1]);
    assert.deepEqual(numeros(await posicao(m, '40', AMANHA)), [2, 4, 2, 0, 2]);
    assert.deepEqual((await coberturaDe(m, AMANHA)).map((i) => i.coberta), [1, 1, 0, 0], 'as duas mais novas perdem a cobertura; as mais antigas mantêm a prioridade');
    assert.deepEqual(numeros(await posicao(m, '40', HOJE)), [5, 4, 4, 1, 0], 'voltar a data não deixou estado para trás');
  });

  test('material que dispensa CA: lote sem CA é utilizável', async () => {
    const m = await novoMaterial({ exigeCa: false, exigeTamanho: false });
    await aprovada({ materialId: m, tamanho: null, quantidade: 2 });
    await criarLote(pool(), { empresaId: d.empresaA, materialId: m, quantidade: 3, tamanho: null, caNumero: null, caValidade: null });
    assert.deepEqual(numeros(await posicao(m, null)), [3, 2, 2, 1, 0]);
  });

  test('tamanho ausente é um par próprio, casa com os lotes sem tamanho e não se mistura com tamanho real', async () => {
    const m = await novoMaterial({ exigeTamanho: false });
    await aprovada({ materialId: m, tamanho: null, quantidade: 2 });
    await entrada(m, 5, { tamanho: null });
    assert.deepEqual(numeros(await posicao(m, null)), [5, 2, 2, 3, 0]);
    assert.deepEqual(numeros(await posicao(m, '40')), [0, 0, 0, 0, 0]);
    assert.equal((await posicao(m, null)).tamanho, null);
    assert.deepEqual((await coberturaDe(m)).map((i) => [i.tamanho, i.coberta]), [[null, 2]]);
  });

  test('tamanhos são pares separados e vários lotes do mesmo par somam', async () => {
    const m = await novoMaterial();
    await aprovada({ materialId: m, tamanho: '40', quantidade: 3, trabalhador: trabalhadores[0] });
    await aprovada({ materialId: m, tamanho: '41', quantidade: 2, trabalhador: trabalhadores[1] });
    await entrada(m, 1, { tamanho: '40' });
    await entrada(m, 1, { tamanho: '40', caNumero: '99999' });
    await entrada(m, 7, { tamanho: '41' });
    const [p40, p41] = await posicaoRepo().lerPosicoes(pool(), d.empresaA, [{ materialId: m, tamanho: '41' }, { materialId: m, tamanho: '40' }], { hoje: HOJE });
    assert.deepEqual([p40.tamanho, p41.tamanho], ['40', '41'], 'saem ordenados por material e tamanho');
    assert.deepEqual(numeros(p40), [2, 3, 2, 0, 1]);
    assert.deepEqual(numeros(p41), [7, 2, 2, 5, 0]);
  });

  test('só a demanda atendível conta: item aprovado de APROVADA e APROVADA_PARCIAL; PENDENTE, REPROVADA, CANCELADA e ENTREGUE ficam de fora; quantidade reduzida conta a aprovada', async () => {
    const m = await novoMaterial();
    await aprovada({ materialId: m, quantidade: 5, aprovada: 2, trabalhador: trabalhadores[0] });
    await aprovada({ materialId: m, quantidade: 3, trabalhador: trabalhadores[1] });
    const pendente = await criarSolicitacao(pool(), d, { funcionarioId: trabalhadores[2], itens: [{ material_id: m, tamanho: '40', quantidade: 4 }] });
    const reprovada = await criarSolicitacao(pool(), d, { funcionarioId: trabalhadores[3], itens: [{ material_id: m, tamanho: '40', quantidade: 4 }] });
    await decidirSolicitacao(pool(), reprovada.solicitacao, { status: 'REPROVADA', decididaPor: d.aprovador, decisoes: [reprovar(reprovada.itens[0])] });
    const cancelada = await criarSolicitacao(pool(), d, { funcionarioId: trabalhadores[4], itens: [{ material_id: m, tamanho: '40', quantidade: 4 }] });
    await pool().query("UPDATE solicitacoes_epi SET status = 'CANCELADA', cancelada_por = $2, cancelada_em = clock_timestamp() WHERE id = $1", [cancelada.solicitacao.id, d.solicitante]);
    // Entregue de verdade: entra estoque, a solicitação é entregue por inteiro e fecha; o físico volta a zero.
    const entregue = await aprovada({ materialId: m, quantidade: 6, trabalhador: trabalhadores[5] });
    const estoqueDaEntrega = await entrada(m, 6);
    await entregarPorSolicitacao(pool(), { solicitacao: entregue.solicitacao, usuarioId: d.aprovador, itens: [{ item: entregue.item, loteId: estoqueDaEntrega, quantidade: 6 }] });
    assert.equal((await pool().query('SELECT status FROM solicitacoes_epi WHERE id = $1', [entregue.solicitacao.id])).rows[0].status, 'ENTREGUE');
    assert.equal(pendente.solicitacao.status, 'PENDENTE');
    assert.deepEqual(numeros(await posicao(m)), [0, 5, 0, 0, 5], '2 (reduzida) + 3 (integral)');
    assert.deepEqual((await coberturaDe(m)).map((i) => i.quantidadePendente), [2, 3]);
  });

  test('item reprovado de uma solicitação APROVADA_PARCIAL não conta; o aprovado conta', async () => {
    const m1 = await novoMaterial();
    const m2 = await novoMaterial();
    const { solicitacao, itens } = await criarSolicitacao(pool(), d, {
      funcionarioId: trabalhadores[0],
      itens: [{ material_id: m1, tamanho: '40', quantidade: 2 }, { material_id: m2, tamanho: '40', quantidade: 2 }],
    });
    await decidirSolicitacao(pool(), solicitacao, { status: 'APROVADA_PARCIAL', decididaPor: d.aprovador, decisoes: [aprovar(itens[0]), reprovar(itens[1])] });
    assert.equal((await posicao(m1)).demandaPendente, 2);
    assert.equal((await posicao(m2)).demandaPendente, 0);
  });

  test('trabalhador ou material inativo suspende a demanda sem mudar o status; reativar devolve a posição na fila', async () => {
    const m = await novoMaterial();
    const primeira = await aprovada({ materialId: m, trabalhador: trabalhadores[0] });
    const segunda = await aprovada({ materialId: m, trabalhador: trabalhadores[1] });
    await entrada(m, 1);
    assert.deepEqual((await coberturaDe(m)).map((i) => [i.solicitacaoId, i.coberta]), [[primeira.solicitacao.id, 1], [segunda.solicitacao.id, 0]]);

    await pool().query('UPDATE funcionarios SET ativo = false WHERE id = $1', [trabalhadores[0]]);
    assert.deepEqual((await coberturaDe(m)).map((i) => [i.solicitacaoId, i.coberta]), [[segunda.solicitacao.id, 1]], 'a suspensa sai e a seguinte ganha a cobertura');
    assert.deepEqual(numeros(await posicao(m)), [1, 1, 1, 0, 0]);
    assert.equal((await pool().query('SELECT status FROM solicitacoes_epi WHERE id = $1', [primeira.solicitacao.id])).rows[0].status, 'APROVADA', 'o status persistido não muda');

    await pool().query('UPDATE funcionarios SET ativo = true WHERE id = $1', [trabalhadores[0]]);
    assert.deepEqual((await coberturaDe(m)).map((i) => [i.solicitacaoId, i.coberta]), [[primeira.solicitacao.id, 1], [segunda.solicitacao.id, 0]], 'a mais antiga volta à frente');

    await pool().query('UPDATE materiais SET ativo = false WHERE id = $1', [m]);
    assert.deepEqual(numeros(await posicao(m)), [0, 0, 0, 0, 0], 'material inativo: sem físico utilizável e sem demanda');
    assert.deepEqual(await coberturaDe(m), []);
    await pool().query('UPDATE materiais SET ativo = true WHERE id = $1', [m]);
    assert.deepEqual(numeros(await posicao(m)), [1, 2, 1, 0, 1]);
  });

  test('entregar a mais antiga tira do estoque o que tira da demanda: as seguintes mantêm a cobertura que já tinham', async () => {
    const m = await novoMaterial();
    const a = await aprovada({ materialId: m, quantidade: 2, trabalhador: trabalhadores[0] });
    const b = await aprovada({ materialId: m, quantidade: 2, trabalhador: trabalhadores[1] });
    const c = await aprovada({ materialId: m, quantidade: 2, trabalhador: trabalhadores[2] });
    const lote = await entrada(m, 3);
    assert.deepEqual((await coberturaDe(m)).map((i) => [i.solicitacaoId, i.coberta]), [[a.solicitacao.id, 2], [b.solicitacao.id, 1], [c.solicitacao.id, 0]]);
    await entregarPorSolicitacao(pool(), { solicitacao: a.solicitacao, usuarioId: d.aprovador, itens: [{ item: a.item, loteId: lote, quantidade: 2 }] });
    assert.deepEqual((await coberturaDe(m)).map((i) => [i.solicitacaoId, i.coberta]), [[b.solicitacao.id, 1], [c.solicitacao.id, 0]]);
    await entrada(m, 1);
    assert.deepEqual((await coberturaDe(m)).map((i) => [i.solicitacaoId, i.coberta]), [[b.solicitacao.id, 2], [c.solicitacao.id, 0]], 'a entrada seguinte vai primeiro para a mais antiga');
  });

  test('FIFO por decidida_em, não pelo id: a solicitação criada antes e decidida depois fica atrás; empate de hora desempata pelo id da solicitação', async () => {
    const m = await novoMaterial();
    const aCriarPrimeiro = await criarSolicitacao(pool(), d, { funcionarioId: trabalhadores[0], itens: [{ material_id: m, tamanho: '40', quantidade: 1 }] });
    const aCriarDepois = await criarSolicitacao(pool(), d, { funcionarioId: trabalhadores[1], itens: [{ material_id: m, tamanho: '40', quantidade: 1 }] });
    // Decide primeiro a criada depois.
    await decidirSolicitacao(pool(), aCriarDepois.solicitacao, { status: 'APROVADA', decididaPor: d.aprovador, decisoes: [aprovar(aCriarDepois.itens[0])] });
    await decidirSolicitacao(pool(), aCriarPrimeiro.solicitacao, { status: 'APROVADA', decididaPor: d.aprovador, decisoes: [aprovar(aCriarPrimeiro.itens[0])] });
    await entrada(m, 1);
    assert.deepEqual((await coberturaDe(m)).map((i) => [i.solicitacaoId, i.coberta]), [[aCriarDepois.solicitacao.id, 1], [aCriarPrimeiro.solicitacao.id, 0]]);

    const n = await novoMaterial();
    const x = await criarSolicitacao(pool(), d, { funcionarioId: trabalhadores[0], itens: [{ material_id: n, tamanho: '40', quantidade: 1 }] });
    const y = await criarSolicitacao(pool(), d, { funcionarioId: trabalhadores[1], itens: [{ material_id: n, tamanho: '40', quantidade: 1 }] });
    const mesmaHora = '2099-01-01T00:00:00Z';
    await decidirSolicitacao(pool(), y.solicitacao, { status: 'APROVADA', decididaPor: d.aprovador, decisoes: [aprovar(y.itens[0])], decididaEm: mesmaHora });
    await decidirSolicitacao(pool(), x.solicitacao, { status: 'APROVADA', decididaPor: d.aprovador, decisoes: [aprovar(x.itens[0])], decididaEm: mesmaHora });
    await entrada(n, 1);
    assert.deepEqual((await coberturaDe(n)).map((i) => [i.solicitacaoId, i.coberta]), [[x.solicitacao.id, 1], [y.solicitacao.id, 0]], 'mesma hora: menor id primeiro');
  });

  test('a cobertura de uma solicitação só é calculada contra a fila inteira do par: as mais antigas consomem primeiro', async () => {
    const m = await novoMaterial();
    await aprovada({ materialId: m, quantidade: 3, trabalhador: trabalhadores[0] });
    const nova = await aprovada({ materialId: m, quantidade: 2, trabalhador: trabalhadores[1] });
    await entrada(m, 4);
    const [item] = await posicaoRepo().listarCobertura(pool(), d.empresaA, { hoje: HOJE, solicitacaoId: nova.solicitacao.id });
    assert.deepEqual(
      [item.solicitacaoId, item.quantidadePendente, item.acumuladoAnterior, item.fisicoUtilizavel, item.coberta, item.semCobertura],
      [nova.solicitacao.id, 2, 3, 4, 1, 1],
    );
    assert.deepEqual(await posicaoRepo().listarCobertura(pool(), d.empresaA, { hoje: HOJE, solicitacaoId: 2147483000 }), []);
  });

  test('isolamento entre empresas: outra empresa não vê a demanda nem o estoque, nem pelos mesmos identificadores', async () => {
    const m = await novoMaterial();
    await aprovada({ materialId: m });
    await entrada(m, 3);
    assert.deepEqual(numeros(await posicao(m)), [3, 1, 1, 2, 0]);
    assert.deepEqual(numeros(await posicao(m, '40', HOJE, d.empresaB)), [0, 0, 0, 0, 0]);
    assert.deepEqual((await posicaoRepo().listarCobertura(pool(), d.empresaB, { hoje: HOJE })).filter((i) => i.materialId === m), []);
    // Demanda e estoque da empresa B não entram na posição da A.
    const solicitanteB = d.usuarioB;
    const { solicitacao, itens } = await criarSolicitacao(pool(), d, {
      empresaId: d.empresaB, funcionarioId: d.trabalhadorB, solicitanteId: solicitanteB, itens: [{ material_id: d.botinaB, tamanho: '40', quantidade: 2 }],
    });
    const aprovadorB = await criarUsuario(pool(), d.empresaB, 'aprovador-b@example.invalid');
    await decidirSolicitacao(pool(), solicitacao, { status: 'APROVADA', decididaPor: aprovadorB, decisoes: [aprovar(itens[0])] });
    assert.deepEqual(numeros(await posicao(d.botinaB, '40', HOJE, d.empresaB)), [0, 2, 0, 0, 2]);
    assert.deepEqual(numeros(await posicao(d.botinaB, '40', HOJE, d.empresaA)), [0, 0, 0, 0, 0]);
  });

  test('leitura pura: roda numa transação READ ONLY e não muda lotes, operações, solicitações nem itens', async () => {
    const m = await novoMaterial();
    await aprovada({ materialId: m, quantidade: 2 });
    await entrada(m, 1);
    const foto = async () => (await pool().query(
      `SELECT (SELECT json_agg(l ORDER BY l.id) FROM estoque_lotes l) AS lotes,
              (SELECT json_agg(o ORDER BY o.id) FROM estoque_operacoes o) AS operacoes,
              (SELECT json_agg(s ORDER BY s.id) FROM solicitacoes_epi s) AS solicitacoes,
              (SELECT json_agg(i ORDER BY i.id) FROM solicitacoes_epi_itens i) AS itens`,
    )).rows[0];
    const antes = await foto();
    const c = await pool().connect();
    try {
      await c.query('BEGIN READ ONLY');
      await posicaoRepo().lerPosicoes(c, d.empresaA, [{ materialId: m, tamanho: '40' }], { hoje: HOJE });
      await posicaoRepo().listarCobertura(c, d.empresaA, { hoje: HOJE });
      await c.query('COMMIT');
    } finally {
      // Sem isto, uma falha devolveria ao pool uma conexão ainda em transação somente leitura.
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
    assert.deepEqual(await foto(), antes);
  });

  test('par sem lote e sem demanda: zeros; vários pares na mesma chamada saem ordenados', async () => {
    const m1 = await novoMaterial();
    const m2 = await novoMaterial();
    await aprovada({ materialId: m2, quantidade: 1 });
    const posicoes = await posicaoRepo().lerPosicoes(pool(), d.empresaA, [{ materialId: m2, tamanho: '40' }, { materialId: m1, tamanho: '40' }], { hoje: HOJE });
    assert.deepEqual(posicoes.map((p) => [p.materialId, ...numeros(p)]), [[m1, 0, 0, 0, 0, 0], [m2, 0, 1, 0, 0, 1]]);
  });

  describe('prova do FIFO contra um modelo de referência, em cenários aleatórios de semente fixa', () => {
    const mulberry32 = (semente) => () => {
      let t = (semente += 0x6D2B79F5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    // Modelo de referência: a fila em ordem de decisão consome o físico utilizável.
    const referencia = (utilizavel, fila) => {
      let acumulado = 0;
      return fila.map((pendente) => {
        const coberta = Math.min(pendente, Math.max(0, utilizavel - acumulado));
        const linha = { pendente, acumuladoAnterior: acumulado, coberta };
        acumulado += pendente;
        return linha;
      });
    };

    test('40 cenários: posição e cobertura batem com o modelo, as invariantes valem e nunca um item posterior é coberto enquanto um anterior espera', async () => {
      const aleatorio = mulberry32(20261002);
      const inteiro = (min, max) => min + Math.floor(aleatorio() * (max - min + 1));
      let verificados = 0;

      for (let cenario = 0; cenario < 40; cenario += 1) {
        const m = await novoMaterial();
        const hoje = HOJE;
        let utilizavel = 0;
        for (let i = 0, lotes = inteiro(0, 3); i < lotes; i += 1) {
          const quantidade = inteiro(1, 6);
          const tipo = aleatorio();
          if (tipo < 0.6) {
            await entrada(m, quantidade, { caNumero: `CA${cenario}${i}`, caValidade: aleatorio() < 0.5 ? HOJE : '2099-12-31' });
            utilizavel += quantidade;
          } else if (tipo < 0.8) {
            await entrada(m, quantidade, { caNumero: `CV${cenario}${i}`, caValidade: '2026-09-30' });
          } else {
            await criarLote(pool(), { empresaId: d.empresaA, materialId: m, quantidade, tamanho: '40', caNumero: null, caValidade: null });
          }
        }

        const criadas = [];
        for (let i = 0, pedidos = inteiro(1, 6); i < pedidos; i += 1) {
          const quantidade = inteiro(1, 4);
          criadas.push({
            quantidade,
            ...(await criarSolicitacao(pool(), d, { funcionarioId: trabalhadores[i], itens: [{ material_id: m, tamanho: '40', quantidade }] })),
          });
        }
        // Decide em ordem embaralhada: a ordem das decisões, não a dos ids, é a da fila.
        const ordem = criadas.map((c, i) => [aleatorio(), i]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
        const fila = [];
        for (const indice of ordem) {
          const { solicitacao, itens, quantidade } = criadas[indice];
          const sorteio = aleatorio();
          if (sorteio < 0.1) continue;
          if (sorteio < 0.2) {
            await decidirSolicitacao(pool(), solicitacao, { status: 'REPROVADA', decididaPor: d.aprovador, decisoes: [reprovar(itens[0])] });
          } else if (sorteio < 0.25) {
            await pool().query("UPDATE solicitacoes_epi SET status = 'CANCELADA', cancelada_por = $2, cancelada_em = clock_timestamp() WHERE id = $1", [solicitacao.id, d.solicitante]);
          } else if (sorteio < 0.4 && quantidade > 1) {
            const reduzida = inteiro(1, quantidade - 1);
            await decidirSolicitacao(pool(), solicitacao, { status: 'APROVADA_PARCIAL', decididaPor: d.aprovador, decisoes: [aprovar(itens[0], reduzida, 'Quantidade reduzida')] });
            fila.push({ solicitacaoId: solicitacao.id, pendente: reduzida });
          } else {
            await decidirSolicitacao(pool(), solicitacao, { status: 'APROVADA', decididaPor: d.aprovador, decisoes: [aprovar(itens[0])] });
            fila.push({ solicitacaoId: solicitacao.id, pendente: quantidade });
          }
        }

        const esperado = referencia(utilizavel, fila.map((f) => f.pendente));
        const demanda = fila.reduce((soma, f) => soma + f.pendente, 0);
        const p = await posicao(m, '40', hoje);
        assert.deepEqual(
          numeros(p),
          [utilizavel, demanda, Math.min(utilizavel, demanda), Math.max(0, utilizavel - demanda), Math.max(0, demanda - utilizavel)],
          `cenário ${cenario}: posição`,
        );
        assert.ok(p.comprometido <= p.fisicoUtilizavel && p.comprometido <= p.demandaPendente, `cenário ${cenario}: C ≤ min(U, D)`);
        assert.ok(p.saldoLivre >= 0 && p.semCobertura >= 0, `cenário ${cenario}: L e G não negativos`);

        const cobertura = await coberturaDe(m, hoje);
        assert.deepEqual(cobertura.map((i) => i.solicitacaoId), fila.map((f) => f.solicitacaoId), `cenário ${cenario}: ordem da fila`);
        assert.deepEqual(
          cobertura.map((i) => ({ pendente: i.quantidadePendente, acumuladoAnterior: i.acumuladoAnterior, coberta: i.coberta })),
          esperado,
          `cenário ${cenario}: cobertura`,
        );
        assert.equal(cobertura.reduce((soma, i) => soma + i.coberta, 0), p.comprometido, `cenário ${cenario}: soma da cobertura = C`);
        let esperando = false;
        for (const i of cobertura) {
          assert.ok(i.coberta >= 0 && i.coberta <= i.quantidadePendente, `cenário ${cenario}: 0 ≤ coberta ≤ pendente`);
          assert.equal(i.semCobertura, i.quantidadePendente - i.coberta);
          if (esperando) assert.equal(i.coberta, 0, `cenário ${cenario}: posterior coberto com anterior esperando`);
          if (i.coberta < i.quantidadePendente) esperando = true;
        }
        verificados += 1;
      }
      assert.equal(verificados, 40);
    });
  });
});
