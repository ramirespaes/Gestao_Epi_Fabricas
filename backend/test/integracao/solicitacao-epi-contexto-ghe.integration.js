'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { montarAmbiente12f } = require('./helpers/ambiente-http-12f');
const {
  criarGhe, criarFuncionario, criarMaterial,
} = require('./helpers/entrega-epi');
const { criarLoteDeEntrada } = require('./helpers/solicitacao-epi');
const { vincularMaterialAoGhe, chaveNova } = require('./helpers/solicitacao-epi-servico');

/**
 * Validação visual da 12G-2: o trabalhador tem GHE ativo com cinco EPIs ativos
 * vinculados, e o Pedido de EPI dizia que nenhum EPI estava previsto. Os
 * materiais que já existiam antes da 044 ficaram com `exige_tamanho` nulo (não
 * classificados), e o contexto escondia todo material não classificado, então
 * os vínculos do GHE sumiam. O direito vem do GHE: o contexto devolve os EPIs
 * ativos vinculados, inclusive os ainda não classificados (`exigeTamanho: null`,
 * para a tela explicar por que não podem ser pedidos); a criação continua
 * recusando o não classificado. Estoque nunca é critério.
 */

const materiaisDe = (funcionarioId) => `/api/solicitacoes-epi/contexto/${funcionarioId}/materiais?previstoNoGhe=true&pagina=1&limite=100`;

