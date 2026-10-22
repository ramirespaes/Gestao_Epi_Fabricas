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
 * 12I (decisão de 21/10/2026): os cartões não ampliam mais e não têm prévia. O Dashboard devolve só o número de cada indicador
 * ({ permitido, valor }); nenhuma lista de cinco registros é montada, e o código que existia só para isso (ordenações opt-in da posição,
 * funcionários mais recentes e solicitações por cobertura com dados do pedido) foi removido. Os números e as permissões não mudam.
 */

const CONTEXTO = { empresaId: 42, usuarioId: 7, perfil: 'USUARIO', hoje: '2026-10-04' };
const RESUMO = { fisicoUtilizavel: 40, saldoLivre: 30, comprometido: 10, semCobertura: 2, paresAbaixoDoMinimo: 3, necessidade: 11 };

function simular(t, { recursos = {}, acoes = {} } = {}) {
  const liberado = { availableItems: true, stockValidity: true, employeeHistory: true, epiFicha: true, ...recursos };
  const proibidas = [];
  t.mock.method(autorizacao, 'avaliarPermissaoRecurso', async (_p, _c, r) => ({ visualizar: liberado[r] === true }));
  t.mock.method(autorizacao, 'avaliarPermissaoAcao', async (_p, _c, a) => acoes[a] === true);
  t.mock.method(posicaoRepo, 'resumirPosicoes', async () => RESUMO);
  t.mock.method(posicaoRepo, 'listarPosicoes', async () => { proibidas.push('listarPosicoes'); return { itens: [], total: 0 }; });
  t.mock.method(loteRepo, 'resumirIndicadores', async () => ({ caVencido: 4, caAVencer: 5 }));
  t.mock.method(funcionarioRepo, 'contarPorEmpresa', async () => 17);
  t.mock.method(consultaRepo, 'contarFila', async () => 5);
  t.mock.method(relatorioSvc, 'unidadesEntregues', async () => 31);
  t.mock.method(relatorioSvc, 'contarProximoVencimento', async () => 8);
  t.mock.method(coberturaRepo, 'contarSolicitacoesPorCobertura', async () => ({ comCobertura: 2, semCobertura: 3, coberturaCompleta: 2 }));
  const cliente = { query: async () => ({ rows: [] }), release() {} };
  return { proibidas, pool: { connect: async () => cliente, query: async () => ({ rows: [] }) } };
}

describe('dashboard.service — só números, sem prévia (12I)', () => {
  test('todos os indicadores permitidos trazem só { permitido, valor } (CA vencido, a mais, aVencer e diasAlerta); nenhum traz previa', async (t) => {
    const { pool, proibidas } = simular(t, { acoes: { APROVAR_SOLICITACAO: true, REALIZAR_ENTREGA: true, ENCERRAR_SOLICITACAO: true } });
    const r = await servico.consultar(pool, CONTEXTO);
    assert.deepEqual(r, {
      itensDisponiveis: { permitido: true, valor: 40 },
      estoqueAbaixoMinimo: { permitido: true, valor: 3 },
      saldoLivre: { permitido: true, valor: 30 },
      comprometido: { permitido: true, valor: 10 },
      semCobertura: { permitido: true, valor: 2 },
      necessidadeReposicao: { permitido: true, valor: 11 },
      caVencido: { permitido: true, valor: 4, aVencer: 5, diasAlerta: 60 },
      funcionariosAtivos: { permitido: true, valor: 17 },
      solicitacoesAguardandoSst: { permitido: true, valor: 5 },
      solicitacoesAguardandoEstoque: { permitido: true, valor: 3 },
      disponiveisParaEntrega: { permitido: true, valor: 2 },
      episEntregues: { permitido: true, valor: 31, de: '2026-10-01', ate: '2026-10-31' },
      proximoVencimentoUso: { permitido: true, valor: 8 },
    });
    assert.deepEqual(proibidas, [], 'nenhuma lista da posição é consultada');
    assert.equal(JSON.stringify(r).includes('previa'), false);
  });

  test('sem permissão continua { permitido: false } em cada fonte', async (t) => {
    const { pool } = simular(t, { recursos: { availableItems: false, stockValidity: false, employeeHistory: false, epiFicha: false } });
    const r = await servico.consultar(pool, CONTEXTO);
    for (const v of Object.values(r)) assert.deepEqual(v, { permitido: false });
  });
});

describe('código que existia só para a prévia foi removido', () => {
  test('funcionarioRepo.listarRecentesAtivos e coberturaRepo.listarSolicitacoesPorCobertura não existem mais; o filtro por cobertura das listas (ids) continua', () => {
    assert.equal(funcionarioRepo.listarRecentesAtivos, undefined);
    assert.equal(coberturaRepo.listarSolicitacoesPorCobertura, undefined);
    assert.equal(typeof coberturaRepo.idsDeSolicitacoesPorCobertura, 'function');
    assert.equal(typeof coberturaRepo.contarSolicitacoesPorCobertura, 'function');
  });

  test('listarPosicoes não aceita mais ordem opt-in: só a ordem padrão (nome, material, tamanho) e o mesmo SQL para qualquer chamada', async () => {
    const chamadas = [];
    const ex = { query: async (texto) => { chamadas.push(texto); return { rows: [{ total: 0, material_id: null }] }; } };
    const base = { hoje: '2026-10-02', diasAlerta: 60, pagina: 1, limite: 5 };
    await posicaoRepo.listarPosicoes(ex, 42, base);
    await posicaoRepo.listarPosicoes(ex, 42, { ...base, ordem: 'DEFICIT_DESC' });
    assert.equal(chamadas[0], chamadas[1], 'a chave `ordem` é ignorada, não escolhe SQL');
    assert.equal(/DESC,\s*lower\(nome\)/i.test(chamadas[0]), false);
    assert.match(chamadas[0], /ORDER BY lower\(nome\),\s*material_id,\s*tamanho_chave/);
  });
});
