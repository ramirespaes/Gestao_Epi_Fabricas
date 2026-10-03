'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');

const servico = require('../../src/services/estoque.service');
const materialRepo = require('../../src/repositories/material.repository');
const operacaoRepo = require('../../src/repositories/estoque-operacao.repository');
const auditoriaRepo = require('../../src/repositories/auditoria.repository');
const parRepo = require('../../src/repositories/estoque-par.repository');
const coberturaRepo = require('../../src/repositories/solicitacao-epi-cobertura.repository');
const entregaRepo = require('../../src/repositories/entrega-epi.repository');
const { HttpError } = require('../../src/errors/HttpError');

/**
 * Baixa de estoque e reserva lógica (12C-3), sem PostgreSQL real.
 *
 * Evento físico (CA vencido, avaria, descarte, perda, ajuste de inventário)
 * nunca é recusado por reserva: a realidade física é registrada e a cobertura
 * se recalcula. Ato discricionário (devolução ao fornecedor, outro) não pode
 * consumir o comprometido: se a posição do par depois da baixa tem menos
 * comprometido que antes, é 409 SALDO_LIVRE_INSUFICIENTE e a transação inteira
 * volta. A posição é a da própria cobertura (mesma regra de "utilizável"), lida
 * depois das travas: lote que não participa de U não muda o comprometido.
 * A auditoria da recusa só acontece depois do ROLLBACK.
 */

const auditoriaRecusa = () => exigirModulo('src/services/auditoria-recusa-saldo-livre');

// O módulo da auditoria da recusa é só dublê aqui: os casos que não dependem dele
// falham (ou passam) pelo comportamento da baixa, não por o módulo ainda não existir.
// Quem especifica a auditoria da recusa chama auditoriaRecusa() e exige o módulo.
function auditoriaRecusaOuSubstituto() {
  try {
    return auditoriaRecusa();
  } catch {
    return null;
  }
}

const EMPRESA = 42;
const ATOR = 7;
const MATERIAL = 30;
const LOTE = 500;
const CHAVE = '3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c';
const HOJE = '2026-10-02';

const posicao = (U, D) => ({
  materialId: MATERIAL, tamanho: '40', fisicoUtilizavel: U, demandaPendente: D, comprometido: Math.min(U, D), saldoLivre: Math.max(0, U - D), semCobertura: Math.max(0, D - U),
});
const publica = (p) => ({ fisicoUtilizavel: p.fisicoUtilizavel, demandaPendente: p.demandaPendente, comprometido: p.comprometido, saldoLivre: p.saldoLivre, semCobertura: p.semCobertura });
const lote = (extra = {}) => ({
  loteId: LOTE, materialId: MATERIAL, tamanho: '40', caNumero: '12345', caValidade: '2099-12-31', origem: 'ENTRADA', quantidadeEntrada: 10, quantidadeBaixada: 0, quantidadeEntregue: 0, saldo: 10, ...extra,
});
const dados = (extra = {}) => ({
  empresaId: EMPRESA, atorId: ATOR, loteId: LOTE, quantidade: 1, motivo: 'AVARIA', justificativa: null, chaveIdempotencia: CHAVE, ip: '10.0.0.1', dispositivo: 'Navegador', ...extra,
});

