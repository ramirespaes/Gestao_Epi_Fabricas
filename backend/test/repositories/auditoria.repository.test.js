'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { registrar } = require('../../src/repositories/auditoria.repository');

/**
 * Contrato do repositório de auditoria (logs_auditoria). Só persiste o que
 * recebe: não redige, não decide, não traduz erro. A proibição de dados
 * sensíveis nos JSONB é responsabilidade do chamador (primeira barreira) e
 * da trigger da migration 014 (segunda) — este repositório só garante que
 * os três campos JSONB sejam objetos ou null, o que a CHECK do banco
 * também exige.
 */

const EMPRESA = 4242;
const USUARIO = 77;

const executorFalso = (linhas = [{ id: '901', criado_em: new Date('2026-09-21T12:00:00Z') }]) => {
  const chamadas = [];
  return {
    chamadas,
    query: async (texto, valores) => {
      chamadas.push({ texto, valores });
      return { rows: linhas, rowCount: linhas.length };
    },
  };
};

describe('registrar', () => {
  test('INSERT parametrizado nas dez colunas, na ordem esperada, devolvendo id (string, BIGINT) e criado_em', async () => {
    const executor = executorFalso();

    const resultado = await registrar(executor, {
      empresaId: EMPRESA,
      usuarioId: USUARIO,
      acao: 'AUTORIZACAO_INDIVIDUAL_CONCEDIDA',
      referencia: '15',
      descricao: 'motivo qualquer',
      ip: '10.0.0.1',
      dispositivo: 'teste',
      contexto: { tipo: 'DIRETA' },
      dadosAnteriores: null,
      dadosNovos: { usuarioId: 9, acaoCodigo: 'MOVIMENTAR_ESTOQUE' },
    });

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /insert\s+into\s+logs_auditoria/i);
    assert.match(texto, /returning\s+id,\s*criado_em/i);
    assert.doesNotMatch(texto, /update|delete|truncate/i, 'append-only: nunca outra operação');
    assert.deepEqual(valores, [
      EMPRESA, USUARIO, 'AUTORIZACAO_INDIVIDUAL_CONCEDIDA', '15', 'motivo qualquer', '10.0.0.1', 'teste',
      { tipo: 'DIRETA' }, null, { usuarioId: 9, acaoCodigo: 'MOVIMENTAR_ESTOQUE' },
    ]);
    assert.deepEqual(resultado, { id: '901', criadoEm: new Date('2026-09-21T12:00:00Z') });
  });

  test('campos opcionais ausentes viajam como null, nunca undefined', async () => {
    const executor = executorFalso();

    await registrar(executor, { empresaId: EMPRESA, acao: 'X' });

    assert.deepEqual(executor.chamadas[0].valores, [EMPRESA, null, 'X', null, null, null, null, null, null, null]);
  });

  test('recusa entrada inválida antes de consultar', async () => {
    const executor = executorFalso();

    await assert.rejects(() => registrar(executor, { empresaId: 0, acao: 'X' }), /empresa/i);
    await assert.rejects(() => registrar(executor, { empresaId: EMPRESA, usuarioId: 0, acao: 'X' }), /usuário/i);
    await assert.rejects(() => registrar(executor, { empresaId: EMPRESA, acao: '' }), /ação de auditoria/i);
    await assert.rejects(() => registrar(executor, { empresaId: EMPRESA, acao: 'A'.repeat(61) }), /ação de auditoria/i);
    await assert.rejects(() => registrar(executor, { empresaId: EMPRESA, acao: 'X', contexto: [] }), /contexto/i);
    await assert.rejects(() => registrar(executor, { empresaId: EMPRESA, acao: 'X', dadosAnteriores: 'texto' }), /dadosAnteriores/i);
    await assert.rejects(() => registrar(executor, { empresaId: EMPRESA, acao: 'X', dadosNovos: 7 }), /dadosNovos/i);
    assert.equal(executor.chamadas.length, 0);
  });

  test('erro do banco propaga sem tradução (inclusive rejeição por chave sensível da migration 014)', async () => {
    const erro = new Error('logs_auditoria: campo JSONB contém chave sensível');
    const executor = { query: async () => { throw erro; } };

    await assert.rejects(() => registrar(executor, { empresaId: EMPRESA, acao: 'X' }), (e) => e === erro);
  });
});

