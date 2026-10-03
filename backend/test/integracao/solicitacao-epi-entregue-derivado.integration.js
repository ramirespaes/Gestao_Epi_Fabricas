'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { gerador } = require('./helpers/gerador');
const { todasAsMigrations, criarFuncionario, criarMaterial } = require('./helpers/entrega-epi');
const {
  CNPJ_A, montarCenario, criarSolicitacao, decidirSolicitacao, aprovar, reprovar, criarLoteDeEntrada, baixarLote, entregarDireta, entregarPorSolicitacao,
} = require('./helpers/solicitacao-epi');

/**
 * Quantidade entregue derivada e cobertura FIFO depois da entrega (12C-1),
 * com PostgreSQL real. A quantidade entregue de um item da solicitação é a
 * soma das entregas ligadas a ele; o pendente é a aprovada menos essa soma, e
 * nada disso é gravado. A posição e a cobertura passam a descontar o entregue:
 *
 *   U = físico utilizável   D = soma dos pendentes
 *   C = min(U, D)           L = max(0, U − D)           G = max(0, D − U)
 *
 * Cada cenário usa um material próprio: a posição é por empresa, material e
 * tamanho. A última prova compara o repositório com um cálculo independente,
 * passo a passo, em entradas, baixas e entregas parciais embaralhadas.
 */

const HOJE = '2026-10-02';

const posicaoRepo = () => exigirModulo('src/repositories/solicitacao-epi-cobertura.repository');
const itemRepo = () => {
  const repo = exigirModulo('src/repositories/solicitacao-epi-item.repository');
  assert.equal(typeof repo.listarPorSolicitacaoComEntregue, 'function', 'função ainda não implementada: listarPorSolicitacaoComEntregue');
  return repo;
};

