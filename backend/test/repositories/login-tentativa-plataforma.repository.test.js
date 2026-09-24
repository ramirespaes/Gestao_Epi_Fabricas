'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  MOTIVO_COOLDOWN_ATIVADO,
  registrarTentativa,
  registrarAtivacaoCooldown,
  buscarCooldownVigente,
  contarFalhasRecentes,
} = require('../../src/repositories/login-tentativa-plataforma.repository');

/**
 * Contrato do repositório de tentativas de login do Painel Privado da
 * plataforma (migration 030 — correção final do Pacote 2, item 1).
 * Espelha login-tentativa.repository.test.js; diferença estrutural: só
 * `administradorId` (vínculo simples), sem `empresaId`.
 */

const ADMIN_ID = 9;
const CHAVE = 'a'.repeat(64);
const ID_BIGINT = '9007199254740993';

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

describe('registrarTentativa', () => {
  test('grava tentativa bem-sucedida, com administrador, sem motivo', async () => {
    const executor = executorFalso([{ id: ID_BIGINT }]);

    const id = await registrarTentativa(executor, { chaveCooldown: CHAVE, administradorId: ADMIN_ID, sucesso: true });

    assert.equal(id, ID_BIGINT, 'o identificador BIGINT não pode ser convertido para Number');
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /insert\s+into\s+login_tentativas_plataforma/i);
    assert.match(texto, /clock_timestamp\(\)/i);
    assert.deepEqual(valores, [CHAVE, ADMIN_ID, true, null, null, null]);
    assert.equal(texto.includes(CHAVE), false, 'a chave não pode ser concatenada no SQL');
  });

  test('grava tentativa malsucedida sem administrador identificado (ADMINISTRADOR_INEXISTENTE)', async () => {
    const executor = executorFalso([{ id: ID_BIGINT }]);

    await registrarTentativa(executor, { chaveCooldown: CHAVE, sucesso: false, motivo: 'ADMINISTRADOR_INEXISTENTE' });

    const { valores } = executor.chamadas[0];
    assert.deepEqual(valores, [CHAVE, null, false, 'ADMINISTRADOR_INEXISTENTE', null, null]);
  });

  test('grava tentativa malsucedida totalmente identificada (SENHA_INVALIDA)', async () => {
    const executor = executorFalso([{ id: ID_BIGINT }]);

    await registrarTentativa(executor, {
      chaveCooldown: CHAVE, administradorId: ADMIN_ID, sucesso: false,
      motivo: 'SENHA_INVALIDA', ip: '203.0.113.10', dispositivo: 'navegador de teste',
    });

    const { valores } = executor.chamadas[0];
    assert.deepEqual(valores, [CHAVE, ADMIN_ID, false, 'SENHA_INVALIDA', '203.0.113.10', 'navegador de teste']);
  });

  test('recusa sucesso que não seja booleano', async () => {
    const executor = executorFalso([{ id: ID_BIGINT }]);

    await assert.rejects(() => registrarTentativa(executor, { chaveCooldown: CHAVE, sucesso: 'true' }), /booleano/i);
    await assert.rejects(() => registrarTentativa(executor, { chaveCooldown: CHAVE, sucesso: undefined }), /booleano/i);
    assert.equal(executor.chamadas.length, 0);
  });

  test('recusa tentativa bem-sucedida com motivo', async () => {
    const executor = executorFalso([{ id: ID_BIGINT }]);

    await assert.rejects(() => registrarTentativa(executor, {
      chaveCooldown: CHAVE, administradorId: ADMIN_ID, sucesso: true, motivo: 'SENHA_INVALIDA',
    }), /motivo/i);
    assert.equal(executor.chamadas.length, 0);
  });

  test('recusa tentativa bem-sucedida sem administrador identificado', async () => {
    const executor = executorFalso([{ id: ID_BIGINT }]);

    await assert.rejects(() => registrarTentativa(executor, { chaveCooldown: CHAVE, sucesso: true }), /identificad/i);
    assert.equal(executor.chamadas.length, 0);
  });

  test('recusa tentativa malsucedida sem motivo', async () => {
    const executor = executorFalso([{ id: ID_BIGINT }]);

    await assert.rejects(() => registrarTentativa(executor, { chaveCooldown: CHAVE, sucesso: false }), /motivo/i);
    assert.equal(executor.chamadas.length, 0);
  });

  test('recusa motivo fora do formato aceito pela coluna', async () => {
    const executor = executorFalso([{ id: ID_BIGINT }]);

    await assert.rejects(() => registrarTentativa(executor, { chaveCooldown: CHAVE, sucesso: false, motivo: 'senha_invalida' }), /motivo/i);
    await assert.rejects(() => registrarTentativa(executor, { chaveCooldown: CHAVE, sucesso: false, motivo: '' }), /motivo/i);
    await assert.rejects(() => registrarTentativa(executor, { chaveCooldown: CHAVE, sucesso: false, motivo: 'M'.repeat(31) }), /motivo/i);
    assert.equal(executor.chamadas.length, 0);
  });

  test('recusa motivo COOLDOWN_ATIVADO, reservado a registrarAtivacaoCooldown', async () => {
    const executor = executorFalso([{ id: ID_BIGINT }]);

    await assert.rejects(() => registrarTentativa(executor, {
      chaveCooldown: CHAVE, sucesso: false, motivo: MOTIVO_COOLDOWN_ATIVADO,
    }), /registrarAtivacaoCooldown|cooldown/i);
    assert.equal(executor.chamadas.length, 0);
  });

  test('recusa chave de cooldown fora do formato', async () => {
    const executor = executorFalso([{ id: ID_BIGINT }]);

    await assert.rejects(() => registrarTentativa(executor, { chaveCooldown: 'curta', sucesso: false, motivo: 'SENHA_INVALIDA' }), /chave/i);
    await assert.rejects(() => registrarTentativa(executor, { chaveCooldown: 'A'.repeat(64), sucesso: false, motivo: 'SENHA_INVALIDA' }), /chave/i);
    await assert.rejects(() => registrarTentativa(executor, { chaveCooldown: null, sucesso: false, motivo: 'SENHA_INVALIDA' }), /chave/i);
    assert.equal(executor.chamadas.length, 0);
  });

  test('recusa identificador de administrador inválido', async () => {
    const executor = executorFalso([{ id: ID_BIGINT }]);

    await assert.rejects(() => registrarTentativa(executor, { chaveCooldown: CHAVE, administradorId: 0, sucesso: false, motivo: 'SENHA_INVALIDA' }), /administrador/i);
    await assert.rejects(() => registrarTentativa(executor, { chaveCooldown: CHAVE, administradorId: -1, sucesso: false, motivo: 'SENHA_INVALIDA' }), /administrador/i);
    await assert.rejects(() => registrarTentativa(executor, { chaveCooldown: CHAVE, administradorId: '9', sucesso: false, motivo: 'SENHA_INVALIDA' }), /administrador/i);
    assert.equal(executor.chamadas.length, 0);
  });
});

