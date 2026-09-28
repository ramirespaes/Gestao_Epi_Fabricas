'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { assertSemSensiveis } = require('../helpers/sensiveis');

const repo = require('../../src/repositories/fator-mfa-plataforma.repository');

/**
 * Contrato do repositório de fatores MFA (migration 049). Só primitivas de
 * persistência: o fluxo é do serviço. O secret chega sempre cifrado, toda
 * mudança de estado é UPDATE condicional e revogar apaga nonce e
 * ciphertext na mesma instrução.
 */

const ADMIN = 7;
const FATOR = '41';
const UID = '3f2c8a4e-9b1d-4c7a-8e2f-5a6b7c8d9e0f';
const NONCE = Buffer.alloc(12, 0x11);
const CIFRADO = Buffer.alloc(36, 0x22);
const envelope = (extra = {}) => ({ formatoVersao: 1, chaveVersao: 1, nonce: NONCE, segredoCifrado: CIFRADO, ...extra });

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

const linhaFator = (extra = {}) => ({
  id: FATOR,
  fator_uid: UID,
  administrador_id: ADMIN,
  tipo: 'TOTP',
  estado: 'ATIVO',
  totp_formato_versao: 1,
  totp_chave_versao: 1,
  totp_nonce: NONCE,
  totp_segredo_cifrado: CIFRADO,
  totp_ultimo_step_aceito: '59000000',
  criado_em: new Date('2026-09-28T10:00:00Z'),
  pendente_expira_em: new Date('2026-09-28T10:15:00Z'),
  pendente_vigente: false,
  ativado_em: new Date('2026-09-28T10:05:00Z'),
  ...extra,
});

describe('criarPendenteTotp', () => {
  test('grava PENDENTE com o envelope, os parâmetros fixos e o prazo pelo relógio do banco', async () => {
    const criadoEm = new Date('2026-09-28T10:00:00Z');
    const pendenteExpiraEm = new Date('2026-09-28T10:15:00Z');
    const executor = executorFalso([{ id: FATOR, fator_uid: UID, criado_em: criadoEm, pendente_expira_em: pendenteExpiraEm }]);

    const fator = await repo.criarPendenteTotp(executor, { administradorId: ADMIN, fatorUid: UID, envelope: envelope(), validadeMinutos: 15 });

    assert.deepEqual(fator, { id: FATOR, fatorUid: UID, criadoEm, pendenteExpiraEm });
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /insert\s+into\s+fatores_mfa_plataforma/i);
    assert.match(texto, /'PENDENTE'/);
    assert.match(texto, /'TOTP'/);
    assert.match(texto, /'SHA1'/);
    assert.match(texto, /clock_timestamp\(\)/i);
    assert.deepEqual(valores, [ADMIN, UID, 1, 1, NONCE, CIFRADO, 15]);
    assert.equal(texto.includes(UID), false, 'nada é concatenado no SQL');
  });

  test('recusa entrada inválida antes de consultar, sem ecoar valores', async () => {
    const executor = executorFalso([]);
    const base = { administradorId: ADMIN, fatorUid: UID, envelope: envelope(), validadeMinutos: 15 };
    const invalidos = [
      { administradorId: 0 },
      { administradorId: '7' },
      { administradorId: 2147483648 },
      { fatorUid: UID.toUpperCase() },
      { fatorUid: 'nao-e-uuid' },
      { envelope: undefined },
      { envelope: envelope({ nonce: Buffer.alloc(11) }) },
      { envelope: envelope({ segredoCifrado: Buffer.alloc(35) }) },
      { envelope: envelope({ segredoCifrado: CIFRADO.toString('hex') }) },
      { envelope: envelope({ formatoVersao: 0 }) },
      { envelope: envelope({ chaveVersao: 10000 }) },
      { validadeMinutos: 0 },
      { validadeMinutos: 1441 },
      { validadeMinutos: 1.5 },
    ];
    for (const extra of invalidos) {
      await assert.rejects(() => repo.criarPendenteTotp(executor, { ...base, ...extra }), (erro) => {
        assert.ok(erro instanceof TypeError, JSON.stringify(Object.keys(extra)));
        assertSemSensiveis(erro.message, [UID, UID.toUpperCase(), CIFRADO.toString('hex')], 'erro');
        return true;
      });
    }
    assert.equal(executor.chamadas.length, 0);
  });

  test('não existe caminho para gravar o secret em claro', async () => {
    const executor = executorFalso([]);
    await assert.rejects(
      () => repo.criarPendenteTotp(executor, { administradorId: ADMIN, fatorUid: UID, segredo: Buffer.alloc(20), validadeMinutos: 15 }),
      TypeError,
    );
    assert.equal(executor.chamadas.length, 0);
  });
});

