'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { exigirModulo } = require('../helpers/exigir-modulo');
const {
  todasAsMigrations, criarEmpresa, criarUsuario, criarFuncionario, criarMaterial, criarLote,
} = require('./helpers/entrega-epi');
const { criarSolicitacaoAprovada, criarLoteDeEntrada, baixarLote } = require('./helpers/solicitacao-epi');

/**
 * Posição de TODOS os pares (empresa, material, tamanho), com PostgreSQL real
 * (12D-1). O universo é a união de: pares com lote (inclusive esgotado), pares
 * com demanda aprovada pendente, pares com mínimo próprio e o par (material,
 * sem tamanho) de material ativo que não usa tamanho e tem mínimo padrão > 0.
 * Só material ATIVO entra. Por par: U físico utilizável, D demanda pendente,
 * C = min(U, D), L = max(0, U − D), G = max(0, D − U), mínimo efetivo (o
 * próprio, mesmo 0, ou o padrão do material), déficit = max(0, mínimo − L),
 * necessidade = G + déficit, abaixo do mínimo = mínimo > 0 e L < mínimo.
 */

const repo = () => exigirModulo('src/repositories/posicao-estoque.repository');
const HOJE = '2026-10-02';
const REFERENCIA = { hoje: HOJE, diasAlerta: 60 };

