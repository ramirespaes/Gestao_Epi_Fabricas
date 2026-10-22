'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { montarAmbiente12f } = require('./helpers/ambiente-http-12f');
const { sessaoDeTeste, CABECALHO } = require('./helpers/ambiente-http-12d2');
const { chaveNova, vincularMaterialAoGhe } = require('./helpers/solicitacao-epi-servico');
const { ACEITE } = require('./helpers/reserva-estoque');
const { criarAppTeste } = require('../helpers/app-teste');
const { criarDashboardController } = require('../../src/controllers/dashboard.controller');
const { criarDashboardRoutes } = require('../../src/routes/dashboard.routes');
const solicitacaoSvc = require('../../src/services/solicitacao-epi.service');
const entregaSolicitacaoSvc = require('../../src/services/entrega-solicitacao.service');

/**
 * 12I — os cartões "Disponíveis para entrega", "Solicitações aguardando estoque", "Solicitações aguardando aprovação" (a fila do SST) e
 * "Funcionários ativos" contra PostgreSQL real: o número do cartão e a listagem de destino são a MESMA população. "Disponíveis para entrega"
 * é só a COBERTURA COMPLETA (todos os itens ainda pendentes cobertos e nenhum item suspenso); a regra de "algum item coberto" continua
 * existindo como filtro COM_COBERTURA para quem a usa. Sem prévia: o corpo do Dashboard traz só números.
 *
 * Mundo (empresa A):
 *   aguardando estoque (nenhum item coberto): A1, A2 (com um item reprovado) e A3;
 *   cobertura parcial: D1 (1 de 3), D2 (um item coberto e outro sem estoque) e D5 (um item coberto e outro SUSPENSO: material inativo);
 *   cobertura COMPLETA: D3, D4 (dois itens, ambos cobertos) e D6 (já entregue em parte; o que falta está coberto);
 *   fora de todas: uma PENDENTE (aguarda a SST) e uma de trabalhador INATIVO (suspensa).
 */

const ROTA = '/api/dashboard/indicadores';
const NEGADO = { permitido: false };

