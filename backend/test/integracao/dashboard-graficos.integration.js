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
const { dataOperacional } = require('../../src/utils/data-operacional');

/**
 * 12I — gráficos do Dashboard contra PostgreSQL real e as rotas reais:
 *   GET /api/dashboard/graficos/setores?periodo=        funcionários ATIVOS cadastrados (criado_em, dia civil de SP) no período, por setor;
 *   GET /api/dashboard/graficos/epis-entregues?periodo= unidades entregues por produto (top 5), pela MESMA fonte do relatório "EPIs entregues".
 * Períodos de calendário (MES, SEIS_MESES, ANO) em São Paulo; permissão da fonte (employeeHistory / epiFicha) decidida no servidor; empresa só da
 * sessão. Equivalência provada contra o cartão "EPIs entregues" e contra a soma das linhas do relatório no mesmo período.
 */

const HOJE = dataOperacional();
const [ANO, MES] = HOJE.split('-').map(Number);
const mesTxt = (ano, mes) => `${String(ano).padStart(4, '0')}-${String(mes).padStart(2, '0')}`;
const ultimoDia = (ano, mes) => new Date(Date.UTC(ano, mes, 0)).getUTCDate();
const mesesAtras = (n) => { const d = new Date(Date.UTC(ANO, MES - 1 - n, 1)); return [d.getUTCFullYear(), d.getUTCMonth() + 1]; };
const PRIMEIRO = `${mesTxt(ANO, MES)}-01`;
const ULTIMO = `${mesTxt(ANO, MES)}-${String(ultimoDia(ANO, MES)).padStart(2, '0')}`;
const deslocar = (dia, dias) => { const d = new Date(`${dia}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + dias); return d.toISOString().slice(0, 10); };
const ULTIMO_DO_MES_ANTERIOR = deslocar(PRIMEIRO, -1);
const diaDoMes = (n, dia = 10) => { const [a, m] = mesesAtras(n); return `${mesTxt(a, m)}-${String(Math.min(dia, ultimoDia(a, m))).padStart(2, '0')}`; };
const chaveMes = (n) => { const [a, m] = mesesAtras(n); return mesTxt(a, m); };

describe('12I — gráficos do Dashboard (PostgreSQL real)', () => {
  let g;
  let master;
  let masterB;
  let completo;
  let soFicha;
  let soFuncionarios;
  let soDashboard;
  let completoB;
  const mat = {};

  before(async () => {
    g = await montar({ extras: ({ pool, exigirEmpresarial }) => [
      criarRelatorioRoutes({ controller: criarRelatorioController({ pool }), exigirSessao: exigirEmpresarial, pool }),
      criarDashboardRoutes({ controller: criarDashboardController({ pool }), exigirSessao: exigirEmpresarial, pool }),
    ] });
    const A = g.empresas.A;
    const B = g.empresas.B;
    master = await g.contaDaEmpresa(A);
    masterB = await g.contaDaEmpresa(B);

    // ---- Funcionários (setores). criado_em é gravado depois, para simular o momento do cadastro em São Paulo.
    let seq = 100;
    const funcionario = async (empresa, setor, { ativo = true, criadoEm = null } = {}) => {
      seq += 1;
      const id = await criarFuncionario(g.pool, empresa, { matricula: `S-${seq}`, cpf: String(10000000000 + seq), setor, ativo });
      if (criadoEm) await g.pool.query('UPDATE funcionarios SET criado_em = $2 WHERE id = $1', [id, criadoEm]);
      return id;
    };
    // Mês corrente: 3 Produção (uma com variação de caixa/espaço), 2 Manutenção, 1 sem setor, 1 vazio (= sem setor), 1 Produção INATIVO (fora).
    await funcionario(A, 'Produção', { criadoEm: `${PRIMEIRO}T00:30:00-03:00` });
    await funcionario(A, 'Produção');
    await funcionario(A, 'produção '); // grafia minoritária: agrupa com as outras e o rótulo é a mais frequente
    await funcionario(A, 'Manutenção');
    await funcionario(A, 'Manutenção');
    await funcionario(A, null);
    await funcionario(A, '   ');
    await funcionario(A, 'Produção', { ativo: false });
    // Último dia do mês anterior às 23:30 de SP (já é o dia 1º em UTC): fora de MES, dentro de SEIS_MESES e ANO.
    await funcionario(A, 'Produção', { criadoEm: `${ULTIMO_DO_MES_ANTERIOR}T23:30:00-03:00` });
    // Cinco meses atrás: dentro de SEIS_MESES; seis meses atrás: só ANO; onze meses atrás: só ANO; doze meses atrás: fora de tudo.
    await funcionario(A, 'Logística', { criadoEm: `${diaDoMes(5)}T12:00:00-03:00` });
    await funcionario(A, 'Logística', { criadoEm: `${diaDoMes(6)}T12:00:00-03:00` });
    await funcionario(A, 'Logística', { criadoEm: `${diaDoMes(11)}T12:00:00-03:00` });
    await funcionario(A, 'Logística', { criadoEm: `${diaDoMes(12)}T12:00:00-03:00` });
    // Empresa B: nunca entra na A.
    await funcionario(B, 'Produção');
    await funcionario(B, 'Produção');

    // ---- Entregas (produtos). Seis materiais na A: a sexta fica fora do top 5.
    const ana = await funcionario(A, 'Produção', { criadoEm: `${diaDoMes(12)}T12:00:00-03:00` }); // cadastro antigo: não afeta o gráfico de setores
    const fichaAna = (await criarFicha(g.pool, A, ana)).id;
    const nomes = ['Luva de raspa', 'Botina', 'Capacete', 'Óculos', 'Protetor auricular', 'Avental'];
    for (const nome of nomes) {
      const materialId = await criarMaterial(g.pool, A, nome, { tipo: null, prazo: 180 });
      const loteId = await criarLote(g.pool, { empresaId: A, materialId, quantidade: 1000, caNumero: `CA-${materialId}`, caValidade: '2099-01-01' });
      mat[nome] = { materialId, loteId };
    }
    const entrega = async (empresa, ficha, dia, hora, itens, conta = master) => registrarEntrega(g.pool, {
      usuarioId: conta.usuarioId,
      entrega: {
        empresa_id: empresa, ficha_id: ficha, responsavel_id: conta.usuarioId, responsavel_nome: 'Responsável', data_operacional: dia,
        entregue_em: `${dia}T${hora}-03:00`, trabalhador_nome: 'Ana', trabalhador_matricula: 'S-999', trabalhador_setor: 'Produção',
      },
      itens: itens.map(([nome, quantidade]) => ({
        material_id: mat[nome].materialId, lote_id: mat[nome].loteId, quantidade, material_nome: nome, material_tipo: null, material_prazo_uso_dias: 180,
      })),
    });
    // Mês corrente: Luva 20 (12 no dia 1º + 8 hoje), Botina 15, Capacete 10, Óculos 8, Protetor 5, Avental 1 → total 59; Avental fora do top 5.
    await entrega(A, fichaAna, PRIMEIRO, '00:30:00', [['Luva de raspa', 12], ['Botina', 15]]);
    await entrega(A, fichaAna, HOJE, '10:00:00', [['Luva de raspa', 8], ['Capacete', 10], ['Óculos', 8], ['Protetor auricular', 5], ['Avental', 1]]);
    // Último dia do mês anterior às 23:30 de SP: fora de MES; no mês anterior em SEIS_MESES/ANO. Avental 30 → no semestre o Avental passa o Protetor.
    await entrega(A, fichaAna, ULTIMO_DO_MES_ANTERIOR, '23:30:00', [['Avental', 30]]);
    // Cinco meses atrás (dentro de SEIS_MESES), seis meses atrás (só ANO), doze meses atrás (fora de tudo).
    await entrega(A, fichaAna, diaDoMes(5), '12:00:00', [['Capacete', 7]]);
    await entrega(A, fichaAna, diaDoMes(6), '12:00:00', [['Botina', 100]]);
    await entrega(A, fichaAna, diaDoMes(12), '12:00:00', [['Luva de raspa', 500]]);
    // Empresa B.
    const funcB = await funcionario(B, 'Produção');
    const fichaB = (await criarFicha(g.pool, B, funcB)).id;
    const luvaB = await criarMaterial(g.pool, B, 'Luva da B', { prazo: 30 });
    const loteB = await criarLote(g.pool, { empresaId: B, materialId: luvaB, quantidade: 100 });
    mat['Luva da B'] = { materialId: luvaB, loteId: loteB };
    await entrega(B, fichaB, HOJE, '09:00:00', [['Luva da B', 9]], masterB);

    const liga = async (u, toggle, dono = master) => {
      const r = await g.request(g.app).put(`/api/administracao/usuarios/${u.id}/acessos/${toggle}`).set('Cookie', g.cookie(dono)).send({ ligado: true });
      assert.equal(r.status, 200, `toggle ${toggle}: ${JSON.stringify(r.body)}`);
    };
    completo = await g.usuarioPronto(master);
    for (const t of ['dashboard', 'fichaEpi', 'historicoFuncionarios']) await liga(completo, t);
    soFicha = await g.usuarioPronto(master);
    for (const t of ['dashboard', 'fichaEpi']) await liga(soFicha, t);
    soFuncionarios = await g.usuarioPronto(master);
    for (const t of ['dashboard', 'historicoFuncionarios']) await liga(soFuncionarios, t);
    soDashboard = await g.usuarioPronto(master);
    await liga(soDashboard, 'dashboard');
    completoB = await g.usuarioPronto(masterB);
    for (const t of ['dashboard', 'fichaEpi', 'historicoFuncionarios']) await liga(completoB, t, masterB);
  });
  after(async () => { if (g) await g.encerrar(); });

  const como = async (u) => ((u === master || u === masterB) ? g.cookie(u) : g.deCookies(g.cookiesDe(await g.login(u.email, g.SENHA_PROVISORIA))));
  const grafico = async (u, nome, periodo, esperado = 200) => {
    const consulta = periodo === undefined ? '' : `?periodo=${periodo}`;
    const r = await g.request(g.app).get(`/api/dashboard/graficos/${nome}${consulta}`).set('Cookie', await como(u));
    assert.equal(r.status, esperado, JSON.stringify(r.body));
    return r.body;
  };
  const indicadores = async (u) => {
    const r = await g.request(g.app).get('/api/dashboard/indicadores').set('Cookie', await como(u));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.indicadores;
  };
  const relatorio = async (u, consulta) => {
    const cookie = await como(u);
    const itens = [];
    let total = 0;
    for (let pagina = 1; pagina <= 50; pagina += 1) {
      const r = await g.request(g.app).get(`/api/relatorios/epis-entregues?${consulta}&limite=100&pagina=${pagina}`).set('Cookie', cookie);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      total = r.body.total;
      itens.push(...r.body.itens);
      if (itens.length >= total) break;
    }
    return itens;
  };
  const porSetor = (lista) => Object.fromEntries(lista.map((s) => [s.setor, s.quantidade]));
  const somaPorProduto = (itens) => { const m = {}; for (const i of itens) m[i.epi?.nome ?? i.materialNome ?? i.nome] = (m[i.epi?.nome ?? i.materialNome ?? i.nome] ?? 0) + i.quantidade; return m; };

  describe('acesso', () => {
    test('sem sessão: 401; sem dashboard.visualizar: 403 (mesmo o MASTER sem o toggle vê pela autoridade própria, então usa um usuário sem o toggle)', async () => {
      const r = await g.request(g.app).get('/api/dashboard/graficos/setores?periodo=MES');
      assert.equal(r.status, 401);
      const semNada = await g.usuarioPronto(master);
      await grafico(semNada, 'setores', 'MES', 403);
      await grafico(semNada, 'epis-entregues', 'MES', 403);
    });

    test('período inválido, minúsculo ou parâmetro extra: 400; sem período: MES', async () => {
      await grafico(completo, 'setores', 'SEMANA', 400);
      await grafico(completo, 'epis-entregues', 'mes', 400);
      const r = await g.request(g.app).get('/api/dashboard/graficos/setores?periodo=MES&empresaId=1').set('Cookie', await como(completo));
      assert.equal(r.status, 400);
      const padrao = await grafico(completo, 'setores', undefined);
      assert.equal(padrao.grafico.periodo, 'MES');
    });

    test('a permissão de cada gráfico é a da fonte: só fichaEpi vê produtos e não setores; só employeeHistory o contrário; só dashboard nenhum', async () => {
      assert.deepEqual((await grafico(soFicha, 'setores', 'MES')).grafico, { permitido: false });
      assert.equal((await grafico(soFicha, 'epis-entregues', 'MES')).grafico.permitido, true);
      assert.equal((await grafico(soFuncionarios, 'setores', 'MES')).grafico.permitido, true);
      assert.deepEqual((await grafico(soFuncionarios, 'epis-entregues', 'MES')).grafico, { permitido: false });
      assert.deepEqual((await grafico(soDashboard, 'setores', 'ANO')).grafico, { permitido: false });
      assert.deepEqual((await grafico(soDashboard, 'epis-entregues', 'ANO')).grafico, { permitido: false });
    });
  });

  describe('distribuição por setor', () => {
    test('MES: só os ativos cadastrados no mês corrente (SP), agrupados sem distinguir caixa/espaços, nulo e vazio como "Sem setor", ordem decrescente', async () => {
      const { grafico: gr } = await grafico(completo, 'setores', 'MES');
      assert.deepEqual([gr.permitido, gr.periodo, gr.de, gr.ate], [true, 'MES', PRIMEIRO, ULTIMO]);
      assert.deepEqual(gr.setores.map((s) => s.quantidade), [3, 2, 2].slice(0, gr.setores.length));
      assert.deepEqual(porSetor(gr.setores), { 'Produção': 3, 'Manutenção': 2, 'Sem setor': 2 });
      assert.equal(gr.total, 7);
      assert.equal(gr.setores[0].setor, 'Produção');
    });

    test('a entrada de 23:30 (SP) do último dia do mês anterior não é do mês corrente, mas é do semestre; o inativo nunca conta', async () => {
      const seis = (await grafico(completo, 'setores', 'SEIS_MESES')).grafico;
      assert.deepEqual([seis.de, seis.ate], [`${chaveMes(5)}-01`, ULTIMO]);
      assert.deepEqual(porSetor(seis.setores), { 'Produção': 4, 'Manutenção': 2, 'Sem setor': 2, 'Logística': 1 });
      assert.equal(seis.total, 9);
    });

    test('ANO: doze meses de calendário; o de doze meses atrás fica fora', async () => {
      const ano = (await grafico(completo, 'setores', 'ANO')).grafico;
      assert.deepEqual([ano.de, ano.ate], [`${chaveMes(11)}-01`, ULTIMO]);
      assert.deepEqual(porSetor(ano.setores), { 'Produção': 4, 'Manutenção': 2, 'Sem setor': 2, 'Logística': 3 });
      assert.equal(ano.total, 11);
    });

    test('isolamento: a empresa B vê só os seus; a A nunca inclui os da B', async () => {
      const b = (await grafico(completoB, 'setores', 'ANO')).grafico;
      assert.deepEqual(porSetor(b.setores), { 'Produção': 3 });
      assert.equal(b.total, 3);
    });

    test('é o total dos ativos cadastrados no período, não o indicador "Funcionários ativos" (que conta todos os ativos, de qualquer data)', async () => {
      const i = await indicadores(completo);
      const ano = (await grafico(completo, 'setores', 'ANO')).grafico;
      assert.ok(i.funcionariosAtivos.valor > ano.total, 'há ativos cadastrados há mais de doze meses (Ana e o de 12 meses atrás)');
    });
  });

  describe('produtos que mais saem', () => {
    test('MES: top 5 por unidades (Avental, com 1, fica fora), nomes do snapshot, série por dia de 1º até hoje com zeros, total = cartão "EPIs entregues" = soma das linhas do relatório', async () => {
      const { grafico: gr } = await grafico(completo, 'epis-entregues', 'MES');
      assert.deepEqual([gr.permitido, gr.periodo, gr.de, gr.ate, gr.agrupamento], [true, 'MES', PRIMEIRO, ULTIMO, 'DIA']);
      assert.deepEqual(gr.produtos.map((p) => [p.nome, p.total]), [['Luva de raspa', 20], ['Botina', 15], ['Capacete', 10], ['Óculos', 8], ['Protetor auricular', 5]]);
      assert.ok(gr.produtos.every((p) => Number.isInteger(p.materialId) && p.materialId > 0));
      assert.equal(gr.total, 59);
      const i = await indicadores(completo);
      assert.equal(gr.total, i.episEntregues.valor, 'o total do gráfico é o número do cartão');
      const linhas = await relatorio(completo, `de=${gr.de}&ate=${gr.ate}`);
      assert.equal(gr.total, linhas.reduce((s, l) => s + l.quantidade, 0));
      // Série: uma entrada por dia do mês até hoje, cinco quantidades por dia, na ordem dos produtos.
      assert.equal(gr.series.length, Number(HOJE.slice(8, 10)));
      assert.equal(gr.series[0].chave, PRIMEIRO);
      assert.equal(gr.series[gr.series.length - 1].chave, HOJE);
      assert.ok(gr.series.every((s) => s.quantidades.length === 5));
      assert.deepEqual(gr.series[0].quantidades, [12, 15, 0, 0, 0]);
      assert.deepEqual(gr.series[gr.series.length - 1].quantidades.slice(0, 5), HOJE === PRIMEIRO ? [20, 15, 10, 8, 5] : [8, 0, 10, 8, 5]);
      // Cada coluna soma o total do produto.
      gr.produtos.forEach((p, c) => assert.equal(gr.series.reduce((s, d) => s + d.quantidades[c], 0), p.total, p.nome));
    });

    test('SEIS_MESES: série por mês com seis chaves; a entrega de 23:30 (SP) do último dia do mês anterior cai no mês anterior; o Avental (31) entra no top e o Protetor (5) sai', async () => {
      const gr = (await grafico(completo, 'epis-entregues', 'SEIS_MESES')).grafico;
      assert.deepEqual([gr.de, gr.ate, gr.agrupamento], [`${chaveMes(5)}-01`, ULTIMO, 'MES']);
      assert.deepEqual(gr.series.map((s) => s.chave), [5, 4, 3, 2, 1, 0].map(chaveMes));
      assert.deepEqual(gr.produtos.map((p) => [p.nome, p.total]), [['Avental', 31], ['Luva de raspa', 20], ['Capacete', 17], ['Botina', 15], ['Óculos', 8]]);
      assert.equal(gr.total, 59 + 30 + 7);
      const linhas = await relatorio(completo, `de=${gr.de}&ate=${gr.ate}`);
      assert.equal(gr.total, linhas.reduce((s, l) => s + l.quantidade, 0));
      const mesAnterior = gr.series.find((s) => s.chave === chaveMes(1));
      assert.equal(mesAnterior.quantidades[0], 30, 'Avental de 23:30 SP no mês anterior');
      const cincoAtras = gr.series.find((s) => s.chave === chaveMes(5));
      assert.equal(cincoAtras.quantidades[2], 7, 'Capacete de cinco meses atrás');
      gr.produtos.forEach((p, c) => assert.equal(gr.series.reduce((s, d) => s + d.quantidades[c], 0), p.total, p.nome));
    });

    test('ANO: doze meses; a Botina de seis meses atrás entra (115) e a Luva de doze meses atrás fica fora', async () => {
      const gr = (await grafico(completo, 'epis-entregues', 'ANO')).grafico;
      assert.equal(gr.series.length, 12);
      assert.deepEqual(gr.produtos[0], { materialId: mat.Botina.materialId, nome: 'Botina', total: 115 });
      assert.equal(gr.produtos.find((p) => p.nome === 'Luva de raspa').total, 20);
      assert.equal(gr.total, 59 + 30 + 7 + 100);
      const linhas = await relatorio(completo, `de=${gr.de}&ate=${gr.ate}`);
      assert.equal(gr.total, linhas.reduce((s, l) => s + l.quantidade, 0));
    });

    test('isolamento: a empresa B vê só a sua luva (9); a A nunca a inclui', async () => {
      const b = (await grafico(completoB, 'epis-entregues', 'ANO')).grafico;
      assert.deepEqual(b.produtos.map((p) => [p.nome, p.total]), [['Luva da B', 9]]);
      assert.equal(b.total, 9);
      const a = (await grafico(completo, 'epis-entregues', 'ANO')).grafico;
      assert.equal(a.produtos.some((p) => p.nome === 'Luva da B'), false);
    });

    test('somente leitura: nada é gravado em entregas, solicitações ou auditoria pelos gráficos', async () => {
      const cookie = await como(completo); // o login é auditado; a sessão é aberta antes da contagem
      const antes = await g.um('SELECT (SELECT count(*) FROM entregas_epi_itens) AS itens, (SELECT count(*) FROM logs_auditoria) AS logs');
      for (const nome of ['epis-entregues', 'setores']) {
        const r = await g.request(g.app).get(`/api/dashboard/graficos/${nome}?periodo=ANO`).set('Cookie', cookie);
        assert.equal(r.status, 200);
      }
      const depois = await g.um('SELECT (SELECT count(*) FROM entregas_epi_itens) AS itens, (SELECT count(*) FROM logs_auditoria) AS logs');
      assert.deepEqual(depois, antes);
    });
  });
});
