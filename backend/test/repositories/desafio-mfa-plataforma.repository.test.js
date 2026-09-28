'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const repo = require('../../src/repositories/desafio-mfa-plataforma.repository');

/**
 * Contrato do repositório de desafios pré-MFA (migration 052). Só
 * primitivas: o limite de desafios abertos, a ordem das travas e as
 * transições são do serviço. Validade (aberto, no prazo, administrador
 * ativo) fica toda na consulta; encerrar é sempre condicional.
 */

const ADMIN = 7;
const DESAFIO = '300';
const FATOR = '41';
const SESSAO = '777';
const HASH = 'b'.repeat(64);

const executorFalso = (linhas = [], rowCount) => {
  const chamadas = [];
  return {
    chamadas,
    query: async (texto, valores) => {
      chamadas.push({ texto, valores });
      return { rows: linhas, rowCount: rowCount ?? linhas.length };
    },
  };
};

const linhaDesafio = (extra = {}) => ({
  id: DESAFIO,
  administrador_id: ADMIN,
  tipo: 'VERIFICACAO',
  fator_pendente_id: null,
  sessao_origem_id: null,
  sessao_criada_id: null,
  desafio_anterior_id: null,
  criado_em: new Date('2026-09-28T10:00:00Z'),
  expira_em: new Date('2026-09-28T10:05:00Z'),
  falhas: 0,
  reinicios: 0,
  encerrado_em: null,
  motivo_encerramento: null,
  vigente: true,
  ...extra,
});

describe('criar', () => {
  test('grava só o hash do token, com criação e prazo tirados do mesmo instante do banco', async () => {
    const criadoEm = new Date('2026-09-28T10:00:00Z');
    const expiraEm = new Date('2026-09-28T10:05:00Z');
    const executor = executorFalso([{ id: DESAFIO, criado_em: criadoEm, expira_em: expiraEm }]);

    const desafio = await repo.criar(executor, { administradorId: ADMIN, tokenHash: HASH, tipo: 'VERIFICACAO', validadeMinutos: 5 });

    assert.deepEqual(desafio, { id: DESAFIO, criadoEm, expiraEm });
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /insert\s+into\s+desafios_mfa_plataforma/i);
    assert.match(texto, /clock_timestamp\(\)/i);
    assert.deepEqual(valores, [ADMIN, HASH, 'VERIFICACAO', null, null, null, 5]);
    assert.equal(texto.includes(HASH), false);
    assert.doesNotMatch(texto, /\bip\b|dispositivo|user.agent/i, 'desafio não guarda IP nem User-Agent');
  });

  test('CADASTRO, RECUPERACAO e SUBSTITUICAO levam o fator pendente; SUBSTITUICAO leva também a sessão de origem', async () => {
    const executor = executorFalso([{ id: DESAFIO, criado_em: new Date(), expira_em: new Date() }]);
    const base = { administradorId: ADMIN, tokenHash: HASH, validadeMinutos: 15 };

    await repo.criar(executor, { ...base, tipo: 'CADASTRO', fatorPendenteId: FATOR, desafioAnteriorId: '299' });
    await repo.criar(executor, { ...base, tipo: 'RECUPERACAO', fatorPendenteId: FATOR });
    await repo.criar(executor, { ...base, tipo: 'SUBSTITUICAO', fatorPendenteId: FATOR, sessaoOrigemId: SESSAO });

    assert.deepEqual(executor.chamadas.map((c) => c.valores), [
      [ADMIN, HASH, 'CADASTRO', FATOR, null, '299', 15],
      [ADMIN, HASH, 'RECUPERACAO', FATOR, null, null, 15],
      [ADMIN, HASH, 'SUBSTITUICAO', FATOR, SESSAO, null, 15],
    ]);
  });

  test('recusa combinação incoerente de tipo, fator e sessão antes de consultar', async () => {
    const executor = executorFalso([]);
    const base = { administradorId: ADMIN, tokenHash: HASH, validadeMinutos: 5 };
    const invalidos = [
      { tipo: 'OUTRO' },
      { tipo: 'verificacao' },
      { tipo: 'CADASTRO' },
      { tipo: 'VERIFICACAO', fatorPendenteId: FATOR },
      { tipo: 'LIBERACAO', sessaoOrigemId: SESSAO },
      { tipo: 'SUBSTITUICAO', fatorPendenteId: FATOR },
      { tipo: 'CADASTRO', fatorPendenteId: FATOR, sessaoOrigemId: SESSAO },
      { tipo: 'VERIFICACAO', tokenHash: 'curto' },
      { tipo: 'VERIFICACAO', tokenHash: HASH.toUpperCase() },
      { tipo: 'VERIFICACAO', validadeMinutos: 0 },
      { tipo: 'VERIFICACAO', desafioAnteriorId: 299 },
    ];
    for (const extra of invalidos) {
      await assert.rejects(() => repo.criar(executor, { ...base, ...extra }), TypeError, JSON.stringify(extra));
    }
    assert.equal(executor.chamadas.length, 0);
  });
});

