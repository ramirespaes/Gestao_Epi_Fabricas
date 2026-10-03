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

  test('o filtro opcional do solicitante (12F-1) precisa ser um identificador inteiro positivo quando informado', async () => {
    for (const solicitanteUsuarioId of [0, -1, 1.5, '7']) {
      await assert.rejects(
        servico().buscarSolicitacao(poolFechado, { empresaId: 42, solicitacaoId: 17, solicitanteUsuarioId }),
        /solicitante/,
        String(solicitanteUsuarioId),
      );
    }
    await assert.rejects(servico().buscarSolicitacao(poolFechado, { empresaId: 42, solicitacaoId: 17, solicitanteUsuarioId: 7 }), /não deve abrir transação/);
    await assert.rejects(servico().buscarSolicitacao(poolFechado, { empresaId: 42, solicitacaoId: 17, solicitanteUsuarioId: null }), /não deve abrir transação/);
  });
});

describe('encerrarSolicitacao (D6, 12E-2)', () => {
  const funcao = () => {
    assert.equal(typeof servico().encerrarSolicitacao, 'function', 'função ainda não implementada: encerrarSolicitacao');
    return servico().encerrarSolicitacao;
  };
  const dadosDeEncerramento = (extra = {}) => ({ empresaId: 42, atorId: 8, solicitacaoId: 17, justificativa: 'Trabalhador desligado', ...extra });

  describe('validação antes de qualquer acesso ao banco', () => {
    test('identificadores inteiros positivos; data operacional opcional válida', async () => {
      for (const extra of [{ empresaId: 0 }, { atorId: -1 }, { solicitacaoId: 1.5 }, { solicitacaoId: '17' }, { hoje: '2026-02-30' }]) {
        await assert.rejects(funcao()(poolFechado, dadosDeEncerramento(extra)), TypeError, JSON.stringify(extra));
      }
    });

    test('a justificativa é obrigatória: ausente, nula ou só com espaços em branco é JUSTIFICATIVA_OBRIGATORIA', async () => {
      for (const justificativa of [undefined, null, '', '   ', '  ', '\n\t ']) {
        await esperarValidacao(funcao()(poolFechado, dadosDeEncerramento({ justificativa })), 'body.justificativa', 'JUSTIFICATIVA_OBRIGATORIA');
      }
    });

    test('justificativa inválida (mais de 500 caracteres, caractere de controle ou não texto) é JUSTIFICATIVA_INVALIDA, sem devolver o valor', async () => {
      for (const justificativa of ['x'.repeat(501), 'a\u0007b', 42, { texto: 'x' }]) {
        await assert.rejects(funcao()(poolFechado, dadosDeEncerramento({ justificativa })), (erro) => {
          assert.deepEqual([erro.status, erro.codigo], [400, 'VALIDACAO']);
          assert.deepEqual(erro.detalhes.map((x) => [x.campo, x.codigo]), [['body.justificativa', 'JUSTIFICATIVA_INVALIDA']]);
          assert.doesNotMatch(JSON.stringify(erro.detalhes), /xxxx|\u0007/);
          return true;
        });
      }
      await assert.rejects(funcao()(poolFechado, dadosDeEncerramento({ justificativa: 'x'.repeat(500) })), /não deve abrir transação/);
      await assert.rejects(funcao()(poolFechado, dadosDeEncerramento()), /não deve abrir transação/);
    });
  });

  describe('ordem do ato, com os repositórios simulados', () => {
    const solicitacaoRepo = () => require('../../src/repositories/solicitacao-epi.repository');
    const itemRepo = () => require('../../src/repositories/solicitacao-epi-item.repository');
    const coberturaRepo = () => require('../../src/repositories/solicitacao-epi-cobertura.repository');
    const parRepo = () => require('../../src/repositories/estoque-par.repository');
    const usuarioRepo = () => require('../../src/repositories/usuario.repository');
    const auditoriaRepo = () => require('../../src/repositories/auditoria.repository');

    const DECIDIDA = new Date('2026-10-02T13:00:00Z');
    const cabecalho = (extra = {}) => ({
      id: 17, empresaId: 42, numero: 5, funcionarioId: 30, gheId: 9, origemSolicitacao: 'USUARIO_INTERNO', solicitanteUsuarioId: 8, status: 'APROVADA_PARCIAL',
      quantidadeItens: 3, observacao: 'Texto livre do solicitante', chaveIdempotencia: CHAVE, requisicaoHash: 'a'.repeat(64), criadaEm: DECIDIDA, decididaPor: 9,
      decididaEm: DECIDIDA, canceladaPor: null, canceladaEm: null, justificativaCancelamento: null, entregueEm: null, encerradaPor: null, encerradaEm: null,
      justificativaEncerramento: null, ...extra,
    });
    const itemComEntregue = (extra = {}) => ({
      id: 1, empresaId: 42, solicitacaoId: 17, materialId: 30, tamanho: '40', quantidade: 4, motivo: 'ADMISSAO', justificativa: null, previstoNoGhe: true,
      decisao: 'APROVADO', quantidadeAprovada: 4, justificativaDecisao: null, quantidadeEntregue: 0, ...extra,
    });
    const posicao = (materialId, tamanho, d) => ({
      materialId, tamanho, fisicoUtilizavel: 2, demandaPendente: d, comprometido: Math.min(2, d), saldoLivre: Math.max(0, 2 - d), semCobertura: Math.max(0, d - 2),
    });

    function simular(t, { status = 'APROVADA_PARCIAL', itens, ativo = true } = {}) {
      funcao();
      assert.equal(typeof solicitacaoRepo().encerrar, 'function', 'função ainda não implementada: encerrar (repositório)');
      const ordem = [];
      const client = { query: async (texto) => { ordem.push(texto); return { rows: [] }; }, release: () => {} };
      const pool = { connect: async () => client };
      const anotar = (nome, fn) => async (...args) => { ordem.push(nome); return fn(...args); };
      const encerrada = cabecalho({
        status: 'ENCERRADA', encerradaPor: 8, encerradaEm: new Date('2026-10-03T18:00:00Z'), justificativaEncerramento: 'Trabalhador desligado',
      });
      t.mock.method(solicitacaoRepo(), 'travarPorId', anotar('travarPorId', async () => cabecalho({ status })));
      t.mock.method(usuarioRepo(), 'buscarPorId', anotar('ator', async () => ({ id: 8, empresaId: 42, perfil: 'ADMINISTRADOR', ativo })));
      t.mock.method(itemRepo(), 'listarPorSolicitacaoComEntregue', anotar('itens', async () => itens));
      t.mock.method(parRepo(), 'travarPares', anotar('travarPares', async (_c, _e, pares) => pares));
      let leituras = 0;
      t.mock.method(coberturaRepo(), 'lerPosicoes', anotar('lerPosicoes', async (_c, _e, pares) => {
        leituras += 1;
        return pares.map((p) => posicao(p.materialId, p.tamanho, leituras === 1 ? 5 : 2));
      }));
      t.mock.method(coberturaRepo(), 'listarCobertura', anotar('listarCobertura', async () => []));
      t.mock.method(solicitacaoRepo(), 'encerrar', anotar('encerrar', async () => encerrada));
      const auditorias = [];
      t.mock.method(auditoriaRepo(), 'registrar', anotar('auditoria', async (_c, registro) => { auditorias.push(registro); }));
      return { pool, ordem, auditorias };
    }

    const itensDeTeste = () => [
      itemComEntregue({ id: 1, materialId: 30, tamanho: '40', quantidadeAprovada: 4, quantidadeEntregue: 1 }),
      itemComEntregue({ id: 2, materialId: 31, tamanho: null, quantidade: 2, quantidadeAprovada: 2, quantidadeEntregue: 2 }),
      itemComEntregue({ id: 3, materialId: 32, tamanho: '42', quantidade: 1, decisao: 'REPROVADO', quantidadeAprovada: 0, justificativaDecisao: 'Sem necessidade' }),
    ];

    test('trava a solicitação, confere o ator, lê os itens, trava só os pares com pendente, lê a posição, encerra, relê e audita, nesta ordem, numa transação', async (t) => {
      const { pool, ordem } = simular(t, { itens: itensDeTeste() });
      await funcao()(pool, dadosDeEncerramento({ hoje: '2026-10-03' }));
      const passos = ordem.filter((x) => !/^(BEGIN|COMMIT|ROLLBACK)/.test(x));
      assert.equal(ordem[0], 'BEGIN');
      assert.equal(ordem[ordem.length - 1], 'COMMIT');
      assert.deepEqual(passos.slice(0, 8), ['travarPorId', 'ator', 'itens', 'travarPares', 'lerPosicoes', 'encerrar', 'lerPosicoes', 'auditoria']);
      assert.equal(passos.includes('listarCobertura'), false, 'a ENCERRADA não tem cobertura a calcular');
    });

    test('os pares travados e lidos são só os dos itens aprovados com quantidade ainda não entregue', async (t) => {
      const { pool } = simular(t, { itens: itensDeTeste() });
      await funcao()(pool, dadosDeEncerramento({ hoje: '2026-10-03' }));
      const travados = parRepo().travarPares.mock.calls[0].arguments[2];
      assert.deepEqual(travados, [{ materialId: 30, tamanho: '40' }]);
      assert.deepEqual(coberturaRepo().lerPosicoes.mock.calls[0].arguments[2], [{ materialId: 30, tamanho: '40' }]);
      assert.deepEqual(coberturaRepo().lerPosicoes.mock.calls[0].arguments[3], { hoje: '2026-10-03' });
      assert.deepEqual(solicitacaoRepo().encerrar.mock.calls[0].arguments.slice(1), [42, 17, { encerradaPor: 8, justificativa: 'Trabalhador desligado' }]);
    });

    test('auditoria SOLICITACAO_EPI_ENCERRADA: ids, status, quantidades e posição antes e depois; sem justificativa, observação nem texto livre', async (t) => {
      const { pool, auditorias } = simular(t, { itens: itensDeTeste() });
      await funcao()(pool, dadosDeEncerramento({ hoje: '2026-10-03', ip: '203.0.113.10', dispositivo: 'Navegador de teste' }));
      assert.equal(auditorias.length, 1);
      const [registro] = auditorias;
      assert.deepEqual([registro.acao, registro.empresaId, registro.usuarioId, registro.referencia], ['SOLICITACAO_EPI_ENCERRADA', 42, 8, '17']);
      assert.equal(registro.descricao ?? null, null);
      assert.deepEqual(registro.dadosAnteriores, { status: 'APROVADA_PARCIAL' });
      assert.deepEqual(registro.dadosNovos, { status: 'ENCERRADA' });
      assert.deepEqual(registro.contexto, {
        solicitacaoId: 17,
        numero: 5,
        funcionarioId: 30,
        autoencerramento: true,
        comEntregaAnterior: true,
        quantidadeAprovada: 6,
        quantidadeEntregue: 3,
        quantidadeLiberada: 3,
        itens: [
          { itemId: 1, materialId: 30, tamanho: '40', quantidadeAprovada: 4, quantidadeEntregue: 1, quantidadeLiberada: 3 },
          { itemId: 2, materialId: 31, tamanho: null, quantidadeAprovada: 2, quantidadeEntregue: 2, quantidadeLiberada: 0 },
        ],
        pares: [{
          materialId: 30,
          tamanho: '40',
          posicaoAntes: { fisicoUtilizavel: 2, demandaPendente: 5, comprometido: 2, saldoLivre: 0, semCobertura: 3 },
          posicaoDepois: { fisicoUtilizavel: 2, demandaPendente: 2, comprometido: 2, saldoLivre: 0, semCobertura: 0 },
        }],
      });
      const texto = JSON.stringify(registro);
      for (const proibido of ['Trabalhador desligado', 'Texto livre do solicitante', 'Sem necessidade', 'justificativa"', 'observacao', 'cpf']) {
        assert.equal(texto.includes(proibido), false, proibido);
      }
    });

    test('quem não criou a solicitação também encerra; o encerramento não tem regra de autodecisão', async (t) => {
      const { pool, auditorias } = simular(t, { itens: itensDeTeste() });
      await funcao()(pool, dadosDeEncerramento({ atorId: 99, hoje: '2026-10-03' }));
      assert.equal(auditorias[0].contexto.autoencerramento, false);
    });

    test('a resposta é o detalhe da solicitação encerrada: encerramento com a justificativa, sem situação operacional e com pendente zero', async (t) => {
      const { pool } = simular(t, { itens: itensDeTeste() });
      const visao = await funcao()(pool, dadosDeEncerramento({ hoje: '2026-10-03' }));
      assert.equal(visao.solicitacao.status, 'ENCERRADA');
      assert.deepEqual(visao.solicitacao.encerramento, { encerradaPor: 8, encerradaEm: new Date('2026-10-03T18:00:00Z'), justificativa: 'Trabalhador desligado' });
      assert.equal(visao.solicitacao.situacaoOperacional, null);
      assert.deepEqual(visao.itens.map((i) => [i.id, i.quantidadeEntregue, i.quantidadePendente, i.situacao, i.cobertura, i.posicao]), [
        [1, 1, 0, null, null, null], [2, 2, 0, null, null, null], [3, 0, null, null, null, null],
      ]);
    });

    test('status que não é APROVADA nem APROVADA_PARCIAL: 409 SOLICITACAO_NAO_ENCERRAVEL, sem travar par, gravar nem auditar', async (t) => {
      for (const status of ['PENDENTE', 'REPROVADA', 'CANCELADA', 'ENTREGUE', 'ENCERRADA']) {
        const { pool, ordem, auditorias } = simular(t, { status, itens: itensDeTeste() });
        await assert.rejects(funcao()(pool, dadosDeEncerramento()), (erro) => {
          assert.deepEqual([erro.status, erro.codigo], [409, 'SOLICITACAO_NAO_ENCERRAVEL'], status);
          return true;
        });
        assert.equal(ordem.includes('travarPares'), false, status);
        assert.equal(ordem.includes('encerrar'), false, status);
        assert.equal(auditorias.length, 0, status);
        assert.equal(ordem[ordem.length - 1], 'ROLLBACK', status);
        t.mock.restoreAll();
      }
    });

    test('solicitação inexistente na empresa: 404; encerrador inativo: 403 USUARIO_INATIVO; nada é gravado', async (t) => {
      const semSolicitacao = simular(t, { itens: itensDeTeste() });
      solicitacaoRepo().travarPorId.mock.mockImplementation(async () => null);
      await assert.rejects(funcao()(semSolicitacao.pool, dadosDeEncerramento()), (erro) => erro.status === 404 && erro.codigo === 'SOLICITACAO_NAO_ENCONTRADA');
      t.mock.restoreAll();
      const inativo = simular(t, { itens: itensDeTeste(), ativo: false });
      await assert.rejects(funcao()(inativo.pool, dadosDeEncerramento()), (erro) => erro.status === 403 && erro.codigo === 'USUARIO_INATIVO');
      assert.equal(inativo.ordem.includes('encerrar'), false);
      assert.equal(inativo.auditorias.length, 0);
    });

    test('se a gravação não acontece (corrida que o banco detecta), 409 SOLICITACAO_ALTERADA e nada é auditado', async (t) => {
      const { pool, auditorias } = simular(t, { itens: itensDeTeste() });
      solicitacaoRepo().encerrar.mock.mockImplementation(async () => null);
      await assert.rejects(funcao()(pool, dadosDeEncerramento()), (erro) => erro.status === 409 && erro.codigo === 'SOLICITACAO_ALTERADA');
      assert.equal(auditorias.length, 0);
    });
  });
});

