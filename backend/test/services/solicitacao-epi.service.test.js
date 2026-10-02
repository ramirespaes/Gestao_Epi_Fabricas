'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { HttpError } = require('../../src/errors/HttpError');

/**
 * Parte pura do serviço da solicitação de EPI, sem PostgreSQL: a validação
 * recusa a requisição antes de abrir transação, e o hash da requisição lógica
 * é canônico. O fluxo transacional é provado com banco real em
 * test/integracao/solicitacao-epi-*.integration.js.
 */

const servico = () => exigirModulo('src/services/solicitacao-epi.service');

const CHAVE = '3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c';

const poolFechado = { connect: async () => { throw new Error('não deve abrir transação'); }, query: async () => { throw new Error('não deve consultar'); } };
const item = (extra = {}) => ({ materialId: 30, tamanho: '40', quantidade: 2, motivo: 'ADMISSAO', ...extra });
const dadosDeCriacao = (extra = {}) => ({
  empresaId: 42, atorId: 7, funcionarioId: 5, itens: [item()], chaveIdempotencia: CHAVE, ...extra,
});
const decisao = (extra = {}) => ({ itemId: 1, decisao: 'APROVADO', ...extra });
const dadosDeDecisao = (extra = {}) => ({ empresaId: 42, atorId: 8, solicitacaoId: 17, decisoes: [decisao()], ...extra });

async function esperarValidacao(promessa, campo, codigo) {
  await assert.rejects(promessa, (erro) => {
    assert.ok(HttpError.ehHttpError(erro), `esperado HttpError, veio ${erro && erro.name}: ${erro && erro.message}`);
    assert.deepEqual([erro.status, erro.codigo], [400, 'VALIDACAO']);
    assert.ok(erro.detalhes.some((d) => d.campo === campo && d.codigo === codigo), JSON.stringify(erro.detalhes));
    for (const detalhe of erro.detalhes) {
      assert.deepEqual(Object.keys(detalhe).sort(), ['campo', 'codigo', 'mensagem']);
    }
    return true;
  });
}

describe('constantes', () => {
  test('o limite de itens por solicitação é 20', () => {
    assert.equal(servico().LIMITE_ITENS, 20);
  });
});