describe('registrarAtivacaoCooldown', () => {
  test('grava a ativação com sucesso e motivo fixos, cooldown_ate no lugar certo', async () => {
    const executor = executorFalso([{ id: ID_BIGINT }]);
    const cooldownAte = new Date(Date.now() + 900_000);

    const id = await registrarAtivacaoCooldown(executor, { chaveCooldown: CHAVE, cooldownAte });

    assert.equal(id, ID_BIGINT);
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /insert\s+into\s+login_tentativas_plataforma/i);
    assert.match(texto, /clock_timestamp\(\)/i);
    assert.deepEqual(valores, [CHAVE, null, MOTIVO_COOLDOWN_ATIVADO, cooldownAte, null, null]);
    assert.match(texto, /false/i, 'sucesso deve ser gravado como false diretamente no SQL, não como parâmetro sobrescrevível');
  });

  test('ignora sucesso e motivo caso o chamador tente informá-los', async () => {
    const executor = executorFalso([{ id: ID_BIGINT }]);
    const cooldownAte = new Date(Date.now() + 900_000);

    await registrarAtivacaoCooldown(executor, {
      chaveCooldown: CHAVE, cooldownAte, sucesso: true, motivo: 'OUTRO_MOTIVO_QUALQUER',
    });

    const { valores } = executor.chamadas[0];
    assert.equal(valores[2], MOTIVO_COOLDOWN_ATIVADO, 'motivo do chamador não pode substituir o motivo fixo');
    assert.equal(valores.includes(true), false, 'sucesso do chamador não pode substituir o valor fixo (false)');
  });

  test('grava a ativação vinculada ao administrador quando informado', async () => {
    const executor = executorFalso([{ id: ID_BIGINT }]);
    const cooldownAte = new Date(Date.now() + 900_000);

    await registrarAtivacaoCooldown(executor, { chaveCooldown: CHAVE, cooldownAte, administradorId: ADMIN_ID });

    const { valores } = executor.chamadas[0];
    assert.deepEqual(valores, [CHAVE, ADMIN_ID, MOTIVO_COOLDOWN_ATIVADO, cooldownAte, null, null]);
  });

  test('recusa cooldownAte inválido', async () => {
    const executor = executorFalso([{ id: ID_BIGINT }]);

    await assert.rejects(() => registrarAtivacaoCooldown(executor, { chaveCooldown: CHAVE, cooldownAte: '2026-09-24' }), /data/i);
    await assert.rejects(() => registrarAtivacaoCooldown(executor, { chaveCooldown: CHAVE, cooldownAte: new Date('data inválida') }), /data/i);
    await assert.rejects(() => registrarAtivacaoCooldown(executor, { chaveCooldown: CHAVE, cooldownAte: undefined }), /data/i);
    assert.equal(executor.chamadas.length, 0);
  });

  test('recusa chave de cooldown fora do formato', async () => {
    const executor = executorFalso([{ id: ID_BIGINT }]);
    const cooldownAte = new Date(Date.now() + 900_000);

    await assert.rejects(() => registrarAtivacaoCooldown(executor, { chaveCooldown: 'curta', cooldownAte }), /chave/i);
    assert.equal(executor.chamadas.length, 0);
  });
});

