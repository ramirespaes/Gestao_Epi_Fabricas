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

/**
 * 12G-6 — três indicadores derivados das solicitações no Dashboard, sem
 * PostgreSQL real (a integração está em dashboard-solicitacoes.integration.js):
 *   solicitacoesAguardandoSst      PENDENTE, como a fila da Aprovação;
 *                                  APROVAR_SOLICITACAO;
 *   solicitacoesAguardandoEstoque  aprovadas com pendente e NENHUM item com
 *                                  cobertura > 0 agora; REALIZAR_ENTREGA ou
 *                                  ENCERRAR_SOLICITACAO;
 *   disponiveisParaEntrega         aprovadas com pendente e ALGUM item com
 *                                  cobertura > 0 agora; REALIZAR_ENTREGA.
 * As duas últimas são populações exclusivas, contadas numa leitura só da fila.
 * Cada uma pela ação EFETIVA (a mesma avaliação das rotas), nunca pelo perfil;
 * sem a ação, { permitido: false } e a contagem nem roda.
 */

const CONTEXTO = { empresaId: 42, usuarioId: 7, perfil: 'USUARIO', hoje: '2026-10-04' };
const NEGADO = { permitido: false };
const NOVOS = ['solicitacoesAguardandoSst', 'solicitacoesAguardandoEstoque', 'disponiveisParaEntrega'];

function simular(t, { acoes = {}, contagens = { fila: 5, comCobertura: 2, semCobertura: 3 } } = {}) {
  const chamadas = {
    acoes: [], fila: [], porCobertura: [], sql: [], conexoes: 0, liberadas: 0,
  };
  t.mock.method(autorizacao, 'avaliarPermissaoRecurso', async () => ({ visualizar: true }));
  t.mock.method(autorizacao, 'avaliarPermissaoAcao', async (_p, ctx, acao) => { chamadas.acoes.push([ctx, acao]); return acoes[acao] === true; });
  t.mock.method(posicaoRepo, 'resumirPosicoes', async () => ({
    fisicoUtilizavel: 1, paresAbaixoDoMinimo: 0, saldoLivre: 1, comprometido: 0, semCobertura: 3, necessidade: 3,
  }));
  t.mock.method(loteRepo, 'resumirIndicadores', async () => ({ caVencido: 0, caAVencer: 0 }));
  t.mock.method(funcionarioRepo, 'contarPorEmpresa', async () => 9);
  t.mock.method(consultaRepo, 'contarFila', async (executor, empresaId) => { chamadas.fila.push([executor, empresaId]); return contagens.fila; });
  t.mock.method(coberturaRepo, 'contarSolicitacoesPorCobertura', async (executor, empresaId, ref) => {
    chamadas.porCobertura.push([executor, empresaId, ref]);
    return { comCobertura: contagens.comCobertura, semCobertura: contagens.semCobertura };
  });
  const cliente = {
    query: async (sql) => { chamadas.sql.push(sql); return { rows: [] }; },
    release: () => { chamadas.liberadas += 1; },
  };
  const pool = { connect: async () => { chamadas.conexoes += 1; return cliente; } };
  return { chamadas, pool, cliente };
}

