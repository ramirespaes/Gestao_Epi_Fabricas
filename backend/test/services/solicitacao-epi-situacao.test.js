'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * Situação operacional derivada da solicitação de EPI (Modelo A): nada disto
 * é gravado. O item aprovado é lido pela quantidade aprovada, pela entregue
 * e pela parte coberta do estoque; o cabeçalho, pelas situações dos itens.
 * `coberta` nulo quer dizer que o item não está na fila (trabalhador ou
 * material inativo): a demanda fica suspensa, sem mudar o status gravado.
 */

const modulo = () => exigirModulo('src/services/solicitacao-epi-situacao');

const aprovado = (extra = {}) => ({ decisao: 'APROVADO', quantidadeAprovada: 3, quantidadeEntregue: 0, coberta: 0, ...extra });

describe('situacaoDoItem — item aprovado, sem entrega (até a 12C)', () => {
  test('coberta 0 → AGUARDANDO_ESTOQUE; entre 0 e o pendente → PARCIALMENTE_COBERTA; igual ao pendente → PRONTA_PARA_ENTREGA', () => {
    const { situacaoDoItem } = modulo();
    assert.equal(situacaoDoItem(aprovado({ coberta: 0 })), 'AGUARDANDO_ESTOQUE');
    assert.equal(situacaoDoItem(aprovado({ coberta: 1 })), 'PARCIALMENTE_COBERTA');
    assert.equal(situacaoDoItem(aprovado({ coberta: 2 })), 'PARCIALMENTE_COBERTA');
    assert.equal(situacaoDoItem(aprovado({ coberta: 3 })), 'PRONTA_PARA_ENTREGA');
  });

  test('a quantidade aprovada reduzida é a que conta: aprovada 1 de 5 pedidos coberta 1 está pronta', () => {
    const { situacaoDoItem } = modulo();
    assert.equal(situacaoDoItem(aprovado({ quantidadeAprovada: 1, coberta: 1 })), 'PRONTA_PARA_ENTREGA');
  });

  test('item fora da fila (coberta nulo): SUSPENSA, sem confundir com aguardando estoque', () => {
    const { situacaoDoItem } = modulo();
    assert.equal(situacaoDoItem(aprovado({ coberta: null })), 'SUSPENSA');
  });

  test('item não aprovado não tem situação operacional', () => {
    const { situacaoDoItem } = modulo();
    assert.equal(situacaoDoItem({ decisao: 'REPROVADO', quantidadeAprovada: 0, quantidadeEntregue: 0, coberta: null }), null);
    assert.equal(situacaoDoItem({ decisao: null, quantidadeAprovada: null, quantidadeEntregue: 0, coberta: null }), null);
  });
});

describe('situacaoDoItem — entrega, preparada para a 12C', () => {
  test('pendente zero → ENTREGUE, qualquer que seja a cobertura; parte entregue com pendente → PARCIALMENTE_ENTREGUE', () => {
    const { situacaoDoItem } = modulo();
    assert.equal(situacaoDoItem(aprovado({ quantidadeEntregue: 3, coberta: null })), 'ENTREGUE');
    assert.equal(situacaoDoItem(aprovado({ quantidadeEntregue: 3, coberta: 0 })), 'ENTREGUE');
    assert.equal(situacaoDoItem(aprovado({ quantidadeEntregue: 1, coberta: 2 })), 'PARCIALMENTE_ENTREGUE');
    assert.equal(situacaoDoItem(aprovado({ quantidadeEntregue: 1, coberta: 0 })), 'PARCIALMENTE_ENTREGUE');
  });

  test('o que falta é calculado sobre o pendente: aprovada 3, entregue 1, coberta 2 cobre tudo o que resta', () => {
    const { situacaoDoItem } = modulo();
    assert.equal(situacaoDoItem(aprovado({ quantidadeEntregue: 1, coberta: 2 })), 'PARCIALMENTE_ENTREGUE');
    assert.equal(situacaoDoItem(aprovado({ quantidadeEntregue: 1, coberta: null })), 'SUSPENSA');
  });

  test('números impossíveis são erro de programação: coberta acima do pendente, entregue acima do aprovado, aprovado sem quantidade', () => {
    const { situacaoDoItem } = modulo();
    assert.throws(() => situacaoDoItem(aprovado({ coberta: 4 })), TypeError);
    assert.throws(() => situacaoDoItem(aprovado({ quantidadeEntregue: 4 })), TypeError);
    assert.throws(() => situacaoDoItem(aprovado({ quantidadeAprovada: null })), TypeError);
    assert.throws(() => situacaoDoItem(aprovado({ coberta: -1 })), TypeError);
    assert.throws(() => situacaoDoItem(aprovado({ quantidadeEntregue: -1 })), TypeError);
  });
});