describe('criarSolicitacao — validação antes de qualquer acesso ao banco', () => {
  test('identificadores da sessão e do trabalhador precisam ser inteiros positivos', async () => {
    for (const extra of [{ empresaId: 0 }, { atorId: -1 }, { funcionarioId: 1.5 }, { funcionarioId: '5' }]) {
      await assert.rejects(servico().criarSolicitacao(poolFechado, dadosDeCriacao(extra)), TypeError);
    }
  });

  test('chave de idempotência obrigatória no formato UUID', async () => {
    for (const chaveIdempotencia of [undefined, null, '', 'abc', 42, `${CHAVE}x`]) {
      await esperarValidacao(servico().criarSolicitacao(poolFechado, dadosDeCriacao({ chaveIdempotencia })), 'body.chaveIdempotencia', 'FORMATO_INVALIDO');
    }
  });

  test('itens: de 1 a 20; 21, vazio ou fora de lista são recusados', async () => {
    const muitos = Array.from({ length: 21 }, (_, i) => item({ materialId: i + 1 }));
    for (const itens of [[], muitos, 'x', null, undefined]) {
      await esperarValidacao(servico().criarSolicitacao(poolFechado, dadosDeCriacao({ itens })), 'body.itens', 'ITENS_FORA_DO_LIMITE');
    }
  });

  test('o mesmo material e tamanho duas vezes é recusado; tamanhos diferentes ou ausente em um deles passam da validação de forma', async () => {
    await esperarValidacao(servico().criarSolicitacao(poolFechado, dadosDeCriacao({ itens: [item(), item({ quantidade: 5 })] })), 'body.itens', 'ITEM_REPETIDO');
    await esperarValidacao(servico().criarSolicitacao(poolFechado, dadosDeCriacao({ itens: [item({ tamanho: ' 40 ' }), item({ tamanho: '40' })] })), 'body.itens', 'ITEM_REPETIDO');
    await esperarValidacao(
      servico().criarSolicitacao(poolFechado, dadosDeCriacao({ itens: [item({ tamanho: null }), item({ tamanho: undefined })] })),
      'body.itens', 'ITEM_REPETIDO',
    );
    // Passa a validação de forma e só então tenta abrir transação (o pool fechado recusa).
    await assert.rejects(servico().criarSolicitacao(poolFechado, dadosDeCriacao({ itens: [item({ tamanho: '40' }), item({ tamanho: '41' })] })), /não deve abrir transação/);
    await assert.rejects(servico().criarSolicitacao(poolFechado, dadosDeCriacao({ itens: [item({ tamanho: null }), item({ tamanho: '41' })] })), /não deve abrir transação/);
  });

  test('item: material e quantidade inteiros positivos; quantidade dentro do INTEGER; motivo da lista; tamanho válido', async () => {
    for (const quantidade of [0, -1, 1.5, '1', 2147483648, undefined]) {
      await esperarValidacao(servico().criarSolicitacao(poolFechado, dadosDeCriacao({ itens: [item({ quantidade })] })), 'body.itens[0].quantidade', 'QUANTIDADE_INVALIDA');
    }
    for (const materialId of [0, 'a', 1.5, undefined]) {
      await esperarValidacao(servico().criarSolicitacao(poolFechado, dadosDeCriacao({ itens: [item({ materialId })] })), 'body.itens[0].materialId', 'FORMATO_INVALIDO');
    }
    await esperarValidacao(servico().criarSolicitacao(poolFechado, dadosDeCriacao({ itens: [item({ motivo: 'TROCA' })] })), 'body.itens[0].motivo', 'VALOR_NAO_PERMITIDO');
    await esperarValidacao(servico().criarSolicitacao(poolFechado, dadosDeCriacao({ itens: ['x'] })), 'body.itens[0]', 'FORMATO_INVALIDO');
    for (const tamanho of ['', '   ', 'x'.repeat(21), 40, 'com\u0007controle']) {
      await esperarValidacao(servico().criarSolicitacao(poolFechado, dadosDeCriacao({ itens: [item({ tamanho })] })), 'body.itens[0].tamanho', 'TAMANHO_INVALIDO');
    }
  });

  test('justificativa do pedido opcional, mas obrigatória no motivo OUTRO; limites e caracteres de controle', async () => {
    await esperarValidacao(servico().criarSolicitacao(poolFechado, dadosDeCriacao({ itens: [item({ motivo: 'OUTRO' })] })), 'body.itens[0].justificativa', 'JUSTIFICATIVA_OBRIGATORIA');
    await esperarValidacao(servico().criarSolicitacao(poolFechado, dadosDeCriacao({ itens: [item({ justificativa: 'x'.repeat(501) })] })), 'body.itens[0].justificativa', 'JUSTIFICATIVA_INVALIDA');
    await esperarValidacao(servico().criarSolicitacao(poolFechado, dadosDeCriacao({ itens: [item({ justificativa: '   ' })] })), 'body.itens[0].justificativa', 'JUSTIFICATIVA_INVALIDA');
    await esperarValidacao(servico().criarSolicitacao(poolFechado, dadosDeCriacao({ itens: [item({ justificativa: 'a\u0000b' })] })), 'body.itens[0].justificativa', 'JUSTIFICATIVA_INVALIDA');
  });

  test('observação opcional da solicitação: de 1 a 500 caracteres, sem controle', async () => {
    for (const observacao of ['   ', 'x'.repeat(501), 'a\u0007b', 42]) {
      await esperarValidacao(servico().criarSolicitacao(poolFechado, dadosDeCriacao({ observacao })), 'body.observacao', 'OBSERVACAO_INVALIDA');
    }
  });

  test('o solicitante não precisa justificar item fora do GHE: o campo não existe na criação', async () => {
    // justificativaForaGhe do cliente é ignorada pela validação, não recusada: o GHE é lido do banco, nunca informado.
    await assert.rejects(
      servico().criarSolicitacao(poolFechado, dadosDeCriacao({ itens: [item({ previstoNoGhe: false, justificativaForaGhe: 'x' })] })),
      /não deve abrir transação/,
    );
  });
});

