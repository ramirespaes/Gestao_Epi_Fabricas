'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * Forma pública da solicitação de EPI: só o que a tela e as demais camadas
 * precisam. Nunca saem a chave de idempotência nem o hash da requisição. Os
 * números derivados (pendente, cobertura, posição) vêm de fora e nada é
 * gravado por aqui.
 */

const modulo = () => exigirModulo('src/services/solicitacao-epi-publica');

const CRIADA = new Date('2026-10-02T12:00:00Z');
const DECIDIDA = new Date('2026-10-02T13:00:00Z');

const cabecalho = (extra = {}) => ({
  id: 17, empresaId: 42, numero: 5, funcionarioId: 30, gheId: 9, origemSolicitacao: 'USUARIO_INTERNO', solicitanteUsuarioId: 11,
  status: 'PENDENTE', quantidadeItens: 2, observacao: 'Admissão', chaveIdempotencia: '3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c',
  requisicaoHash: 'a'.repeat(64), criadaEm: CRIADA, decididaPor: null, decididaEm: null, canceladaPor: null, canceladaEm: null,
  justificativaCancelamento: null, entregueEm: null, encerradaPor: null, encerradaEm: null, justificativaEncerramento: null, ...extra,
});
const itemGravado = (extra = {}) => ({
  id: 1, empresaId: 42, solicitacaoId: 17, materialId: 30, tamanho: '40', quantidade: 4, motivo: 'ADMISSAO', justificativa: null,
  previstoNoGhe: true, decisao: null, quantidadeAprovada: null, justificativaDecisao: null, ...extra,
});

describe('solicitacaoPublica', () => {
  test('PENDENTE: cabeçalho sem decisão nem cancelamento; sem empresa, chave nem hash', () => {
    const { solicitacaoPublica } = modulo();
    const publica = solicitacaoPublica(cabecalho(), null);
    assert.deepEqual(publica, {
      id: 17, numero: 5, status: 'PENDENTE', origemSolicitacao: 'USUARIO_INTERNO', solicitanteUsuarioId: 11, funcionarioId: 30, gheId: 9,
      quantidadeItens: 2, observacao: 'Admissão', criadaEm: CRIADA, decisao: null, cancelamento: null, entregueEm: null, encerramento: null,
      situacaoOperacional: null,
    });
    for (const proibida of ['chaveIdempotencia', 'requisicaoHash', 'empresaId']) assert.equal(proibida in publica, false, proibida);
  });

  test('decidida: quem e quando; situação operacional recebida', () => {
    const { solicitacaoPublica } = modulo();
    const publica = solicitacaoPublica(cabecalho({ status: 'APROVADA', decididaPor: 12, decididaEm: DECIDIDA }), 'AGUARDANDO_ESTOQUE');
    assert.deepEqual(publica.decisao, { decididaPor: 12, decididaEm: DECIDIDA });
    assert.equal(publica.situacaoOperacional, 'AGUARDANDO_ESTOQUE');
    assert.equal(publica.cancelamento, null);
  });

  test('cancelada: quem, quando e a justificativa', () => {
    const { solicitacaoPublica } = modulo();
    const publica = solicitacaoPublica(cabecalho({ status: 'CANCELADA', canceladaPor: 11, canceladaEm: DECIDIDA, justificativaCancelamento: 'Duplicada' }), null);
    assert.deepEqual(publica.cancelamento, { canceladaPor: 11, canceladaEm: DECIDIDA, justificativa: 'Duplicada' });
    assert.equal(publica.decisao, null);
  });

  test('encerrada (12E-2): quem, quando e a justificativa, ao lado da decisão que continua visível', () => {
    const { solicitacaoPublica } = modulo();
    const encerradaEm = new Date('2026-10-03T18:00:00Z');
    const publica = solicitacaoPublica(cabecalho({
      status: 'ENCERRADA', decididaPor: 12, decididaEm: DECIDIDA, encerradaPor: 13, encerradaEm, justificativaEncerramento: 'Transferido',
    }), null);
    assert.deepEqual(publica.encerramento, { encerradaPor: 13, encerradaEm, justificativa: 'Transferido' });
    assert.deepEqual(publica.decisao, { decididaPor: 12, decididaEm: DECIDIDA });
    assert.deepEqual([publica.cancelamento, publica.entregueEm, publica.situacaoOperacional], [null, null, null]);
  });

  test('fora de ENCERRADA o bloco de encerramento é nulo', () => {
    const { solicitacaoPublica } = modulo();
    for (const status of ['APROVADA', 'ENTREGUE', 'CANCELADA']) {
      assert.equal(solicitacaoPublica(cabecalho({ status }), null).encerramento, null, status);
    }
  });
});