describe('buscarCooldownVigente', () => {
  test('devolve null quando não há cooldown vigente', async () => {
    assert.equal(await buscarCooldownVigente(executorFalso([]), CHAVE), null);
  });

  test('devolve ativoAte quando existe cooldown vigente', async () => {
    const ativoAte = new Date(Date.now() + 600_000);
    const executor = executorFalso([{ cooldown_ate: ativoAte }]);

    const resultado = await buscarCooldownVigente(executor, CHAVE);

    assert.deepEqual(resultado, { ativoAte });
  });

  test('a consulta filtra pela chave, exige cooldown futuro e traz o mais recente', async () => {
    const executor = executorFalso([]);

    await buscarCooldownVigente(executor, CHAVE);

    const { texto, valores } = executor.chamadas[0];
    assert.deepEqual(valores, [CHAVE]);
    assert.match(texto, /cooldown_ate\s+is\s+not\s+null/i);
    assert.match(texto, /cooldown_ate\s*>\s*clock_timestamp\(\)/i);
    assert.equal(/cooldown_ate\s*>\s*now\(\)/i.test(texto), false);
    assert.match(texto, /order\s+by\s+cooldown_ate\s+desc/i);
    assert.match(texto, /limit\s+1/i);
    assert.equal(texto.includes(CHAVE), false);
  });

  test('recusa chave de cooldown fora do formato, antes de consultar', async () => {
    const executor = executorFalso([]);

    await assert.rejects(() => buscarCooldownVigente(executor, 'curta'), /chave/i);
    await assert.rejects(() => buscarCooldownVigente(executor, null), /chave/i);
    assert.equal(executor.chamadas.length, 0);
  });
});

describe('contarFalhasRecentes', () => {
  const desde = new Date(Date.now() - 900_000);

  test('devolve a contagem calculada pela consulta', async () => {
    assert.equal(await contarFalhasRecentes(executorFalso([{ total: 3 }]), CHAVE, desde), 3);
  });

  test('devolve zero quando não há falhas recentes', async () => {
    assert.equal(await contarFalhasRecentes(executorFalso([{ total: 0 }]), CHAVE, desde), 0);
  });

  test('a consulta ignora linhas de ativação de cooldown e considera só falhas', async () => {
    const executor = executorFalso([{ total: 0 }]);

    await contarFalhasRecentes(executor, CHAVE, desde);

    const { texto } = executor.chamadas[0];
    assert.match(texto, /cooldown_ate\s+is\s+null/i);
    assert.match(texto, /not\s+sucesso/i);
  });

  test('a consulta desconsidera falhas com id anterior ou igual ao do último sucesso da mesma chave', async () => {
    const executor = executorFalso([{ total: 0 }]);

    await contarFalhasRecentes(executor, CHAVE, desde);

    const { texto } = executor.chamadas[0];
    assert.match(texto, /max\(\s*id\s*\)/i);
    assert.match(texto, /id\s*>\s*coalesce/i);
  });

  test('parametriza chave e data, sem concatenar no SQL', async () => {
    const executor = executorFalso([{ total: 0 }]);

    await contarFalhasRecentes(executor, CHAVE, desde);

    const { texto, valores } = executor.chamadas[0];
    assert.deepEqual(valores, [CHAVE, desde]);
    assert.equal(texto.includes(CHAVE), false);
    assert.match(texto, /\$1/);
    assert.match(texto, /\$2/);
  });

  test('recusa chave ou data inválida antes de consultar', async () => {
    const executor = executorFalso([{ total: 0 }]);

    await assert.rejects(() => contarFalhasRecentes(executor, 'curta', desde), /chave/i);
    await assert.rejects(() => contarFalhasRecentes(executor, CHAVE, 'ontem'), /data/i);
    await assert.rejects(() => contarFalhasRecentes(executor, CHAVE, new Date('inválida')), /data/i);
    assert.equal(executor.chamadas.length, 0);
  });
});
