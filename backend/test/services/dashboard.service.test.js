'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const servico = require('../../src/services/dashboard.service');
const autorizacao = require('../../src/middleware/autorizacao');
const loteRepo = require('../../src/repositories/estoque-lote.repository');
const posicaoRepo = require('../../src/repositories/posicao-estoque.repository');
const funcionarioRepo = require('../../src/repositories/funcionario.repository');

/**
 * Indicadores do dashboard (C6 e 12D-2), sem PostgreSQL real. O estoque sai da
 * MESMA posição por par da lista de Itens Disponíveis (resumirPosicoes): o
 * físico utilizável agregado, o saldo livre, o comprometido, a demanda sem
 * cobertura, a necessidade de reposição e os pares abaixo do mínimo, medido
 * contra o saldo livre. Cada indicador só sai se o usuário vê a fonte.
 */

const CONTEXTO = { empresaId: 42, usuarioId: 7, perfil: 'USUARIO', hoje: '2026-10-02' };

const RESUMO = {
  pares: 6, fisicoUtilizavel: 40, demandaPendente: 12, comprometido: 10, saldoLivre: 30, semCobertura: 2, paresAbaixoDoMinimo: 3, deficit: 9, necessidade: 11,
};

function simular(t, { fontes = {}, resumo = RESUMO, validade = { caVencido: 4, caAVencer: 5 } } = {}) {
  const permissoes = { availableItems: true, stockValidity: true, employeeHistory: true, ...fontes };
  const chamadas = { recursos: [], posicao: [], validade: [], funcionarios: [] };
  t.mock.method(autorizacao, 'avaliarPermissaoRecurso', async (_p, ctx, recurso) => { chamadas.recursos.push([ctx, recurso]); return { visualizar: permissoes[recurso] === true }; });
  t.mock.method(posicaoRepo, 'resumirPosicoes', async (_p, empresaId, ref) => { chamadas.posicao.push([empresaId, ref]); return resumo; });
  t.mock.method(loteRepo, 'resumirIndicadores', async (_p, empresaId, ref) => { chamadas.validade.push([empresaId, ref]); return validade; });
  t.mock.method(funcionarioRepo, 'contarPorEmpresa', async (_p, empresaId, f) => { chamadas.funcionarios.push([empresaId, f]); return 17; });
  return chamadas;
}

describe('dashboard.service.consultar — estoque pela posição (12D-2)', () => {
  test('com todas as fontes: físico utilizável, abaixo do mínimo (pelo livre), L, C, G e a necessidade de reposição vêm da posição', async (t) => {
    const chamadas = simular(t);
    const r = await servico.consultar({}, CONTEXTO);
    assert.deepEqual(r, {
      itensDisponiveis: { permitido: true, valor: 40 },
      estoqueAbaixoMinimo: { permitido: true, valor: 3 },
      saldoLivre: { permitido: true, valor: 30 },
      comprometido: { permitido: true, valor: 10 },
      semCobertura: { permitido: true, valor: 2 },
      necessidadeReposicao: { permitido: true, valor: 11 },
      caVencido: { permitido: true, valor: 4, aVencer: 5, diasAlerta: 60 },
      funcionariosAtivos: { permitido: true, valor: 17 },
    });
    assert.deepEqual(chamadas.posicao, [[42, { hoje: '2026-10-02' }]]);
    assert.deepEqual(chamadas.validade, [[42, { hoje: '2026-10-02', diasAlerta: 60 }]]);
  });

  test('itensDisponiveis mantém o significado do físico utilizável agregado, nunca o saldo livre', async (t) => {
    simular(t, { resumo: { ...RESUMO, fisicoUtilizavel: 40, saldoLivre: 30 } });
    const r = await servico.consultar({}, CONTEXTO);
    assert.equal(r.itensDisponiveis.valor, 40);
    assert.equal(r.saldoLivre.valor, 30);
  });

  test('sem availableItems: NENHUM número de estoque sai (cinco indicadores negados) e a posição nem é consultada', async (t) => {
    const chamadas = simular(t, { fontes: { availableItems: false } });
    const r = await servico.consultar({}, CONTEXTO);
    for (const chave of ['itensDisponiveis', 'estoqueAbaixoMinimo', 'saldoLivre', 'comprometido', 'semCobertura', 'necessidadeReposicao']) {
      assert.deepEqual(r[chave], { permitido: false }, chave);
    }
    assert.deepEqual(r.caVencido, { permitido: true, valor: 4, aVencer: 5, diasAlerta: 60 });
    assert.equal(chamadas.posicao.length, 0);
    assert.ok(!JSON.stringify(r).includes('"valor":40') && !JSON.stringify(r).includes('"valor":30'), 'nenhum número da posição vaza');
  });

  test('sem stockValidity: o CA é negado e a consulta de validade nem roda; o estoque segue', async (t) => {
    const chamadas = simular(t, { fontes: { stockValidity: false } });
    const r = await servico.consultar({}, CONTEXTO);
    assert.deepEqual(r.caVencido, { permitido: false });
    assert.equal(chamadas.validade.length, 0);
    assert.deepEqual(r.itensDisponiveis, { permitido: true, valor: 40 });
  });

  test('sem nenhuma fonte de estoque nem validade, nenhuma das duas agregações roda', async (t) => {
    const chamadas = simular(t, { fontes: { availableItems: false, stockValidity: false, employeeHistory: false } });
    const r = await servico.consultar({}, CONTEXTO);
    assert.equal(chamadas.posicao.length + chamadas.validade.length + chamadas.funcionarios.length, 0);
    assert.ok(Object.values(r).every((x) => x.permitido === false));
  });

  test('zeros sem dados: empresa sem nenhum par devolve zeros permitidos, não negados', async (t) => {
    simular(t, {
      resumo: {
        pares: 0, fisicoUtilizavel: 0, demandaPendente: 0, comprometido: 0, saldoLivre: 0, semCobertura: 0, paresAbaixoDoMinimo: 0, deficit: 0, necessidade: 0,
      },
      validade: { caVencido: 0, caAVencer: 0 },
    });
    const r = await servico.consultar({}, CONTEXTO);
    for (const chave of ['itensDisponiveis', 'estoqueAbaixoMinimo', 'saldoLivre', 'comprometido', 'semCobertura', 'necessidadeReposicao']) {
      assert.deepEqual(r[chave], { permitido: true, valor: 0 }, chave);
    }
  });

  test('a permissão é avaliada pelas mesmas funções do RBAC, com a empresa, o usuário e o perfil da sessão', async (t) => {
    const chamadas = simular(t);
    await servico.consultar({}, CONTEXTO);
    assert.deepEqual(chamadas.recursos.map(([, recurso]) => recurso).sort(), ['availableItems', 'employeeHistory', 'stockValidity']);
    for (const [ctx] of chamadas.recursos) assert.deepEqual(ctx, { empresaId: 42, usuarioId: 7, perfil: 'USUARIO' });
  });

  test('entradas inválidas são erro de programação, antes de consultar', async (t) => {
    const chamadas = simular(t);
    for (const extra of [{ empresaId: 0 }, { usuarioId: 0 }, { perfil: '' }, { hoje: '2026-02-30' }]) {
      await assert.rejects(() => servico.consultar({}, { ...CONTEXTO, ...extra }), TypeError, JSON.stringify(extra));
    }
    assert.equal(chamadas.recursos.length, 0);
  });
});
