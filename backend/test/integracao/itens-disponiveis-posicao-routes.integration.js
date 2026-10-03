'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { montarAmbiente } = require('./helpers/ambiente-http-12d2');
const { somarDias } = require('./helpers/estoque-lotes');
const { criarLote } = require('./helpers/entrega-epi');
const { dataOperacional } = require('../../src/utils/data-operacional');

/**
 * GET /api/estoque/itens-disponiveis pela posição de TODOS os pares (12D-2),
 * contra PostgreSQL real. O item é o par (material, tamanho) com o físico
 * utilizável U, o comprometido C, o saldo livre L, a demanda sem cobertura G, o
 * mínimo efetivo (próprio, mesmo 0, ou o padrão do cadastro), o déficit e a
 * necessidade. Cada teste usa materiais com um nome-marca próprio e filtra por
 * ele, para que um não enxergue o outro.
 */

const HOJE = dataOperacional();
const CHAVES_DO_ITEM = [
  'abaixoDoMinimo', 'bloqueado', 'caValidade', 'categoria', 'codigoInterno', 'comprometido', 'deficit', 'disponivel', 'estoqueMinimo', 'fisicoUtilizavel',
  'material', 'materialId', 'minimoOrigem', 'necessidade', 'saldo', 'saldoLivre', 'semCobertura', 'tamanho', 'tipo', 'unidade', 'validade',
];

