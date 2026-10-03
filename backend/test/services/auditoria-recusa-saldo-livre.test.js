'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');
const auditoriaRepo = require('../../src/repositories/auditoria.repository');

/**
 * Auditoria secundária da recusa por SALDO_LIVRE_INSUFICIENTE (12C-3), sem
 * PostgreSQL real. Roda DEPOIS do rollback da operação principal, em
 * transação própria por par, com supressão de 60 s por empresa, ator, tipo de
 * operação, material e tamanho, serializada por advisory lock de namespace
 * próprio. Falha dela nunca vira erro da operação nem sucesso: vai para o
 * registro técnico, sem payload.
 */

const servico = () => exigirModulo('src/services/auditoria-recusa-saldo-livre');
const util = () => exigirModulo('src/utils/supressao-auditoria');

const EMPRESA = 42;
const ATOR = 7;

const recusa = (extra = {}) => ({
  materialId: 30, tamanho: '40', quantidadeSolicitada: 4, fisicoUtilizavel: 5, demandaPendente: 2, comprometido: 2, saldoLivre: 3, ...extra,
});

function mundo(t, { existe = () => false, falhaAoRegistrar = null, falhaAoConectar = false } = {}) {
  assert.equal(typeof auditoriaRepo.existeRecente, 'function', 'função ainda não implementada: auditoria.repository.existeRecente');
  const eventos = [];
  const clientes = [];
  const pool = {
    connect: async () => {
      if (falhaAoConectar) throw Object.assign(new Error('sem conexão: dados sensíveis aqui'), { code: 'ECONNREFUSED' });
      const cliente = {
        query: async (texto, valores) => { eventos.push(['sql', texto.trim().split(/\s+/).slice(0, 3).join(' '), valores]); return { rows: [] }; },
        release: () => { eventos.push(['release']); },
      };
      clientes.push(cliente);
      return cliente;
    },
  };
  const recente = t.mock.method(auditoriaRepo, 'existeRecente', async (_c, dados) => { eventos.push(['existeRecente', dados]); return existe(dados); });
  const registrar = t.mock.method(auditoriaRepo, 'registrar', async (_c, dados) => {
    eventos.push(['registrar', dados]);
    if (falhaAoRegistrar) throw falhaAoRegistrar;
    return { id: '1', criadoEm: new Date() };
  });
  const falhas = [];
  const registrarFalha = (etiqueta, campos) => { falhas.push([etiqueta, campos]); };
  return { pool, eventos, recente, registrar, falhas, registrarFalha };
}

const marcos = (eventos) => eventos.map((e) => (e[0] === 'sql' ? e[1] : e[0]));

describe('uma transação própria por par, com a trava e a consulta antes do INSERT', () => {
  test('ENTREGA_DIRETA: BEGIN, advisory lock, consulta de evento recente, registrar e COMMIT, com a chave canônica e a janela de 60 s', async (t) => {
    const m = mundo(t);
    await servico().registrarRecusaPorSaldoLivre(m.pool, {
      empresaId: EMPRESA, atorId: ATOR, ip: '203.0.113.10', recusa: { operacao: 'ENTREGA_DIRETA', recusas: [recusa()], loteId: null, motivo: null },
    }, { registrarFalha: m.registrarFalha });

    assert.deepEqual(marcos(m.eventos), ['BEGIN', 'SELECT pg_advisory_xact_lock($1::bigint)', 'existeRecente', 'registrar', 'COMMIT', 'release']);
    const evento = util().chaveDoEvento('ENTREGA_DIRETA', 30, '40');
    assert.deepEqual(m.eventos[1][2], [util().lockDaSupressao(EMPRESA, ATOR, evento)]);
    assert.deepEqual(m.eventos[2][1], { empresaId: EMPRESA, usuarioId: ATOR, acao: 'SALDO_LIVRE_INSUFICIENTE', referencia: evento, janelaSegundos: 60 });
    assert.deepEqual(m.eventos[3][1], {
      empresaId: EMPRESA,
      usuarioId: ATOR,
      acao: 'SALDO_LIVRE_INSUFICIENTE',
      referencia: evento,
      ip: '203.0.113.10',
      contexto: { operacao: 'ENTREGA_DIRETA', materialId: 30, tamanho: '40', quantidadeSolicitada: 4, fisicoUtilizavel: 5, demandaPendente: 2, comprometido: 2, saldoLivre: 3 },
    });
    assert.deepEqual(m.falhas, []);
  });

  test('BAIXA: o lote e o motivo (valores estruturados) vão no contexto; texto livre, dispositivo e descrição nunca', async (t) => {
    const m = mundo(t);
    await servico().registrarRecusaPorSaldoLivre(m.pool, {
      empresaId: EMPRESA, atorId: ATOR, recusa: { operacao: 'BAIXA', recusas: [recusa({ quantidadeSolicitada: 1 })], loteId: 55, motivo: 'OUTRO' },
    }, { registrarFalha: m.registrarFalha });
    const gravado = m.registrar.mock.calls[0].arguments[1];
    assert.deepEqual(gravado.contexto, {
      operacao: 'BAIXA', materialId: 30, tamanho: '40', loteId: 55, motivo: 'OUTRO', quantidadeSolicitada: 1, fisicoUtilizavel: 5, demandaPendente: 2, comprometido: 2, saldoLivre: 3,
    });
    for (const proibida of ['dispositivo', 'descricao', 'justificativa', 'dadosAnteriores', 'dadosNovos']) assert.equal(proibida in gravado, false, proibida);
    assert.equal(gravado.ip, null);
    assert.equal(gravado.referencia, 'BAIXA:30:40');
  });

  test('tamanho ausente: referência com texto vazio e contexto com null', async (t) => {
    const m = mundo(t);
    await servico().registrarRecusaPorSaldoLivre(m.pool, {
      empresaId: EMPRESA, atorId: ATOR, recusa: { operacao: 'ENTREGA_DIRETA', recusas: [recusa({ tamanho: null })], loteId: null, motivo: null },
    }, { registrarFalha: m.registrarFalha });
    const gravado = m.registrar.mock.calls[0].arguments[1];
    assert.equal(gravado.referencia, 'ENTREGA_DIRETA:30:');
    assert.equal(gravado.contexto.tamanho, null);
  });
});