describe('contexto do Pedido de EPI — EPIs do GHE do trabalhador (PostgreSQL real)', () => {
  let env;
  let pool;
  let d;
  let como;
  let criador;
  let criadorB;
  const g = {};
  const t = {};
  const m = {};

  before(async () => {
    env = await montarAmbiente12f();
    ({ pool, d, como } = env);
    const A = d.empresaA;
    const B = d.empresaB;
    criador = await env.usuarioCom(A, { recursos: { request: ['visualizar', 'criar'] } });
    criadorB = await env.usuarioCom(B, { recursos: { request: ['criar'] } });

    g.teste = await criarGhe(pool, A, 'GHE TESTE 12G2');
    g.vazio = await criarGhe(pool, A, 'GHE SEM VINCULOS 12G2');
    g.daB = await criarGhe(pool, B, 'GHE DA OUTRA 12G2');
    t.comGhe = await criarFuncionario(pool, A, { matricula: 'TESTE-12G2-001', cpf: '81000000001', gheId: g.teste });
    t.semGhe = await criarFuncionario(pool, A, { matricula: 'TESTE-12G2-002', cpf: '81000000002' });
    t.gheVazio = await criarFuncionario(pool, A, { matricula: 'TESTE-12G2-003', cpf: '81000000003', gheId: g.vazio });
    t.daB = await criarFuncionario(pool, B, { matricula: 'TESTE-12G2-001', cpf: '81000000004', gheId: g.daB });

    // Os cinco EPIs do caso real: ativos, vinculados ao GHE, sem classificação de tamanho (como a 044 deixou) e sem estoque.
    m.legados = [];
    for (const nome of ['BOTINA DE SEGURANÇA — TESTE C2', 'BOTINA DE SEGURANÇA — TESTE VALIDADE C3', 'OTINA DE SEGURANÇA — TESTE VALIDADE C3', 'Botina teste', 'Botina teste ramires']) {
      const id = await criarMaterial(pool, A, nome, { exigeTamanho: null, unidade: 'par' });
      await vincularMaterialAoGhe(pool, A, g.teste, id);
      m.legados.push(id);
    }
    m.classificadoSemEstoque = await criarMaterial(pool, A, 'Luva classificada sem estoque 12G2', { exigeTamanho: true, unidade: 'par' });
    await vincularMaterialAoGhe(pool, A, g.teste, m.classificadoSemEstoque);
    m.zerado = await criarMaterial(pool, A, 'Capacete com lote zerado 12G2', { exigeTamanho: false });
    await vincularMaterialAoGhe(pool, A, g.teste, m.zerado);
    const lote = await criarLoteDeEntrada(pool, { empresaId: A, materialId: m.zerado, quantidade: 1, usuarioId: d.master, tamanho: null });
    await env.f.baixa(lote, 1, 'AVARIA');
    assert.equal((await env.f.lote(lote)).saldo, 0, 'o lote ficou zerado');
    m.inativo = await criarMaterial(pool, A, 'Botina inativa do GHE 12G2', { exigeTamanho: null, ativo: false });
    await vincularMaterialAoGhe(pool, A, g.teste, m.inativo);
    m.foraDoGhe = await criarMaterial(pool, A, 'Botina fora do GHE 12G2', { exigeTamanho: null });
    m.daB = await criarMaterial(pool, B, 'Botina da outra empresa 12G2', { exigeTamanho: null });
    await vincularMaterialAoGhe(pool, B, g.daB, m.daB);
  });

  after(async () => { if (env) await env.encerrar(); });

  test('o caso da validação: GHE ativo com cinco EPIs ativos vinculados e sem classificação de tamanho — os cinco vêm, marcados como não classificados', async () => {
    const r = await como(criador).get(materiaisDe(t.comGhe));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const porId = new Map(r.body.materiais.map((x) => [x.id, x]));
    for (const id of m.legados) {
      assert.ok(porId.has(id), `EPI ${id} do GHE sumiu do contexto: ${JSON.stringify(r.body)}`);
      assert.deepEqual([porId.get(id).previstoNoGhe, porId.get(id).exigeTamanho, porId.get(id).tamanhosSugeridos], [true, null, []]);
    }
  });

  test('estoque não é critério: o EPI classificado sem lote e o de lote zerado continuam permitidos', async () => {
    const r = await como(criador).get(materiaisDe(t.comGhe));
    const porId = new Map(r.body.materiais.map((x) => [x.id, x]));
    assert.deepEqual([porId.get(m.classificadoSemEstoque).exigeTamanho, porId.get(m.zerado).exigeTamanho], [true, false]);
  });

  test('só os vínculos do GHE: os sete EPIs ativos dele e nada mais (sem o inativo, sem o de fora do GHE, sem o da outra empresa); o total confere', async () => {
    const r = await como(criador).get(materiaisDe(t.comGhe));
    const esperados = [...m.legados, m.classificadoSemEstoque, m.zerado].sort((a, b) => a - b);
    assert.deepEqual(r.body.materiais.map((x) => x.id).sort((a, b) => a - b), esperados);
    assert.equal(r.body.total, esperados.length);
    assert.ok(r.body.materiais.every((x) => x.previstoNoGhe === true));
  });

  test('trabalhador sem GHE e GHE sem vínculos: nenhum EPI, sem catálogo como alternativa', async () => {
    for (const funcionario of [t.semGhe, t.gheVazio]) {
      const r = await como(criador).get(materiaisDe(funcionario));
      assert.deepEqual([r.status, r.body.materiais, r.body.total], [200, [], 0], String(funcionario));
    }
  });

  test('outra empresa não vaza: o trabalhador dela é 404 aqui, e lá só aparece o EPI do GHE dela', async () => {
    const aqui = await como(criador).get(materiaisDe(t.daB));
    assert.deepEqual([aqui.status, aqui.body.codigo], [404, 'FUNCIONARIO_NAO_ENCONTRADO']);
    const la = await como(criadorB).get(materiaisDe(t.daB));
    assert.deepEqual(la.body.materiais.map((x) => x.id), [m.daB]);
  });

  test('a regra da criação continua: EPI do GHE ainda não classificado é recusado com 409 MATERIAL_TAMANHO_NAO_CLASSIFICADO', async () => {
    const r = await como(criador).post('/api/solicitacoes-epi', {
      funcionarioId: t.comGhe,
      itens: [{ materialId: m.legados[0], tamanho: null, quantidade: 1, motivo: 'ADMISSAO', justificativa: null }],
      observacao: null,
      chaveIdempotencia: chaveNova(),
    });
    assert.deepEqual([r.status, r.body.codigo], [409, 'MATERIAL_TAMANHO_NAO_CLASSIFICADO']);
  });
});