describe('buscas', () => {
  test('buscarPorHash devolve o desafio em qualquer situação, com a vigência calculada no banco', async () => {
    const executor = executorFalso([linhaDesafio({ vigente: false, encerrado_em: new Date(), motivo_encerramento: 'LOGOUT' })]);

    const desafio = await repo.buscarPorHash(executor, HASH);

    assert.equal(desafio.vigente, false);
    assert.equal(desafio.motivoEncerramento, 'LOGOUT');
    const { texto, valores } = executor.chamadas[0];
    assert.deepEqual(valores, [HASH]);
    assert.match(texto, /token_hash\s*=\s*\$1/i);
    assert.match(texto, /expira_em\s*>\s*clock_timestamp\(\)/i);
    assert.equal(JSON.stringify(desafio).includes(HASH), false, 'o hash não volta para quem chama');
  });

  test('buscarValidoPorHash: aberto, no prazo e de administrador ativo, tudo na consulta; trava só o desafio', async () => {
    const executor = executorFalso([linhaDesafio()]);

    const desafio = await repo.buscarValidoPorHash(executor, HASH);
    await repo.buscarValidoPorHash(executor, HASH, { travar: true });

    assert.deepEqual(desafio, {
      id: DESAFIO,
      administradorId: ADMIN,
      tipo: 'VERIFICACAO',
      fatorPendenteId: null,
      sessaoOrigemId: null,
      sessaoCriadaId: null,
      desafioAnteriorId: null,
      criadoEm: new Date('2026-09-28T10:00:00Z'),
      expiraEm: new Date('2026-09-28T10:05:00Z'),
      falhas: 0,
      reinicios: 0,
      encerradoEm: null,
      motivoEncerramento: null,
      vigente: true,
    });
    const { texto } = executor.chamadas[0];
    assert.match(texto, /encerrado_em\s+is\s+null/i);
    assert.match(texto, /expira_em\s*>\s*clock_timestamp\(\)/i);
    assert.match(texto, /a\.ativo/i);
    assert.doesNotMatch(texto, /for\s+update/i);
    assert.match(executor.chamadas[1].texto, /for\s+update\s+of\s+d\b/i);
  });

  test('listarAbertos: do administrador, sem encerramento, do mais antigo para o mais novo', async () => {
    const executor = executorFalso([linhaDesafio(), linhaDesafio({ id: '301' })]);

    const abertos = await repo.listarAbertos(executor, ADMIN, { travar: true });

    assert.deepEqual(abertos.map((d) => d.id), [DESAFIO, '301']);
    const { texto, valores } = executor.chamadas[0];
    assert.deepEqual(valores, [ADMIN]);
    assert.match(texto, /encerrado_em\s+is\s+null/i);
    assert.match(texto, /order\s+by\s+(d\.)?criado_em\s*,\s*(d\.)?id/i);
    assert.match(texto, /for\s+update/i);
  });

  test('nada encontrado devolve null; hash inválido é recusado antes de consultar', async () => {
    assert.equal(await repo.buscarPorHash(executorFalso([]), HASH), null);
    assert.equal(await repo.buscarValidoPorHash(executorFalso([]), HASH), null);
    const executor = executorFalso([]);
    await assert.rejects(() => repo.buscarValidoPorHash(executor, 'x'.repeat(64)), TypeError);
    assert.equal(executor.chamadas.length, 0);
  });
});