describe('supressão', () => {
  test('evento recente na janela: não registra e termina a transação', async (t) => {
    const m = mundo(t, { existe: () => true });
    await servico().registrarRecusaPorSaldoLivre(m.pool, {
      empresaId: EMPRESA, atorId: ATOR, recusa: { operacao: 'ENTREGA_DIRETA', recusas: [recusa()], loteId: null, motivo: null },
    }, { registrarFalha: m.registrarFalha });
    assert.equal(m.registrar.mock.callCount(), 0);
    assert.deepEqual(marcos(m.eventos), ['BEGIN', 'SELECT pg_advisory_xact_lock($1::bigint)', 'existeRecente', 'COMMIT', 'release']);
  });

  test('a janela é configurável só por quem chama o serviço (testes); o padrão é a de 60 s', async (t) => {
    const m = mundo(t);
    await servico().registrarRecusaPorSaldoLivre(m.pool, {
      empresaId: EMPRESA, atorId: ATOR, recusa: { operacao: 'BAIXA', recusas: [recusa()], loteId: 5, motivo: 'OUTRO' },
    }, { janelaSegundos: 2, registrarFalha: m.registrarFalha });
    assert.equal(m.recente.mock.calls[0].arguments[1].janelaSegundos, 2);
  });

  test('vários pares insuficientes: uma transação própria, uma trava, uma consulta e um registro por par, na ordem canônica', async (t) => {
    const m = mundo(t);
    await servico().registrarRecusaPorSaldoLivre(m.pool, {
      empresaId: EMPRESA,
      atorId: ATOR,
      recusa: {
        operacao: 'ENTREGA_DIRETA',
        recusas: [recusa({ materialId: 31, tamanho: null }), recusa({ materialId: 30, tamanho: '41' }), recusa({ materialId: 30, tamanho: '40' })],
        loteId: null,
        motivo: null,
      },
    }, { registrarFalha: m.registrarFalha });
    assert.deepEqual(m.registrar.mock.calls.map((c) => c.arguments[1].referencia), ['ENTREGA_DIRETA:30:40', 'ENTREGA_DIRETA:30:41', 'ENTREGA_DIRETA:31:']);
    assert.equal(marcos(m.eventos).filter((x) => x === 'BEGIN').length, 3);
    assert.equal(marcos(m.eventos).filter((x) => x === 'COMMIT').length, 3);
    const locks = m.eventos.filter((e) => e[0] === 'sql' && /advisory/.test(e[1])).map((e) => e[2][0]);
    assert.equal(new Set(locks).size, 3, 'cada par tem a sua trava');
  });

  test('sem recusas não abre transação alguma', async (t) => {
    const m = mundo(t);
    await servico().registrarRecusaPorSaldoLivre(m.pool, {
      empresaId: EMPRESA, atorId: ATOR, recusa: { operacao: 'ENTREGA_DIRETA', recusas: [], loteId: null, motivo: null },
    }, { registrarFalha: m.registrarFalha });
    assert.deepEqual(m.eventos, []);
  });
});

