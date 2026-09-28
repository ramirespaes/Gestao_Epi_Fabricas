'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const trava = require('../../src/repositories/trava-mfa-plataforma.repository');

/**
 * Trava consultiva do administrador no MFA. Usa a forma de DUAS chaves int4
 * do pg_advisory_xact_lock, cujo espaço o PostgreSQL mantém separado do
 * espaço de uma chave bigint usado pelo cooldown e pelas demais travas do
 * projeto: não há colisão possível com elas, nem por acaso.
 */

const executorFalso = () => {
  const chamadas = [];
  return { chamadas, query: async (texto, valores) => { chamadas.push({ texto, valores }); return { rows: [] }; } };
};

describe('travarAdministrador', () => {
  test('pg_advisory_xact_lock de duas chaves: espaço fixo do MFA e o id do administrador', async () => {
    const executor = executorFalso();

    await trava.travarAdministrador(executor, 42);

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /pg_advisory_xact_lock\(\s*\$1::int(eger)?\s*,\s*\$2::int(eger)?\s*\)/i);
    assert.doesNotMatch(texto, /bigint/i, 'nunca a forma de chave única, que é a do cooldown');
    assert.deepEqual(valores, [trava.ESPACO_TRAVA_ADMINISTRADOR_MFA, 42]);
  });

  test('o espaço é um int4 positivo fixo, igual para todas as chamadas', async () => {
    assert.ok(Number.isInteger(trava.ESPACO_TRAVA_ADMINISTRADOR_MFA));
    assert.ok(trava.ESPACO_TRAVA_ADMINISTRADOR_MFA > 0 && trava.ESPACO_TRAVA_ADMINISTRADOR_MFA <= 2147483647);
    const a = executorFalso();
    const b = executorFalso();
    await trava.travarAdministrador(a, 1);
    await trava.travarAdministrador(b, 2);
    assert.equal(a.chamadas[0].valores[0], b.chamadas[0].valores[0]);
  });

  test('administrador inválido é recusado antes de consultar', async () => {
    const executor = executorFalso();
    for (const id of [0, -1, '7', 1.5, 2147483648, null]) {
      await assert.rejects(() => trava.travarAdministrador(executor, id), TypeError);
    }
    assert.equal(executor.chamadas.length, 0);
  });
});