describe('falhas e encerramento', () => {
  test('incrementarFalhas só conta em desafio aberto e devolve o novo total', async () => {
    const executor = executorFalso([{ falhas: 3 }], 1);

    assert.equal(await repo.incrementarFalhas(executor, DESAFIO), 3);

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /falhas\s*=\s*falhas\s*\+\s*1/i);
    assert.match(texto, /encerrado_em\s+is\s+null/i);
    assert.deepEqual(valores, [DESAFIO]);
    assert.equal(await repo.incrementarFalhas(executorFalso([], 0), DESAFIO), null);
  });

  test('encerrar é condicional (só o que está aberto) e registra o motivo', async () => {
    const executor = executorFalso([], 1);

    assert.equal(await repo.encerrar(executor, { desafioId: DESAFIO, motivo: 'CONCLUIDO' }), true);

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /encerrado_em\s*=\s*clock_timestamp\(\)/i);
    assert.match(texto, /motivo_encerramento\s*=\s*\$2/i);
    assert.match(texto, /encerrado_em\s+is\s+null/i);
    assert.deepEqual(valores, [DESAFIO, 'CONCLUIDO']);
    assert.equal(await repo.encerrar(executorFalso([], 0), { desafioId: DESAFIO, motivo: 'CONCLUIDO' }), false);
  });

  test('encerrarExpirados fecha só os vencidos do administrador, com motivo EXPIRADO', async () => {
    const executor = executorFalso([], 2);

    assert.equal(await repo.encerrarExpirados(executor, ADMIN), 2);

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /'EXPIRADO'/);
    assert.match(texto, /expira_em\s*<=\s*clock_timestamp\(\)/i);
    assert.match(texto, /encerrado_em\s+is\s+null/i);
    assert.deepEqual(valores, [ADMIN]);
  });

  test('encerrarMaisAntigos mantém abertos só os N mais novos; o N é de quem chama', async () => {
    const executor = executorFalso([], 2);

    assert.equal(await repo.encerrarMaisAntigos(executor, { administradorId: ADMIN, manterAbertos: 4, motivo: 'LIMITE_DESAFIOS' }), 2);

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /order\s+by\s+criado_em\s+desc\s*,\s*id\s+desc/i);
    assert.match(texto, /offset\s+\$2/i);
    assert.deepEqual(valores, [ADMIN, 4, 'LIMITE_DESAFIOS']);
    for (const manterAbertos of [-1, 1.5, '4', 101]) {
      await assert.rejects(() => repo.encerrarMaisAntigos(executor, { administradorId: ADMIN, manterAbertos, motivo: 'LIMITE_DESAFIOS' }), TypeError);
    }
  });

  test('encerrarAbertos fecha todos os abertos do administrador, com exceção opcional', async () => {
    const executor = executorFalso([], 3);

    assert.equal(await repo.encerrarAbertos(executor, { administradorId: ADMIN, motivo: 'RESET_OPERACIONAL' }), 3);
    await repo.encerrarAbertos(executor, { administradorId: ADMIN, motivo: 'CONCLUIDO', exceto: DESAFIO });

    assert.deepEqual(executor.chamadas[0].valores, [ADMIN, 'RESET_OPERACIONAL', null]);
    assert.deepEqual(executor.chamadas[1].valores, [ADMIN, 'CONCLUIDO', DESAFIO]);
    assert.match(executor.chamadas[0].texto, /id\s*<>\s*\$3/i);
  });

  test('ligarSessaoCriada só num desafio CONCLUIDO que ainda não tem sessão', async () => {
    const executor = executorFalso([], 1);

    assert.equal(await repo.ligarSessaoCriada(executor, { desafioId: DESAFIO, sessaoId: SESSAO }), true);

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /sessao_criada_id\s*=\s*\$2/i);
    assert.match(texto, /sessao_criada_id\s+is\s+null/i);
    assert.match(texto, /motivo_encerramento\s*=\s*'CONCLUIDO'/i);
    assert.deepEqual(valores, [DESAFIO, SESSAO]);
  });

  test('identificadores e motivos inválidos são recusados antes de consultar', async () => {
    const executor = executorFalso([], 1);
    await assert.rejects(() => repo.incrementarFalhas(executor, 300), TypeError);
    await assert.rejects(() => repo.encerrar(executor, { desafioId: DESAFIO, motivo: 'concluido' }), TypeError);
    await assert.rejects(() => repo.encerrarAbertos(executor, { administradorId: ADMIN, motivo: 'X', exceto: 5 }), TypeError);
    await assert.rejects(() => repo.ligarSessaoCriada(executor, { desafioId: DESAFIO, sessaoId: '0' }), TypeError);
    assert.equal(executor.chamadas.length, 0);
  });
});