describe('dashboard — indicadores das solicitações (12G-6)', () => {
  test('com as três ações: os três números, lidos numa transação só de leitura e REPEATABLE READ, pelo mesmo cliente; estoque e disponíveis numa contagem só', async (t) => {
    const { chamadas, pool, cliente } = simular(t, { acoes: { APROVAR_SOLICITACAO: true, REALIZAR_ENTREGA: true, ENCERRAR_SOLICITACAO: true } });
    const r = await servico.consultar(pool, CONTEXTO);
    assert.deepEqual(r.solicitacoesAguardandoSst, { permitido: true, valor: 5 });
    assert.deepEqual(r.solicitacoesAguardandoEstoque, { permitido: true, valor: 3 });
    assert.deepEqual(r.disponiveisParaEntrega, { permitido: true, valor: 2 });
    assert.equal(chamadas.conexoes, 1);
    assert.equal(chamadas.liberadas, 1);
    assert.match(chamadas.sql[0], /^BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ$/);
    assert.equal(chamadas.sql[chamadas.sql.length - 1], 'COMMIT');
    assert.equal(chamadas.porCobertura.length, 1, 'aguardando estoque e disponíveis saem da mesma contagem');
    for (const lista of [chamadas.fila, chamadas.porCobertura]) {
      assert.equal(lista[0][0], cliente);
      assert.equal(lista[0][1], 42);
    }
    assert.deepEqual(chamadas.porCobertura[0][2], { hoje: '2026-10-04' });
  });

  test('não existe mais o indicador "aguardando entrega" (aprovadas com ou sem cobertura)', async (t) => {
    const { pool } = simular(t, { acoes: { REALIZAR_ENTREGA: true } });
    const r = await servico.consultar(pool, CONTEXTO);
    assert.equal('solicitacoesAguardandoEntrega' in r, false);
  });

  test('a ação é avaliada com o contexto da sessão: empresa, usuário e perfil', async (t) => {
    const { chamadas, pool } = simular(t, { acoes: { REALIZAR_ENTREGA: true } });
    await servico.consultar(pool, CONTEXTO);
    for (const [ctx] of chamadas.acoes) assert.deepEqual(ctx, { empresaId: 42, usuarioId: 7, perfil: 'USUARIO' });
  });

  test('sem nenhuma das ações: os três negados (nunca zero), nenhuma conexão aberta e nenhuma contagem', async (t) => {
    const { chamadas, pool } = simular(t);
    const r = await servico.consultar(pool, CONTEXTO);
    for (const chave of NOVOS) assert.deepEqual(r[chave], NEGADO, chave);
    assert.deepEqual([chamadas.conexoes, chamadas.fila.length, chamadas.porCobertura.length], [0, 0, 0]);
    assert.deepEqual(r.semCobertura, { permitido: true, valor: 3 }, 'Pendências sem estoque continua com a sua fonte');
  });

  test('MASTER sem as ações efetivas também vê só negados: nada é concedido pelo nome do perfil', async (t) => {
    const { pool } = simular(t);
    const r = await servico.consultar(pool, { ...CONTEXTO, perfil: 'MASTER' });
    for (const chave of NOVOS) assert.deepEqual(r[chave], NEGADO, chave);
  });

  test('só REPROVAR_SOLICITACAO não mostra "aguardando SST" (a fila é de quem aprova)', async (t) => {
    const { chamadas, pool } = simular(t, { acoes: { REPROVAR_SOLICITACAO: true } });
    const r = await servico.consultar(pool, CONTEXTO);
    assert.deepEqual(r.solicitacoesAguardandoSst, NEGADO);
    assert.equal(chamadas.fila.length, 0);
  });

  test('só ENCERRAR_SOLICITACAO: "aguardando estoque" sim; "disponíveis para entrega" não (é de quem entrega)', async (t) => {
    const { pool } = simular(t, { acoes: { ENCERRAR_SOLICITACAO: true } });
    const r = await servico.consultar(pool, CONTEXTO);
    assert.deepEqual(r.solicitacoesAguardandoEstoque, { permitido: true, valor: 3 });
    assert.deepEqual(r.disponiveisParaEntrega, NEGADO);
    assert.deepEqual(r.solicitacoesAguardandoSst, NEGADO);
  });

  test('só REALIZAR_ENTREGA: os dois da entrega; "aguardando SST" negado', async (t) => {
    const { pool } = simular(t, { acoes: { REALIZAR_ENTREGA: true } });
    const r = await servico.consultar(pool, CONTEXTO);
    assert.deepEqual(r.solicitacoesAguardandoEstoque, { permitido: true, valor: 3 });
    assert.deepEqual(r.disponiveisParaEntrega, { permitido: true, valor: 2 });
    assert.deepEqual(r.solicitacoesAguardandoSst, NEGADO);
  });

  test('zero de verdade é um número permitido, diferente de negado', async (t) => {
    const { pool } = simular(t, { acoes: { APROVAR_SOLICITACAO: true, REALIZAR_ENTREGA: true }, contagens: { fila: 0, comCobertura: 0, semCobertura: 0 } });
    const r = await servico.consultar(pool, CONTEXTO);
    for (const chave of NOVOS) assert.deepEqual(r[chave], { permitido: true, valor: 0 }, chave);
  });

  test('erro na leitura: ROLLBACK e o cliente é devolvido', async (t) => {
    const { chamadas, pool } = simular(t, { acoes: { APROVAR_SOLICITACAO: true } });
    t.mock.method(consultaRepo, 'contarFila', async () => { throw new Error('falha simulada'); });
    await assert.rejects(servico.consultar(pool, CONTEXTO), /falha simulada/);
    assert.ok(chamadas.sql.includes('ROLLBACK'));
    assert.equal(chamadas.liberadas, 1);
  });
});
