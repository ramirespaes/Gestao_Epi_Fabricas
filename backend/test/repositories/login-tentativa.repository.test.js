'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  MOTIVO_COOLDOWN_ATIVADO,
  registrarTentativa,
  registrarAtivacaoCooldown,
  buscarCooldownVigente,
  contarFalhasRecentes,
} = require('../../src/repositories/login-tentativa.repository');

/**
 * Contrato do repositório de tentativas de login (migration 015).
 *
 * A chave de correlação é sempre `chave_cooldown`, uma string opaca já
 * calculada por src/security/cooldown.js. Este repositório nunca recebe
 * CNPJ, e-mail, senha, hash de senha, token ou cookie — não há colunas
 * para nada disso na tabela, e este arquivo não reproduz o cálculo do
 * HMAC, apenas confere o formato de 64 hex já produzido.
 */

const EMPRESA = 4242;
const USUARIO = 77;
// Formato exigido por chaveCooldownTemFormatoValido: 64 hex minúsculos.
const CHAVE = 'a'.repeat(64);
// Além de Number.MAX_SAFE_INTEGER, para provar que o id BIGINT devolvido
// pelo banco nunca é convertido para Number.
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
  test('grava tentativa bem-sucedida, com empresa e usuário, sem motivo', async () => {
    const executor = executorFalso([{ id: ID_BIGINT }]);

    const id = await registrarTentativa(executor, {
      chaveCooldown: CHAVE, empresaId: EMPRESA, usuarioId: USUARIO, sucesso: true,
    });

    assert.equal(id, ID_BIGINT, 'o identificador BIGINT não pode ser convertido para Number');
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /insert\s+into\s+login_tentativas/i);
    // criado_em vem de clock_timestamp() escrito no próprio SQL, não de um
    // parâmetro novo: a assinatura pública da função não muda.
    assert.match(texto, /criado_em/i);
    assert.match(texto, /clock_timestamp\(\)/i);
    assert.deepEqual(valores, [CHAVE, EMPRESA, USUARIO, true, null, null, null]);
    assert.equal(texto.includes(CHAVE), false, 'a chave não pode ser concatenada no SQL');
  });

  test('grava tentativa malsucedida sem empresa nem usuário (EMPRESA_INEXISTENTE)', async () => {
    const executor = executorFalso([{ id: ID_BIGINT }]);

    await registrarTentativa(executor, { chaveCooldown: CHAVE, sucesso: false, motivo: 'EMPRESA_INEXISTENTE' });

    const { valores } = executor.chamadas[0];
    assert.deepEqual(valores, [CHAVE, null, null, false, 'EMPRESA_INEXISTENTE', null, null]);
  });

  test('grava tentativa malsucedida com empresa mas sem usuário (EMAIL_INEXISTENTE)', async () => {
    const executor = executorFalso([{ id: ID_BIGINT }]);

    await registrarTentativa(executor, {
      chaveCooldown: CHAVE, empresaId: EMPRESA, sucesso: false, motivo: 'EMAIL_INEXISTENTE',
    });

    const { valores } = executor.chamadas[0];
    assert.deepEqual(valores, [CHAVE, EMPRESA, null, false, 'EMAIL_INEXISTENTE', null, null]);
  });

  test('grava tentativa malsucedida totalmente identificada (SENHA_INVALIDA)', async () => {
    const executor = executorFalso([{ id: ID_BIGINT }]);

    await registrarTentativa(executor, {
      chaveCooldown: CHAVE, empresaId: EMPRESA, usuarioId: USUARIO, sucesso: false,
      motivo: 'SENHA_INVALIDA', ip: '203.0.113.10', dispositivo: 'navegador de teste',
    });

    const { valores } = executor.chamadas[0];
    assert.deepEqual(valores, [CHAVE, EMPRESA, USUARIO, false, 'SENHA_INVALIDA', '203.0.113.10', 'navegador de teste']);
  });

  test('recusa usuário identificado sem empresa identificada', async () => {
    const executor = executorFalso([{ id: ID_BIGINT }]);

    await assert.rejects(
      () => registrarTentativa(executor, { chaveCooldown: CHAVE, usuarioId: USUARIO, sucesso: false, motivo: 'SENHA_INVALIDA' }),
      /empresa/i,
    );
    assert.equal(executor.chamadas.length, 0);
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
      chaveCooldown: CHAVE, empresaId: EMPRESA, usuarioId: USUARIO, sucesso: true, motivo: 'SENHA_INVALIDA',
    }), /motivo/i);
    assert.equal(executor.chamadas.length, 0);
  });

  test('recusa tentativa bem-sucedida sem empresa ou sem usuário identificados', async () => {
    const executor = executorFalso([{ id: ID_BIGINT }]);

    await assert.rejects(() => registrarTentativa(executor, { chaveCooldown: CHAVE, sucesso: true }), /identificad/i);
    await assert.rejects(() => registrarTentativa(executor, { chaveCooldown: CHAVE, empresaId: EMPRESA, sucesso: true }), /identificad/i);
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

  test('recusa identificador de empresa ou usuário inválido', async () => {
    const executor = executorFalso([{ id: ID_BIGINT }]);

    await assert.rejects(() => registrarTentativa(executor, { chaveCooldown: CHAVE, empresaId: 0, sucesso: false, motivo: 'EMPRESA_INEXISTENTE' }), /empresa/i);
    await assert.rejects(() => registrarTentativa(executor, { chaveCooldown: CHAVE, empresaId: -1, sucesso: false, motivo: 'EMPRESA_INEXISTENTE' }), /empresa/i);
    await assert.rejects(() => registrarTentativa(executor, { chaveCooldown: CHAVE, empresaId: EMPRESA, usuarioId: 1.5, sucesso: false, motivo: 'SENHA_INVALIDA' }), /usuário/i);
    await assert.rejects(() => registrarTentativa(executor, { chaveCooldown: CHAVE, empresaId: '4242', sucesso: false, motivo: 'EMPRESA_INEXISTENTE' }), /empresa/i);
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
    assert.match(texto, /insert\s+into\s+login_tentativas/i);
    assert.match(texto, /criado_em/i);
    assert.match(texto, /clock_timestamp\(\)/i);
    assert.deepEqual(valores, [CHAVE, null, null, MOTIVO_COOLDOWN_ATIVADO, cooldownAte, null, null]);
    assert.match(texto, /false/i, 'sucesso deve ser gravado como false diretamente no SQL, não como parâmetro sobrescrevível');
  });

  test('ignora sucesso e motivo caso o chamador tente informá-los', async () => {
    const executor = executorFalso([{ id: ID_BIGINT }]);
    const cooldownAte = new Date(Date.now() + 900_000);

    await registrarAtivacaoCooldown(executor, {
      chaveCooldown: CHAVE, cooldownAte, sucesso: true, motivo: 'OUTRO_MOTIVO_QUALQUER',
    });

    const { valores } = executor.chamadas[0];
    assert.equal(valores[3], MOTIVO_COOLDOWN_ATIVADO, 'motivo do chamador não pode substituir o motivo fixo');
    assert.equal(valores.includes(true), false, 'sucesso do chamador não pode substituir o valor fixo (false)');
  });

  test('grava a ativação vinculada a empresa e usuário quando informados', async () => {
    const executor = executorFalso([{ id: ID_BIGINT }]);
    const cooldownAte = new Date(Date.now() + 900_000);

    await registrarAtivacaoCooldown(executor, {
      chaveCooldown: CHAVE, cooldownAte, empresaId: EMPRESA, usuarioId: USUARIO,
    });

    const { valores } = executor.chamadas[0];
    assert.deepEqual(valores, [CHAVE, EMPRESA, USUARIO, MOTIVO_COOLDOWN_ATIVADO, cooldownAte, null, null]);
  });

  test('recusa usuário identificado sem empresa identificada', async () => {
    const executor = executorFalso([{ id: ID_BIGINT }]);
    const cooldownAte = new Date(Date.now() + 900_000);

    await assert.rejects(
      () => registrarAtivacaoCooldown(executor, { chaveCooldown: CHAVE, cooldownAte, usuarioId: USUARIO }),
      /empresa/i,
    );
    assert.equal(executor.chamadas.length, 0);
  });

  test('recusa cooldownAte inválido', async () => {
    const executor = executorFalso([{ id: ID_BIGINT }]);

    await assert.rejects(() => registrarAtivacaoCooldown(executor, { chaveCooldown: CHAVE, cooldownAte: '2026-09-20' }), /data/i);
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
    assert.match(texto, /cooldown_ate\s*>\s*clock_timestamp\(\)/i, 'cooldown vencido não pode ser considerado vigente');
    assert.equal(/cooldown_ate\s*>\s*now\(\)/i.test(texto), false, 'now() fica congelado no início da transação; a comparação precisa refletir o instante real, mesmo após espera por advisory lock');
    assert.match(texto, /order\s+by\s+cooldown_ate\s+desc/i);
    assert.match(texto, /limit\s+1/i);
    assert.equal(texto.includes(CHAVE), false, 'a chave não pode ser concatenada no SQL');
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
    assert.match(texto, /cooldown_ate\s+is\s+null/i, 'ativação de cooldown não é uma falha de tentativa');
    assert.match(texto, /not\s+sucesso/i);
  });

  test('a consulta desconsidera falhas com id anterior ou igual ao do último sucesso da mesma chave', async () => {
    const executor = executorFalso([{ total: 0 }]);

    await contarFalhasRecentes(executor, CHAVE, desde);

    const { texto } = executor.chamadas[0];
    // A fronteira usa id, não criado_em: now() é fixo por transação, então
    // criado_em sozinho não desempata sucesso e falha gravados juntos.
    assert.match(texto, /max\(\s*id\s*\)/i);
    assert.match(texto, /id\s*>\s*coalesce/i);
    assert.equal(/greatest\s*\(/i.test(texto), false, 'a fronteira de sucesso não deve mais ser combinada com a janela via GREATEST');
  });

  test('a janela de tempo (criado_em) e a fronteira de sucesso (id) são condições independentes', async () => {
    const executor = executorFalso([{ total: 0 }]);

    await contarFalhasRecentes(executor, CHAVE, desde);

    const { texto } = executor.chamadas[0];
    assert.match(texto, /criado_em\s*>\s*\$2/i, 'a janela de tempo usa criado_em diretamente contra o parâmetro, sem envolver id');
  });

  test('parametriza chave e data, sem concatenar no SQL', async () => {
    const executor = executorFalso([{ total: 0 }]);

    await contarFalhasRecentes(executor, CHAVE, desde);

    const { texto, valores } = executor.chamadas[0];
    assert.deepEqual(valores, [CHAVE, desde]);
    assert.equal(texto.includes(CHAVE), false, 'a chave não pode ser concatenada no SQL');
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
