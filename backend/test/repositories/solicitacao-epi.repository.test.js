'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * Contrato do repositório do cabeçalho da solicitação de EPI. Os triggers, as
 * transições, as travas e a concorrência são provados com PostgreSQL real na
 * integração; aqui confiro isolamento, SQL, parâmetros, validação e
 * mapeamento. O repositório não decide regra de negócio: o resultado da
 * decisão e quem pode decidir são do serviço.
 */

const repo = () => exigirModulo('src/repositories/solicitacao-epi.repository');

const EMPRESA = 4242;
const ID = 17;
const USUARIO = 11;
const CHAVE = '3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c';
const HASH = 'a'.repeat(64);
const CRIADA_EM = new Date('2026-10-02T15:00:00Z');
const ASTRAL = '\u{1D400}';

const executorFalso = (...respostas) => {
  const chamadas = [];
  return {
    chamadas,
    query: async (texto, valores) => {
      chamadas.push({ texto, valores });
      return { rows: respostas.length > 0 ? respostas.shift() : [] };
    },
  };
};

const linha = (extra = {}) => ({
  id: ID, empresa_id: EMPRESA, numero: 5, funcionario_id: 30, ghe_id: 9, origem_solicitacao: 'USUARIO_INTERNO', solicitante_usuario_id: USUARIO,
  status: 'PENDENTE', quantidade_itens: 2, observacao: null, chave_idempotencia: CHAVE, requisicao_hash: HASH, criada_em: CRIADA_EM,
  decidida_por: null, decidida_em: null, cancelada_por: null, cancelada_em: null, justificativa_cancelamento: null, entregue_em: null,
  encerrada_por: null, encerrada_em: null, justificativa_encerramento: null, ...extra,
});
const publica = (extra = {}) => ({
  id: ID, empresaId: EMPRESA, numero: 5, funcionarioId: 30, gheId: 9, origemSolicitacao: 'USUARIO_INTERNO', solicitanteUsuarioId: USUARIO,
  status: 'PENDENTE', quantidadeItens: 2, observacao: null, chaveIdempotencia: CHAVE, requisicaoHash: HASH, criadaEm: CRIADA_EM,
  decididaPor: null, decididaEm: null, canceladaPor: null, canceladaEm: null, justificativaCancelamento: null, entregueEm: null,
  encerradaPor: null, encerradaEm: null, justificativaEncerramento: null, ...extra,
});

const novo = (extra = {}) => ({
  empresaId: EMPRESA, numero: 5, funcionarioId: 30, gheId: 9, origemSolicitacao: 'USUARIO_INTERNO', solicitanteUsuarioId: USUARIO,
  quantidadeItens: 2, observacao: null, chave: CHAVE, requisicaoHash: HASH, ...extra,
});

describe('travarChave', () => {
  test('advisory lock de transação de 64 bits, no espaço das solicitações: diferente do da entrega e do estoque para a mesma chave', async () => {
    const lockDe = async (empresaId, chave) => {
      const executor = executorFalso();
      await repo().travarChave(executor, empresaId, chave);
      const { texto, valores } = executor.chamadas[0];
      assert.match(texto, /^SELECT pg_advisory_xact_lock\(\$1::bigint\)$/);
      assert.equal(valores.length, 1);
      assert.ok(BigInt(valores[0]) >= -(2n ** 63n) && BigInt(valores[0]) < 2n ** 63n);
      return valores[0];
    };
    const { lockDaChave, ESPACO_ESTOQUE, ESPACO_ENTREGAS } = require('../../src/utils/idempotencia');
    const lock = await lockDe(EMPRESA, CHAVE);
    assert.equal(lock, await lockDe(EMPRESA, CHAVE));
    assert.notEqual(lock, await lockDe(EMPRESA + 1, CHAVE));
    assert.notEqual(lock, await lockDe(EMPRESA, '3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9d'));
    assert.notEqual(lock, lockDaChave(ESPACO_ENTREGAS, EMPRESA, CHAVE));
    assert.notEqual(lock, lockDaChave(ESPACO_ESTOQUE, EMPRESA, CHAVE));
  });

  test('recusa empresa ou chave inválidas sem consultar', async () => {
    const executor = executorFalso();
    await assert.rejects(() => repo().travarChave(executor, 0, CHAVE), /empresa/);
    await assert.rejects(() => repo().travarChave(executor, EMPRESA, CHAVE.toUpperCase()), /chave/);
    await assert.rejects(() => repo().travarChave(executor, EMPRESA, 'abc'), /chave/);
    assert.equal(executor.chamadas.length, 0);
  });
});