describe('itemPublico', () => {
  test('item pendente de decisão: sem pendente, situação, cobertura nem posição', () => {
    const { itemPublico } = modulo();
    const publico = itemPublico(itemGravado(), { situacao: null, quantidadeEntregue: 0, cobertura: null, posicao: null });
    assert.deepEqual(publico, {
      id: 1, materialId: 30, tamanho: '40', quantidade: 4, motivo: 'ADMISSAO', justificativa: null, previstoNoGhe: true, decisao: null,
      quantidadeAprovada: null, justificativaDecisao: null, quantidadeEntregue: 0, quantidadePendente: null, situacao: null, cobertura: null, posicao: null,
    });
    assert.equal('empresaId' in publico, false);
    assert.equal('solicitacaoId' in publico, false);
  });

  test('item aprovado: o pendente é a aprovada menos a entregue, e cobertura e posição saem como recebidas', () => {
    const { itemPublico } = modulo();
    const cobertura = { coberta: 1, semCobertura: 2, acumuladoAnterior: 3, fisicoUtilizavel: 4 };
    const posicao = { fisicoUtilizavel: 4, demandaPendente: 6, comprometido: 4, saldoLivre: 0, semCobertura: 2 };
    const publico = itemPublico(
      itemGravado({ decisao: 'APROVADO', quantidadeAprovada: 3, justificativaDecisao: 'Reduzida' }),
      { situacao: 'PARCIALMENTE_COBERTA', quantidadeEntregue: 0, cobertura, posicao },
    );
    assert.equal(publico.quantidadePendente, 3);
    assert.equal(publico.situacao, 'PARCIALMENTE_COBERTA');
    assert.deepEqual(publico.cobertura, cobertura);
    assert.deepEqual(publico.posicao, posicao);
    assert.notEqual(publico.cobertura, cobertura, 'cópia, não a mesma referência');
  });

  test('item reprovado: pendente nulo', () => {
    const { itemPublico } = modulo();
    const publico = itemPublico(
      itemGravado({ decisao: 'REPROVADO', quantidadeAprovada: 0, justificativaDecisao: 'Sem necessidade' }),
      { situacao: null, quantidadeEntregue: 0, cobertura: null, posicao: null },
    );
    assert.equal(publico.quantidadePendente, null);
  });

  test('item aprovado de solicitação ENCERRADA (12E-2): a entregue continua a das entregas e o pendente é zero', () => {
    const { itemPublico } = modulo();
    const publico = itemPublico(
      itemGravado({ decisao: 'APROVADO', quantidadeAprovada: 3 }),
      {
        situacao: null, quantidadeEntregue: 1, cobertura: null, posicao: null, encerrada: true,
      },
    );
    assert.deepEqual([publico.quantidadeEntregue, publico.quantidadePendente, publico.situacao], [1, 0, null]);
    const reprovado = itemPublico(
      itemGravado({ decisao: 'REPROVADO', quantidadeAprovada: 0, justificativaDecisao: 'Sem necessidade' }),
      {
        situacao: null, quantidadeEntregue: 0, cobertura: null, posicao: null, encerrada: true,
      },
    );
    assert.equal(reprovado.quantidadePendente, null);
  });
});

