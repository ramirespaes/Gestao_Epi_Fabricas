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
 * 12I — "EPIs entregues" (soma das UNIDADES entregues no mês corrente, em São Paulo) e "Próximo do vencimento de uso" (o total da aba do relatório,
 * janela de até 30 dias) contra PostgreSQL real e as rotas reais: o número do cartão é EXATAMENTE o que o relatório mostra, pelo mesmo serviço e
 * pela mesma fonte. O modelo não tem estorno nem anulação de entrega (a entrega é imutável): nada a subtrair; se um dia existir, cartão e relatório
 * seguem a mesma fonte. Permissão: epiFicha.visualizar (a das abas do relatório); sem ela, negado. Empresa sempre da sessão.
 */

const HOJE = dataOperacional();
const [ANO, MES] = HOJE.split('-').map(Number);
const MES_TXT = `${String(ANO).padStart(4, '0')}-${String(MES).padStart(2, '0')}`;
const PRIMEIRO = `${MES_TXT}-01`;
const ULTIMO = `${MES_TXT}-${String(new Date(Date.UTC(ANO, MES, 0)).getUTCDate()).padStart(2, '0')}`;
const deslocar = (dia, dias) => {
  const d = new Date(`${dia}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
};
const ULTIMO_DO_MES_ANTERIOR = deslocar(PRIMEIRO, -1);

describe('12I — Dashboard × relatórios (PostgreSQL real)', () => {
  let g;
  let master;
  let masterB;
  let comFicha;
  let semFicha;
  let comFichaB;
  const esperado = { unidadesDoMes: 0, proximo: 0 };

  before(async () => {
    g = await montar({ extras: ({ pool, exigirEmpresarial }) => [
      criarRelatorioRoutes({ controller: criarRelatorioController({ pool }), exigirSessao: exigirEmpresarial, pool }),
      criarDashboardRoutes({ controller: criarDashboardController({ pool }), exigirSessao: exigirEmpresarial, pool }),
    ] });
    const A = g.empresas.A;
    const B = g.empresas.B;
    master = await g.contaDaEmpresa(A);
    masterB = await g.contaDaEmpresa(B);

    const ana = await criarFuncionario(g.pool, A, { matricula: 'M-001', cpf: '52998224725', setor: 'Produção' });
    const fichaAna = (await criarFicha(g.pool, A, ana)).id;
    const luva = await criarMaterial(g.pool, A, 'Luva de raspa', { tipo: 'Luva', prazo: 30 });
    const botina = await criarMaterial(g.pool, A, 'Botina', { tipo: 'Botina de Segurança', prazo: 180 });
    const loteLuva = await criarLote(g.pool, { empresaId: A, materialId: luva, quantidade: 1000, caNumero: '1111', caValidade: '2020-01-01' }); // CA vencido: não interfere no prazo de uso
    const loteBotina = await criarLote(g.pool, { empresaId: A, materialId: botina, quantidade: 1000, caNumero: '2222', caValidade: '2099-01-01' });

    // Cada entrega: [dia (SP), hora, itens [material, lote, quantidade, prazo]]. dias restantes = prazo - dias desde a entrega.
    const entrega = async (empresa, ficha, dia, hora, itens, conta = master, nome = 'Ana') => registrarEntrega(g.pool, {
      usuarioId: conta.usuarioId,
      entrega: {
        empresa_id: empresa, ficha_id: ficha, responsavel_id: conta.usuarioId, responsavel_nome: 'Responsável', data_operacional: dia,
        entregue_em: `${dia}T${hora}-03:00`, trabalhador_nome: nome, trabalhador_matricula: 'M-001', trabalhador_setor: 'Produção',
      },
      itens: itens.map(([materialId, loteId, quantidade, prazo, nomeMaterial, tipo]) => ({
        material_id: materialId, lote_id: loteId, quantidade, material_nome: nomeMaterial, material_tipo: tipo, material_prazo_uso_dias: prazo,
      })),
    });
    const L = [luva, loteLuva, null, 30, 'Luva de raspa', 'Luva'];
    const Bo = [botina, loteBotina, null, 180, 'Botina', 'Botina de Segurança'];
    const item = (base, quantidade) => [base[0], base[1], quantidade, base[3], base[4], base[5]];

    // No mês corrente (SP): dois itens numa entrega só (5 + 2) no primeiro dia, às 00:30; e 4 hoje.
    await entrega(A, fichaAna, PRIMEIRO, '00:30:00', [item(L, 5), item(Bo, 2)]);
    esperado.unidadesDoMes += 7;
    await entrega(A, fichaAna, HOJE, '10:00:00', [item(L, 4)]);
    esperado.unidadesDoMes += 4;
    // Fora do mês: o último dia do mês anterior às 23:30 em São Paulo (já é o dia 1º em UTC) e um mês antes.
    await entrega(A, fichaAna, ULTIMO_DO_MES_ANTERIOR, '23:30:00', [item(L, 11)]);
    await entrega(A, fichaAna, deslocar(PRIMEIRO, -40), '12:00:00', [item(Bo, 13)]);
    // Outra empresa, no mês corrente: nunca entra na A.
    const funcB = await criarFuncionario(g.pool, B, { matricula: 'B-001', cpf: '98765432100', setor: 'Produção' });
    const fichaB = (await criarFicha(g.pool, B, funcB)).id;
    const luvaB = await criarMaterial(g.pool, B, 'Luva da B', { tipo: 'Luva', prazo: 30 });
    const loteB = await criarLote(g.pool, { empresaId: B, materialId: luvaB, quantidade: 100 });
    await entrega(B, fichaB, HOJE, '09:00:00', [[luvaB, loteB, 9, 30, 'Luva da B', 'Luva']], masterB, 'Fulano da B');

    // Próximo do vencimento (janela de 0 a 30 dias restantes): contado em LINHAS do relatório (itens entregues). Luva prazo 30.
    // Esta: entregue há 29 dias, 1 dia restante → dentro. (Também as de hoje e do primeiro dia do mês, se a luva ainda estiver no prazo.)
    await entrega(A, fichaAna, deslocar(HOJE, -29), '12:00:00', [item(L, 6)]);
    await entrega(A, fichaAna, deslocar(HOJE, -31), '12:00:00', [item(L, 1)]); // 30 - 31 = -1: vencida, fora da janela
    await entrega(A, fichaAna, deslocar(HOJE, -30), '12:00:00', [item(L, 1)]); // 0 dia restante: dentro (limite inferior inclusivo)
    await entrega(A, fichaAna, deslocar(HOJE, -29), '13:00:00', [item(Bo, 3)]); // botina prazo 180: 151 dias restantes, fora

    const liga = async (u, toggle, dono = master) => g.request(g.app).put(`/api/administracao/usuarios/${u.id}/acessos/${toggle}`).set('Cookie', g.cookie(dono)).send({ ligado: true });
    comFicha = await g.usuarioPronto(master);
    await liga(comFicha, 'dashboard');
    await liga(comFicha, 'fichaEpi');
    semFicha = await g.usuarioPronto(master);
    await liga(semFicha, 'dashboard');
    comFichaB = await g.usuarioPronto(masterB);
    await liga(comFichaB, 'dashboard', masterB);
    await liga(comFichaB, 'fichaEpi', masterB);
  });
  after(async () => { if (g) await g.encerrar(); });

  // As contas MASTER (contaDaEmpresa) já trazem o cookie; os usuários prontos entram pelo login com a senha provisória.
  const como = async (u) => ((u === master || u === masterB) ? g.cookie(u) : g.deCookies(g.cookiesDe(await g.login(u.email, g.SENHA_PROVISORIA))));
  const dashboard = async (u) => {
    const r = await g.request(g.app).get('/api/dashboard/indicadores').set('Cookie', await como(u));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.indicadores;
  };
  const relatorio = async (u, rota, consulta) => {
    const cookie = await como(u);
    const itens = [];
    let total = 0;
    for (let pagina = 1; pagina <= 50; pagina += 1) {
      const r = await g.request(g.app).get(`/api/relatorios/${rota}?${consulta}&limite=100&pagina=${pagina}`).set('Cookie', cookie);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      total = r.body.total;
      itens.push(...r.body.itens);
      if (itens.length >= total) break;
    }
    return { itens, total };
  };

  describe('EPIs entregues = unidades entregues no mês corrente', () => {
    test('o número do cartão é a SOMA DAS UNIDADES (quantidade) de todas as linhas do relatório no mesmo período, não o número de linhas, pedidos ou pessoas', async () => {
      const i = await dashboard(comFicha);
      assert.deepEqual([i.episEntregues.permitido, i.episEntregues.de, i.episEntregues.ate], [true, PRIMEIRO, ULTIMO]);
      const rel = await relatorio(comFicha, 'epis-entregues', `de=${i.episEntregues.de}&ate=${i.episEntregues.ate}`);
      const soma = rel.itens.reduce((s, l) => s + l.quantidade, 0);
      assert.equal(i.episEntregues.valor, soma, 'cartão = soma das unidades das linhas do relatório');
      assert.notEqual(rel.itens.length, soma, 'não é a contagem de linhas');
    });

    test('o valor bate com o construído: 5 + 2 (uma entrega, dois itens) + 4 + as entregas dos dias seguintes deste mês; o mês anterior (inclusive 23:30 de São Paulo, já dia 1º em UTC) e a outra empresa ficam de fora', async () => {
      const i = await dashboard(comFicha);
      const rel = await relatorio(comFicha, 'epis-entregues', `de=${PRIMEIRO}&ate=${ULTIMO}`);
      assert.ok(rel.itens.every((l) => l.dataEntrega >= PRIMEIRO && l.dataEntrega <= ULTIMO), 'o relatório do mês só traz o mês');
      assert.equal(rel.itens.some((l) => l.dataEntrega === ULTIMO_DO_MES_ANTERIOR), false, 'a entrega de 23:30 (SP) do último dia do mês anterior não é deste mês');
      assert.equal(i.episEntregues.valor, rel.itens.reduce((s, l) => s + l.quantidade, 0));
      assert.ok(i.episEntregues.valor >= esperado.unidadesDoMes, 'inclui as deste mês criadas pelo teste');
      const naoDoMes = await relatorio(comFicha, 'epis-entregues', `de=${deslocar(PRIMEIRO, -60)}&ate=${ULTIMO_DO_MES_ANTERIOR}`);
      assert.ok(naoDoMes.itens.length >= 2, 'o mês anterior existe no relatório e não entrou no cartão');
    });

    test('isolamento: a empresa B soma só as suas 9 unidades e a A nunca as inclui', async () => {
      const b = await dashboard(comFichaB);
      const relB = await relatorio(comFichaB, 'epis-entregues', `de=${PRIMEIRO}&ate=${ULTIMO}`);
      assert.equal(b.episEntregues.valor, relB.itens.reduce((s, l) => s + l.quantidade, 0));
      assert.equal(b.episEntregues.valor, 9);
      const a = await dashboard(comFicha);
      const relA = await relatorio(comFicha, 'epis-entregues', `de=${PRIMEIRO}&ate=${ULTIMO}`);
      assert.equal(relA.itens.some((l) => l.trabalhador.nome === 'Fulano da B'), false);
      assert.equal(a.episEntregues.valor, relA.itens.reduce((s, l) => s + l.quantidade, 0));
    });

    test('sem epiFicha.visualizar: negado, sem número nem período', async () => {
      assert.deepEqual((await dashboard(semFicha)).episEntregues, { permitido: false });
    });
  });

  describe('Próximo do vencimento de uso = o total da aba do relatório (janela de 30 dias)', () => {
    test('o número é exatamente o total do relatório Prazo de uso — próximo do vencimento, na mesma janela', async () => {
      const i = await dashboard(comFicha);
      const rel = await relatorio(comFicha, 'proximo-vencimento', '');
      assert.equal(i.proximoVencimentoUso.valor, rel.total);
      assert.equal(rel.itens.length, rel.total);
      assert.ok(rel.itens.every((l) => l.diasRestantes >= 0 && l.diasRestantes <= 30), 'só 0 a 30 dias restantes');
    });

    test('prazo de uso, não CA: a luva com CA vencido e prazo em dia conta; o vencido por prazo (dias restantes < 0) não; a botina com prazo longo não', async () => {
      const rel = await relatorio(comFicha, 'proximo-vencimento', '');
      const dias = rel.itens.map((l) => l.diasRestantes).sort((x, y) => x - y);
      assert.ok(dias.includes(0), 'dias restantes = 0 é o limite inferior inclusivo');
      assert.ok(dias.includes(1));
      assert.equal(rel.itens.some((l) => l.material.nome === 'Botina'), false);
      const vencidos = await relatorio(comFicha, 'vencidos', '');
      assert.ok(vencidos.itens.length >= 1, 'a de dias restantes -1 está só em "Itens vencidos"');
      const ids = new Set(rel.itens.map((l) => l.itemId));
      assert.equal(vencidos.itens.some((l) => ids.has(l.itemId)), false, 'as duas populações não se sobrepõem');
    });

    test('isolamento e permissão: a B conta só as dela; sem epiFicha.visualizar, negado', async () => {
      const b = await dashboard(comFichaB);
      const relB = await relatorio(comFichaB, 'proximo-vencimento', '');
      assert.equal(b.proximoVencimentoUso.valor, relB.total);
      assert.equal(b.proximoVencimentoUso.valor, 1, 'a luva da B entregue hoje (30 dias restantes)');
      assert.deepEqual((await dashboard(semFicha)).proximoVencimentoUso, { permitido: false });
    });
  });
});