describe('buscarPorChave, buscarPorId e travarPorId', () => {
  test('buscarPorChave procura só na empresa e devolve a solicitação com o hash para comparação; null quando não existe', async () => {
    const executor = executorFalso([linha()], []);
    assert.deepEqual(await repo().buscarPorChave(executor, EMPRESA, CHAVE), publica());
    assert.equal(await repo().buscarPorChave(executor, EMPRESA, CHAVE), null);
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /FROM solicitacoes_epi\s+WHERE empresa_id = \$1 AND chave_idempotencia = \$2/);
    assert.deepEqual(valores, [EMPRESA, CHAVE]);
  });

  test('buscarPorId procura pelo par (empresa, id); a mesma consulta nunca depende só do id', async () => {
    const executor = executorFalso([linha()], []);
    assert.deepEqual(await repo().buscarPorId(executor, EMPRESA, ID), publica());
    assert.equal(await repo().buscarPorId(executor, EMPRESA, ID), null);
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /WHERE empresa_id = \$1 AND id = \$2/);
    assert.doesNotMatch(texto, /FOR (NO KEY )?UPDATE/);
    assert.deepEqual(valores, [EMPRESA, ID]);
  });

  test('travarPorId trava a linha com FOR NO KEY UPDATE (serializa decisão e cancelamento sem bloquear as FKs filhas)', async () => {
    const executor = executorFalso([linha()], []);
    assert.deepEqual(await repo().travarPorId(executor, EMPRESA, ID), publica());
    assert.equal(await repo().travarPorId(executor, EMPRESA, ID), null);
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /WHERE empresa_id = \$1 AND id = \$2\s+FOR NO KEY UPDATE$/);
    assert.deepEqual(valores, [EMPRESA, ID]);
  });

  test('mapeia decisão, cancelamento e entrega quando existem', async () => {
    const decidida = new Date('2026-10-02T16:00:00Z');
    const executor = executorFalso([linha({ status: 'APROVADA', decidida_por: 12, decidida_em: decidida })]);
    assert.deepEqual(await repo().buscarPorId(executor, EMPRESA, ID), publica({ status: 'APROVADA', decididaPor: 12, decididaEm: decidida }));
  });

  test('lê e mapeia o encerramento: quem, quando e a justificativa (12E-2)', async () => {
    const encerradaEm = new Date('2026-10-03T18:00:00Z');
    const executor = executorFalso([linha({ status: 'ENCERRADA', encerrada_por: 13, encerrada_em: encerradaEm, justificativa_encerramento: 'Transferido' })]);
    const lida = await repo().buscarPorId(executor, EMPRESA, ID);
    assert.deepEqual([lida.encerradaPor, lida.encerradaEm, lida.justificativaEncerramento], [13, encerradaEm, 'Transferido']);
    assert.match(executor.chamadas[0].texto, /encerrada_por, encerrada_em, justificativa_encerramento/);
  });

  test('recusa identificadores inválidos sem consultar', async () => {
    const executor = executorFalso();
    for (const invalido of [0, -1, 1.5, '1', null, undefined]) {
      await assert.rejects(() => repo().buscarPorId(executor, invalido, ID), /empresa/, `empresa ${invalido}`);
      await assert.rejects(() => repo().buscarPorId(executor, EMPRESA, invalido), /solicitação/, `id ${invalido}`);
      await assert.rejects(() => repo().travarPorId(executor, EMPRESA, invalido), /solicitação/, `travar ${invalido}`);
      await assert.rejects(() => repo().buscarPorChave(executor, invalido, CHAVE), /empresa/, `chave ${invalido}`);
    }
    assert.equal(executor.chamadas.length, 0);
  });
});