describe('itens disponíveis pela posição — HTTP (PostgreSQL real)', () => {
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

  // Material da empresa A ligado ao GHE (a solicitação o aceita), com nome-marca e mínimo padrão.
  async function novo(marca, sufixo, { minimo = 0, ...opcoes } = {}) {
    const id = await amb.f.material(opcoes);
    await q('UPDATE materiais SET nome = $2, estoque_minimo = $3 WHERE id = $1', [id, `${marca} ${sufixo}`, minimo]);
    return id;
  }
  const itens = async (quem, marca, extra = '') => {
    const r = await quem.get(`/api/estoque/itens-disponiveis?busca=${encodeURIComponent(marca)}&limite=100${extra}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };
  const porPar = (corpo) => Object.fromEntries(corpo.itens.map((i) => [`${i.material.split(' ').slice(1).join(' ')}|${i.tamanho ?? '-'}`, i]));
  const numeros = (i) => [i.fisicoUtilizavel, i.comprometido, i.saldoLivre, i.semCobertura, i.estoqueMinimo, i.deficit, i.necessidade, i.abaixoDoMinimo];

  describe('contrato aditivo e compatibilidade', () => {
    test('o item traz os campos antigos e os novos; disponivel é o físico utilizável; a demanda por si não sai', async () => {
      const marca = 'ZQ01';
      const id = await novo(marca, 'botina', { minimo: 5 });
      await amb.f.estoque(id, 5);
      await amb.f.estoque(id, 3, { caValidade: '2020-01-01' });
      await amb.f.aprovada({ materialId: id, quantidade: 2 });
      const corpo = await itens(master, marca);
      assert.equal(corpo.itens.length, 1);
      const [item] = corpo.itens;
      assert.deepEqual(Object.keys(item).sort(), CHAVES_DO_ITEM);
      assert.deepEqual(
        { ...item, caValidade: undefined },
        {
          materialId: id,
          material: `${marca} botina`,
          codigoInterno: null,
          categoria: null,
          tipo: null,
          tamanho: '40',
          saldo: 8,
          bloqueado: 3,
          disponivel: 5,
          fisicoUtilizavel: 5,
          comprometido: 2,
          saldoLivre: 3,
          semCobertura: 0,
          estoqueMinimo: 5,
          minimoOrigem: 'PADRAO',
          abaixoDoMinimo: true,
          deficit: 2,
          necessidade: 2,
          unidade: 'unidade',
          caValidade: undefined,
          validade: 'expired',
        },
      );
      assert.equal(item.caValidade, '2020-01-01');
      assert.equal(item.disponivel, item.fisicoUtilizavel);
      assert.deepEqual([corpo.total, corpo.pagina, corpo.limite], [1, 1, 100]);
      assert.deepEqual(Object.keys(corpo.filtros).sort(), ['categorias', 'tamanhos', 'tipos']);
      assert.ok(!JSON.stringify(corpo).match(/demandaPendente|solicit/i), 'só o efeito da demanda sai, nunca ela ou as solicitações');
    });

    test('os exemplos aprovados: U5 D2 mín5 dá C2 L3 G0 déficit2 necessidade2; U0 D2 mín5 dá C0 L0 G2 déficit5 necessidade7', async () => {
      const marca = 'ZQ02';
      const a = await novo(marca, 'a', { minimo: 5 });
      await amb.f.estoque(a, 5);
      await amb.f.aprovada({ materialId: a, quantidade: 2 });
      const b = await novo(marca, 'b', { minimo: 5 });
      await amb.f.aprovada({ materialId: b, quantidade: 2 });
      const pares = porPar(await itens(master, marca));
      assert.deepEqual(numeros(pares['a|40']), [5, 2, 3, 0, 5, 2, 2, true]);
      assert.deepEqual(numeros(pares['b|40']), [0, 0, 0, 2, 5, 5, 7, true]);
    });
  });

  describe('o universo: todos os pares, não só os que têm lote', () => {
    test('demanda sem lote, mínimo próprio sem lote nem demanda e material sem tamanho com mínimo padrão aparecem; o inativo e o que não tem nada não', async () => {
      const marca = 'ZQ03';
      const semLote = await novo(marca, 'semlote', { minimo: 5 });
      await amb.f.aprovada({ materialId: semLote, quantidade: 3 });
      const soMinimo = await novo(marca, 'sominimo', { minimo: 0 });
      await q("INSERT INTO estoque_minimos (empresa_id, material_id, tamanho, minimo) VALUES ($1, $2, '42', 4)", [amb.d.empresaA, soMinimo]);
      const semTamanho = await novo(marca, 'semtamanho', { minimo: 3, exigeTamanho: false });
      const nada = await novo(marca, 'nada', { minimo: 0 });
      const inativo = await novo(marca, 'inativo', { minimo: 9 });
      await amb.f.estoque(inativo, 4);
      await q('UPDATE materiais SET ativo = false WHERE id = $1', [inativo]);
      const pares = porPar(await itens(master, marca));
      assert.deepEqual(Object.keys(pares).sort(), ['semlote|40', 'semtamanho|-', 'sominimo|42']);
      assert.deepEqual(numeros(pares['semlote|40']), [0, 0, 0, 3, 5, 5, 8, true]);
      assert.deepEqual(numeros(pares['sominimo|42']), [0, 0, 0, 0, 4, 4, 4, true]);
      assert.deepEqual(numeros(pares['semtamanho|-']), [0, 0, 0, 0, 3, 3, 3, true]);
      assert.equal(pares['semtamanho|-'].tamanho, null);
      assert.ok(![nada, inativo].some((id) => Object.values(pares).some((p) => p.materialId === id)));
    });

    test('lote esgotado continua na lista (o tamanho que acabou); lote com CA vencido conta no saldo e não no utilizável', async () => {
      const marca = 'ZQ04';
      const id = await novo(marca, 'esgotado', { minimo: 0 });
      const lote = await amb.f.estoque(id, 2);
      await amb.f.baixa(lote, 2, 'AVARIA');
      const vencido = await novo(marca, 'vencido', { minimo: 0 });
      await amb.f.estoque(vencido, 6, { caValidade: '2020-01-01' });
      const pares = porPar(await itens(master, marca));
      assert.deepEqual([pares['esgotado|40'].saldo, pares['esgotado|40'].fisicoUtilizavel], [0, 0]);
      assert.deepEqual([pares['vencido|40'].saldo, pares['vencido|40'].bloqueado, pares['vencido|40'].fisicoUtilizavel], [6, 6, 0]);
    });

    test('lote bloqueado só vira utilizável no dia em que o CA vale: CA que vence hoje ainda vale', async () => {
      const marca = 'ZQ05';
      const hoje = await novo(marca, 'hoje', { minimo: 0 });
      await amb.f.estoque(hoje, 4, { caValidade: HOJE });
      const ontem = await novo(marca, 'ontem', { minimo: 0 });
      await amb.f.estoque(ontem, 4, { caValidade: somarDias(HOJE, -1) });
      const pares = porPar(await itens(master, marca));
      assert.equal(pares['hoje|40'].fisicoUtilizavel, 4);
      assert.equal(pares['ontem|40'].fisicoUtilizavel, 0);
    });
  });

  describe('mínimo efetivo: o próprio (mesmo 0) vence o padrão', () => {
    test('padrão, sobrescrita, zero próprio e herança por tamanho', async () => {
      const marca = 'ZQ06';
      const id = await novo(marca, 'mat', { minimo: 20 });
      for (const tamanho of ['P', 'M', 'G', 'GG']) await amb.f.estoque(id, 8, { tamanho });
      await q("INSERT INTO estoque_minimos (empresa_id, material_id, tamanho, minimo) VALUES ($1, $2, 'M', 5), ($1, $2, 'G', 0)", [amb.d.empresaA, id]);
      const pares = porPar(await itens(master, marca));
      assert.deepEqual([pares['mat|P'].estoqueMinimo, pares['mat|P'].minimoOrigem, pares['mat|P'].abaixoDoMinimo], [20, 'PADRAO', true]);
      assert.deepEqual([pares['mat|M'].estoqueMinimo, pares['mat|M'].minimoOrigem, pares['mat|M'].abaixoDoMinimo], [5, 'PROPRIO', false]);
      assert.deepEqual([pares['mat|G'].estoqueMinimo, pares['mat|G'].minimoOrigem, pares['mat|G'].abaixoDoMinimo, pares['mat|G'].deficit], [0, 'PROPRIO', false, 0]);
      assert.deepEqual([pares['mat|GG'].estoqueMinimo, pares['mat|GG'].minimoOrigem], [20, 'PADRAO']);
    });

    test('o mínimo se compara com o saldo LIVRE: físico 10, comprometido 8 e mínimo 5 está abaixo (livre 2), e sem a demanda não estaria', async () => {
      const marca = 'ZQ07';
      const id = await novo(marca, 'mat', { minimo: 5 });
      await amb.f.estoque(id, 10);
      assert.equal(porPar(await itens(master, marca))['mat|40'].abaixoDoMinimo, false);
      await amb.f.aprovada({ materialId: id, quantidade: 8 });
      const item = porPar(await itens(master, marca))['mat|40'];
      assert.deepEqual([item.fisicoUtilizavel, item.saldoLivre, item.abaixoDoMinimo, item.deficit], [10, 2, true, 3]);
    });
  });

  describe('filtros', () => {
    // Quatro pares com situações diferentes, todos sob a mesma marca.
    async function cenario(marca) {
      const semEstoque = await novo(marca, 'semestoque', { minimo: 0 });
      const lote = await amb.f.estoque(semEstoque, 2);
      await amb.f.baixa(lote, 2, 'AVARIA');
      const abaixo = await novo(marca, 'abaixo', { minimo: 9 });
      await amb.f.estoque(abaixo, 4);
      const comprometido = await novo(marca, 'comprometido', { minimo: 0 });
      await amb.f.estoque(comprometido, 6);
      await amb.f.aprovada({ materialId: comprometido, quantidade: 2 });
      const semCobertura = await novo(marca, 'semcobertura', { minimo: 0 });
      await amb.f.estoque(semCobertura, 1);
      await amb.f.aprovada({ materialId: semCobertura, quantidade: 3 });
      const folgado = await novo(marca, 'folgado', { minimo: 2 });
      await amb.f.estoque(folgado, 50);
    }
    const nomes = (corpo) => corpo.itens.map((i) => i.material.split(' ')[1]).sort();

    test('situacao: SEM_ESTOQUE, ABAIXO_MINIMO, COM_COMPROMETIDO e SEM_COBERTURA, cada uma pelo campo derivado certo', async () => {
      const marca = 'ZQ08';
      await cenario(marca);
      assert.deepEqual(nomes(await itens(master, marca)), ['abaixo', 'comprometido', 'folgado', 'semcobertura', 'semestoque']);
      assert.deepEqual(nomes(await itens(master, marca, '&situacao=SEM_ESTOQUE')), ['semestoque']);
      assert.deepEqual(nomes(await itens(master, marca, '&situacao=ABAIXO_MINIMO')), ['abaixo']);
      assert.deepEqual(nomes(await itens(master, marca, '&situacao=COM_COMPROMETIDO')), ['comprometido', 'semcobertura']);
      assert.deepEqual(nomes(await itens(master, marca, '&situacao=SEM_COBERTURA')), ['semcobertura']);
    });

    test('somenteComNecessidade: só os pares com demanda sem cobertura ou déficit do mínimo; false é o mesmo que ausente; combina com a situação', async () => {
      const marca = 'ZQ09';
      await cenario(marca);
      assert.deepEqual(nomes(await itens(master, marca, '&somenteComNecessidade=true')), ['abaixo', 'semcobertura']);
      assert.deepEqual(nomes(await itens(master, marca, '&somenteComNecessidade=false')), nomes(await itens(master, marca)));
      assert.deepEqual(nomes(await itens(master, marca, '&somenteComNecessidade=true&situacao=SEM_COBERTURA')), ['semcobertura']);
      assert.deepEqual(nomes(await itens(master, marca, '&somenteComNecessidade=true&situacao=COM_COMPROMETIDO')), ['semcobertura']);
      assert.deepEqual(nomes(await itens(master, marca, '&somenteComNecessidade=true&situacao=SEM_ESTOQUE')), []);
    });

    test('categoria, tipo, tamanho e busca (com os coringas escapados)', async () => {
      const marca = 'ZQ10';
      const a = await novo(marca, 'a', { minimo: 0 });
      const b = await novo(marca, 'b', { minimo: 0 });
      await q("UPDATE materiais SET categoria = 'Uniforme', tipo = 'Camisa', codigo_interno = 'ZQ10%X' WHERE id = $1", [a]);
      await q("UPDATE materiais SET categoria = 'EPI', tipo = 'Luva', codigo_interno = 'ZQ10YX' WHERE id = $1", [b]);
      await amb.f.estoque(a, 1, { tamanho: 'G' });
      await amb.f.estoque(b, 1, { tamanho: 'P' });
      assert.deepEqual(nomes(await itens(master, marca, '&categoria=Uniforme')), ['a']);
      assert.deepEqual(nomes(await itens(master, marca, '&tipo=Luva')), ['b']);
      assert.deepEqual(nomes(await itens(master, marca, '&tamanho=G')), ['a']);
      assert.deepEqual(nomes(await itens(master, 'ZQ10%X')), ['a'], 'o % da busca é literal: não casa com ZQ10YX');
      assert.deepEqual(nomes(await itens(master, 'ZQ10_X')), [], 'o _ da busca é literal');
      assert.deepEqual(nomes(await itens(master, marca.toLowerCase())), ['a', 'b'], 'a busca ignora a caixa');
    });

    test('validade: ok, expiring (até 60 dias) e expired, pela pior validade do CA entre os lotes com saldo', async () => {
      const marca = 'ZQ11';
      const ok = await novo(marca, 'ok');
      await amb.f.estoque(ok, 1, { caValidade: somarDias(HOJE, 200) });
      const vencendo = await novo(marca, 'vencendo');
      await amb.f.estoque(vencendo, 1, { caValidade: somarDias(HOJE, 30) });
      const vencido = await novo(marca, 'vencido');
      await amb.f.estoque(vencido, 1, { caValidade: somarDias(HOJE, -3) });
      assert.deepEqual(nomes(await itens(master, marca, '&validade=ok')), ['ok']);
      assert.deepEqual(nomes(await itens(master, marca, '&validade=expiring')), ['vencendo']);
      assert.deepEqual(nomes(await itens(master, marca, '&validade=expired')), ['vencido']);
    });

    test('combinação de filtros: todos valem juntos', async () => {
      const marca = 'ZQ12';
      await cenario(marca);
      assert.deepEqual(nomes(await itens(master, marca, '&situacao=ABAIXO_MINIMO&somenteComNecessidade=true&tamanho=40&validade=ok')), ['abaixo']);
      assert.deepEqual(nomes(await itens(master, marca, '&situacao=ABAIXO_MINIMO&tamanho=41')), []);
    });
  });

  describe('paginação', () => {
    test('23 pares com limite 10: páginas de 10, 10 e 3; a página 4 e a 9 voltam vazias com o total 23', async () => {
      const marca = 'ZQPAG';
      for (let n = 1; n <= 23; n += 1) {
        const id = await novo(marca, String(n).padStart(2, '0'));
        await amb.f.estoque(id, 1);
      }
      const pagina = async (n) => {
        const r = await master.get(`/api/estoque/itens-disponiveis?busca=${marca}&limite=10&pagina=${n}`);
        assert.equal(r.status, 200, JSON.stringify(r.body));
        return r.body;
      };
      const paginas = [await pagina(1), await pagina(2), await pagina(3)];
      assert.deepEqual(paginas.map((p) => p.itens.length), [10, 10, 3]);
      assert.deepEqual(paginas.map((p) => p.total), [23, 23, 23]);
      const nomes = paginas.flatMap((p) => p.itens.map((i) => i.material));
      assert.equal(new Set(nomes).size, 23);
      assert.deepEqual(nomes, [...nomes].sort(), 'a ordem é a mesma em todas as páginas');
      for (const n of [4, 9]) {
        const vazia = await pagina(n);
        assert.deepEqual([vazia.itens, vazia.total, vazia.pagina, vazia.limite], [[], 23, n, 10]);
      }
    });

    test('sem nenhum item: itens vazios e total 0', async () => {
      const r = await master.get('/api/estoque/itens-disponiveis?busca=ZQ-NAO-EXISTE');
      assert.deepEqual([r.status, r.body.itens, r.body.total], [200, [], 0]);
    });
  });

  describe('MULTIEMPRESA', () => {
    test('a posição, a demanda e o mínimo de uma empresa nunca aparecem na outra', async () => {
      const marca = 'ZQ13';
      const daA = await novo(marca, 'a', { minimo: 5 });
      await amb.f.estoque(daA, 7);
      const daB = await amb.material(amb.d.empresaB, `${marca} b`, { estoqueMinimo: 50 });
      await q("INSERT INTO estoque_minimos (empresa_id, material_id, tamanho, minimo) VALUES ($1, $2, '40', 99)", [amb.d.empresaB, daB]);
      await criarLote(amb.pool, { empresaId: amb.d.empresaB, materialId: daB, quantidade: 33, tamanho: '40' });
      const naA = await itens(master, marca);
      assert.deepEqual(naA.itens.map((i) => i.materialId), [daA]);
      assert.equal(naA.itens[0].estoqueMinimo, 5);
      const naB = await itens(masterB, marca);
      assert.deepEqual(naB.itens.map((i) => [i.materialId, i.saldo, i.estoqueMinimo, i.minimoOrigem]), [[daB, 33, 99, 'PROPRIO']]);
    });

    test('a empresa de query ou de corpo não existe: empresaId na query é 400, e a sessão decide', async () => {
      const r = await master.get(`/api/estoque/itens-disponiveis?empresaId=${amb.d.empresaB}`);
      assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO']);
    });
  });

  describe('RBAC e erros públicos', () => {
    test('availableItems.visualizar é a única permissão que vale: sem ela, 403, mesmo com materials, dashboard, operations e epiFicha', async () => {
      const sem = amb.como(await amb.usuarioCom(amb.d.empresaA, { materials: ['visualizar', 'editar'], dashboard: ['visualizar'], operations: ['visualizar'], epiFicha: ['visualizar'] }));
      const r = await sem.get('/api/estoque/itens-disponiveis');
      assert.deepEqual([r.status, r.body.codigo], [403, 'PERMISSAO_NEGADA']);
      const com = amb.como(await amb.usuarioCom(amb.d.empresaA, { availableItems: ['visualizar'] }));
      assert.equal((await com.get('/api/estoque/itens-disponiveis')).status, 200);
    });

    test('sem identificação: 401', async () => {
      assert.equal((await amb.anonimo.get('/api/estoque/itens-disponiveis')).status, 401);
    });

    test('parâmetros inválidos: 400 VALIDACAO sem devolver o valor recebido', async () => {
      const invalidos = [
        'situacao=QUALQUER', 'situacao=COM_NECESSIDADE', 'situacao=sem_estoque', 'somenteComNecessidade=sim', 'somenteComNecessidade=1', 'validade=vencido',
        'limite=101', 'limite=0', 'pagina=0', 'pagina=abc', `busca=${'x'.repeat(101)}`, 'busca=', 'categoria=', 'ordem=nome',
      ];
      for (const consulta of invalidos) {
        const r = await master.get(`/api/estoque/itens-disponiveis?${consulta}`);
        assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], consulta);
        assert.ok(!JSON.stringify(r.body).includes('QUALQUER') && !JSON.stringify(r.body).includes('xxxx'));
      }
    });

    test('nenhum erro de banco vira 500 por filtro: caracteres especiais na busca são só texto', async () => {
      for (const busca of ["'; DROP TABLE materiais; --", '%', '_', '\\', 'ZQ"quote']) {
        const r = await master.get(`/api/estoque/itens-disponiveis?busca=${encodeURIComponent(busca)}`);
        assert.equal(r.status, 200, busca);
      }
      assert.equal((await q('SELECT count(*)::int AS n FROM materiais')).rows[0].n > 0, true);
    });
  });
});