describe('12I — contagens do Dashboard e listagens de destino (PostgreSQL real)', () => {
  let env;
  let pool;
  let d;
  let f;
  let app;
  const u = {};
  const idsAguardando = [];
  const idsCompletas = [];
  const idsParciais = [];

  const indicadores = async (usuarioId) => {
    const r = await request(app).get(ROTA).set(CABECALHO, String(usuarioId));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.indicadores;
  };
  async function decidida(itens, funcionarioId = d.trabalhador) {
    const criada = await solicitacaoSvc.criarSolicitacao(pool, {
      empresaId: d.empresaA, atorId: d.solicitante, funcionarioId, chaveIdempotencia: chaveNova(),
      itens: itens.map(({ materialId, quantidade }) => ({ materialId, tamanho: '40', quantidade, motivo: 'ADMISSAO' })),
    });
    const decisoes = criada.itens.map((item, i) => (itens[i].decisao === 'REPROVADO'
      ? { itemId: item.id, decisao: 'REPROVADO', justificativa: 'Não previsto (fictício)' }
      : { itemId: item.id, decisao: 'APROVADO' }));
    await solicitacaoSvc.decidirSolicitacao(pool, {
      empresaId: d.empresaA, atorId: d.sst1, solicitacaoId: criada.solicitacao.id, decisoes, hoje: f.HOJE,
    });
    return criada.solicitacao.id;
  }
  const semEstoque = async (quantidade = 2, itens = []) => decidida([{ materialId: await f.material(), quantidade }, ...itens]);
  const comEstoque = async (quantidade, estoque) => { const m = await f.material(); await f.estoque(m, estoque); return m; };
  const idsDaLista = async (quem, consulta) => {
    const r = await env.como(quem).get(`/api/solicitacoes-epi/entregaveis?${consulta}&limite=100`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return { total: r.body.total, ids: r.body.solicitacoes.map((s) => s.id).sort((x, y) => x - y) };
  };
  const ordenados = (lista) => [...lista].sort((x, y) => x - y);

  before(async () => {
    env = await montarAmbiente12f();
    ({ pool, d, f } = env);
    app = criarAppTeste((a) => {
      a.use('/api', criarDashboardRoutes({ controller: criarDashboardController({ pool }), exigirSessao: sessaoDeTeste(pool), pool }));
    });
    const painel = { dashboard: ['visualizar'], availableItems: ['visualizar'] };
    u.sst = await env.usuarioCom(d.empresaA, { recursos: painel, acoes: ['APROVAR_SOLICITACAO'], sst: true });
    u.entrega = await env.usuarioCom(d.empresaA, { recursos: painel, acoes: ['REALIZAR_ENTREGA'] });
    u.encerra = await env.usuarioCom(d.empresaA, { recursos: painel, acoes: ['ENCERRAR_SOLICITACAO'], sst: true });
    u.semAcao = await env.usuarioCom(d.empresaA, { recursos: painel });
    u.entregaB = await env.usuarioCom(d.empresaB, { recursos: painel, acoes: ['REALIZAR_ENTREGA'] });
    u.rh = await env.usuarioCom(d.empresaA, { recursos: { dashboard: ['visualizar'], employeeHistory: ['visualizar'] } });
    u.rhB = await env.usuarioCom(d.empresaB, { recursos: { dashboard: ['visualizar'], employeeHistory: ['visualizar'] } });

    idsAguardando.push(await semEstoque(3)); // A1
    const m2 = await f.material();
    await f.estoque(m2, 1);
    idsParciais.push(await decidida([{ materialId: m2, quantidade: 3 }])); // D1: 1 de 3
    idsAguardando.push(await semEstoque(2, [{ materialId: await f.material(), quantidade: 1, decisao: 'REPROVADO' }])); // A2: o item reprovado não conta
    const m3 = await f.material();
    await f.estoque(m3, 1);
    idsParciais.push(await decidida([{ materialId: m3, quantidade: 1 }, { materialId: await f.material(), quantidade: 4 }])); // D2: um coberto, outro sem estoque
    idsCompletas.push(await decidida([{ materialId: await comEstoque(2, 9), quantidade: 2 }])); // D3
    idsAguardando.push(await semEstoque(5)); // A3
    idsCompletas.push(await decidida([{ materialId: await comEstoque(2, 5), quantidade: 2 }, { materialId: await comEstoque(3, 5), quantidade: 3 }])); // D4: dois itens cobertos
    const mA = await comEstoque(1, 5);
    const mSuspenso = await comEstoque(1, 5);
    idsParciais.push(await decidida([{ materialId: mA, quantidade: 1 }, { materialId: mSuspenso, quantidade: 1 }])); // D5: um coberto e outro suspenso
    await pool.query('UPDATE materiais SET ativo = false WHERE id = $1', [mSuspenso]);
    const m9 = await f.material();
    const lote9 = await f.estoque(m9, 5);
    const d6 = await decidida([{ materialId: m9, quantidade: 3 }]); // D6: entrega de 1 unidade; as 2 que faltam estão cobertas
    const { rows: [{ id: itemD6 }] } = await pool.query('SELECT id FROM solicitacoes_epi_itens WHERE solicitacao_id = $1', [d6]);
    await entregaSolicitacaoSvc.registrarEntregaPorSolicitacao(pool, {
      empresaId: d.empresaA, atorId: d.master, solicitacaoId: d6, itens: [{ solicitacaoItemId: itemD6, loteId: lote9, quantidade: 1 }], confirmacao: ACEITE, chaveIdempotencia: chaveNova(),
    });
    idsCompletas.push(d6);
    // Fora: PENDENTE (aguarda a SST) e a de trabalhador inativo (suspensa).
    await solicitacaoSvc.criarSolicitacao(pool, {
      empresaId: d.empresaA, atorId: d.solicitante, funcionarioId: d.trabalhador, itens: [{ materialId: await f.material(), tamanho: '40', quantidade: 1, motivo: 'ADMISSAO' }], chaveIdempotencia: chaveNova(),
    });
    const inativo = await d.novoTrabalhador(d.empresaA, { gheId: d.gheA });
    await decidida([{ materialId: await comEstoque(1, 5), quantidade: 1 }], inativo);
    await pool.query("UPDATE funcionarios SET situacao = 'INATIVO' WHERE id = $1", [inativo]);
    // Empresa B: uma aprovada sem estoque e outra PENDENTE (não podem aparecer na A).
    await vincularMaterialAoGhe(pool, d.empresaB, d.gheB, d.botinaB);
    for (let i = 0; i < 2; i += 1) {
      const criadaB = await solicitacaoSvc.criarSolicitacao(pool, {
        empresaId: d.empresaB, atorId: d.usuarioB, funcionarioId: d.trabalhadorB, itens: [{ materialId: d.botinaB, tamanho: '40', quantidade: 1, motivo: 'ADMISSAO' }], chaveIdempotencia: chaveNova(),
      });
      if (i === 0) {
        await solicitacaoSvc.decidirSolicitacao(pool, {
          empresaId: d.empresaB, atorId: d.sstB, solicitacaoId: criadaB.solicitacao.id, decisoes: [{ itemId: criadaB.itens[0].id, decisao: 'APROVADO' }], hoje: f.HOJE,
        });
      }
    }
  });
  after(async () => { if (env) await env.encerrar(); });

  test('só números: nenhum indicador traz previa nem dado de pedido ou de pessoa, e não existe indicador de "aguardando entrega"', async () => {
    const r = await request(app).get(ROTA).set(CABECALHO, String(u.entrega));
    assert.equal(JSON.stringify(r.body).includes('previa'), false);
    assert.equal(/trabalhador|matricula|cpf|telefone|nascimento/i.test(JSON.stringify(r.body)), false);
    assert.equal('solicitacoesAguardandoEntrega' in r.body.indicadores, false);
  });

  describe('Disponíveis para entrega = só a cobertura completa', () => {
    test('o cartão conta D3, D4 e D6 (3): pedido com todos os itens pendentes cobertos, inclusive o já entregue em parte; parcial, suspenso e aguardando estoque ficam fora', async () => {
      const i = await indicadores(u.entrega);
      assert.deepEqual(i.disponiveisParaEntrega, { permitido: true, valor: 3 });
      assert.deepEqual(i.solicitacoesAguardandoEstoque, { permitido: true, valor: 3 });
    });

    test('a lista de destino (filtro COBERTURA_COMPLETA) é exatamente a mesma população do cartão, com o total da consulta', async () => {
      const dash = (await indicadores(u.entrega)).disponiveisParaEntrega.valor;
      const lista = await idsDaLista(u.entrega, 'cobertura=COBERTURA_COMPLETA');
      assert.equal(lista.total, dash);
      assert.deepEqual(lista.ids, ordenados(idsCompletas));
      const pagina = await env.como(u.entrega).get('/api/solicitacoes-epi/entregaveis?cobertura=COBERTURA_COMPLETA&limite=1&pagina=1');
      assert.equal(pagina.body.solicitacoes.length, 1);
      assert.equal(pagina.body.total, dash, 'o total é o da consulta, não o da página');
    });

    test('o filtro antigo COM_COBERTURA continua sendo "algum item coberto" (6: as 3 completas + D1, D2 e D5), então NÃO é equivalente à cobertura completa', async () => {
      const algum = await idsDaLista(u.entrega, 'cobertura=COM_COBERTURA');
      assert.equal(algum.total, 6);
      assert.deepEqual(algum.ids, ordenados([...idsCompletas, ...idsParciais]));
      const completa = await idsDaLista(u.entrega, 'cobertura=COBERTURA_COMPLETA');
      for (const id of idsParciais) assert.equal(completa.ids.includes(id), false, `parcial ${id} fora da completa`);
    });

    test('o pedido com um item coberto e outro SUSPENSO (material inativo) não é completo; o que já foi totalmente entregue ou está suspenso por inteiro também não', async () => {
      const completa = await idsDaLista(u.entrega, 'cobertura=COBERTURA_COMPLETA');
      const d5 = idsParciais[2];
      assert.equal(completa.ids.includes(d5), false);
      const todas = await idsDaLista(u.entrega, '');
      assert.equal(todas.total, 10, '3 aguardando + 6 com algum item coberto + 1 suspensa (trabalhador inativo)');
    });

    test('a mudança do estoque muda a população: a entrada que cobre o que falta de D1 a torna completa nos dois lados (cartão e lista)', async () => {
      const antes = (await indicadores(u.entrega)).disponiveisParaEntrega.valor;
      const { rows: [{ material_id: materialD1 }] } = await pool.query('SELECT material_id FROM solicitacoes_epi_itens WHERE solicitacao_id = $1', [idsParciais[0]]);
      await f.estoque(materialD1, 5);
      const depois = (await indicadores(u.entrega)).disponiveisParaEntrega.valor;
      assert.equal(depois, antes + 1);
      assert.equal((await idsDaLista(u.entrega, 'cobertura=COBERTURA_COMPLETA')).total, depois);
    });

    test('quem só encerra não vê "disponíveis" e não filtra encerráveis por cobertura completa (400); SEM_COBERTURA segue valendo (3)', async () => {
      const i = await indicadores(u.encerra);
      assert.deepEqual(i.disponiveisParaEntrega, NEGADO);
      assert.deepEqual(i.solicitacoesAguardandoEstoque, { permitido: true, valor: 3 });
      assert.equal((await env.como(u.encerra).get('/api/solicitacoes-epi/encerraveis?cobertura=COBERTURA_COMPLETA')).status, 400);
      const sem = await env.como(u.encerra).get('/api/solicitacoes-epi/encerraveis?cobertura=SEM_COBERTURA&limite=100');
      assert.equal(sem.status, 200, JSON.stringify(sem.body));
      assert.equal(sem.body.total, 3);
      assert.equal((await env.como(u.encerra).get('/api/solicitacoes-epi/entregaveis?cobertura=COBERTURA_COMPLETA')).status, 403, 'sem REALIZAR_ENTREGA não abre a lista de entregáveis');
    });

    test('sem as ações os dois cartões vêm negados', async () => {
      const i = await indicadores(u.semAcao);
      assert.deepEqual([i.solicitacoesAguardandoEstoque, i.disponiveisParaEntrega], [NEGADO, NEGADO]);
    });

    test('isolamento: a empresa B conta e lista só o que é dela', async () => {
      const b = await indicadores(u.entregaB);
      assert.deepEqual([b.solicitacoesAguardandoEstoque, b.disponiveisParaEntrega], [{ permitido: true, valor: 1 }, { permitido: true, valor: 0 }]);
      const lista = await idsDaLista(u.entregaB, 'cobertura=SEM_COBERTURA');
      assert.equal(lista.total, 1);
      assert.equal(lista.ids.every((id) => !idsAguardando.includes(id)), true);
      assert.equal((await idsDaLista(u.entregaB, 'cobertura=COBERTURA_COMPLETA')).total, 0);
    });
  });

  describe('Solicitações aguardando aprovação = a fila do SST (um indicador só)', () => {
    test('o número do cartão (solicitacoesAguardandoSst) é exatamente a fila de aprovação: as PENDENTE da empresa, sem as aprovadas, reprovadas, canceladas nem a de outra empresa', async () => {
      const dash = (await indicadores(u.sst)).solicitacoesAguardandoSst;
      const fila = await env.como(u.sst).get('/api/solicitacoes-epi/fila?limite=100');
      assert.equal(fila.status, 200, JSON.stringify(fila.body));
      assert.deepEqual(dash, { permitido: true, valor: fila.body.total });
      assert.equal(dash.valor, 1, 'a PENDENTE da empresa A');
      assert.equal(fila.body.solicitacoes.length, dash.valor);
      assert.ok(fila.body.solicitacoes.every((x) => x.status === 'PENDENTE'));
    });

    test('só APROVAR_SOLICITACAO libera: quem entrega, encerra ou não tem ação recebe negado (nenhuma permissão é concedida para tornar o cartão visível)', async () => {
      for (const quem of [u.entrega, u.encerra, u.semAcao]) assert.deepEqual((await indicadores(quem)).solicitacoesAguardandoSst, NEGADO);
    });

    test('isolamento: a empresa B tem a sua própria fila (1), e a A não vê a dela', async () => {
      const sstB = await env.usuarioCom(d.empresaB, { recursos: { dashboard: ['visualizar'] }, acoes: ['APROVAR_SOLICITACAO'], sst: true });
      assert.deepEqual((await indicadores(sstB)).solicitacoesAguardandoSst, { permitido: true, valor: 1 });
    });
  });

  test('funcionários ativos: o número é a contagem de ativos da empresa (inativo, afastado e outra empresa fora); exige employeeHistory', async () => {
    const criar = async (empresaId, situacao) => {
      const id = await d.novoTrabalhador(empresaId, { gheId: empresaId === d.empresaA ? d.gheA : d.gheB });
      if (situacao !== 'ATIVO') await pool.query('UPDATE funcionarios SET situacao = $2 WHERE id = $1', [id, situacao]);
    };
    await criar(d.empresaA, 'ATIVO');
    await criar(d.empresaA, 'INATIVO');
    await criar(d.empresaA, 'AFASTADO');
    await criar(d.empresaB, 'ATIVO');
    const { rows: [{ n }] } = await pool.query('SELECT count(*)::int AS n FROM funcionarios WHERE empresa_id = $1 AND ativo', [d.empresaA]);
    assert.deepEqual((await indicadores(u.rh)).funcionariosAtivos, { permitido: true, valor: n });
    assert.deepEqual((await indicadores(u.semAcao)).funcionariosAtivos, NEGADO);
    const { rows: [{ nb }] } = await pool.query('SELECT count(*)::int AS nb FROM funcionarios WHERE empresa_id = $1 AND ativo', [d.empresaB]);
    assert.deepEqual((await indicadores(u.rhB)).funcionariosAtivos, { permitido: true, valor: nb });
  });
});