// SEC-002: User-Agent e IP vêm do cliente e as colunas são VARCHAR(150) e
// VARCHAR(45). O repositório é o ponto canônico: corta aqui, para nenhum
// serviço precisar lembrar, e a operação auditada não cai por isso.
describe('existeRecente — janela de supressão da auditoria de recusa (12C-3)', () => {
  const repositorio = () => require('../../src/repositories/auditoria.repository');
  const consulta = (linhas = []) => {
    const chamadas = [];
    return { chamadas, query: async (texto, valores) => { chamadas.push({ texto, valores }); return { rows: linhas, rowCount: linhas.length }; } };
  };
  const dados = (extra = {}) => ({
    empresaId: EMPRESA, usuarioId: USUARIO, acao: 'SALDO_LIVRE_INSUFICIENTE', referencia: 'BAIXA:30:40', janelaSegundos: 60, ...extra,
  });

  test('só lê: SELECT parametrizado por empresa, ator, ação e referência, com o relógio da consulta e a janela em segundos', async () => {
    assert.equal(typeof repositorio().existeRecente, 'function', 'função ainda não implementada: existeRecente');
    const executor = consulta([{ existe: 1 }]);
    assert.equal(await repositorio().existeRecente(executor, dados()), true);
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /^SELECT 1\s+FROM logs_auditoria/);
    assert.doesNotMatch(texto, /\b(INSERT|UPDATE|DELETE)\b/i);
    assert.match(texto, /WHERE empresa_id = \$1 AND usuario_id = \$2 AND acao = \$3 AND referencia = \$4/);
    assert.match(texto, /criado_em > clock_timestamp\(\) - make_interval\(secs => \$5\)/, 'o relógio da consulta, não o do início da transação');
    assert.match(texto, /LIMIT 1$/);
    assert.deepEqual(valores, [EMPRESA, USUARIO, 'SALDO_LIVRE_INSUFICIENTE', 'BAIXA:30:40', 60]);
  });

  test('sem linha, não há evento recente', async () => {
    assert.equal(await repositorio().existeRecente(consulta([]), dados()), false);
  });

  test('recusa empresa, ator, ação, referência e janela inválidos antes de consultar', async () => {
    const executor = consulta();
    for (const extra of [
      { empresaId: 0 }, { usuarioId: -1 }, { usuarioId: null }, { acao: '' }, { acao: 'A'.repeat(61) }, { referencia: '' }, { referencia: 'x'.repeat(151) }, { referencia: null },
      { janelaSegundos: 0 }, { janelaSegundos: -5 }, { janelaSegundos: 1.5 }, { janelaSegundos: '60' }, { janelaSegundos: 3601 },
    ]) {
      await assert.rejects(() => repositorio().existeRecente(executor, dados(extra)), TypeError, JSON.stringify(extra));
    }
    assert.equal(executor.chamadas.length, 0);
  });
});

describe('SEC-002 — IP e User-Agent cabem nas colunas', () => {
  const gravar = async (extra) => {
    const executor = executorFalso();
    await registrar(executor, { empresaId: EMPRESA, acao: 'X', ...extra });
    const valores = executor.chamadas[0].valores;
    return { ip: valores[5], dispositivo: valores[6] };
  };

  test('User-Agent com 150 fica igual; com 151 e com 400 é cortado nos primeiros 150', async () => {
    const ua = (n) => 'Mozilla/5.0 '.repeat(40).slice(0, n);
    assert.equal((await gravar({ dispositivo: ua(150) })).dispositivo, ua(150));
    assert.equal((await gravar({ dispositivo: ua(151) })).dispositivo, ua(150));
    assert.equal((await gravar({ dispositivo: ua(400) })).dispositivo, ua(150));
  });

  test('IP no limite fica igual; acima de 45 é cortado', async () => {
    const ipv6 = '0000:0000:0000:0000:0000:ffff:192.168.100.228';
    assert.equal(ipv6.length, 45);
    assert.equal((await gravar({ ip: ipv6 })).ip, ipv6);
    assert.equal((await gravar({ ip: '10.0.0.1' })).ip, '10.0.0.1');
    assert.equal((await gravar({ ip: `${ipv6}, 203.0.113.9` })).ip, ipv6);
  });

  test('o corte conta caracteres, sem partir caractere composto', async () => {
    const { dispositivo } = await gravar({ dispositivo: '😀'.repeat(151) });
    assert.equal(dispositivo, '😀'.repeat(150));
    assert.equal(Array.from(dispositivo).length, 150);
  });

  test('ausente vira null; tipo que não é texto é erro de programação, antes de consultar', async () => {
    assert.deepEqual(await gravar({ ip: undefined, dispositivo: null }), { ip: null, dispositivo: null });
    const executor = executorFalso();
    await assert.rejects(() => registrar(executor, { empresaId: EMPRESA, acao: 'X', dispositivo: ['a', 'b'] }), /dispositivo/i);
    await assert.rejects(() => registrar(executor, { empresaId: EMPRESA, acao: 'X', ip: 10 }), /ip/i);
    assert.equal(executor.chamadas.length, 0);
  });
});