describe('entregue derivado e cobertura depois da entrega — PostgreSQL real', () => {
  let contexto;
  let d;
  let trabalhadores;
  let sequencia = 0;

  const pool = () => contexto.pool;

  before(async () => {
    contexto = await abrirPoolTemporario(todasAsMigrations());
    d = await montarCenario(contexto.pool);
    trabalhadores = [d.trabalhadorA, d.trabalhadorA2];
    for (let i = 3; i <= 9; i += 1) {
      trabalhadores.push(await criarFuncionario(contexto.pool, d.empresaA, { matricula: `A-${i}`, cpf: `${i}`.repeat(11) }));
    }
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  const novoMaterial = (opcoes = {}) => {
    sequencia += 1;
    return criarMaterial(pool(), d.empresaA, `Material derivado ${sequencia}`, opcoes);
  };
  const entrada = (materialId, quantidade, extra = {}) => criarLoteDeEntrada(pool(), {
    empresaId: d.empresaA, materialId, quantidade, usuarioId: d.aprovador, ...extra,
  });

  // Solicitação aprovada de um item; `aprovada` menor que `quantidade` dá APROVADA_PARCIAL.
  async function aprovada({ materialId, tamanho = '40', quantidade = 1, aprovada: qtd = quantidade, trabalhador = trabalhadores[0] }) {
    const { solicitacao, itens } = await criarSolicitacao(pool(), d, {
      funcionarioId: trabalhador, itens: [{ material_id: materialId, tamanho, quantidade }],
    });
    const reduzida = qtd < quantidade;
    const decidida = await decidirSolicitacao(pool(), solicitacao, {
      status: reduzida ? 'APROVADA_PARCIAL' : 'APROVADA',
      decididaPor: d.aprovador,
      decisoes: [reduzida ? aprovar(itens[0], qtd, 'Quantidade reduzida pela SST') : aprovar(itens[0])],
    });
    return { solicitacao: decidida, item: itens[0] };
  }

  const entregar = (alvo, itens) => entregarPorSolicitacao(pool(), {
    solicitacao: alvo.solicitacao, usuarioId: d.aprovador, itens: itens.map(([item, loteId, quantidade]) => ({ item, loteId, quantidade })),
  });
  const posicao = async (materialId, tamanho = '40') => (
    await posicaoRepo().lerPosicoes(pool(), d.empresaA, [{ materialId, tamanho }], { hoje: HOJE })
  )[0];
  const numeros = (p) => [p.fisicoUtilizavel, p.demandaPendente, p.comprometido, p.saldoLivre, p.semCobertura];
  const coberturaDe = async (materialId) => (await posicaoRepo().listarCobertura(pool(), d.empresaA, { hoje: HOJE }))
    .filter((i) => i.materialId === materialId);
  const entregueDe = async (solicitacao, empresaId = d.empresaA) => (await itemRepo().listarPorSolicitacaoComEntregue(pool(), empresaId, solicitacao.id))
    .map((i) => [i.id, i.quantidadeAprovada, i.quantidadeEntregue]);

  test('a entregue do item soma só as entregas ligadas a ele, de todos os lotes; DIRETA, outro item e outra solicitação não entram', async () => {
    const m = await novoMaterial();
    const lote1 = await entrada(m, 10);
    const lote2 = await entrada(m, 10);
    const a = await aprovada({ materialId: m, quantidade: 6, trabalhador: trabalhadores[0] });
    const b = await aprovada({ materialId: m, quantidade: 3, trabalhador: trabalhadores[1] });
    assert.deepEqual(await entregueDe(a.solicitacao), [[a.item.id, 6, 0]]);
    await entregar(a, [[a.item, lote1, 1]]);
    await entregar(a, [[a.item, lote1, 1], [a.item, lote2, 2]]);
    await entregar(b, [[b.item, lote2, 1]]);
    await entregarDireta(pool(), { empresaId: d.empresaA, funcionarioId: trabalhadores[0], usuarioId: d.aprovador, materialId: m, loteId: lote1, quantidade: 3, cnpj: CNPJ_A });
    assert.deepEqual(await entregueDe(a.solicitacao), [[a.item.id, 6, 4]]);
    assert.deepEqual(await entregueDe(b.solicitacao), [[b.item.id, 3, 1]]);
  });

  test('item reprovado e item sem entrega valem zero; com vários itens cada um tem a sua soma', async () => {
    const m1 = await novoMaterial();
    const m2 = await novoMaterial();
    const m3 = await novoMaterial();
    const lote1 = await entrada(m1, 10);
    const { solicitacao, itens } = await criarSolicitacao(pool(), d, {
      funcionarioId: trabalhadores[2],
      itens: [{ material_id: m1, tamanho: '40', quantidade: 2 }, { material_id: m2, tamanho: '40', quantidade: 2 }, { material_id: m3, tamanho: '40', quantidade: 2 }],
    });
    const decidida = await decidirSolicitacao(pool(), solicitacao, {
      status: 'APROVADA_PARCIAL', decididaPor: d.aprovador, decisoes: [aprovar(itens[0]), aprovar(itens[1]), reprovar(itens[2])],
    });
    await entregar({ solicitacao: decidida }, [[itens[0], lote1, 1]]);
    assert.deepEqual(await entregueDe(decidida), [[itens[0].id, 2, 1], [itens[1].id, 2, 0], [itens[2].id, 0, 0]]);
  });

  test('isolamento: a leitura é da empresa informada; a solicitação de A vista por B volta vazia', async () => {
    const m = await novoMaterial();
    const lote = await entrada(m, 5);
    const a = await aprovada({ materialId: m, quantidade: 2 });
    await entregar(a, [[a.item, lote, 1]]);
    assert.deepEqual(await entregueDe(a.solicitacao, d.empresaB), []);
    assert.deepEqual(await entregueDe(a.solicitacao, d.empresaA), [[a.item.id, 2, 1]]);
  });

  test('entrega parcial mantém a pendente na demanda: aprovada 3, uma unidade em estoque e entregue 1 → U0 D2 C0 L0 G2', async () => {
    const m = await novoMaterial();
    const alvo = await aprovada({ materialId: m, quantidade: 3 });
    const lote = await entrada(m, 1);
    assert.deepEqual(numeros(await posicao(m)), [1, 3, 1, 0, 2]);
    assert.deepEqual((await coberturaDe(m)).map((i) => [i.quantidadePendente, i.coberta, i.semCobertura]), [[3, 1, 2]]);
    await entregar(alvo, [[alvo.item, lote, 1]]);
    assert.deepEqual(numeros(await posicao(m)), [0, 2, 0, 0, 2]);
    assert.deepEqual((await coberturaDe(m)).map((i) => [i.quantidadePendente, i.coberta, i.semCobertura]), [[2, 0, 2]]);
    assert.equal((await pool().query('SELECT status FROM solicitacoes_epi WHERE id = $1', [alvo.solicitacao.id])).rows[0].status, 'APROVADA', 'a solicitação continua aberta');
    await entrada(m, 5);
    assert.deepEqual(numeros(await posicao(m)), [5, 2, 2, 3, 0]);
  });

  test('FIFO depois da entrega: entregar parte da mais antiga não muda a cobertura das seguintes; entregar o resto a tira da fila', async () => {
    const m = await novoMaterial();
    const primeira = await aprovada({ materialId: m, quantidade: 2, trabalhador: trabalhadores[0] });
    const segunda = await aprovada({ materialId: m, quantidade: 2, trabalhador: trabalhadores[1] });
    const lote = await entrada(m, 3);
    const lerFila = async () => (await coberturaDe(m)).map((i) => [i.solicitacaoId, i.quantidadePendente, i.coberta]);
    assert.deepEqual(await lerFila(), [[primeira.solicitacao.id, 2, 2], [segunda.solicitacao.id, 2, 1]]);
    await entregar(primeira, [[primeira.item, lote, 1]]);
    assert.deepEqual(await lerFila(), [[primeira.solicitacao.id, 1, 1], [segunda.solicitacao.id, 2, 1]], 'a segunda continua com 1 coberta');
    assert.deepEqual(numeros(await posicao(m)), [2, 3, 2, 0, 1]);
    await entregar(primeira, [[primeira.item, lote, 1]]);
    assert.deepEqual(await lerFila(), [[segunda.solicitacao.id, 2, 1]]);
    assert.deepEqual(numeros(await posicao(m)), [1, 2, 1, 0, 1]);
  });

  test('item inteiramente entregue de solicitação ainda aberta sai da fila; o item pendente da mesma solicitação fica', async () => {
    const m1 = await novoMaterial();
    const m2 = await novoMaterial();
    const lote1 = await entrada(m1, 5);
    await entrada(m2, 1);
    const { solicitacao, itens } = await criarSolicitacao(pool(), d, {
      funcionarioId: trabalhadores[3], itens: [{ material_id: m1, tamanho: '40', quantidade: 2 }, { material_id: m2, tamanho: '40', quantidade: 3 }],
    });
    const decidida = await decidirSolicitacao(pool(), solicitacao, { status: 'APROVADA', decididaPor: d.aprovador, decisoes: itens.map((i) => aprovar(i)) });
    await entregar({ solicitacao: decidida }, [[itens[0], lote1, 2]]);
    assert.equal((await pool().query('SELECT status FROM solicitacoes_epi WHERE id = $1', [decidida.id])).rows[0].status, 'APROVADA');
    assert.deepEqual(numeros(await posicao(m1)), [3, 0, 0, 3, 0]);
    assert.deepEqual(await coberturaDe(m1), []);
    assert.deepEqual((await coberturaDe(m2)).map((i) => [i.quantidadePendente, i.coberta]), [[3, 1]]);
  });

  test('baixa física depois de uma entrega parcial reduz o físico e a cobertura, e L e G nunca ficam negativos', async () => {
    const m = await novoMaterial();
    const alvo = await aprovada({ materialId: m, quantidade: 3 });
    const lote = await entrada(m, 3);
    await entregar(alvo, [[alvo.item, lote, 1]]);
    assert.deepEqual(numeros(await posicao(m)), [2, 2, 2, 0, 0]);
    await baixarLote(pool(), { empresaId: d.empresaA, loteId: lote, quantidade: 1, usuarioId: d.aprovador });
    assert.deepEqual(numeros(await posicao(m)), [1, 2, 1, 0, 1]);
    assert.deepEqual((await coberturaDe(m)).map((i) => [i.quantidadePendente, i.coberta, i.semCobertura]), [[2, 1, 1]]);
    await baixarLote(pool(), { empresaId: d.empresaA, loteId: lote, quantidade: 1, usuarioId: d.aprovador });
    const zerada = await posicao(m);
    assert.deepEqual(numeros(zerada), [0, 2, 0, 0, 2]);
    for (const campo of ['comprometido', 'saldoLivre', 'semCobertura']) assert.ok(zerada[campo] >= 0, campo);
  });

  test('a entrega DIRETA consome só o físico: a demanda das solicitações não muda', async () => {
    const m = await novoMaterial();
    await aprovada({ materialId: m, quantidade: 2 });
    const lote = await entrada(m, 5);
    await entregarDireta(pool(), { empresaId: d.empresaA, funcionarioId: trabalhadores[5], usuarioId: d.aprovador, materialId: m, loteId: lote, quantidade: 2, cnpj: CNPJ_A });
    assert.deepEqual(numeros(await posicao(m)), [3, 2, 2, 1, 0]);
  });

  test('solicitação ENTREGUE (fechada por entrega completa) não conta na demanda nem na fila', async () => {
    const m = await novoMaterial();
    const lote = await entrada(m, 4);
    const fechada = await aprovada({ materialId: m, quantidade: 2, trabalhador: trabalhadores[0] });
    const aberta = await aprovada({ materialId: m, quantidade: 1, trabalhador: trabalhadores[1] });
    await entregar(fechada, [[fechada.item, lote, 2]]);
    assert.equal((await pool().query('SELECT status FROM solicitacoes_epi WHERE id = $1', [fechada.solicitacao.id])).rows[0].status, 'ENTREGUE');
    assert.deepEqual(numeros(await posicao(m)), [2, 1, 1, 1, 0]);
    assert.deepEqual((await coberturaDe(m)).map((i) => i.solicitacaoId), [aberta.solicitacao.id]);
  });

  test('modelo de referência: depois de cada entrada, baixa e entrega parcial, a posição e a cobertura batem com o cálculo independente', async () => {
    const m = await novoMaterial();
    const sorteio = gerador(20261002);
    const inteiro = (minimo, maximo) => minimo + Math.floor(sorteio() * (maximo - minimo + 1));

    const fila = [];
    for (let i = 0; i < 5; i += 1) {
      const quantidade = inteiro(1, 4);
      const alvo = await aprovada({ materialId: m, quantidade, trabalhador: trabalhadores[i] });
      fila.push({ ...alvo, aprovada: quantidade, entregue: 0 });
    }
    const lotes = [];
    const fisico = () => lotes.reduce((soma, l) => soma + l.saldo, 0);
    const pendente = (i) => i.aprovada - i.entregue;
    const cobertura = () => {
      let anterior = 0;
      return fila.filter((i) => pendente(i) > 0).map((i) => {
        const coberta = Math.min(pendente(i), Math.max(0, fisico() - anterior));
        anterior += pendente(i);
        return { solicitacaoId: i.solicitacao.id, pendente: pendente(i), coberta };
      });
    };

    const conferir = async (passo) => {
      const esperada = cobertura();
      const demanda = esperada.reduce((soma, i) => soma + i.pendente, 0);
      const U = fisico();
      const lida = await posicao(m);
      assert.deepEqual(numeros(lida), [U, demanda, Math.min(U, demanda), Math.max(0, U - demanda), Math.max(0, demanda - U)], `posição no passo ${passo}`);
      const lidaFila = (await coberturaDe(m)).map((i) => ({ solicitacaoId: i.solicitacaoId, pendente: i.quantidadePendente, coberta: i.coberta }));
      assert.deepEqual(lidaFila, esperada, `cobertura no passo ${passo}`);
      for (const linha of lidaFila) assert.ok(linha.pendente >= 0 && linha.coberta >= 0 && linha.coberta <= linha.pendente, `invariantes no passo ${passo}`);
    };

    await conferir(0);
    let entregas = 0;
    let parciais = 0;
    for (let passo = 1; passo <= 28; passo += 1) {
      const sorte = sorteio();
      if (sorte < 0.3) {
        const quantidade = inteiro(1, 4);
        lotes.push({ id: await entrada(m, quantidade), saldo: quantidade });
      } else if (sorte < 0.45) {
        const comSaldo = lotes.filter((l) => l.saldo > 0);
        if (comSaldo.length > 0) {
          const lote = comSaldo[inteiro(0, comSaldo.length - 1)];
          const quantidade = inteiro(1, Math.min(2, lote.saldo));
          await baixarLote(pool(), { empresaId: d.empresaA, loteId: lote.id, quantidade, usuarioId: d.aprovador });
          lote.saldo -= quantidade;
        }
      } else {
        const candidatas = cobertura().filter((c) => c.coberta > 0);
        if (candidatas.length > 0) {
          const escolhida = candidatas[inteiro(0, candidatas.length - 1)];
          const alvo = fila.find((i) => i.solicitacao.id === escolhida.solicitacaoId);
          let falta = inteiro(1, escolhida.coberta);
          const partes = [];
          for (const lote of lotes) {
            if (falta === 0) break;
            const tirar = Math.min(falta, lote.saldo);
            if (tirar > 0) { partes.push([alvo.item, lote.id, tirar]); lote.saldo -= tirar; falta -= tirar; }
          }
          await entregar(alvo, partes);
          alvo.entregue += partes.reduce((soma, p) => soma + p[2], 0);
          entregas += 1;
          if (alvo.entregue < alvo.aprovada) parciais += 1;
        }
      }
      await conferir(passo);
    }
    assert.ok(entregas >= 3, `o roteiro precisa exercitar entregas (houve ${entregas})`);
    assert.ok(parciais >= 1, `o roteiro precisa exercitar entrega parcial, que deixa pendente (houve ${parciais})`);
  });
});
