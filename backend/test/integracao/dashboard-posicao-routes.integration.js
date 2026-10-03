'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { montarAmbiente } = require('./helpers/ambiente-http-12d2');
const { criarLote } = require('./helpers/entrega-epi');

/**
 * GET /api/dashboard/indicadores pela MESMA posição de Itens Disponíveis
 * (12D-2), contra PostgreSQL real. O estoque do dashboard soma os pares: o
 * físico utilizável (itensDisponiveis, o significado antigo), o saldo livre L,
 * o comprometido C, a demanda sem cobertura G e a necessidade de reposição
 * (G + déficit do mínimo); o abaixo do mínimo compara o mínimo efetivo com o
 * saldo livre. Cada indicador só sai com a permissão da fonte.
 */

const ROTA = '/api/dashboard/indicadores';
const NEGADO = { permitido: false };

describe('dashboard pela posição — HTTP (PostgreSQL real)', () => {
  let amb;
  let master;
  let masterB;
  const q = (sql, params) => amb.pool.query(sql, params);

  before(async () => {
    amb = await montarAmbiente();
    master = amb.como(amb.d.master);
    masterB = amb.como(amb.d.masterB);
  });
  after(async () => { if (amb) await amb.encerrar(); });

  const indicadores = async (quem) => {
    const r = await quem.get(ROTA);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.indicadores;
  };
  const valor = (i) => (i.permitido ? i.valor : null);
  const estoqueDe = (i) => [i.itensDisponiveis, i.estoqueAbaixoMinimo, i.saldoLivre, i.comprometido, i.semCobertura, i.necessidadeReposicao].map(valor);

  test('empresa sem nenhum dado: zeros PERMITIDOS (não negados) em todos os indicadores de estoque e de validade', async () => {
    const i = await indicadores(masterB);
    assert.deepEqual(estoqueDe(i), [0, 0, 0, 0, 0, 0]);
    assert.deepEqual(i.caVencido, { permitido: true, valor: 0, aVencer: 0, diasAlerta: 60 });
    assert.equal(i.funcionariosAtivos.permitido, true);
  });

  describe('com a posição de seis pares', () => {
    // M1 U5 D2 mín5 → C2 L3 déficit2 (abaixo pelo livre, não pelo físico); M2 U10 mín próprio 12 → L10 déficit2 (abaixo);
    // M3 U0 D2 mín5 → G2 déficit5 necessidade7; M4 sem tamanho U6 mín4; M5 só CA vencido (U0); M6 U1 com mínimo próprio 0 (padrão 7).
    const ids = {};
    before(async () => {
      const comDemanda = async (chave, minimo) => {
        ids[chave] = await amb.f.material();
        await q('UPDATE materiais SET estoque_minimo = $2 WHERE id = $1', [ids[chave], minimo]);
      };
      await comDemanda('m1', 5);
      await amb.f.estoque(ids.m1, 5);
      await amb.f.aprovada({ materialId: ids.m1, quantidade: 2 });
      await comDemanda('m2', 0);
      await amb.f.estoque(ids.m2, 10);
      await q("INSERT INTO estoque_minimos (empresa_id, material_id, tamanho, minimo) VALUES ($1, $2, '40', 12)", [amb.d.empresaA, ids.m2]);
      await comDemanda('m3', 5);
      await amb.f.aprovada({ materialId: ids.m3, quantidade: 2 });
      ids.m4 = await amb.f.material({ exigeTamanho: false });
      await q('UPDATE materiais SET estoque_minimo = 4 WHERE id = $1', [ids.m4]);
      await amb.f.estoque(ids.m4, 6, { tamanho: null });
      await comDemanda('m5', 0);
      await amb.f.estoque(ids.m5, 8, { caValidade: '2020-01-01' });
      await comDemanda('m6', 7);
      await amb.f.estoque(ids.m6, 1);
      await q("INSERT INTO estoque_minimos (empresa_id, material_id, tamanho, minimo) VALUES ($1, $2, '40', 0)", [amb.d.empresaA, ids.m6]);
    });

    test('os cinco números de estoque somam a posição: U 22, abaixo do mínimo 3 pelo livre, L 20, C 2, G 2 e necessidade 11', async () => {
      const i = await indicadores(master);
      assert.deepEqual(i.itensDisponiveis, { permitido: true, valor: 22 });
      assert.deepEqual(i.estoqueAbaixoMinimo, { permitido: true, valor: 3 });
      assert.deepEqual(i.saldoLivre, { permitido: true, valor: 20 });
      assert.deepEqual(i.comprometido, { permitido: true, valor: 2 });
      assert.deepEqual(i.semCobertura, { permitido: true, valor: 2 });
      assert.deepEqual(i.necessidadeReposicao, { permitido: true, valor: 11 });
    });

    test('o abaixo do mínimo mede o saldo livre: M1 tem físico 5 (não abaixo do mínimo 5) e entra porque o livre é 3', async () => {
      const m1 = (await master.get('/api/estoque/itens-disponiveis?limite=100')).body.itens.find((x) => x.materialId === ids.m1);
      assert.deepEqual([m1.fisicoUtilizavel, m1.estoqueMinimo, m1.saldoLivre, m1.abaixoDoMinimo], [5, 5, 3, true]);
      assert.ok(m1.fisicoUtilizavel >= m1.estoqueMinimo, 'pelo físico (o critério antigo) ele não estaria abaixo');
      assert.equal((await indicadores(master)).estoqueAbaixoMinimo.valor, 3);
    });

    test('o dashboard e a lista de Itens Disponíveis são a mesma definição: a soma dos itens bate com cada indicador', async () => {
      const lista = (await master.get('/api/estoque/itens-disponiveis?limite=100')).body;
      assert.equal(lista.total, lista.itens.length);
      const soma = (campo) => lista.itens.reduce((s, x) => s + x[campo], 0);
      const i = await indicadores(master);
      assert.deepEqual(estoqueDe(i), [
        soma('fisicoUtilizavel'), lista.itens.filter((x) => x.abaixoDoMinimo).length, soma('saldoLivre'), soma('comprometido'), soma('semCobertura'), soma('necessidade'),
      ]);
    });

    test('o CA vencido continua pelo recorte da Validade de estoque (lote com saldo), sem relação com o estoque livre', async () => {
      const i = await indicadores(master);
      assert.deepEqual(i.caVencido, { permitido: true, valor: 1, aVencer: 0, diasAlerta: 60 });
      const { rows: [{ n }] } = await q('SELECT count(*)::int AS n FROM funcionarios WHERE empresa_id = $1 AND ativo', [amb.d.empresaA]);
      assert.deepEqual(i.funcionariosAtivos, { permitido: true, valor: n });
    });

    // [físico utilizável, abaixo do mínimo, saldo livre, comprometido, sem cobertura, necessidade]
    test('a mudança do estoque muda os números: a entrada tira M1 do abaixo do mínimo; a entrega direta e a baixa consomem U e L', async () => {
      assert.deepEqual(estoqueDe(await indicadores(master)), [22, 3, 20, 2, 2, 11]);
      const lote = await amb.f.estoque(ids.m1, 4);
      assert.deepEqual(estoqueDe(await indicadores(master)), [26, 2, 24, 2, 2, 9]);
      await amb.f.direta([[ids.m1, lote, 1]]);
      assert.deepEqual(estoqueDe(await indicadores(master)), [25, 2, 23, 2, 2, 9]);
      const loteM2 = (await q('SELECT id FROM estoque_lotes WHERE material_id = $1', [ids.m2])).rows[0].id;
      await amb.f.baixa(loteM2, 1, 'AVARIA');
      assert.deepEqual(estoqueDe(await indicadores(master)), [24, 2, 22, 2, 2, 10]);
    });

    describe('gating por fonte: nenhum número sai sem a permissão da fonte', () => {
      test('dashboard.visualizar sem nenhuma fonte: tudo negado e nenhum valor no corpo', async () => {
        const so = amb.como(await amb.usuarioCom(amb.d.empresaA, { dashboard: ['visualizar'] }));
        const i = await indicadores(so);
        for (const chave of ['itensDisponiveis', 'estoqueAbaixoMinimo', 'saldoLivre', 'comprometido', 'semCobertura', 'necessidadeReposicao', 'caVencido', 'funcionariosAtivos']) {
          assert.deepEqual(i[chave], NEGADO, chave);
        }
        assert.ok(!JSON.stringify(i).includes('valor'));
      });

      test('com availableItems: os seis de estoque saem e o resto fica negado', async () => {
        const quem = amb.como(await amb.usuarioCom(amb.d.empresaA, { dashboard: ['visualizar'], availableItems: ['visualizar'] }));
        const i = await indicadores(quem);
        assert.ok(estoqueDe(i).every((v) => typeof v === 'number'));
        assert.deepEqual([i.caVencido, i.funcionariosAtivos], [NEGADO, NEGADO]);
      });

      test('com stockValidity: só o CA sai; o estoque continua negado', async () => {
        const quem = amb.como(await amb.usuarioCom(amb.d.empresaA, { dashboard: ['visualizar'], stockValidity: ['visualizar'] }));
        const i = await indicadores(quem);
        assert.equal(i.caVencido.permitido, true);
        for (const chave of ['itensDisponiveis', 'estoqueAbaixoMinimo', 'saldoLivre', 'comprometido', 'semCobertura', 'necessidadeReposicao']) assert.deepEqual(i[chave], NEGADO, chave);
      });

      test('a fonte sem o dashboard não vale: availableItems sozinho recebe 403', async () => {
        const quem = amb.como(await amb.usuarioCom(amb.d.empresaA, { availableItems: ['visualizar'] }));
        const r = await quem.get(ROTA);
        assert.deepEqual([r.status, r.body.codigo], [403, 'PERMISSAO_NEGADA']);
        assert.equal((await amb.anonimo.get(ROTA)).status, 401);
      });
    });

    test('MULTIEMPRESA: o estoque, a demanda e o mínimo da empresa B não entram nos números da A, e vice-versa', async () => {
      const antesA = estoqueDe(await indicadores(master));
      const daB = await amb.material(amb.d.empresaB, 'Material da B do dashboard', { estoqueMinimo: 500 });
      await criarLote(amb.pool, { empresaId: amb.d.empresaB, materialId: daB, quantidade: 77, tamanho: '40' });
      await q("INSERT INTO estoque_minimos (empresa_id, material_id, tamanho, minimo) VALUES ($1, $2, '40', 600)", [amb.d.empresaB, daB]);
      assert.deepEqual(estoqueDe(await indicadores(master)), antesA);
      assert.deepEqual(estoqueDe(await indicadores(masterB)), [77, 1, 77, 0, 0, 523]);
    });

    test('a empresa de query ou de corpo é recusada: o dashboard não aceita parâmetro nenhum', async () => {
      const r = await master.get(`${ROTA}?empresaId=${amb.d.empresaB}`);
      assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO']);
    });
  });
});