describe('criar', () => {
  test('insere o cabeçalho com SQL parametrizado, sem status (o banco o inicia em PENDENTE), e devolve a solicitação', async () => {
    const executor = executorFalso([linha()]);
    assert.deepEqual(await repo().criar(executor, novo()), publica());
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /^INSERT INTO solicitacoes_epi\b/);
    assert.match(texto, /RETURNING /);
    assert.doesNotMatch(texto.split('VALUES')[0], /status|decidida|cancelada|entregue_em/, 'o INSERT não escolhe estado nem preenche decisão');
    assert.deepEqual(valores, [EMPRESA, 5, 30, 9, 'USUARIO_INTERNO', USUARIO, 2, null, CHAVE, HASH]);
    for (const marcador of ['$1', '$2', '$3', '$4', '$5', '$6', '$7', '$8', '$9', '$10']) assert.ok(texto.includes(marcador), marcador);
  });

  test('USUARIO_INTERNO exige o solicitante; AUTOATENDIMENTO não aceita solicitante interno', async () => {
    const executor = executorFalso([linha({ origem_solicitacao: 'AUTOATENDIMENTO', solicitante_usuario_id: null })]);
    const automatica = await repo().criar(executor, novo({ origemSolicitacao: 'AUTOATENDIMENTO', solicitanteUsuarioId: null }));
    assert.equal(automatica.origemSolicitacao, 'AUTOATENDIMENTO');
    assert.equal(automatica.solicitanteUsuarioId, null);
    assert.deepEqual(executor.chamadas[0].valores.slice(4, 6), ['AUTOATENDIMENTO', null]);
    const recusadas = [
      novo({ solicitanteUsuarioId: null }),
      novo({ origemSolicitacao: 'AUTOATENDIMENTO', solicitanteUsuarioId: USUARIO }),
      novo({ origemSolicitacao: 'TOTEM', solicitanteUsuarioId: null }),
      novo({ origemSolicitacao: undefined }),
    ];
    const vazio = executorFalso();
    for (const dados of recusadas) await assert.rejects(() => repo().criar(vazio, dados), /origem|solicitante/, JSON.stringify(dados));
    assert.equal(vazio.chamadas.length, 0);
  });

  test('o GHE é opcional; a observação é opcional e conta caracteres, não unidades UTF-16', async () => {
    const executor = executorFalso([linha()], [linha()], [linha()]);
    await repo().criar(executor, novo({ gheId: null }));
    assert.equal(executor.chamadas[0].valores[3], null);
    const quinhentos = ASTRAL.repeat(500);
    assert.equal(quinhentos.length, 1000);
    await repo().criar(executor, novo({ observacao: quinhentos }));
    assert.equal(executor.chamadas[1].valores[7], quinhentos);
    await repo().criar(executor, novo({ observacao: 'x' }));
    const vazio = executorFalso();
    for (const observacao of ['', ASTRAL.repeat(501), 'x'.repeat(501), 42]) {
      await assert.rejects(() => repo().criar(vazio, novo({ observacao })), /observação/, String(observacao).slice(0, 10));
    }
    assert.equal(vazio.chamadas.length, 0);
  });

  test('recusa identificadores, número, quantidade de itens, chave e hash inválidos sem consultar', async () => {
    const vazio = executorFalso();
    const invalidos = [
      [{ empresaId: 0 }, /empresa/],
      [{ numero: 0 }, /número/],
      [{ numero: 1.5 }, /número/],
      [{ funcionarioId: -1 }, /funcionário/],
      [{ gheId: 0 }, /GHE/],
      [{ gheId: '9' }, /GHE/],
      [{ quantidadeItens: 0 }, /itens/],
      [{ quantidadeItens: '2' }, /itens/],
      [{ chave: CHAVE.toUpperCase() }, /chave/],
      [{ chave: 'abc' }, /chave/],
      [{ requisicaoHash: 'A'.repeat(64) }, /hash/],
      [{ requisicaoHash: 'ab' }, /hash/],
    ];
    for (const [extra, mensagem] of invalidos) {
      await assert.rejects(() => repo().criar(vazio, novo(extra)), mensagem, JSON.stringify(extra));
    }
    assert.equal(vazio.chamadas.length, 0);
  });
});