describe('cancelarSolicitacao — anti-enumeração e auditoria, com os repositórios simulados (fechamento 12E+12F)', () => {
  const solicitacaoRepo = () => require('../../src/repositories/solicitacao-epi.repository');
  const itemRepo = () => require('../../src/repositories/solicitacao-epi-item.repository');
  const usuarioRepo = () => require('../../src/repositories/usuario.repository');
  const auditoriaRepo = () => require('../../src/repositories/auditoria.repository');

  const CRIADA = new Date('2026-10-02T12:00:00Z');
  const JUSTIFICATIVA = 'Pedido feito em duplicidade';
  const cabecalho = (extra = {}) => ({
    id: 17, empresaId: 42, numero: 5, funcionarioId: 30, gheId: 9, origemSolicitacao: 'USUARIO_INTERNO', solicitanteUsuarioId: 7, status: 'PENDENTE',
    quantidadeItens: 1, observacao: null, chaveIdempotencia: CHAVE, requisicaoHash: 'a'.repeat(64), criadaEm: CRIADA, decididaPor: null, decididaEm: null,
    canceladaPor: null, canceladaEm: null, justificativaCancelamento: null, entregueEm: null, encerradaPor: null, encerradaEm: null, justificativaEncerramento: null, ...extra,
  });
  const dadosDeCancelamento = (extra = {}) => ({
    empresaId: 42, atorId: 7, solicitacaoId: 17, justificativa: JUSTIFICATIVA, hoje: '2026-10-03', ...extra,
  });

  function simular(t, { solicitacao = cabecalho(), ativo = true } = {}) {
    const ordem = [];
    const client = { query: async (texto) => { ordem.push(texto); return { rows: [] }; }, release: () => {} };
    const pool = { connect: async () => client };
    const anotar = (nome, fn) => async (...args) => { ordem.push(nome); return fn(...args); };
    t.mock.method(solicitacaoRepo(), 'travarPorId', anotar('travarPorId', async () => solicitacao));
    t.mock.method(usuarioRepo(), 'buscarPorId', anotar('ator', async (_c, empresaId, id) => ({ id, empresaId, perfil: 'USUARIO', ativo })));
    t.mock.method(solicitacaoRepo(), 'cancelar', anotar('cancelar', async () => cabecalho({
      status: 'CANCELADA', canceladaPor: 7, canceladaEm: new Date('2026-10-03T12:00:00Z'), justificativaCancelamento: JUSTIFICATIVA,
    })));
    t.mock.method(itemRepo(), 'listarPorSolicitacaoComEntregue', anotar('itens', async () => []));
    const auditorias = [];
    t.mock.method(auditoriaRepo(), 'registrar', anotar('auditoria', async (_c, registro) => { auditorias.push(registro); }));
    return { pool, ordem, auditorias };
  }

  const recusa = async (promessa) => {
    try {
      await promessa;
    } catch (erro) {
      return { status: erro.status, corpo: erro.corpoResposta() };
    }
    return assert.fail('o cancelamento deveria ter sido recusado');
  };
  const NAO_ENCONTRADA = { status: 404, corpo: { status: 'error', codigo: 'SOLICITACAO_NAO_ENCONTRADA', message: 'Solicitação não encontrada' } };

  test('a solicitação de outro solicitante interno é "não encontrada": a mesma resposta da inexistente; nada mais é lido nem gravado', async (t) => {
    const inexistente = simular(t, { solicitacao: null });
    assert.deepEqual(await recusa(servico().cancelarSolicitacao(inexistente.pool, dadosDeCancelamento())), NAO_ENCONTRADA);
    t.mock.restoreAll();
    const deOutro = simular(t, { solicitacao: cabecalho({ solicitanteUsuarioId: 99 }) });
    assert.deepEqual(await recusa(servico().cancelarSolicitacao(deOutro.pool, dadosDeCancelamento())), NAO_ENCONTRADA);
    assert.deepEqual(deOutro.ordem.filter((x) => !/^(BEGIN|ROLLBACK)/.test(x)), ['travarPorId']);
    assert.equal(deOutro.auditorias.length, 0);
  });

  test('a de autoatendimento (sem solicitante interno) também é "não encontrada" para o usuário interno', async (t) => {
    const { pool, ordem } = simular(t, { solicitacao: cabecalho({ origemSolicitacao: 'AUTOATENDIMENTO', solicitanteUsuarioId: null }) });
    assert.deepEqual(await recusa(servico().cancelarSolicitacao(pool, dadosDeCancelamento())), NAO_ENCONTRADA);
    assert.equal(ordem.includes('cancelar'), false);
  });

  test('a própria, fora de PENDENTE, continua 409 SOLICITACAO_NAO_PENDENTE; a própria com o solicitante inativo continua 403 USUARIO_INATIVO', async (t) => {
    const aprovada = simular(t, { solicitacao: cabecalho({ status: 'APROVADA' }) });
    assert.deepEqual(await recusa(servico().cancelarSolicitacao(aprovada.pool, dadosDeCancelamento())), {
      status: 409, corpo: { status: 'error', codigo: 'SOLICITACAO_NAO_PENDENTE', message: 'A solicitação já foi decidida ou cancelada' },
    });
    t.mock.restoreAll();
    const inativo = simular(t, { ativo: false });
    assert.equal((await recusa(servico().cancelarSolicitacao(inativo.pool, dadosDeCancelamento()))).corpo.codigo, 'USUARIO_INATIVO');
    assert.equal(inativo.ordem.includes('cancelar'), false);
  });

  test('auditoria SOLICITACAO_EPI_CANCELADA: ids, estado anterior e novo e se houve justificativa; o texto da justificativa não vai para a auditoria (nem descrição, nem contexto, nem dados)', async (t) => {
    const { pool, auditorias } = simular(t);
    await servico().cancelarSolicitacao(pool, dadosDeCancelamento({ ip: '203.0.113.10', dispositivo: 'Navegador de teste' }));
    assert.equal(auditorias.length, 1);
    const [registro] = auditorias;
    assert.deepEqual([registro.acao, registro.empresaId, registro.usuarioId, registro.referencia], ['SOLICITACAO_EPI_CANCELADA', 42, 7, '17']);
    assert.equal(registro.descricao ?? null, null);
    assert.deepEqual(registro.contexto, { solicitacaoId: 17, numero: 5, funcionarioId: 30, comJustificativa: true });
    assert.deepEqual([registro.dadosAnteriores, registro.dadosNovos], [{ status: 'PENDENTE' }, { status: 'CANCELADA' }]);
    assert.equal(JSON.stringify(registro).includes(JUSTIFICATIVA), false, 'o texto livre não vai para a auditoria');
    assert.deepEqual(solicitacaoRepo().cancelar.mock.calls[0].arguments.slice(1), [42, 17, { canceladaPor: 7, justificativa: JUSTIFICATIVA }], 'o texto fica na solicitação');
  });

  test('sem justificativa, a auditoria registra comJustificativa falso', async (t) => {
    const { pool, auditorias } = simular(t);
    await servico().cancelarSolicitacao(pool, dadosDeCancelamento({ justificativa: null }));
    assert.equal(auditorias[0].contexto.comJustificativa, false);
    assert.equal(auditorias[0].descricao ?? null, null);
  });
});