describe('buscas', () => {
  test('buscarTotpAtivo filtra tipo e estado e devolve o envelope como Buffer', async () => {
    const executor = executorFalso([linhaFator()]);

    const fator = await repo.buscarTotpAtivo(executor, ADMIN);

    const { texto, valores } = executor.chamadas[0];
    assert.deepEqual(valores, [ADMIN]);
    assert.match(texto, /administrador_id\s*=\s*\$1/i);
    assert.match(texto, /tipo\s*=\s*'TOTP'/i);
    assert.match(texto, /estado\s*=\s*'ATIVO'/i);
    assert.doesNotMatch(texto, /for\s+update/i, 'sem trava quando não pedida');
    assert.deepEqual(fator, {
      id: FATOR,
      fatorUid: UID,
      administradorId: ADMIN,
      tipo: 'TOTP',
      estado: 'ATIVO',
      formatoVersao: 1,
      chaveVersao: 1,
      nonce: NONCE,
      segredoCifrado: CIFRADO,
      ultimoStepAceito: 59000000,
      criadoEm: new Date('2026-09-28T10:00:00Z'),
      pendenteExpiraEm: new Date('2026-09-28T10:15:00Z'),
      pendenteVigente: false,
      ativadoEm: new Date('2026-09-28T10:05:00Z'),
    });
  });

  test('travar: true acrescenta FOR UPDATE', async () => {
    const executor = executorFalso([linhaFator()]);
    await repo.buscarTotpAtivo(executor, ADMIN, { travar: true });
    assert.match(executor.chamadas[0].texto, /for\s+update/i);
  });

  test('buscarTotpPendente devolve também se o prazo ainda vale, pelo relógio do banco', async () => {
    const executor = executorFalso([linhaFator({ estado: 'PENDENTE', ativado_em: null, pendente_vigente: true, totp_ultimo_step_aceito: null })]);

    const fator = await repo.buscarTotpPendente(executor, ADMIN, { travar: true });

    const { texto } = executor.chamadas[0];
    assert.match(texto, /estado\s*=\s*'PENDENTE'/i);
    assert.match(texto, /pendente_expira_em\s*>\s*clock_timestamp\(\)/i);
    assert.match(texto, /for\s+update/i);
    assert.equal(fator.pendenteVigente, true);
    assert.equal(fator.ultimoStepAceito, null);
  });

  test('buscarPorId exige o fator E o administrador', async () => {
    const executor = executorFalso([linhaFator()]);
    await repo.buscarPorId(executor, { administradorId: ADMIN, fatorId: FATOR });
    const { texto, valores } = executor.chamadas[0];
    assert.deepEqual(valores, [FATOR, ADMIN]);
    assert.match(texto, /id\s*=\s*\$1/i);
    assert.match(texto, /administrador_id\s*=\s*\$2/i);
  });

  test('nada encontrado devolve null', async () => {
    assert.equal(await repo.buscarTotpAtivo(executorFalso([]), ADMIN), null);
    assert.equal(await repo.buscarTotpPendente(executorFalso([]), ADMIN), null);
    assert.equal(await repo.buscarPorId(executorFalso([]), { administradorId: ADMIN, fatorId: FATOR }), null);
  });

  test('recusa identificadores e opção de trava inválidos antes de consultar', async () => {
    const executor = executorFalso([]);
    await assert.rejects(() => repo.buscarTotpAtivo(executor, 0), TypeError);
    await assert.rejects(() => repo.buscarTotpAtivo(executor, ADMIN, { travar: 'sim' }), TypeError);
    await assert.rejects(() => repo.buscarPorId(executor, { administradorId: ADMIN, fatorId: 41 }), TypeError);
    await assert.rejects(() => repo.buscarPorId(executor, { administradorId: ADMIN, fatorId: '0' }), TypeError);
    assert.equal(executor.chamadas.length, 0);
  });
});

