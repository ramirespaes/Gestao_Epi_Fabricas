'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { montar } = require('./helpers/gestao-usuarios-app');
const {
  criarFuncionario, criarMaterial, criarLote, criarFicha, registrarEntrega,
} = require('./helpers/entrega-epi');
const { criarRelatorioController } = require('../../src/controllers/relatorio.controller');
const { criarRelatorioRoutes } = require('../../src/routes/relatorio.routes');
const { criarDashboardController } = require('../../src/controllers/dashboard.controller');
const { criarDashboardRoutes } = require('../../src/routes/dashboard.routes');

/**
 * 12I — gráfico "Produtos que mais saem" com RELÓGIO CONTROLADO (PostgreSQL real, rotas reais). Regressão da CI #80, que falhou em 01/11/2026:
 * no dia 1º, "o primeiro dia" e "hoje" são o MESMO ponto da série, e as entregas do mesmo dia se somam. O controller recebe `relogio`, então
 * cada cenário fixa o instante e a suíte prova o 1º dia, um dia intermediário, o último dia e a virada de mês na meia-noite de São Paulo sem
 * esperar o calendário. Nenhum código de produção muda.
 *
 * Cada cenário usa meses próprios, todos no passado e disjuntos entre si, e semeia só as suas entregas (datas explícitas): os testes são
 * independentes e rodam em qualquer ordem. A data operacional dos testes não depende do dia em que a suíte roda.
 * Em todo cenário: o total do gráfico = o cartão "EPIs entregues" do Dashboard = a soma das linhas do relatório no mesmo período; a empresa B
 * nunca aparece na A.
 */

const NOMES = ['Luva de raspa', 'Botina', 'Capacete', 'Óculos', 'Protetor auricular', 'Avental'];
const instante = (dia, hora) => new Date(`${dia}T${hora}-03:00`); // horário de São Paulo (UTC-3, sem verão desde 2019)
const dois = (n) => String(n).padStart(2, '0');