describe('registrarDecisao', () => {
  test('atualiza só uma solicitação PENDENTE da empresa, grava quem decidiu e a hora do relógio do banco, e devolve a linha', async () => {
    const executor = executorFalso([linha({ status: 'APROVADA', decidida_por: 12, decidida_em: CRIADA_EM })]);
    const decidida = await repo().registrarDecisao(executor, EMPRESA, ID, { status: 'APROVADA', decididaPor: 12 });
    assert.equal(decidida.status, 'APROVADA');
    assert.equal(decidida.decididaPor, 12);
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /^UPDATE solicitacoes_epi\s+SET status = \$3, decidida_por = \$4, decidida_em = clock_timestamp\(\)/);
    assert.match(texto, /WHERE empresa_id = \$1 AND id = \$2 AND status = 'PENDENTE'/);
    assert.match(texto, /RETURNING /);
    assert.deepEqual(valores, [EMPRESA, ID, 'APROVADA', 12]);
  });

  test('devolve null quando a solicitação não está PENDENTE ou não é da empresa (nenhuma linha atualizada)', async () => {
    const executor = executorFalso([]);
    assert.equal(await repo().registrarDecisao(executor, EMPRESA, ID, { status: 'REPROVADA', decididaPor: 12 }), null);
  });

  test('aceita só os três resultados de decisão; o repositório não calcula o resultado', async () => {
    const executor = executorFalso([linha()], [linha()], [linha()]);
    for (const status of ['APROVADA', 'APROVADA_PARCIAL', 'REPROVADA']) {
      await repo().registrarDecisao(executor, EMPRESA, ID, { status, decididaPor: 12 });
    }
    const vazio = executorFalso();
    for (const status of ['PENDENTE', 'CANCELADA', 'ENTREGUE', 'ABERTA', undefined, null]) {
      await assert.rejects(() => repo().registrarDecisao(vazio, EMPRESA, ID, { status, decididaPor: 12 }), /status/, String(status));
    }
    for (const decididaPor of [0, -1, '12', null, undefined, 1.5]) {
      await assert.rejects(() => repo().registrarDecisao(vazio, EMPRESA, ID, { status: 'APROVADA', decididaPor }), /decisor/, String(decididaPor));
    }
    await assert.rejects(() => repo().registrarDecisao(vazio, 0, ID, { status: 'APROVADA', decididaPor: 12 }), /empresa/);
    await assert.rejects(() => repo().registrarDecisao(vazio, EMPRESA, 0, { status: 'APROVADA', decididaPor: 12 }), /solicitação/);
    assert.equal(vazio.chamadas.length, 0);
  });
});