function cenario(t, { antes, depois, loteLido = lote(), existente = null, falhaDaAuditoriaDaRecusa = null } = {}) {
  const chamadas = [];
  const cliente = {
    chamadas,
    query: async (texto) => { chamadas.push(texto); return { rows: [], rowCount: 0 }; },
    release: () => { chamadas.push('RELEASE'); },
  };
  const pool = { connect: async () => cliente, query: (...args) => cliente.query(...args) };
  let leituras = 0;
  let posicoes = 0;
  t.mock.method(operacaoRepo, 'travarChave', async () => {});
  t.mock.method(operacaoRepo, 'buscarPorChave', async () => existente);
  t.mock.method(operacaoRepo, 'buscarLote', async () => { leituras += 1; return loteLido; });
  t.mock.method(operacaoRepo, 'buscarLoteParaBaixa', async () => loteLido);
  t.mock.method(materialRepo, 'listarPorIdsParaVinculo', async (_c, _e, ids) => [{ id: ids[0], ativo: true, exigeCa: true }]);
  t.mock.method(parRepo, 'travarPares', async (_c, _e, pares) => pares);
  t.mock.method(entregaRepo, 'dataOperacionalDaTransacao', async () => HOJE);
  t.mock.method(coberturaRepo, 'lerPosicoes', async () => { const lida = posicoes === 0 ? antes : depois; posicoes += 1; return [lida]; });
  const baixa = t.mock.method(operacaoRepo, 'registrarBaixa', async (_c, d) => ({
    id: '900', tipo: 'BAIXA', loteId: LOTE, quantidade: d.quantidade, motivo: d.motivo, justificativa: d.justificativa, usuarioId: ATOR, criadoEm: new Date(),
  }));
  const registrar = t.mock.method(auditoriaRepo, 'registrar', async () => ({ id: '1', criadoEm: new Date() }));
  const moduloDaRecusa = auditoriaRecusaOuSubstituto();
  const recusa = moduloDaRecusa === null
    ? { mock: { callCount: () => 0, calls: [] } }
    : t.mock.method(moduloDaRecusa, 'registrarRecusaPorSaldoLivre', async () => {
      chamadas.push('AUDITORIA_DA_RECUSA');
      if (falhaDaAuditoriaDaRecusa) throw falhaDaAuditoriaDaRecusa;
    });
  return {
    pool, cliente, baixa, registrar, recusa, leituras: () => leituras, posicoes: () => posicoes,
  };
}

async function esperarConflito(promessa) {
  await assert.rejects(promessa, (erro) => {
    assert.ok(HttpError.ehHttpError(erro), `esperado HttpError, veio ${erro && erro.name}: ${erro && erro.message}`);
    assert.deepEqual([erro.status, erro.codigo], [409, 'SALDO_LIVRE_INSUFICIENTE']);
    return true;
  });
}

describe('evento físico: nunca recusado por reserva, e a posição antes e depois vai para a auditoria', () => {
  test('CASO C: U2 D2 C2 L0, PERDA 1 passa; depois U1 C1 G1, e reduziuCobertura é verdadeiro', async (t) => {
    const antes = posicao(2, 2);
    const depois = posicao(1, 2);
    const m = cenario(t, { antes, depois, loteLido: lote({ saldo: 2 }) });
    const r = await servico.registrarBaixa(m.pool, dados({ motivo: 'PERDA' }));
    assert.equal(r.repetida, false);
    assert.equal(m.baixa.mock.callCount(), 1);
    const contexto = m.registrar.mock.calls[0].arguments[1].contexto;
    assert.deepEqual([contexto.posicaoAntes, contexto.posicaoDepois, contexto.reduziuCobertura], [publica(antes), publica(depois), true]);
    assert.deepEqual([depois.fisicoUtilizavel, depois.comprometido, depois.semCobertura], [1, 1, 1]);
    assert.equal(m.recusa.mock.callCount(), 0);
  });

  test('os cinco eventos físicos passam mesmo com L0 e cobertura caindo', async (t) => {
    for (const motivo of ['CA_VENCIDO', 'AVARIA', 'DESCARTE', 'PERDA', 'AJUSTE_INVENTARIO']) {
      const m = cenario(t, { antes: posicao(2, 2), depois: posicao(1, 2), loteLido: lote({ saldo: 2 }) });
      await servico.registrarBaixa(m.pool, dados({ motivo }));
      assert.equal(m.baixa.mock.callCount(), 1, motivo);
      assert.equal(m.registrar.mock.calls[0].arguments[1].contexto.reduziuCobertura, true, motivo);
      t.mock.restoreAll();
    }
  });

  test('CASO H: U10 D2 C2, AVARIA 1: a cobertura continua 2 e reduziuCobertura é falso (não se infere da queda do físico)', async (t) => {
    const m = cenario(t, { antes: posicao(10, 2), depois: posicao(9, 2) });
    await servico.registrarBaixa(m.pool, dados());
    const contexto = m.registrar.mock.calls[0].arguments[1].contexto;
    assert.deepEqual([contexto.posicaoAntes.comprometido, contexto.posicaoDepois.comprometido, contexto.reduziuCobertura], [2, 2, false]);
  });

  test('CASO I: U2 D2 C2, AVARIA 1: a cobertura cai de 2 para 1 e reduziuCobertura é verdadeiro', async (t) => {
    const m = cenario(t, { antes: posicao(2, 2), depois: posicao(1, 2) });
    await servico.registrarBaixa(m.pool, dados());
    const contexto = m.registrar.mock.calls[0].arguments[1].contexto;
    assert.deepEqual([contexto.posicaoAntes.comprometido, contexto.posicaoDepois.comprometido, contexto.reduziuCobertura], [2, 1, true]);
  });
});