describe('hashDaRequisicao', () => {
  const base = () => ({ atorId: 7, funcionarioId: 5, observacao: null, itens: [item({ justificativa: null }), item({ materialId: 31, tamanho: null, justificativa: null })] });

  test('SHA-256 hexadecimal, independente da ordem dos itens', () => {
    const { hashDaRequisicao } = servico();
    const a = hashDaRequisicao(base());
    assert.match(a, /^[0-9a-f]{64}$/);
    const invertido = base();
    invertido.itens.reverse();
    assert.equal(hashDaRequisicao(invertido), a);
  });

  test('muda com o solicitante, o trabalhador, a observação e qualquer campo do item', () => {
    const { hashDaRequisicao } = servico();
    const original = hashDaRequisicao(base());
    const variacoes = [
      { ...base(), atorId: 8 },
      { ...base(), funcionarioId: 6 },
      { ...base(), observacao: 'Outra' },
      { ...base(), itens: [item({ quantidade: 3, justificativa: null }), item({ materialId: 31, tamanho: null, justificativa: null })] },
      { ...base(), itens: [item({ motivo: 'OUTRO', justificativa: 'x' }), item({ materialId: 31, tamanho: null, justificativa: null })] },
      { ...base(), itens: [item({ tamanho: '41', justificativa: null }), item({ materialId: 31, tamanho: null, justificativa: null })] },
      { ...base(), itens: [item({ justificativa: null })] },
    ];
    for (const variacao of variacoes) assert.notEqual(hashDaRequisicao(variacao), original);
  });
});