describe('linhaDaLista — forma pública das listagens (12E-1)', () => {
  const funcao = () => {
    assert.equal(typeof modulo().linhaDaLista, 'function', 'função ainda não implementada: linhaDaLista');
    return modulo().linhaDaLista;
  };
  const linhaDoRepositorio = (extra = {}) => ({
    id: 17, numero: 5, status: 'APROVADA', solicitanteUsuarioId: 11, funcionarioId: 30, quantidadeItens: 2, criadaEm: CRIADA, decididaEm: DECIDIDA,
    canceladaEm: null, entregueEm: null, trabalhador: { nome: 'Trabalhador Fictício', matricula: 'T-1', ativo: true }, ...extra,
  });
  const quantidades = { solicitada: 6, aprovada: 5, entregue: 1, restante: 4 };

  test('devolve só o que a lista precisa: identificação, situação, trabalhador, quantidades e carimbos', () => {
    const publica = funcao()(linhaDoRepositorio(), { situacaoOperacional: 'PARCIALMENTE_ENTREGUE', quantidades });
    assert.deepEqual(publica, {
      id: 17,
      numero: 5,
      status: 'APROVADA',
      situacaoOperacional: 'PARCIALMENTE_ENTREGUE',
      solicitanteUsuarioId: 11,
      funcionario: { id: 30, nome: 'Trabalhador Fictício', matricula: 'T-1', ativo: true },
      quantidadeItens: 2,
      quantidades,
      criadaEm: CRIADA,
      decididaEm: DECIDIDA,
      canceladaEm: null,
      entregueEm: null,
    });
  });

  test('nunca sai CPF, observação, justificativa, chave, hash, empresa nem itens, mesmo que a linha traga mais campos', () => {
    const suja = linhaDoRepositorio({
      cpf: '12345678901', observacao: 'texto livre', justificativaCancelamento: 'texto livre', chaveIdempotencia: 'k', requisicaoHash: 'h', empresaId: 42, itens: [],
      trabalhador: { nome: 'Trabalhador Fictício', matricula: 'T-1', ativo: true, cpf: '12345678901' },
    });
    const texto = JSON.stringify(funcao()(suja, { situacaoOperacional: null, quantidades: { solicitada: 1, aprovada: null, entregue: null, restante: null } }));
    for (const proibido of ['12345678901', 'texto livre', 'chaveIdempotencia', 'requisicaoHash', 'empresaId', 'cpf', 'itens']) {
      assert.equal(texto.includes(proibido), false, proibido);
    }
  });

  test('com o encerramento pedido (só "minhas", 12F-1), a linha leva encerradaEm; sem o pedido, a chave não existe; a justificativa nunca vai', () => {
    const encerradaEm = new Date('2026-10-03T18:00:00Z');
    const linhaEncerrada = linhaDoRepositorio({ status: 'ENCERRADA', encerradaEm, justificativaEncerramento: 'texto livre' });
    const comData = funcao()(linhaEncerrada, { situacaoOperacional: null, quantidades, comEncerramento: true });
    assert.equal(comData.encerradaEm, encerradaEm);
    const semData = funcao()(linhaEncerrada, { situacaoOperacional: null, quantidades });
    assert.equal('encerradaEm' in semData, false);
    for (const publica of [comData, semData]) {
      assert.equal(JSON.stringify(publica).includes('texto livre'), false);
      assert.equal('justificativaEncerramento' in publica, false);
    }
  });

  test('o conteúdo recebido é copiado, não compartilhado', () => {
    const entrada = { solicitada: 6, aprovada: 5, entregue: 1, restante: 4 };
    const publica = funcao()(linhaDoRepositorio(), { situacaoOperacional: null, quantidades: entrada });
    assert.notEqual(publica.quantidades, entrada);
    assert.deepEqual(publica.quantidades, entrada);
  });
});

describe('itensSemEstoque — a visão de quem só pede (12F-2)', () => {
  test('tira só a cobertura e a posição de cada item; o resto fica igual e a entrada não muda', () => {
    const { itensSemEstoque } = modulo();
    assert.equal(typeof itensSemEstoque, 'function');
    const entrada = [{ id: 1, quantidadePendente: 2, situacao: 'AGUARDANDO_ESTOQUE', cobertura: { coberta: 1 }, posicao: { saldoLivre: 0 } }, { id: 2, cobertura: null, posicao: null }];
    assert.deepEqual(itensSemEstoque(entrada), [{ id: 1, quantidadePendente: 2, situacao: 'AGUARDANDO_ESTOQUE' }, { id: 2 }]);
    assert.deepEqual(Object.keys(entrada[0]).sort(), ['cobertura', 'id', 'posicao', 'quantidadePendente', 'situacao']);
  });
});