describe('12I — gráfico de produtos com relógio controlado (PostgreSQL real)', () => {
  let g;
  let master;
  let masterB;
  let completo;
  let completoB;
  let agora = new Date();
  const mat = {};
  let fichaAna;
  let fichaB;

  before(async () => {
    g = await montar({ extras: ({ pool, exigirEmpresarial }) => [
      criarRelatorioRoutes({ controller: criarRelatorioController({ pool }), exigirSessao: exigirEmpresarial, pool }),
      criarDashboardRoutes({ controller: criarDashboardController({ pool, relogio: () => agora }), exigirSessao: exigirEmpresarial, pool }),
    ] });
    const A = g.empresas.A;
    const B = g.empresas.B;
    master = await g.contaDaEmpresa(A);
    masterB = await g.contaDaEmpresa(B);

    const ana = await criarFuncionario(g.pool, A, { matricula: 'CAL-1', cpf: '10000000101', setor: 'Produção', ativo: true });
    fichaAna = (await criarFicha(g.pool, A, ana)).id;
    for (const nome of NOMES) {
      const materialId = await criarMaterial(g.pool, A, nome, { tipo: null, prazo: 180 });
      const loteId = await criarLote(g.pool, { empresaId: A, materialId, quantidade: 1000, caNumero: `CA-${materialId}`, caValidade: '2099-01-01' });
      mat[nome] = { materialId, loteId };
    }
    const funcB = await criarFuncionario(g.pool, B, { matricula: 'CAL-B1', cpf: '10000000102', setor: 'Produção', ativo: true });
    fichaB = (await criarFicha(g.pool, B, funcB)).id;
    const luvaB = await criarMaterial(g.pool, B, 'Luva da B', { prazo: 30 });
    mat['Luva da B'] = { materialId: luvaB, loteId: await criarLote(g.pool, { empresaId: B, materialId: luvaB, quantidade: 100 }) };

    const liga = async (u, toggle, dono = master) => {
      const r = await g.request(g.app).put(`/api/administracao/usuarios/${u.id}/acessos/${toggle}`).set('Cookie', g.cookie(dono)).send({ ligado: true });
      assert.equal(r.status, 200, `toggle ${toggle}: ${JSON.stringify(r.body)}`);
    };
    completo = await g.usuarioPronto(master);
    for (const t of ['dashboard', 'fichaEpi']) await liga(completo, t);
    completoB = await g.usuarioPronto(masterB);
    for (const t of ['dashboard', 'fichaEpi']) await liga(completoB, t, masterB);
  });
  after(async () => { if (g) await g.encerrar(); });

  /** Cada entrega: { dia, hora, itens: [[nome, quantidade]] } — datas explícitas, em São Paulo. */
  const semear = async (empresa, ficha, entregas, conta = master) => {
    for (const { dia, hora, itens } of entregas) {
      await registrarEntrega(g.pool, {
        usuarioId: conta.usuarioId,
        entrega: {
          empresa_id: empresa, ficha_id: ficha, responsavel_id: conta.usuarioId, responsavel_nome: 'Responsável', data_operacional: dia,
          entregue_em: `${dia}T${hora}-03:00`, trabalhador_nome: 'Ana', trabalhador_matricula: 'CAL-1', trabalhador_setor: 'Produção',
        },
        itens: itens.map(([nome, quantidade]) => ({
          material_id: mat[nome].materialId, lote_id: mat[nome].loteId, quantidade, material_nome: nome, material_tipo: null, material_prazo_uso_dias: 180,
        })),
      });
    }
  };

  const como = (u) => ((u === master || u === masterB) ? g.cookie(u) : null);
  const cookieDe = async (u) => (como(u) ?? g.deCookies(g.cookiesDe(await g.login(u.email, g.SENHA_PROVISORIA))));
  const grafico = async (u, relogio) => {
    agora = relogio;
    const r = await g.request(g.app).get('/api/dashboard/graficos/epis-entregues?periodo=MES').set('Cookie', await cookieDe(u));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.grafico;
  };
  const cartao = async (u, relogio) => {
    agora = relogio;
    const r = await g.request(g.app).get('/api/dashboard/indicadores').set('Cookie', await cookieDe(u));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.indicadores.episEntregues;
  };
  const somaDoRelatorio = async (u, de, ate) => {
    const cookie = await cookieDe(u);
    let soma = 0;
    let lidos = 0;
    for (let pagina = 1; pagina <= 50; pagina += 1) {
      const r = await g.request(g.app).get(`/api/relatorios/epis-entregues?de=${de}&ate=${ate}&limite=100&pagina=${pagina}`).set('Cookie', cookie);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      for (const l of r.body.itens) soma += l.quantidade;
      lidos += r.body.itens.length;
      if (lidos >= r.body.total) break;
    }
    return soma;
  };

  /**
   * Expectativa calculada das próprias entregas semeadas (e não da resposta): só as do mês entram; o top vem do total por produto (sem empates
   * nos cenários), e a série tem um ponto por dia de 1º até hoje.
   */
  const esperado = (entregas, hoje) => {
    const mes = hoje.slice(0, 7);
    const doMes = entregas.filter((e) => e.dia.startsWith(mes));
    const totais = {};
    for (const e of doMes) for (const [nome, q] of e.itens) totais[nome] = (totais[nome] ?? 0) + q;
    const top = Object.keys(totais).sort((a, b) => totais[b] - totais[a]).slice(0, 5);
    assert.equal(new Set(top.map((n) => totais[n])).size, top.length, 'cenário sem empates no top');
    const quantidadesDoDia = (dia) => top.map((nome) => doMes.filter((e) => e.dia === dia).reduce((s, e) => s + e.itens.filter(([n]) => n === nome).reduce((x, [, q]) => x + q, 0), 0));
    const dias = Number(hoje.slice(8, 10));
    const series = Array.from({ length: dias }, (_, i) => ({ chave: `${mes}-${dois(i + 1)}`, quantidades: quantidadesDoDia(`${mes}-${dois(i + 1)}`) }));
    const ultimoDia = new Date(Date.UTC(Number(mes.slice(0, 4)), Number(mes.slice(5, 7)), 0)).getUTCDate();
    return {
      de: `${mes}-01`, ate: `${mes}-${dois(ultimoDia)}`, produtos: top.map((nome) => [nome, totais[nome]]), series, total: Object.values(totais).reduce((s, q) => s + q, 0),
    };
  };

  /** Confere o gráfico contra a expectativa e contra as outras duas fontes do mesmo período. */
  const conferir = async (u, entregas, hoje, relogio) => {
    const e = esperado(entregas, hoje);
    const gr = await grafico(u, relogio);
    assert.deepEqual([gr.permitido, gr.periodo, gr.de, gr.ate, gr.agrupamento], [true, 'MES', e.de, e.ate, 'DIA']);
    assert.deepEqual(gr.produtos.map((p) => [p.nome, p.total]), e.produtos);
    assert.deepEqual(gr.series, e.series);
    assert.equal(gr.series.length, Number(hoje.slice(8, 10)));
    assert.equal(gr.total, e.total);
    e.produtos.forEach(([, total], c) => assert.equal(gr.series.reduce((s, d) => s + d.quantidades[c], 0), total, e.produtos[c][0]));
    const c = await cartao(u, relogio);
    assert.deepEqual([c.permitido, c.de, c.ate, c.valor], [true, e.de, e.ate, e.total], 'o total do gráfico é o número do cartão');
    assert.equal(await somaDoRelatorio(u, e.de, e.ate), e.total, 'o total do gráfico é a soma das linhas do relatório');
    return { gr, e };
  };

  test('1º dia do mês: duas entregas no mesmo dia somam num ponto só, e o mês anterior fica de fora', async () => {
    const A = g.empresas.A;
    const entregas = [
      { dia: '2026-03-01', hora: '00:30:00', itens: [['Luva de raspa', 12], ['Botina', 15]] },
      { dia: '2026-03-01', hora: '10:00:00', itens: [['Luva de raspa', 8], ['Capacete', 10], ['Óculos', 8], ['Protetor auricular', 5], ['Avental', 1]] },
      // 23:30 de SP do último dia do mês anterior (já é 1º de março em UTC): fora de março.
      { dia: '2026-02-28', hora: '23:30:00', itens: [['Avental', 30]] },
    ];
    await semear(A, fichaAna, entregas);
    await semear(g.empresas.B, fichaB, [{ dia: '2026-03-01', hora: '09:00:00', itens: [['Luva da B', 9]] }], masterB);
    const duas = await g.um('SELECT count(*)::int AS n FROM entregas_epi WHERE empresa_id = $1 AND data_operacional = $2', [A, '2026-03-01']);
    assert.equal(duas.n, 2, 'são DUAS entregas no mesmo dia');

    const { gr } = await conferir(completo, entregas, '2026-03-01', instante('2026-03-01', '12:00:00'));
    // Valores literais, para a expectativa calculada não ser a única âncora.
    assert.deepEqual(gr.series, [{ chave: '2026-03-01', quantidades: [20, 15, 10, 8, 5] }]);
    assert.deepEqual(gr.produtos.map((p) => [p.nome, p.total]), [['Luva de raspa', 20], ['Botina', 15], ['Capacete', 10], ['Óculos', 8], ['Protetor auricular', 5]]);
    assert.equal(gr.total, 59);

    // Isolamento: a B vê só a sua luva no mesmo instante, e a A nunca a inclui.
    const b = await grafico(completoB, instante('2026-03-01', '12:00:00'));
    assert.deepEqual(b.produtos.map((p) => [p.nome, p.total]), [['Luva da B', 9]]);
    assert.deepEqual(b.series, [{ chave: '2026-03-01', quantidades: [9] }]);
    assert.equal(gr.produtos.some((p) => p.nome === 'Luva da B'), false);
  });

  test('dia intermediário: o 1º dia e hoje são pontos distintos, e os dias sem entrega têm zeros', async () => {
    const entregas = [
      { dia: '2026-04-01', hora: '00:30:00', itens: [['Luva de raspa', 12], ['Botina', 15]] },
      { dia: '2026-04-15', hora: '10:00:00', itens: [['Luva de raspa', 8], ['Botina', 3], ['Capacete', 10], ['Óculos', 8], ['Protetor auricular', 5], ['Avental', 1]] },
    ];
    await semear(g.empresas.A, fichaAna, entregas);
    const { gr } = await conferir(completo, entregas, '2026-04-15', instante('2026-04-15', '12:00:00'));
    assert.equal(gr.series.length, 15);
    assert.deepEqual(gr.series[0].quantidades, [12, 15, 0, 0, 0]);
    assert.deepEqual(gr.series[14].quantidades, [8, 3, 10, 8, 5]);
    assert.ok(gr.series.slice(1, 14).every((s) => s.quantidades.every((q) => q === 0)));
    assert.equal(gr.total, 62);
  });

  test('último dia do mês: a entrega de 23:30 (SP) entra no último ponto e a de 00:30 do dia 1º seguinte fica de fora', async () => {
    const entregas = [
      { dia: '2026-05-01', hora: '00:30:00', itens: [['Luva de raspa', 12], ['Botina', 15]] },
      { dia: '2026-05-31', hora: '23:30:00', itens: [['Luva de raspa', 4], ['Capacete', 10]] },
      // 00:30 de SP de 1º de junho: fora de maio. Se entrasse, o Avental (40) passaria a liderar o top.
      { dia: '2026-06-01', hora: '00:30:00', itens: [['Avental', 40]] },
    ];
    await semear(g.empresas.A, fichaAna, entregas);
    const { gr } = await conferir(completo, entregas, '2026-05-31', instante('2026-05-31', '12:00:00'));
    assert.equal(gr.series.length, 31);
    assert.deepEqual(gr.series[0].quantidades, [12, 15, 0]);
    assert.deepEqual(gr.series[30].quantidades, [4, 0, 10]);
    assert.deepEqual(gr.produtos.map((p) => p.nome), ['Luva de raspa', 'Botina', 'Capacete']);
    assert.equal(gr.total, 41);
  });

  test('virada de mês na meia-noite de São Paulo: 23:59:59 ainda é o último dia; 00:00:00 já é o 1º dia do mês seguinte', async () => {
    const entregas = [
      { dia: '2026-08-01', hora: '00:30:00', itens: [['Botina', 6]] },
      { dia: '2026-08-31', hora: '23:30:00', itens: [['Luva de raspa', 4]] },
      { dia: '2026-09-01', hora: '00:30:00', itens: [['Avental', 40]] },
    ];
    await semear(g.empresas.A, fichaAna, entregas);

    // 2026-09-01T02:59:59Z = 31/08 23:59:59 em São Paulo.
    const ultimo = await conferir(completo, entregas, '2026-08-31', new Date('2026-09-01T02:59:59Z'));
    assert.equal(ultimo.gr.series.length, 31);
    assert.deepEqual([ultimo.gr.de, ultimo.gr.ate], ['2026-08-01', '2026-08-31']);
    assert.deepEqual(ultimo.gr.produtos.map((p) => [p.nome, p.total]), [['Botina', 6], ['Luva de raspa', 4]]);
    assert.deepEqual(ultimo.gr.series[30].quantidades, [0, 4]);

    // 2026-09-01T03:00:00Z = 01/09 00:00:00 em São Paulo: um mês novo, com um ponto só.
    const primeiro = await conferir(completo, entregas, '2026-09-01', new Date('2026-09-01T03:00:00Z'));
    assert.deepEqual([primeiro.gr.de, primeiro.gr.ate], ['2026-09-01', '2026-09-30']);
    assert.deepEqual(primeiro.gr.series, [{ chave: '2026-09-01', quantidades: [40] }]);
    assert.deepEqual(primeiro.gr.produtos.map((p) => [p.nome, p.total]), [['Avental', 40]]);
    assert.equal(primeiro.gr.total, 40);
  });
});