// Primitivas usadas pelas etapas do cadastro (MFA-4).
describe('buscarValidoPorId e trocarFatorPendente', () => {
  test('buscarValidoPorId: o desafio deste administrador, aberto, no prazo e de administrador ativo; trava só o desafio', async () => {
    const executor = executorFalso([linhaDesafio({ tipo: 'CADASTRO', fator_pendente_id: FATOR })]);

    const desafio = await repo.buscarValidoPorId(executor, { desafioId: DESAFIO, administradorId: ADMIN }, { travar: true });

    assert.deepEqual([desafio.id, desafio.tipo, desafio.fatorPendenteId], [DESAFIO, 'CADASTRO', FATOR]);
    const { texto, valores } = executor.chamadas[0];
    assert.deepEqual(valores, [DESAFIO, ADMIN]);
    assert.match(texto, /d\.id\s*=\s*\$1/i);
    assert.match(texto, /d\.administrador_id\s*=\s*\$2/i);
    assert.match(texto, /encerrado_em\s+is\s+null/i);
    assert.match(texto, /expira_em\s*>\s*clock_timestamp\(\)/i);
    assert.match(texto, /a\.ativo/i);
    assert.match(texto, /for\s+update\s+of\s+d\b/i);
    assert.equal(await repo.buscarValidoPorId(executorFalso([]), { desafioId: DESAFIO, administradorId: ADMIN }), null);
  });

  test('trocarFatorPendente: condicional ao desafio aberto e ao limite de reinícios; conta o reinício', async () => {
    const executor = executorFalso([], 1);

    assert.equal(await repo.trocarFatorPendente(executor, { desafioId: DESAFIO, fatorPendenteId: '42', maximoReinicios: 3 }), true);

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /fator_pendente_id\s*=\s*\$2/i);
    assert.match(texto, /reinicios\s*=\s*reinicios\s*\+\s*1/i);
    assert.match(texto, /reinicios\s*<\s*\$3/i);
    assert.match(texto, /encerrado_em\s+is\s+null/i);
    assert.deepEqual(valores, [DESAFIO, '42', 3]);
    assert.equal(await repo.trocarFatorPendente(executorFalso([], 0), { desafioId: DESAFIO, fatorPendenteId: '42', maximoReinicios: 3 }), false);
  });

  test('entrada inválida recusada antes de consultar', async () => {
    const executor = executorFalso([], 1);
    await assert.rejects(() => repo.buscarValidoPorId(executor, { desafioId: 300, administradorId: ADMIN }), TypeError);
    await assert.rejects(() => repo.buscarValidoPorId(executor, { desafioId: DESAFIO, administradorId: 0 }), TypeError);
    await assert.rejects(() => repo.trocarFatorPendente(executor, { desafioId: DESAFIO, fatorPendenteId: 42, maximoReinicios: 3 }), TypeError);
    await assert.rejects(() => repo.trocarFatorPendente(executor, { desafioId: DESAFIO, fatorPendenteId: '42', maximoReinicios: 0 }), TypeError);
    assert.equal(executor.chamadas.length, 0);
  });
});
