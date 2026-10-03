'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');

/** Listagem HTTP dos vínculos SST (12F-1): só paginação, query estrita; a empresa vem da sessão. */

const schema = () => exigirModulo('src/schemas/vinculo-sst.schema');

describe('vinculo-sst.schema — listar.query', () => {
  test('sem nada, página 1 e limite 20; limite de 1 a 100', () => {
    const q = schema().listar.query;
    assert.deepEqual(q.safeParse({}).data, { pagina: 1, limite: 20 });
    assert.deepEqual(q.safeParse({ pagina: '2', limite: '100' }).data, { pagina: 2, limite: 100 });
    for (const bruto of [{ pagina: '0' }, { limite: '0' }, { limite: '101' }, { pagina: 'x' }]) assert.equal(q.safeParse(bruto).success, false, JSON.stringify(bruto));
  });

  test('recusa empresa, usuário e qualquer campo desconhecido', () => {
    const q = schema().listar.query;
    for (const bruto of [{ empresaId: '2' }, { usuarioId: '1' }, { perfil: 'MASTER' }]) assert.equal(q.safeParse(bruto).success, false, JSON.stringify(bruto));
  });
});

describe('vinculo-sst.schema — conceder.body (12F-2)', () => {
  const vinculoRepo = require('../../src/repositories/vinculo-sst.repository');

  test('usuário alvo inteiro positivo; motivo opcional, anulável e aparado, até o limite do repositório', () => {
    const b = schema().conceder.body;
    assert.deepEqual(b.safeParse({ usuarioId: 7 }).data, { usuarioId: 7 });
    assert.deepEqual(b.safeParse({ usuarioId: 7, motivo: '  Técnico de segurança  ' }).data, { usuarioId: 7, motivo: 'Técnico de segurança' });
    assert.deepEqual(b.safeParse({ usuarioId: 7, motivo: null }).data, { usuarioId: 7, motivo: null });
    assert.equal(b.safeParse({ usuarioId: 7, motivo: 'x'.repeat(vinculoRepo.MOTIVO_MAXIMO) }).success, true);
    for (const corpo of [{}, { usuarioId: 0 }, { usuarioId: '7' }, { usuarioId: 1.5 }, { usuarioId: 7, motivo: '' }, { usuarioId: 7, motivo: '  ' },
      { usuarioId: 7, motivo: 'x'.repeat(vinculoRepo.MOTIVO_MAXIMO + 1) }, { usuarioId: 7, motivo: 'a\u0007' }]) {
      assert.equal(b.safeParse(corpo).success, false, JSON.stringify(corpo).slice(0, 40));
    }
  });

  test('recusa empresa, quem concede, perfil e instantes vindos do cliente', () => {
    for (const extra of [{ empresaId: 2 }, { concedidoPor: 1 }, { atorId: 1 }, { perfil: 'MASTER' }, { concedidoEm: '2026-10-03' }]) {
      assert.equal(schema().conceder.body.safeParse({ usuarioId: 7, ...extra }).success, false, JSON.stringify(extra));
    }
  });
});

describe('vinculo-sst.schema — remover.params (12F-2)', () => {
  test('usuarioId canônico positivo; nada além dele', () => {
    const p = schema().remover.params;
    assert.deepEqual(p.safeParse({ usuarioId: '7' }).data, { usuarioId: 7 });
    for (const usuarioId of ['0', '-1', '07', 'abc', '', '2147483648']) assert.equal(p.safeParse({ usuarioId }).success, false, usuarioId);
    assert.equal(p.safeParse({ usuarioId: '7', empresaId: '2' }).success, false);
  });
});