describe('ato discricionário: não consome o comprometido', () => {
  test('CASO E: U5 D2 L3, DEVOLUCAO_FORNECEDOR 3 passa (consome só o livre); reduziuCobertura falso', async (t) => {
    const m = cenario(t, { antes: posicao(5, 2), depois: posicao(2, 2) });
    const r = await servico.registrarBaixa(m.pool, dados({ motivo: 'DEVOLUCAO_FORNECEDOR', quantidade: 3 }));
    assert.equal(r.repetida, false);
    assert.equal(m.registrar.mock.calls[0].arguments[1].contexto.reduziuCobertura, false);
    assert.equal(m.recusa.mock.callCount(), 0);
  });

  test('CASO F: U5 D2 L3, DEVOLUCAO_FORNECEDOR 4 é 409 SALDO_LIVRE_INSUFICIENTE; nada é auditado como baixa', async (t) => {
    const m = cenario(t, { antes: posicao(5, 2), depois: posicao(1, 2) });
    await esperarConflito(servico.registrarBaixa(m.pool, dados({ motivo: 'DEVOLUCAO_FORNECEDOR', quantidade: 4 })));
    assert.equal(m.registrar.mock.callCount(), 0, 'sem ESTOQUE_BAIXA');
    assert.equal(m.cliente.chamadas.filter((c) => c === 'COMMIT').length, 0);
    assert.equal(m.cliente.chamadas.filter((c) => c === 'ROLLBACK').length, 1);
  });

  test('CASO D: U2 D2 L0, OUTRO 1 é 409 SALDO_LIVRE_INSUFICIENTE', async (t) => {
    const m = cenario(t, { antes: posicao(2, 2), depois: posicao(1, 2), loteLido: lote({ saldo: 2 }) });
    await esperarConflito(servico.registrarBaixa(m.pool, dados({ motivo: 'OUTRO', justificativa: 'Doação', quantidade: 1 })));
  });

  test('lote que não participa de U (CASO G): a posição não muda, então o ato discricionário passa mesmo com L0', async (t) => {
    const m = cenario(t, { antes: posicao(2, 2), depois: posicao(2, 2), loteLido: lote({ caValidade: '2020-01-01', saldo: 4 }) });
    const r = await servico.registrarBaixa(m.pool, dados({ motivo: 'OUTRO', justificativa: 'Descarte autorizado', quantidade: 4 }));
    assert.equal(r.repetida, false);
    assert.equal(m.registrar.mock.calls[0].arguments[1].contexto.reduziuCobertura, false);
    t.mock.restoreAll();
    const m2 = cenario(t, { antes: posicao(0, 0), depois: posicao(0, 0) });
    assert.equal((await servico.registrarBaixa(m2.pool, dados({ motivo: 'DEVOLUCAO_FORNECEDOR', quantidade: 3 }))).repetida, false, 'material inativo: U0 e D0');
  });

  test('sem demanda não há reserva: todo o físico utilizável é livre', async (t) => {
    const m = cenario(t, { antes: posicao(5, 0), depois: posicao(0, 0), loteLido: lote({ saldo: 5 }) });
    assert.equal((await servico.registrarBaixa(m.pool, dados({ motivo: 'OUTRO', justificativa: 'x', quantidade: 5 }))).repetida, false);
  });
});

