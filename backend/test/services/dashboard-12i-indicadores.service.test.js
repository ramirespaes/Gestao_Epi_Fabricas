'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const servico = require('../../src/services/dashboard.service');
const autorizacao = require('../../src/middleware/autorizacao');
const loteRepo = require('../../src/repositories/estoque-lote.repository');
const posicaoRepo = require('../../src/repositories/posicao-estoque.repository');
const funcionarioRepo = require('../../src/repositories/funcionario.repository');
const consultaRepo = require('../../src/repositories/solicitacao-epi-consulta.repository');
const coberturaRepo = require('../../src/repositories/solicitacao-epi-cobertura.repository');
const relatorioSvc = require('../../src/services/relatorio.service');

/**
 * 12I (21/10/2026) — indicadores corrigidos e integrados (RED), sem PostgreSQL real:
 *   - "Solicitações aguardando aprovação" é UM indicador só (solicitacoesAguardandoSst: a fila PENDENTE, APROVAR_SOLICITACAO); o indicador de
 *     "aguardando entrega" criado antes deixou de existir (contava os mesmos pedidos que a fila de entregas, não a aprovação);
 *   - "Disponíveis para entrega" = só a cobertura COMPLETA;
 *   - "EPIs entregues" = soma das unidades do mês corrente (São Paulo) pelo serviço dos relatórios, com o período devolvido para o link;
 *   - "Próximo do vencimento de uso" = o total da aba do relatório (janela de 30 dias).
 * Os dois últimos exigem epiFicha.visualizar, a permissão das abas do relatório.
 */

const CONTEXTO = { empresaId: 42, usuarioId: 7, perfil: 'USUARIO', hoje: '2026-10-21' };
const NEGADO = { permitido: false };

function simular(t, { recursos = {}, acoes = {} } = {}) {
  const liberado = { availableItems: true, stockValidity: true, employeeHistory: true, epiFicha: true, ...recursos };
  const chamadas = { unidades: [], proximo: [] };
  t.mock.method(autorizacao, 'avaliarPermissaoRecurso', async (_p, _c, r) => ({ visualizar: liberado[r] === true }));
  t.mock.method(autorizacao, 'avaliarPermissaoAcao', async (_p, _c, a) => acoes[a] === true);
  t.mock.method(posicaoRepo, 'resumirPosicoes', async () => ({ fisicoUtilizavel: 1, paresAbaixoDoMinimo: 0, saldoLivre: 1, comprometido: 0, semCobertura: 0, necessidade: 0 }));
  t.mock.method(loteRepo, 'resumirIndicadores', async () => ({ caVencido: 0, caAVencer: 0 }));
  t.mock.method(funcionarioRepo, 'contarPorEmpresa', async () => 0);
  t.mock.method(consultaRepo, 'contarFila', async () => 5);
  t.mock.method(coberturaRepo, 'contarSolicitacoesPorCobertura', async () => ({ comCobertura: 9, semCobertura: 3, coberturaCompleta: 2 }));
  t.mock.method(relatorioSvc, 'unidadesEntregues', async (...a) => { chamadas.unidades.push(a); return 31; });
  t.mock.method(relatorioSvc, 'contarProximoVencimento', async (...a) => { chamadas.proximo.push(a); return 8; });
  return { chamadas, pool: { connect: async () => ({ query: async () => ({ rows: [] }), release() {} }), query: async () => ({ rows: [] }) } };
}

describe('Solicitações aguardando aprovação: um indicador só, a fila de aprovação', () => {
  test('solicitacoesAguardandoSst é a fila PENDENTE (APROVAR_SOLICITACAO) e não existe indicador de "aguardando entrega"', async (t) => {
    const { pool } = simular(t, { acoes: { APROVAR_SOLICITACAO: true, REALIZAR_ENTREGA: true } });
    const r = await servico.consultar(pool, CONTEXTO);
    assert.deepEqual(r.solicitacoesAguardandoSst, { permitido: true, valor: 5 });
    assert.equal('solicitacoesAguardandoEntrega' in r, false, 'sem segundo indicador contando as mesmas solicitações');
  });

  test('sem APROVAR_SOLICITACAO fica negado, mesmo para quem entrega ou encerra (nenhuma permissão é concedida para tornar o cartão visível)', async (t) => {
    const { pool } = simular(t, { acoes: { REALIZAR_ENTREGA: true, ENCERRAR_SOLICITACAO: true } });
    assert.deepEqual((await servico.consultar(pool, CONTEXTO)).solicitacoesAguardandoSst, NEGADO);
  });
});

describe('Disponíveis para entrega: só a cobertura completa', () => {
  test('o valor é coberturaCompleta (2), não "algum item coberto" (9); aguardando estoque segue pela regra de antes (3)', async (t) => {
    const { pool } = simular(t, { acoes: { REALIZAR_ENTREGA: true } });
    const r = await servico.consultar(pool, CONTEXTO);
    assert.deepEqual(r.disponiveisParaEntrega, { permitido: true, valor: 2 });
    assert.deepEqual(r.solicitacoesAguardandoEstoque, { permitido: true, valor: 3 });
  });
});

describe('EPIs entregues: unidades do mês corrente pelo serviço dos relatórios', () => {
  test('soma as unidades de 1º ao último dia do mês da data operacional (SP) da empresa da sessão e devolve o período para o link', async (t) => {
    const { pool, chamadas } = simular(t);
    const r = await servico.consultar(pool, CONTEXTO);
    assert.deepEqual(r.episEntregues, { permitido: true, valor: 31, de: '2026-10-01', ate: '2026-10-31' });
    assert.deepEqual(chamadas.unidades[0].slice(1), [{ empresaId: 42, de: '2026-10-01', ate: '2026-10-31' }]);
  });

  test('o último dia do mês é o certo em meses de 28, 29, 30 e 31 dias e na virada de ano', async (t) => {
    for (const [hoje, de, ate] of [['2026-02-10', '2026-02-01', '2026-02-28'], ['2028-02-29', '2028-02-01', '2028-02-29'], ['2026-04-30', '2026-04-01', '2026-04-30'], ['2026-12-31', '2026-12-01', '2026-12-31']]) {
      const { pool } = simular(t);
      const r = await servico.consultar(pool, { ...CONTEXTO, hoje });
      assert.deepEqual([r.episEntregues.de, r.episEntregues.ate], [de, ate], hoje);
      t.mock.restoreAll();
    }
  });

  test('sem epiFicha.visualizar: negado e nenhuma soma roda', async (t) => {
    const { pool, chamadas } = simular(t, { recursos: { epiFicha: false } });
    const r = await servico.consultar(pool, CONTEXTO);
    assert.deepEqual(r.episEntregues, NEGADO);
    assert.equal(chamadas.unidades.length, 0);
  });
});

describe('Próximo do vencimento de uso: o total da aba do relatório', () => {
  test('conta pelo serviço dos relatórios (janela de 30 dias), empresa da sessão', async (t) => {
    const { pool, chamadas } = simular(t);
    const r = await servico.consultar(pool, CONTEXTO);
    assert.deepEqual(r.proximoVencimentoUso, { permitido: true, valor: 8 });
    assert.deepEqual(chamadas.proximo[0].slice(1), [{ empresaId: 42 }]);
  });

  test('sem epiFicha.visualizar: negado e nenhuma contagem roda', async (t) => {
    const { pool, chamadas } = simular(t, { recursos: { epiFicha: false } });
    assert.deepEqual((await servico.consultar(pool, CONTEXTO)).proximoVencimentoUso, NEGADO);
    assert.equal(chamadas.proximo.length, 0);
  });
});