describe('cancelar', () => {
  test('cancela só uma solicitação PENDENTE da empresa, com quem cancelou e a hora do relógio do banco', async () => {
    const executor = executorFalso([linha({ status: 'CANCELADA', cancelada_por: USUARIO, cancelada_em: CRIADA_EM, justificativa_cancelamento: 'Duplicada' })]);
    const cancelada = await repo().cancelar(executor, EMPRESA, ID, { canceladaPor: USUARIO, justificativa: 'Duplicada' });
    assert.deepEqual(
      [cancelada.status, cancelada.canceladaPor, cancelada.justificativaCancelamento],
      ['CANCELADA', USUARIO, 'Duplicada'],
    );
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /^UPDATE solicitacoes_epi\s+SET status = 'CANCELADA', cancelada_por = \$3, cancelada_em = clock_timestamp\(\), justificativa_cancelamento = \$4/);
    assert.match(texto, /WHERE empresa_id = \$1 AND id = \$2 AND status = 'PENDENTE'/);
    assert.deepEqual(valores, [EMPRESA, ID, USUARIO, 'Duplicada']);
  });

  test('a justificativa é opcional (null) e conta caracteres; devolve null quando nada foi atualizado', async () => {
    const executor = executorFalso([linha({ status: 'CANCELADA' })], [], [linha({ status: 'CANCELADA' })]);
    await repo().cancelar(executor, EMPRESA, ID, { canceladaPor: USUARIO });
    assert.equal(executor.chamadas[0].valores[3], null);
    assert.equal(await repo().cancelar(executor, EMPRESA, ID, { canceladaPor: USUARIO }), null);
    await repo().cancelar(executor, EMPRESA, ID, { canceladaPor: USUARIO, justificativa: ASTRAL.repeat(500) });
    const vazio = executorFalso();
    for (const justificativa of ['', ASTRAL.repeat(501), 7]) {
      await assert.rejects(() => repo().cancelar(vazio, EMPRESA, ID, { canceladaPor: USUARIO, justificativa }), /justificativa/, String(justificativa).slice(0, 5));
    }
    for (const canceladaPor of [0, -1, '11', null, undefined]) {
      await assert.rejects(() => repo().cancelar(vazio, EMPRESA, ID, { canceladaPor }), /cancelamento/, String(canceladaPor));
    }
    assert.equal(vazio.chamadas.length, 0);
  });
});

describe('marcarEntregue', () => {
  test('fecha só uma solicitação APROVADA ou APROVADA_PARCIAL da empresa, com a hora do relógio do banco, e devolve a linha', async () => {
    const executor = executorFalso([linha({ status: 'ENTREGUE', entregue_em: CRIADA_EM })]);
    const fechada = await repo().marcarEntregue(executor, EMPRESA, ID);
    assert.deepEqual(fechada, publica({ status: 'ENTREGUE', entregueEm: CRIADA_EM }));
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /^UPDATE solicitacoes_epi\s+SET status = 'ENTREGUE', entregue_em = clock_timestamp\(\)/);
    assert.match(texto, /WHERE empresa_id = \$1 AND id = \$2 AND status IN \('APROVADA', 'APROVADA_PARCIAL'\)/);
    assert.match(texto, /RETURNING id, empresa_id/);
    assert.deepEqual(valores, [EMPRESA, ID]);
    assert.doesNotMatch(texto, /now\(\)|CURRENT_TIMESTAMP/i, 'o carimbo é do relógio da transação em andamento, como a decisão e o cancelamento');
  });

  test('devolve null quando a solicitação não está aberta para entrega ou não é da empresa (nenhuma linha atualizada)', async () => {
    assert.equal(await repo().marcarEntregue(executorFalso([]), EMPRESA, ID), null);
  });

  test('recusa empresa e solicitação inválidas sem consultar', async () => {
    const vazio = executorFalso();
    await assert.rejects(() => repo().marcarEntregue(vazio, 0, ID), /empresa/);
    await assert.rejects(() => repo().marcarEntregue(vazio, EMPRESA, '17'), /solicitação/);
    assert.equal(vazio.chamadas.length, 0);
  });
});