describe('situacaoDaSolicitacao', () => {
  test('sem situação operacional enquanto não há aprovação ativa: PENDENTE, REPROVADA e CANCELADA', () => {
    const { situacaoDaSolicitacao } = modulo();
    for (const status of ['PENDENTE', 'REPROVADA', 'CANCELADA']) {
      assert.equal(situacaoDaSolicitacao(status, [null, null]), null, status);
    }
  });

  test('ENTREGUE vale ENTREGUE', () => {
    const { situacaoDaSolicitacao } = modulo();
    assert.equal(situacaoDaSolicitacao('ENTREGUE', ['ENTREGUE', 'ENTREGUE']), 'ENTREGUE');
  });

  test('ENCERRADA (12E-2) não tem situação operacional: nada mais será entregue, qualquer que seja a situação calculada dos itens', () => {
    const { situacaoDaSolicitacao } = modulo();
    assert.equal(situacaoDaSolicitacao('ENCERRADA', [null, null]), null);
    assert.equal(situacaoDaSolicitacao('ENCERRADA', ['ENTREGUE', 'SUSPENSA']), null);
    assert.equal(situacaoDaSolicitacao('ENCERRADA', ['SUSPENSA', null]), null);
  });

  test('aprovada: todos prontos → PRONTA_PARA_ENTREGA; todos aguardando → AGUARDANDO_ESTOQUE; todos suspensos → SUSPENSA', () => {
    const { situacaoDaSolicitacao } = modulo();
    for (const status of ['APROVADA', 'APROVADA_PARCIAL']) {
      assert.equal(situacaoDaSolicitacao(status, ['PRONTA_PARA_ENTREGA', 'PRONTA_PARA_ENTREGA']), 'PRONTA_PARA_ENTREGA', status);
      assert.equal(situacaoDaSolicitacao(status, ['AGUARDANDO_ESTOQUE', 'AGUARDANDO_ESTOQUE']), 'AGUARDANDO_ESTOQUE', status);
      assert.equal(situacaoDaSolicitacao(status, ['SUSPENSA', 'SUSPENSA']), 'SUSPENSA', status);
    }
  });

  test('mistura de prontos e aguardando, ou com parcialmente coberto ou suspenso, é PARCIALMENTE_COBERTA; item reprovado (nulo) não pesa', () => {
    const { situacaoDaSolicitacao } = modulo();
    assert.equal(situacaoDaSolicitacao('APROVADA_PARCIAL', ['PRONTA_PARA_ENTREGA', 'AGUARDANDO_ESTOQUE']), 'PARCIALMENTE_COBERTA');
    assert.equal(situacaoDaSolicitacao('APROVADA', ['PARCIALMENTE_COBERTA', 'PRONTA_PARA_ENTREGA']), 'PARCIALMENTE_COBERTA');
    assert.equal(situacaoDaSolicitacao('APROVADA', ['SUSPENSA', 'PRONTA_PARA_ENTREGA']), 'PARCIALMENTE_COBERTA');
    assert.equal(situacaoDaSolicitacao('APROVADA_PARCIAL', [null, 'PRONTA_PARA_ENTREGA']), 'PRONTA_PARA_ENTREGA');
    assert.equal(situacaoDaSolicitacao('APROVADA_PARCIAL', [null, 'AGUARDANDO_ESTOQUE', null]), 'AGUARDANDO_ESTOQUE');
  });

  test('com entrega parcial ou de parte dos itens: PARCIALMENTE_ENTREGUE; todos entregues: ENTREGUE', () => {
    const { situacaoDaSolicitacao } = modulo();
    assert.equal(situacaoDaSolicitacao('APROVADA', ['ENTREGUE', 'PRONTA_PARA_ENTREGA']), 'PARCIALMENTE_ENTREGUE');
    assert.equal(situacaoDaSolicitacao('APROVADA', ['PARCIALMENTE_ENTREGUE', 'AGUARDANDO_ESTOQUE']), 'PARCIALMENTE_ENTREGUE');
    assert.equal(situacaoDaSolicitacao('APROVADA', ['ENTREGUE', 'ENTREGUE']), 'ENTREGUE');
  });

  test('precedência com SUSPENSA: se o que falta entregar está todo suspenso, a solicitação é SUSPENSA, mesmo com parte já entregue; se ainda há o que entregar, vale o progresso', () => {
    const { situacaoDaSolicitacao } = modulo();
    for (const status of ['APROVADA', 'APROVADA_PARCIAL']) {
      assert.equal(situacaoDaSolicitacao(status, ['ENTREGUE', 'SUSPENSA']), 'SUSPENSA', `${status}: o item entregue fica visível nas quantidades, a situação é a impossibilidade atual`);
      assert.equal(situacaoDaSolicitacao(status, ['ENTREGUE', 'SUSPENSA', 'SUSPENSA']), 'SUSPENSA', status);
      assert.equal(situacaoDaSolicitacao(status, ['SUSPENSA', null]), 'SUSPENSA', status);
      assert.equal(situacaoDaSolicitacao(status, ['ENTREGUE', 'SUSPENSA', 'PRONTA_PARA_ENTREGA']), 'PARCIALMENTE_ENTREGUE', `${status}: ainda há o que entregar`);
      assert.equal(situacaoDaSolicitacao(status, ['PARCIALMENTE_ENTREGUE', 'SUSPENSA']), 'PARCIALMENTE_ENTREGUE', status);
    }
  });

  test('aprovada sem nenhum item aprovado, ou status desconhecido, é inconsistência: erro de programação', () => {
    const { situacaoDaSolicitacao } = modulo();
    assert.throws(() => situacaoDaSolicitacao('APROVADA', [null, null]), TypeError);
    assert.throws(() => situacaoDaSolicitacao('APROVADA', []), TypeError);
    assert.throws(() => situacaoDaSolicitacao('TALVEZ', ['PRONTA_PARA_ENTREGA']), TypeError);
    assert.throws(() => situacaoDaSolicitacao('APROVADA', ['INVENTADA']), TypeError);
    assert.throws(() => situacaoDaSolicitacao('APROVADA', 'x'), TypeError);
  });

});