describe('decidirSolicitacao — validação antes de qualquer acesso ao banco', () => {
  test('identificadores precisam ser inteiros positivos; a data operacional opcional precisa ser válida', async () => {
    for (const extra of [{ empresaId: 0 }, { atorId: -1 }, { solicitacaoId: 1.5 }, { solicitacaoId: '17' }, { hoje: '2026-02-30' }]) {
      await assert.rejects(servico().decidirSolicitacao(poolFechado, dadosDeDecisao(extra)), TypeError, JSON.stringify(extra));
    }
  });

  test('decisões: de 1 a 20, uma por item, nenhuma repetida', async () => {
    const muitas = Array.from({ length: 21 }, (_, i) => decisao({ itemId: i + 1 }));
    for (const decisoes of [[], muitas, 'x', null]) {
      await esperarValidacao(servico().decidirSolicitacao(poolFechado, dadosDeDecisao({ decisoes })), 'body.decisoes', 'ITENS_FORA_DO_LIMITE');
    }
    await esperarValidacao(servico().decidirSolicitacao(poolFechado, dadosDeDecisao({ decisoes: [decisao(), decisao()] })), 'body.decisoes', 'DECISAO_REPETIDA');
    await esperarValidacao(servico().decidirSolicitacao(poolFechado, dadosDeDecisao({ decisoes: [decisao({ itemId: 0 })] })), 'body.decisoes[0].itemId', 'FORMATO_INVALIDO');
    await esperarValidacao(servico().decidirSolicitacao(poolFechado, dadosDeDecisao({ decisoes: ['x'] })), 'body.decisoes[0]', 'FORMATO_INVALIDO');
  });

  test('cada decisão: APROVADO ou REPROVADO; quantidade aprovada inteira; reprovado só com zero; justificativa válida', async () => {
    await esperarValidacao(servico().decidirSolicitacao(poolFechado, dadosDeDecisao({ decisoes: [decisao({ decisao: 'TALVEZ' })] })), 'body.decisoes[0].decisao', 'VALOR_NAO_PERMITIDO');
    for (const quantidadeAprovada of [0, -1, 1.5, '2', 2147483648]) {
      await esperarValidacao(
        servico().decidirSolicitacao(poolFechado, dadosDeDecisao({ decisoes: [decisao({ quantidadeAprovada })] })),
        'body.decisoes[0].quantidadeAprovada', 'QUANTIDADE_INVALIDA',
      );
    }
    for (const quantidadeAprovada of [1, 3, '0', -1]) {
      await esperarValidacao(
        servico().decidirSolicitacao(poolFechado, dadosDeDecisao({ decisoes: [decisao({ decisao: 'REPROVADO', quantidadeAprovada, justificativa: 'Sem necessidade' })] })),
        'body.decisoes[0].quantidadeAprovada', 'QUANTIDADE_INVALIDA',
      );
    }
    for (const justificativa of ['   ', 'x'.repeat(501), 'a\u0007b', 42]) {
      await esperarValidacao(
        servico().decidirSolicitacao(poolFechado, dadosDeDecisao({ decisoes: [decisao({ justificativa })] })),
        'body.decisoes[0].justificativa', 'JUSTIFICATIVA_INVALIDA',
      );
    }
  });

  test('reprovação sem justificativa é recusada antes do banco; reprovação com zero explícito passa da validação de forma', async () => {
    await esperarValidacao(
      servico().decidirSolicitacao(poolFechado, dadosDeDecisao({ decisoes: [decisao({ decisao: 'REPROVADO' })] })),
      'body.decisoes[0].justificativa', 'JUSTIFICATIVA_OBRIGATORIA',
    );
    await assert.rejects(
      servico().decidirSolicitacao(poolFechado, dadosDeDecisao({ decisoes: [decisao({ decisao: 'REPROVADO', quantidadeAprovada: 0, justificativa: 'Sem necessidade' })] })),
      /não deve abrir transação/,
    );
    await assert.rejects(servico().decidirSolicitacao(poolFechado, dadosDeDecisao()), /não deve abrir transação/);
  });
});

describe('cancelarSolicitacao — validação antes de qualquer acesso ao banco', () => {
  test('identificadores inteiros positivos; justificativa opcional, de 1 a 500 caracteres, sem controle', async () => {
    for (const extra of [{ empresaId: 0 }, { atorId: 1.5 }, { solicitacaoId: '17' }]) {
      await assert.rejects(servico().cancelarSolicitacao(poolFechado, { empresaId: 42, atorId: 7, solicitacaoId: 17, ...extra }), TypeError);
    }
    for (const justificativa of ['   ', 'x'.repeat(501), 'a\u0007b', 42]) {
      await esperarValidacao(
        servico().cancelarSolicitacao(poolFechado, { empresaId: 42, atorId: 7, solicitacaoId: 17, justificativa }),
        'body.justificativa', 'JUSTIFICATIVA_INVALIDA',
      );
    }
    await assert.rejects(servico().cancelarSolicitacao(poolFechado, { empresaId: 42, atorId: 7, solicitacaoId: 17 }), /não deve abrir transação/);
  });
});

describe('buscarSolicitacao — validação antes de qualquer acesso ao banco', () => {
  test('identificadores inteiros positivos e data operacional válida', async () => {
    for (const extra of [{ empresaId: 0 }, { solicitacaoId: 1.5 }, { hoje: '2026-13-01' }]) {
      await assert.rejects(servico().buscarSolicitacao(poolFechado, { empresaId: 42, solicitacaoId: 17, ...extra }), TypeError, JSON.stringify(extra));
    }
  });
});