describe('encerrar (D6, 12E-2)', () => {
  const funcao = () => {
    assert.equal(typeof repo().encerrar, 'function', 'função ainda não implementada: encerrar');
    return repo().encerrar;
  };

  test('encerra só uma solicitação APROVADA ou APROVADA_PARCIAL da empresa, com quem encerrou, a hora do relógio do banco e a justificativa', async () => {
    const encerradaEm = new Date('2026-10-03T18:00:00Z');
    const executor = executorFalso([linha({
      status: 'ENCERRADA', decidida_por: 12, decidida_em: CRIADA_EM, encerrada_por: 13, encerrada_em: encerradaEm, justificativa_encerramento: 'Transferido',
    })]);
    const encerrada = await funcao()(executor, EMPRESA, ID, { encerradaPor: 13, justificativa: 'Transferido' });
    assert.deepEqual(encerrada, publica({
      status: 'ENCERRADA', decididaPor: 12, decididaEm: CRIADA_EM, encerradaPor: 13, encerradaEm: encerradaEm, justificativaEncerramento: 'Transferido',
    }));
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /^UPDATE solicitacoes_epi\s+SET status = 'ENCERRADA', encerrada_por = \$3, encerrada_em = clock_timestamp\(\), justificativa_encerramento = \$4/);
    assert.match(texto, /WHERE empresa_id = \$1 AND id = \$2 AND status IN \('APROVADA', 'APROVADA_PARCIAL'\)/);
    assert.match(texto, /RETURNING id, empresa_id/);
    assert.doesNotMatch(texto, /now\(\)|CURRENT_TIMESTAMP/i);
    assert.deepEqual(valores, [EMPRESA, ID, 13, 'Transferido']);
  });

  test('devolve null quando a solicitação não está aprovada em aberto ou não é da empresa (nenhuma linha atualizada)', async () => {
    assert.equal(await funcao()(executorFalso([]), EMPRESA, ID, { encerradaPor: 13, justificativa: 'Transferido' }), null);
  });

  test('a justificativa é obrigatória e conta caracteres (até 500); identificadores inválidos são recusados sem consultar', async () => {
    const executor = executorFalso([linha({ status: 'ENCERRADA' })]);
    await funcao()(executor, EMPRESA, ID, { encerradaPor: 13, justificativa: ASTRAL.repeat(500) });
    assert.equal(executor.chamadas[0].valores[3], ASTRAL.repeat(500));
    const vazio = executorFalso();
    for (const justificativa of [null, undefined, '', ASTRAL.repeat(501), 'x'.repeat(501), 7]) {
      await assert.rejects(() => funcao()(vazio, EMPRESA, ID, { encerradaPor: 13, justificativa }), /justificativa/, String(justificativa).slice(0, 5));
    }
    for (const encerradaPor of [0, -1, '13', null, undefined, 1.5]) {
      await assert.rejects(() => funcao()(vazio, EMPRESA, ID, { encerradaPor, justificativa: 'Transferido' }), /encerramento/, String(encerradaPor));
    }
    await assert.rejects(() => funcao()(vazio, 0, ID, { encerradaPor: 13, justificativa: 'Transferido' }), /empresa/);
    await assert.rejects(() => funcao()(vazio, EMPRESA, '17', { encerradaPor: 13, justificativa: 'Transferido' }), /solicitação/);
    assert.equal(vazio.chamadas.length, 0);
  });
});

describe('o repositório não escreve em outra tabela nem muda o estoque', () => {
  test('nenhuma função toca estoque, lotes ou fichas; só a tabela solicitacoes_epi', async () => {
    const executor = executorFalso(...Array.from({ length: 10 }, () => [linha()]));
    const r = repo();
    await r.criar(executor, novo());
    await r.registrarDecisao(executor, EMPRESA, ID, { status: 'APROVADA', decididaPor: 12 });
    await r.cancelar(executor, EMPRESA, ID, { canceladaPor: USUARIO });
    await r.marcarEntregue(executor, EMPRESA, ID);
    assert.equal(typeof r.encerrar, 'function', 'função ainda não implementada: encerrar');
    await r.encerrar(executor, EMPRESA, ID, { encerradaPor: 13, justificativa: 'Transferido' });
    await r.buscarPorId(executor, EMPRESA, ID);
    await r.travarPorId(executor, EMPRESA, ID);
    await r.buscarPorChave(executor, EMPRESA, CHAVE);
    for (const { texto } of executor.chamadas) {
      assert.doesNotMatch(texto, /estoque_|fichas_epi|entregas_epi|solicitacoes_epi_itens/);
    }
  });
});
