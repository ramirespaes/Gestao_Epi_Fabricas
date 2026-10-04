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

// ── 12G-0 ───────────────────────────────────────────────────────────

const exigir = (nome) => {
  assert.equal(typeof modulo()[nome], 'function', `função ainda não implementada: ${nome}`);
  return modulo()[nome];
};

describe('formas públicas da 12G-0: só o que a tela precisa, nunca CPF, e-mail ou número de estoque', () => {
  const funcionarioLido = {
    id: 5, nome: 'Ana Souza', matricula: 'M-10', setor: 'Produção', funcao: 'Operadora', ativo: true, cpf: '12345678909', cpfMascarado: '***.***.789-09', ghe: { id: 2, nome: 'GHE' }, email: 'ana@exemplo.invalid', grupoHomogeneoId: 2,
  };

  test('trabalhadorDoContexto (L2): id, nome, matrícula, setor e função', () => {
    const publico = exigir('trabalhadorDoContexto')(funcionarioLido);
    assert.deepEqual(publico, {
      id: 5, nome: 'Ana Souza', matricula: 'M-10', setor: 'Produção', funcao: 'Operadora',
    });
  });

  test('materialDoContexto (L2): id, nome, unidade, exigeTamanho, previstoNoGhe e as sugestões de tamanho (cópia), sem saldo, lote, CA nem posição', () => {
    const tamanhos = ['38', '40'];
    const lido = {
      id: 9, nome: 'Botina', unidade: 'par', exigeTamanho: true, previstoNoGhe: false, tamanhosSugeridos: tamanhos, codigoInterno: 'B-1', tipo: 'Calçado',
      saldo: 12, fisicoUtilizavel: 12, saldoLivre: 3, comprometido: 9, prazoUsoDias: 180, exigeCa: true, oculosComGrau: null,
    };
    const publico = exigir('materialDoContexto')(lido);
    assert.deepEqual(publico, {
      id: 9, nome: 'Botina', unidade: 'par', exigeTamanho: true, previstoNoGhe: false, tamanhosSugeridos: ['38', '40'],
    });
    assert.notEqual(publico.tamanhosSugeridos, tamanhos);
  });

  test('trabalhadorDoDetalhe (L3): id, nome, matrícula, setor, função e situação', () => {
    assert.deepEqual(exigir('trabalhadorDoDetalhe')(funcionarioLido), {
      id: 5, nome: 'Ana Souza', matricula: 'M-10', setor: 'Produção', funcao: 'Operadora', ativo: true,
    });
    assert.equal(exigir('trabalhadorDoDetalhe')(null), null);
  });

  test('pessoaDoDetalhe (D7): só id e nome do usuário, nunca e-mail, perfil ou situação; ausente é null', () => {
    const usuario = {
      id: 7, nome: 'Bruno Lima', email: 'bruno@exemplo.invalid', perfil: 'ADMINISTRADOR', ativo: true, senhaHash: 'x',
    };
    assert.deepEqual(exigir('pessoaDoDetalhe')(usuario), { id: 7, nome: 'Bruno Lima' });
    assert.equal(exigir('pessoaDoDetalhe')(null), null);
    assert.equal(exigir('pessoaDoDetalhe')(undefined), null);
  });

  test('materialDoDetalhe (L3): nome e unidade; ausente é null', () => {
    assert.deepEqual(exigir('materialDoDetalhe')({ id: 9, nome: 'Botina', unidade: 'par', ativo: true, codigoInterno: 'B-1', saldo: 4 }), { nome: 'Botina', unidade: 'par' });
    assert.equal(exigir('materialDoDetalhe')(null), null);
  });

  test('linhaEncerravel (L4): identificação, trabalhador sem CPF, quantidades da solicitação e carimbos; sem situação, cobertura, posição, texto livre nem itens', () => {
    const linha = {
      id: 17, numero: 5, status: 'APROVADA_PARCIAL', solicitanteUsuarioId: 11, funcionarioId: 30, quantidadeItens: 2, criadaEm: 'c', decididaEm: 'd', canceladaEm: null, entregueEm: null,
      trabalhador: {
        nome: 'Ana', matricula: 'M-1', ativo: false, cpf: '12345678909',
      },
      observacao: 'livre', justificativaEncerramento: 'livre', itens: [{ id: 1 }], cobertura: { coberta: 1 }, situacaoOperacional: 'SUSPENSA',
    };
    const quantidades = {
      solicitada: 6, aprovada: 5, entregue: 1, restante: 4,
    };
    const publica = exigir('linhaEncerravel')(linha, { quantidades });
    assert.deepEqual(publica, {
      id: 17,
      numero: 5,
      status: 'APROVADA_PARCIAL',
      funcionario: {
        id: 30, nome: 'Ana', matricula: 'M-1', ativo: false,
      },
      quantidadeItens: 2,
      quantidades: {
        solicitada: 6, aprovada: 5, entregue: 1, restante: 4,
      },
      criadaEm: 'c',
      decididaEm: 'd',
    });
    assert.notEqual(publica.quantidades, quantidades);
  });
});