describe('quantidadesDaSolicitacao — soma por solicitação, derivada dos itens', () => {
  const funcao = () => {
    assert.equal(typeof modulo().quantidadesDaSolicitacao, 'function', 'função ainda não implementada: quantidadesDaSolicitacao');
    return modulo().quantidadesDaSolicitacao;
  };
  const pedido = (extra = {}) => ({ decisao: null, quantidade: 4, quantidadeAprovada: null, quantidadeEntregue: 0, ...extra });
  const aprovadoCom = (quantidade, quantidadeAprovada, quantidadeEntregue = 0) => pedido({ decisao: 'APROVADO', quantidade, quantidadeAprovada, quantidadeEntregue });
  const reprovado = (quantidade) => pedido({ decisao: 'REPROVADO', quantidade, quantidadeAprovada: 0 });

  test('PENDENTE e CANCELADA: só a quantidade solicitada; o resto não se aplica', () => {
    for (const status of ['PENDENTE', 'CANCELADA']) {
      assert.deepEqual(funcao()(status, [pedido({ quantidade: 4 }), pedido({ quantidade: 1 })]), { solicitada: 5, aprovada: null, entregue: null, restante: null }, status);
    }
  });

  test('REPROVADA: nada aprovado (zero), sem entregue nem restante', () => {
    assert.deepEqual(funcao()('REPROVADA', [reprovado(4), reprovado(2)]), { solicitada: 6, aprovada: 0, entregue: null, restante: null });
  });

  test('APROVADA e APROVADA_PARCIAL: aprovada e entregue só dos itens aprovados; o restante é a diferença', () => {
    const itens = [aprovadoCom(5, 3, 1), aprovadoCom(2, 2, 0), reprovado(4)];
    for (const status of ['APROVADA', 'APROVADA_PARCIAL']) {
      assert.deepEqual(funcao()(status, itens), { solicitada: 11, aprovada: 5, entregue: 1, restante: 4 }, status);
    }
  });

  test('ENTREGUE: tudo o que foi aprovado foi entregue, restante zero', () => {
    assert.deepEqual(funcao()('ENTREGUE', [aprovadoCom(5, 3, 3), reprovado(4)]), { solicitada: 9, aprovada: 3, entregue: 3, restante: 0 });
  });

  test('ENCERRADA (12E-2): a entregue continua a das entregas e o restante é zero; o que faltava foi liberado, não fica pendente', () => {
    assert.deepEqual(funcao()('ENCERRADA', [aprovadoCom(5, 3, 1), aprovadoCom(2, 2, 0), reprovado(4)]), { solicitada: 11, aprovada: 5, entregue: 1, restante: 0 });
    assert.deepEqual(funcao()('ENCERRADA', [aprovadoCom(2, 2, 0)]), { solicitada: 2, aprovada: 2, entregue: 0, restante: 0 });
  });

  test('recusa status desconhecido, itens fora de lista e entregue acima da aprovada (erro de programação)', () => {
    assert.throws(() => funcao()('TALVEZ', []), TypeError);
    assert.throws(() => funcao()('APROVADA', 'x'), TypeError);
    assert.throws(() => funcao()('APROVADA', [aprovadoCom(5, 3, 4)]), TypeError);
    assert.throws(() => funcao()('PENDENTE', [pedido({ quantidade: 0 })]), TypeError);
  });
});

describe('SITUACOES', () => {
  test('o conjunto de situações é fechado e não inclui nenhum estado gravado', () => {
    const { SITUACOES } = modulo();
    assert.deepEqual([...SITUACOES].sort(), [
      'AGUARDANDO_ESTOQUE', 'ENTREGUE', 'PARCIALMENTE_COBERTA', 'PARCIALMENTE_ENTREGUE', 'PRONTA_PARA_ENTREGA', 'SUSPENSA',
    ]);
    assert.ok(Object.isFrozen(SITUACOES));
  });
});