describe('falha da auditoria secundária', () => {
  test('falha ao registrar: ROLLBACK, o serviço não lança, e o registro técnico leva só evento, operação e código — sem mensagem, stack nem payload', async (t) => {
    const m = mundo(t, { falhaAoRegistrar: Object.assign(new Error('insert falhou com contexto {"quantidade":4} e segredo'), { code: '23514' }) });
    await servico().registrarRecusaPorSaldoLivre(m.pool, {
      empresaId: EMPRESA, atorId: ATOR, recusa: { operacao: 'ENTREGA_DIRETA', recusas: [recusa()], loteId: null, motivo: null },
    }, { registrarFalha: m.registrarFalha });
    assert.ok(marcos(m.eventos).includes('ROLLBACK'));
    assert.equal(marcos(m.eventos).includes('COMMIT'), false);
    assert.deepEqual(m.falhas, [['[auditoria-recusa]', { evento: 'auditoria_recusa_saldo_livre_falhou', operacao: 'ENTREGA_DIRETA', motivo: '23514' }]]);
    assert.doesNotMatch(JSON.stringify(m.falhas), /segredo|quantidade|insert/);
  });

  test('falha ao obter conexão: também não lança e é registrada de forma sanitizada; os demais pares ainda são tentados', async (t) => {
    const m = mundo(t, { falhaAoConectar: true });
    await servico().registrarRecusaPorSaldoLivre(m.pool, {
      empresaId: EMPRESA, atorId: ATOR, recusa: { operacao: 'BAIXA', recusas: [recusa(), recusa({ tamanho: '41' })], loteId: 5, motivo: 'OUTRO' },
    }, { registrarFalha: m.registrarFalha });
    assert.equal(m.falhas.length, 2);
    assert.deepEqual(m.falhas[0], ['[auditoria-recusa]', { evento: 'auditoria_recusa_saldo_livre_falhou', operacao: 'BAIXA', motivo: 'ECONNREFUSED' }]);
    assert.doesNotMatch(JSON.stringify(m.falhas), /sens/);
  });

  test('erro sem código usa o nome do erro como motivo', async (t) => {
    const m = mundo(t, { falhaAoRegistrar: new TypeError('x') });
    await servico().registrarRecusaPorSaldoLivre(m.pool, {
      empresaId: EMPRESA, atorId: ATOR, recusa: { operacao: 'ENTREGA_DIRETA', recusas: [recusa()], loteId: null, motivo: null },
    }, { registrarFalha: m.registrarFalha });
    assert.equal(m.falhas[0][1].motivo, 'TypeError');
  });

  test('o registro técnico padrão existe e não lança', async (t) => {
    const m = mundo(t, { falhaAoRegistrar: new Error('y') });
    const original = console.error;
    const vistos = [];
    console.error = (...args) => { vistos.push(args); };
    try {
      await servico().registrarRecusaPorSaldoLivre(m.pool, {
        empresaId: EMPRESA, atorId: ATOR, recusa: { operacao: 'ENTREGA_DIRETA', recusas: [recusa()], loteId: null, motivo: null },
      });
    } finally {
      console.error = original;
    }
    assert.equal(vistos.length, 1);
    assert.equal(vistos[0][0], '[auditoria-recusa]');
  });
});

describe('contrato de entrada', () => {
  test('empresa e ator inválidos são erro de programação; operação desconhecida também', async (t) => {
    const m = mundo(t);
    for (const extra of [{ empresaId: 0 }, { atorId: 'x' }]) {
      await assert.rejects(() => servico().registrarRecusaPorSaldoLivre(m.pool, {
        empresaId: EMPRESA, atorId: ATOR, recusa: { operacao: 'BAIXA', recusas: [recusa()], loteId: 5, motivo: 'OUTRO' }, ...extra,
      }), TypeError, JSON.stringify(extra));
    }
    await assert.rejects(() => servico().registrarRecusaPorSaldoLivre(m.pool, {
      empresaId: EMPRESA, atorId: ATOR, recusa: { operacao: 'ENTREGA', recusas: [recusa()], loteId: null, motivo: null },
    }), TypeError);
    assert.deepEqual(m.eventos, []);
  });
});