describe('posição de todos os pares — PostgreSQL real', () => {
  let contexto;
  let pool;
  let d;
  let n = 0;
  let sequenciaCnpj = 0;

  const q = (sql, params) => pool.query(sql, params);
  const proximo = () => { n += 1; return n; };

  async function novaEmpresa(nome) {
    sequenciaCnpj += 1;
    const empresaId = await criarEmpresa(pool, String(30000000000000 + sequenciaCnpj), nome);
    const solicitante = await criarUsuario(pool, empresaId, `solicitante-${empresaId}@example.invalid`);
    const aprovador = await criarUsuario(pool, empresaId, `aprovador-${empresaId}@example.invalid`);
    const trabalhador = await criarFuncionario(pool, empresaId, { matricula: 'T-1', cpf: String(10000000000 + empresaId) });
    return { empresaId, solicitante, aprovador, trabalhador };
  }

  async function material(e, { nome = null, exigeTamanho = true, exigeCa = true, padrao = 0, ativo = true } = {}) {
    const rotulo = nome ?? `Material ${proximo()}`;
    const id = await criarMaterial(pool, e.empresaId, rotulo, { exigeTamanho, exigeCa, ativo });
    await q('UPDATE materiais SET estoque_minimo = $1 WHERE id = $2', [padrao, id]);
    return { id, nome: rotulo };
  }

  const lote = (e, m, quantidade, extra = {}) => criarLote(pool, { empresaId: e.empresaId, materialId: m.id, quantidade, ...extra });
  const minimoProprio = (e, m, tamanho, minimo) => q('INSERT INTO estoque_minimos (empresa_id, material_id, tamanho, minimo) VALUES ($1, $2, $3, $4)', [e.empresaId, m.id, tamanho, minimo]);

  async function demanda(e, m, tamanho, quantidade, funcionarioId = e.trabalhador) {
    return criarSolicitacaoAprovada(pool, { empresaA: e.empresaId, aprovador: e.aprovador, solicitante: e.solicitante }, {
      empresaId: e.empresaId,
      funcionarioId,
      solicitanteId: e.solicitante,
      itens: [{ material_id: m.id, tamanho, quantidade, motivo: 'ADMISSAO' }],
    });
  }

  // A lista inteira de um material, achada pelo nome único dele.
  async function par(e, m, tamanho) {
    const { itens } = await repo().listarPosicoes(pool, e.empresaId, { ...REFERENCIA, busca: m.nome, pagina: 1, limite: 100 });
    return itens.find((i) => i.materialId === m.id && i.tamanho === tamanho) ?? null;
  }

  const numeros = (p) => [p.fisicoUtilizavel, p.demandaPendente, p.comprometido, p.saldoLivre, p.semCobertura];

  before(async () => {
    exigirModulo('src/repositories/posicao-estoque.repository');
    contexto = await abrirPoolTemporario(todasAsMigrations());
    pool = contexto.pool;
    d = await novaEmpresa('Empresa A');
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  describe('as fórmulas', () => {
    test('U5 D2 mínimo 5: C2 L3 G0, déficit 2, necessidade 2, abaixo do mínimo (o mínimo é comparado com o livre, não com o físico)', async () => {
      const m = await material(d, { padrao: 5 });
      await lote(d, m, 5, { tamanho: 'P' });
      await demanda(d, m, 'P', 2);
      const p = await par(d, m, 'P');
      assert.deepEqual(numeros(p), [5, 2, 2, 3, 0]);
      assert.deepEqual([p.estoqueMinimo, p.abaixoDoMinimo, p.deficit, p.necessidade], [5, true, 2, 2]);
    });

    test('U0 D2 mínimo 5: C0 L0 G2, déficit 5, necessidade 7', async () => {
      const m = await material(d, { padrao: 5 });
      await demanda(d, m, 'P', 2);
      const p = await par(d, m, 'P');
      assert.deepEqual(numeros(p), [0, 2, 0, 0, 2]);
      assert.deepEqual([p.estoqueMinimo, p.abaixoDoMinimo, p.deficit, p.necessidade], [5, true, 5, 7]);
    });

    test('livre exatamente no mínimo não está abaixo (3 livres, mínimo 3); sem mínimo nunca está abaixo, mesmo com físico zero', async () => {
      const exato = await material(d, { padrao: 3 });
      await lote(d, exato, 5, { tamanho: 'P' });
      await demanda(d, exato, 'P', 2);
      const p = await par(d, exato, 'P');
      assert.deepEqual([p.saldoLivre, p.abaixoDoMinimo, p.deficit, p.necessidade], [3, false, 0, 0]);

      const semMinimo = await material(d, { padrao: 0 });
      await lote(d, semMinimo, 1, { tamanho: 'P' });
      await baixarLote(pool, { empresaId: d.empresaId, loteId: (await q('SELECT id FROM estoque_lotes WHERE material_id = $1', [semMinimo.id])).rows[0].id, quantidade: 1, usuarioId: d.solicitante });
      const zero = await par(d, semMinimo, 'P');
      assert.deepEqual([zero.fisicoUtilizavel, zero.abaixoDoMinimo, zero.deficit, zero.necessidade], [0, false, 0, 0]);
    });

    test('a demanda sem cobertura entra na necessidade mesmo sem mínimo: G + déficit', async () => {
      const m = await material(d, { padrao: 0 });
      await lote(d, m, 1, { tamanho: 'P' });
      await demanda(d, m, 'P', 4);
      const p = await par(d, m, 'P');
      assert.deepEqual(numeros(p), [1, 4, 1, 0, 3]);
      assert.deepEqual([p.deficit, p.necessidade, p.abaixoDoMinimo], [0, 3, false]);
    });
  });

  describe('o universo dos pares: os quatro casos obrigatórios', () => {
    test('A) U = 0 e D > 0: o par aparece, sem lote e sem mínimo próprio', async () => {
      const m = await material(d, { padrao: 0 });
      await demanda(d, m, 'M', 3);
      const p = await par(d, m, 'M');
      assert.ok(p, 'o par com demanda e sem estoque tem de aparecer');
      assert.deepEqual([...numeros(p), p.saldo, p.bloqueado], [0, 3, 0, 0, 3, 0, 0]);
    });

    test('B) U = 0, D = 0 e mínimo próprio > 0: o par aparece só pelo mínimo próprio', async () => {
      const m = await material(d, { padrao: 2 });
      await minimoProprio(d, m, 'G', 8);
      const p = await par(d, m, 'G');
      assert.ok(p, 'o par com mínimo próprio e sem lote nem demanda tem de aparecer');
      assert.deepEqual(numeros(p), [0, 0, 0, 0, 0]);
      assert.deepEqual([p.estoqueMinimo, p.minimoOrigem, p.abaixoDoMinimo, p.deficit, p.necessidade], [8, 'PROPRIO', true, 8, 8]);
    });

    test('C) material sem tamanho, mínimo padrão > 0, sem lote e sem demanda: o par aparece com tamanho null', async () => {
      const m = await material(d, { exigeTamanho: false, padrao: 4 });
      const p = await par(d, m, null);
      assert.ok(p, 'o par do material sem tamanho com mínimo padrão tem de aparecer');
      assert.deepEqual(numeros(p), [0, 0, 0, 0, 0]);
      assert.deepEqual([p.tamanho, p.estoqueMinimo, p.minimoOrigem, p.deficit, p.abaixoDoMinimo], [null, 4, 'PADRAO', 4, true]);
    });

    test('D) tamanho que existe em lote, sem mínimo próprio: herda o mínimo padrão', async () => {
      const m = await material(d, { padrao: 20 });
      await lote(d, m, 5, { tamanho: 'M' });
      const p = await par(d, m, 'M');
      assert.deepEqual([p.estoqueMinimo, p.minimoOrigem, p.saldoLivre, p.abaixoDoMinimo, p.deficit], [20, 'PADRAO', 5, true, 15]);
    });

    test('material sem tamanho com mínimo padrão 0, sem lote e sem demanda: não entra (nada a mostrar)', async () => {
      const m = await material(d, { exigeTamanho: false, padrao: 0 });
      assert.equal(await par(d, m, null), null);
    });

    test('material ainda não classificado (exige_tamanho NULL) só aparece pelo que tem: lote ou demanda, não pelo padrão', async () => {
      const m = await material(d, { exigeTamanho: null, padrao: 6 });
      assert.equal(await par(d, m, null), null, 'sem lote nem demanda, o tamanho é desconhecido');
      await lote(d, m, 2, { tamanho: null });
      const p = await par(d, m, null);
      assert.deepEqual([p.fisicoUtilizavel, p.estoqueMinimo, p.minimoOrigem], [2, 6, 'PADRAO']);
    });

    test('lote esgotado mantém o tamanho na lista (saldo 0), como na leitura de itens disponíveis', async () => {
      const m = await material(d, { padrao: 1 });
      await lote(d, m, 3, { tamanho: 'P' });
      const { id } = (await q('SELECT id FROM estoque_lotes WHERE material_id = $1', [m.id])).rows[0];
      await baixarLote(pool, { empresaId: d.empresaId, loteId: id, quantidade: 3, usuarioId: d.solicitante });
      const p = await par(d, m, 'P');
      assert.deepEqual([p.saldo, p.fisicoUtilizavel, p.abaixoDoMinimo], [0, 0, true]);
    });
  });

  describe('o mínimo efetivo: padrão e sobrescrita por tamanho', () => {
    test('Luva padrão 20: P = 10, M = 30, G = 15 próprios, GG herda 20', async () => {
      const m = await material(d, { padrao: 20 });
      for (const [tamanho, minimo] of [['P', 10], ['M', 30], ['G', 15]]) {
        await minimoProprio(d, m, tamanho, minimo);
        await lote(d, m, 12, { tamanho });
      }
      await lote(d, m, 12, { tamanho: 'GG' });
      const efetivos = {};
      for (const tamanho of ['P', 'M', 'G', 'GG']) {
        const p = await par(d, m, tamanho);
        efetivos[tamanho] = [p.estoqueMinimo, p.minimoOrigem, p.abaixoDoMinimo];
      }
      assert.deepEqual(efetivos, { P: [10, 'PROPRIO', false], M: [30, 'PROPRIO', true], G: [15, 'PROPRIO', true], GG: [20, 'PADRAO', true] });
    });

    test('o mínimo próprio 0 prevalece sobre o padrão: este tamanho não tem mínimo, e não herda', async () => {
      const m = await material(d, { padrao: 20 });
      await minimoProprio(d, m, 'P', 0);
      await lote(d, m, 3, { tamanho: 'P' });
      await lote(d, m, 3, { tamanho: 'M' });
      const p = await par(d, m, 'P');
      assert.deepEqual([p.estoqueMinimo, p.minimoOrigem, p.abaixoDoMinimo, p.deficit], [0, 'PROPRIO', false, 0]);
      assert.deepEqual([(await par(d, m, 'M')).estoqueMinimo, (await par(d, m, 'M')).minimoOrigem], [20, 'PADRAO']);
    });

    test('o mínimo próprio vale mesmo com o padrão 0 (o padrão não é o que decide)', async () => {
      const m = await material(d, { padrao: 0 });
      await minimoProprio(d, m, 'P', 4);
      await lote(d, m, 3, { tamanho: 'P' });
      const p = await par(d, m, 'P');
      assert.deepEqual([p.estoqueMinimo, p.minimoOrigem, p.deficit], [4, 'PROPRIO', 1]);
    });
  });

  describe('o físico utilizável e o saldo bloqueado', () => {
    test('lote com CA vencido ou sem CA conta no saldo, mas não no utilizável; vence hoje ainda é utilizável', async () => {
      const m = await material(d, { padrao: 0 });
      await lote(d, m, 4, { tamanho: 'P', caNumero: '111', caValidade: '2099-12-31' });
      await lote(d, m, 3, { tamanho: 'P', caNumero: '222', caValidade: '2020-01-01' });
      await lote(d, m, 2, { tamanho: 'P', caNumero: null, caValidade: null });
      await lote(d, m, 1, { tamanho: 'P', caNumero: '333', caValidade: HOJE });
      const p = await par(d, m, 'P');
      assert.deepEqual([p.saldo, p.bloqueado, p.fisicoUtilizavel], [10, 5, 5]);
      assert.equal(p.validade, 'expired');
      assert.equal(p.caValidade, '2020-01-01');
    });

    test('material que dispensa CA: todo o saldo é utilizável, mesmo com CA vencido ou ausente no lote', async () => {
      const m = await material(d, { exigeCa: false, padrao: 0 });
      await lote(d, m, 4, { tamanho: 'P', caNumero: '222', caValidade: '2020-01-01' });
      await lote(d, m, 2, { tamanho: 'P', caNumero: null, caValidade: null });
      const p = await par(d, m, 'P');
      assert.deepEqual([p.saldo, p.bloqueado, p.fisicoUtilizavel], [6, 0, 6]);
    });

    test('a validade do par segue a leitura de itens disponíveis: expiring quando um lote vence em até 60 dias, ok quando todos têm folga', async () => {
      const proximo = await material(d, { padrao: 0 });
      await lote(d, proximo, 2, { tamanho: 'P', caNumero: '1', caValidade: '2026-11-15' });
      assert.equal((await par(d, proximo, 'P')).validade, 'expiring');
      const folga = await material(d, { padrao: 0 });
      await lote(d, folga, 2, { tamanho: 'P', caNumero: '1', caValidade: '2027-12-31' });
      assert.equal((await par(d, folga, 'P')).validade, 'ok');
    });
  });

  describe('a demanda: só o que ainda é atendível', () => {
    test('solicitação de trabalhador inativo não conta; a de trabalhador ativo conta', async () => {
      const m = await material(d, { padrao: 0 });
      const inativo = await criarFuncionario(pool, d.empresaId, { matricula: `I-${proximo()}`, cpf: String(20000000000 + n), ativo: false });
      await demanda(d, m, 'P', 5, inativo);
      assert.equal(await par(d, m, 'P'), null, 'só demanda de inativo: o par nem aparece');
      await demanda(d, m, 'P', 2);
      assert.equal((await par(d, m, 'P')).demandaPendente, 2);
    });

    test('solicitação pendente, reprovada e cancelada não entram; só APROVADA e APROVADA_PARCIAL', async () => {
      const m = await material(d, { padrao: 0 });
      const { criarSolicitacao, decidirSolicitacao, aprovar, reprovar, cancelarSolicitacao } = require('./helpers/solicitacao-epi');
      const cenario = { empresaA: d.empresaId, aprovador: d.aprovador, solicitante: d.solicitante };
      const nova = (extra = {}) => criarSolicitacao(pool, cenario, {
        empresaId: d.empresaId, funcionarioId: d.trabalhador, solicitanteId: d.solicitante, itens: [{ material_id: m.id, tamanho: 'P', quantidade: 2, motivo: 'ADMISSAO' }], ...extra,
      });
      await nova();
      const reprovada = await nova();
      await decidirSolicitacao(pool, reprovada.solicitacao, { status: 'REPROVADA', decididaPor: d.aprovador, decisoes: reprovada.itens.map((i) => reprovar(i)) });
      const cancelada = await nova();
      await cancelarSolicitacao(pool, cancelada.solicitacao, { canceladaPor: d.solicitante });
      assert.equal(await par(d, m, 'P'), null, 'nenhuma demanda atendível: o par não aparece');
      const parcial = await nova();
      await decidirSolicitacao(pool, parcial.solicitacao, { status: 'APROVADA_PARCIAL', decididaPor: d.aprovador, decisoes: [aprovar(parcial.itens[0], 1, 'Quantidade reduzida pela SST')] });
      assert.equal((await par(d, m, 'P')).demandaPendente, 1);
    });

    test('entrega parcial por solicitação desconta o já entregue da demanda', async () => {
      const { entregarPorSolicitacao } = require('./helpers/solicitacao-epi');
      const m = await material(d, { padrao: 0 });
      await lote(d, m, 10, { tamanho: 'P' });
      const { solicitacao, itens } = await demanda(d, m, 'P', 5);
      const { id: loteId } = (await q('SELECT id FROM estoque_lotes WHERE material_id = $1', [m.id])).rows[0];
      await entregarPorSolicitacao(pool, { solicitacao, itens: [{ item: itens[0], loteId, quantidade: 2 }], usuarioId: d.solicitante });
      const p = await par(d, m, 'P');
      assert.deepEqual(numeros(p), [8, 3, 3, 5, 0]);
    });
  });

  describe('o que não entra', () => {
    test('material inativo: nem lote, nem demanda, nem mínimo próprio, nem padrão', async () => {
      const m = await material(d, { padrao: 9 });
      await lote(d, m, 5, { tamanho: 'P' });
      await demanda(d, m, 'P', 2);
      await minimoProprio(d, m, 'G', 4);
      assert.ok(await par(d, m, 'P'));
      await q('UPDATE materiais SET ativo = false WHERE id = $1', [m.id]);
      for (const tamanho of ['P', 'G']) assert.equal(await par(d, m, tamanho), null, tamanho);
      const sem = await material(d, { exigeTamanho: false, padrao: 5, ativo: false });
      assert.equal(await par(d, sem, null), null);
    });

    test('isolamento multiempresa: a empresa B nunca vê par, demanda ou mínimo da A', async () => {
      const b = await novaEmpresa('Empresa B');
      const m = await material(d, { padrao: 3 });
      await lote(d, m, 5, { tamanho: 'P' });
      await demanda(d, m, 'P', 2);
      await minimoProprio(d, m, 'G', 6);
      assert.ok(await par(d, m, 'P'));
      const { itens, total } = await repo().listarPosicoes(pool, b.empresaId, { ...REFERENCIA, pagina: 1, limite: 100 });
      assert.deepEqual([itens, total], [[], 0]);
      assert.equal(await par({ empresaId: b.empresaId }, m, 'P'), null);
    });
  });

  describe('filtros', () => {
    let e;
    let luva;
    let capacete;

    before(async () => {
      e = await novaEmpresa('Empresa de filtros');
      luva = await material(e, { nome: 'Luva Filtro', padrao: 6 });
      capacete = await material(e, { nome: 'Capacete Filtro', exigeTamanho: false, padrao: 0 });
      await q("UPDATE materiais SET categoria = 'EPI', tipo = 'Luva', codigo_interno = 'LV-1' WHERE id = $1", [luva.id]);
      await q("UPDATE materiais SET categoria = 'Cabeça', tipo = 'Capacete' WHERE id = $1", [capacete.id]);
      await lote(e, luva, 9, { tamanho: 'P' });
      await lote(e, luva, 2, { tamanho: 'M', caNumero: '9', caValidade: '2020-01-01' });
      await demanda(e, luva, 'G', 4);
      await lote(e, capacete, 5, { tamanho: null });
    });

    const listar = (extra = {}) => repo().listarPosicoes(pool, e.empresaId, { ...REFERENCIA, pagina: 1, limite: 100, ...extra });
    const chaves = (r) => r.itens.map((i) => `${i.material}|${i.tamanho}`);

    test('sem filtro: todos os pares, em ordem de nome, material e tamanho', async () => {
      assert.deepEqual(chaves(await listar()), ['Capacete Filtro|null', 'Luva Filtro|G', 'Luva Filtro|M', 'Luva Filtro|P']);
    });

    test('categoria, tipo e tamanho', async () => {
      assert.deepEqual(chaves(await listar({ categoria: 'Cabeça' })), ['Capacete Filtro|null']);
      assert.deepEqual(chaves(await listar({ tipo: 'Luva' })), ['Luva Filtro|G', 'Luva Filtro|M', 'Luva Filtro|P']);
      assert.deepEqual(chaves(await listar({ tamanho: 'M' })), ['Luva Filtro|M']);
    });

    test('busca por nome ou código interno, sem diferenciar maiúsculas, com coringas como texto', async () => {
      assert.deepEqual(chaves(await listar({ busca: 'capacete' })).length, 1);
      assert.equal((await listar({ busca: 'lv-1' })).total, 3);
      assert.equal((await listar({ busca: '%' })).total, 0, 'o coringa é texto');
    });

    test('validade: expired (lote vencido), ok e expiring', async () => {
      assert.deepEqual(chaves(await listar({ validade: 'expired' })), ['Luva Filtro|M']);
      assert.deepEqual(chaves(await listar({ validade: 'ok' })), ['Capacete Filtro|null', 'Luva Filtro|P']);
    });

    test('situação: sem estoque, abaixo do mínimo, com comprometido, sem cobertura e com necessidade', async () => {
      assert.deepEqual(chaves(await listar({ situacao: 'SEM_ESTOQUE' })), ['Luva Filtro|G', 'Luva Filtro|M']);
      assert.deepEqual(chaves(await listar({ situacao: 'ABAIXO_MINIMO' })), ['Luva Filtro|G', 'Luva Filtro|M']);
      assert.deepEqual(chaves(await listar({ situacao: 'COM_COMPROMETIDO' })), []);
      assert.deepEqual(chaves(await listar({ situacao: 'SEM_COBERTURA' })), ['Luva Filtro|G']);
      assert.deepEqual(chaves(await listar({ situacao: 'COM_NECESSIDADE' })), ['Luva Filtro|G', 'Luva Filtro|M']);
    });

    test('o total acompanha o filtro, não a página', async () => {
      const r = await listar({ tipo: 'Luva', limite: 1, pagina: 2 });
      assert.deepEqual([r.itens.length, r.total], [1, 3]);
    });
  });

  describe('paginação: o total não depende de a página ter linha', () => {
    let e;
    const listar = (pagina, limite, extra = {}) => repo().listarPosicoes(pool, e.empresaId, { ...REFERENCIA, pagina, limite, ...extra });

    before(async () => {
      e = await novaEmpresa('Empresa de paginação');
      for (let i = 1; i <= 23; i += 1) await material(e, { nome: `Capacete ${String(i).padStart(2, '0')}`, exigeTamanho: false, padrao: 1 });
    });

    test('23 pares, limite 10: páginas de 10, 10 e 3, sempre com total 23', async () => {
      const paginas = [await listar(1, 10), await listar(2, 10), await listar(3, 10)];
      assert.deepEqual(paginas.map((p) => p.itens.length), [10, 10, 3]);
      assert.deepEqual(paginas.map((p) => p.total), [23, 23, 23]);
      const nomes = paginas.flatMap((p) => p.itens.map((i) => i.material));
      assert.equal(new Set(nomes).size, 23, 'nenhum par repetido nem perdido entre as páginas');
      assert.deepEqual(nomes, [...nomes].sort(), 'a ordem é a mesma em todas as páginas');
    });

    test('PÁGINA ALÉM DO ÚLTIMO RESULTADO: página 4 e página 9 voltam sem itens e com total 23', async () => {
      assert.deepEqual(await listar(4, 10), { itens: [], total: 23 });
      assert.deepEqual(await listar(9, 10), { itens: [], total: 23 });
    });

    test('limite maior que o total traz tudo; filtro sem resultado: itens vazios e total 0', async () => {
      const tudo = await listar(1, 100);
      assert.deepEqual([tudo.itens.length, tudo.total], [23, 23]);
      assert.deepEqual(await listar(1, 10, { busca: 'inexistente' }), { itens: [], total: 0 });
      assert.deepEqual(await listar(2, 10, { busca: 'inexistente' }), { itens: [], total: 0 });
    });
  });

  describe('resumirPosicoes — o que o Dashboard vai somar', () => {
    test('totais do mesmo universo: Σ U, Σ D, Σ C, Σ L, Σ G, pares abaixo do mínimo, Σ déficit, Σ necessidade', async () => {
      const e = await novaEmpresa('Empresa do resumo');
      const a = await material(e, { padrao: 5 });
      await lote(e, a, 5, { tamanho: 'P' });
      await demanda(e, a, 'P', 2);
      const b = await material(e, { padrao: 5 });
      await demanda(e, b, 'P', 2);
      const c = await material(e, { exigeTamanho: false, padrao: 4 });
      const inativo = await material(e, { padrao: 9, ativo: false });
      await lote(e, inativo, 50, { tamanho: 'P' });
      const r = await repo().resumirPosicoes(pool, e.empresaId, { hoje: HOJE });
      // a: U5 D2 C2 L3 G0 déficit 2 nec 2 · b: U0 D2 C0 L0 G2 déficit 5 nec 7 · c: U0 D0 déficit 4 nec 4
      assert.deepEqual(r, {
        pares: 3, fisicoUtilizavel: 5, demandaPendente: 4, comprometido: 2, saldoLivre: 3, semCobertura: 2, paresAbaixoDoMinimo: 3, deficit: 11, necessidade: 13,
      });
      assert.ok(c);
    });

    test('empresa sem nada: zeros, nunca null', async () => {
      const e = await novaEmpresa('Empresa vazia');
      assert.deepEqual(await repo().resumirPosicoes(pool, e.empresaId, { hoje: HOJE }), {
        pares: 0, fisicoUtilizavel: 0, demandaPendente: 0, comprometido: 0, saldoLivre: 0, semCobertura: 0, paresAbaixoDoMinimo: 0, deficit: 0, necessidade: 0,
      });
    });
  });
});