describe('ativarTotp', () => {
  test('UPDATE condicional: só um PENDENTE deste administrador, dentro do prazo, vira ATIVO com o primeiro step', async () => {
    const executor = executorFalso([], 1);

    assert.equal(await repo.ativarTotp(executor, { administradorId: ADMIN, fatorId: FATOR, step: 59000001 }), true);

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /update\s+fatores_mfa_plataforma/i);
    assert.match(texto, /estado\s*=\s*'ATIVO'/i);
    assert.match(texto, /ativado_em\s*=\s*clock_timestamp\(\)/i);
    assert.match(texto, /totp_ultimo_step_aceito\s*=\s*\$3/i);
    assert.match(texto, /estado\s*=\s*'PENDENTE'/i);
    assert.match(texto, /pendente_expira_em\s*>\s*clock_timestamp\(\)/i);
    assert.deepEqual(valores, [FATOR, ADMIN, 59000001]);
  });

  test('nenhuma linha atingida devolve false', async () => {
    assert.equal(await repo.ativarTotp(executorFalso([], 0), { administradorId: ADMIN, fatorId: FATOR, step: 1 }), false);
  });

  test('step precisa ser inteiro seguro e não negativo', async () => {
    const executor = executorFalso([], 1);
    for (const step of [-1, 1.5, '5', Number.MAX_SAFE_INTEGER + 1, null]) {
      await assert.rejects(() => repo.ativarTotp(executor, { administradorId: ADMIN, fatorId: FATOR, step }), TypeError, String(step));
    }
    assert.equal(executor.chamadas.length, 0);
  });
});

describe('registrarStepAceito (anti-replay)', () => {
  test('só avança para um step maior que o último aceito, em fator ATIVO', async () => {
    const executor = executorFalso([], 1);

    assert.equal(await repo.registrarStepAceito(executor, { administradorId: ADMIN, fatorId: FATOR, step: 59000002 }), true);

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /set\s+totp_ultimo_step_aceito\s*=\s*\$3/i);
    assert.match(texto, /estado\s*=\s*'ATIVO'/i);
    assert.match(texto, /totp_ultimo_step_aceito\s+is\s+null\s+or\s+totp_ultimo_step_aceito\s*<\s*\$3/i);
    assert.deepEqual(valores, [FATOR, ADMIN, 59000002]);
  });

  test('replay (0 linhas) devolve false', async () => {
    assert.equal(await repo.registrarStepAceito(executorFalso([], 0), { administradorId: ADMIN, fatorId: FATOR, step: 5 }), false);
  });
});

describe('revogação', () => {
  test('revogar apaga nonce e ciphertext na mesma instrução e só atinge PENDENTE ou ATIVO', async () => {
    const executor = executorFalso([], 1);

    assert.equal(await repo.revogar(executor, { administradorId: ADMIN, fatorId: FATOR, motivo: 'SUBSTITUIDO' }), true);

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /estado\s*=\s*'REVOGADO'/i);
    assert.match(texto, /revogado_em\s*=\s*clock_timestamp\(\)/i);
    assert.match(texto, /motivo_revogacao\s*=\s*\$3/i);
    assert.match(texto, /totp_nonce\s*=\s*null/i);
    assert.match(texto, /totp_segredo_cifrado\s*=\s*null/i);
    assert.match(texto, /estado\s+in\s*\(\s*'PENDENTE'\s*,\s*'ATIVO'\s*\)/i);
    assert.deepEqual(valores, [FATOR, ADMIN, 'SUBSTITUIDO']);
  });

  test('revogar o que já está revogado devolve false', async () => {
    assert.equal(await repo.revogar(executorFalso([], 0), { administradorId: ADMIN, fatorId: FATOR, motivo: 'SUBSTITUIDO' }), false);
  });

  test('revogarPendenteTotp atinge só o PENDENTE TOTP do administrador e devolve a quantidade', async () => {
    const executor = executorFalso([], 1);

    assert.equal(await repo.revogarPendenteTotp(executor, { administradorId: ADMIN, motivo: 'ABANDONADO' }), 1);

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /administrador_id\s*=\s*\$1/i);
    assert.match(texto, /tipo\s*=\s*'TOTP'/i);
    assert.match(texto, /estado\s*=\s*'PENDENTE'/i);
    assert.match(texto, /totp_segredo_cifrado\s*=\s*null/i);
    assert.deepEqual(valores, [ADMIN, 'ABANDONADO']);
  });

  test('motivo precisa caber no formato da coluna', async () => {
    const executor = executorFalso([], 1);
    for (const motivo of ['substituido', '', 'A'.repeat(31), undefined]) {
      await assert.rejects(() => repo.revogar(executor, { administradorId: ADMIN, fatorId: FATOR, motivo }), TypeError);
      await assert.rejects(() => repo.revogarPendenteTotp(executor, { administradorId: ADMIN, motivo }), TypeError);
    }
    assert.equal(executor.chamadas.length, 0);
  });
});