describe('a recusa só é auditada depois do ROLLBACK', () => {
  test('o rollback vem antes da auditoria da recusa, que leva o par, a quantidade, a posição de antes, o lote e o motivo — e nunca a justificativa nem o dispositivo', async (t) => {
    auditoriaRecusa();
    const m = cenario(t, { antes: posicao(5, 2), depois: posicao(1, 2) });
    await esperarConflito(servico.registrarBaixa(m.pool, dados({ motivo: 'OUTRO', justificativa: 'Texto livre do operador', quantidade: 4 })));
    const { chamadas } = m.cliente;
    assert.ok(chamadas.indexOf('ROLLBACK') >= 0 && chamadas.indexOf('ROLLBACK') < chamadas.indexOf('AUDITORIA_DA_RECUSA'), JSON.stringify(chamadas));
    assert.equal(m.recusa.mock.callCount(), 1);
    const [, argumento] = m.recusa.mock.calls[0].arguments;
    assert.deepEqual(argumento, {
      empresaId: EMPRESA,
      atorId: ATOR,
      ip: '10.0.0.1',
      recusa: {
        operacao: 'BAIXA',
        recusas: [{ materialId: MATERIAL, tamanho: '40', quantidadeSolicitada: 4, fisicoUtilizavel: 5, demandaPendente: 2, comprometido: 2, saldoLivre: 3 }],
        loteId: LOTE,
        motivo: 'OUTRO',
      },
    });
    assert.doesNotMatch(JSON.stringify(argumento), /Texto livre|Navegador/);
  });

  test('se a auditoria da recusa falhar, o erro devolvido continua sendo SALDO_LIVRE_INSUFICIENTE', async (t) => {
    auditoriaRecusa();
    const m = cenario(t, { antes: posicao(2, 2), depois: posicao(1, 2), falhaDaAuditoriaDaRecusa: new Error('auditoria indisponível') });
    await esperarConflito(servico.registrarBaixa(m.pool, dados({ motivo: 'OUTRO', justificativa: 'x' })));
  });

  test('outras recusas não geram auditoria de saldo livre: saldo do lote insuficiente, lote inexistente e idempotência', async (t) => {
    const semSaldo = cenario(t, { antes: posicao(5, 0), depois: posicao(0, 0), loteLido: lote({ saldo: 2 }) });
    await assert.rejects(servico.registrarBaixa(semSaldo.pool, dados({ quantidade: 3 })), (erro) => erro.codigo === 'SALDO_LOTE_INSUFICIENTE');
    assert.equal(semSaldo.recusa.mock.callCount(), 0);
    t.mock.restoreAll();

    const inexistente = cenario(t, { antes: posicao(5, 0), depois: posicao(0, 0), loteLido: null });
    await assert.rejects(servico.registrarBaixa(inexistente.pool, dados()), (erro) => erro.codigo === 'LOTE_NAO_ENCONTRADO');
    assert.equal(inexistente.recusa.mock.callCount(), 0);
    assert.equal(inexistente.posicoes(), 0, 'sem lote não há posição');
  });
});

describe('a posição é medida uma vez antes e uma vez depois da operação, com as travas já tomadas', () => {
  test('duas leituras da posição por baixa bem-sucedida', async (t) => {
    const m = cenario(t, { antes: posicao(10, 2), depois: posicao(9, 2) });
    await servico.registrarBaixa(m.pool, dados());
    assert.equal(m.posicoes(), 2);
    assert.equal(m.leituras() >= 2, true, 'a leitura sem trava para descobrir o par e a releitura final');
  });

  test('repetição da mesma chave devolve a baixa original sem medir posição nem auditar', async (t) => {
    const hash = await (async () => {
      const prova = cenario(t, { antes: posicao(10, 0), depois: posicao(9, 0) });
      await servico.registrarBaixa(prova.pool, dados());
      const h = prova.baixa.mock.calls[0].arguments[1].requisicaoHash;
      t.mock.restoreAll();
      return h;
    })();
    const original = {
      id: '900', tipo: 'BAIXA', loteId: LOTE, quantidade: 1, motivo: 'AVARIA', justificativa: null, usuarioId: ATOR, criadoEm: new Date(), requisicaoHash: hash,
    };
    const m = cenario(t, { antes: posicao(10, 0), depois: posicao(9, 0), existente: original });
    const r = await servico.registrarBaixa(m.pool, dados());
    assert.equal(r.repetida, true);
    assert.equal(m.posicoes(), 0);
    assert.equal(m.registrar.mock.callCount() + m.baixa.mock.callCount(), 0);
  });
});
