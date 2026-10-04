'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { montarAmbiente12f } = require('./helpers/ambiente-http-12f');
const { chaveNova, vincularMaterialAoGhe } = require('./helpers/solicitacao-epi-servico');
const { ACEITE } = require('./helpers/reserva-estoque');
const solicitacaoSvc = require('../../src/services/solicitacao-epi.service');
const entregaSvc = require('../../src/services/entrega-solicitacao.service');

/**
 * Solicitações encerráveis (12G-0, L4 revisada), contra PostgreSQL real:
 *   GET /api/solicitacoes-epi/encerraveis   ação ENCERRAR_SOLICITACAO.
 * Um contrato próprio e mínimo para quem encerra localizar o que pode encerrar
 * (APROVADA e APROVADA_PARCIAL), sem ampliar /entregaveis: nada de situação
 * derivada do estoque, cobertura, posição, lote ou saldo. REALIZAR_ENTREGA não
 * abre este contrato, e ENCERRAR_SOLICITACAO não abre /entregaveis.
 */

const URL = '/api/solicitacoes-epi/encerraveis';
const CAMPOS = ['criadaEm', 'decididaEm', 'funcionario', 'id', 'numero', 'quantidadeItens', 'quantidades', 'status'];

describe('solicitações encerráveis — HTTP (PostgreSQL real)', () => {
  let env;
  let pool;
  let d;
  let f;
  let como;
  const u = {};
  const S = {};

  const resposta = (r) => ({ status: r.status, corpo: r.body });
  const idsDe = (r) => r.body.solicitacoes.map((s) => s.id);
  const criar = (empresaId, atorId, funcionarioId, materialId, quantidade = 2) => solicitacaoSvc.criarSolicitacao(pool, {
    empresaId, atorId, funcionarioId, itens: [{ materialId, tamanho: '40', quantidade, motivo: 'ADMISSAO' }], chaveIdempotencia: chaveNova(),
  });
  const decidir = (empresaId, criada, decisor, decisoes) => solicitacaoSvc.decidirSolicitacao(pool, {
    empresaId, atorId: decisor, solicitacaoId: criada.solicitacao.id, decisoes, hoje: f.HOJE,
  });
  const aprovar = (empresaId, criada, decisor, quantidadeAprovada) => decidir(empresaId, criada, decisor, [{
    itemId: criada.itens[0].id, decisao: 'APROVADO', ...(quantidadeAprovada ? { quantidadeAprovada, justificativa: 'Reposição parcial' } : {}),
  }]);

  before(async () => {
    env = await montarAmbiente12f();
    ({ pool, d, f, como } = env);
    const A = d.empresaA;
    const B = d.empresaB;
    const SST = { perfil: 'ADMINISTRADOR', sst: true };
    u.encerrador = await env.usuarioCom(A, { ...SST, acoes: ['ENCERRAR_SOLICITACAO'] });
    u.entregador = await env.usuarioCom(A, { acoes: ['REALIZAR_ENTREGA'] });
    u.ambos = await env.usuarioCom(A, { ...SST, acoes: ['ENCERRAR_SOLICITACAO', 'REALIZAR_ENTREGA'] });
    u.aprovador = await env.usuarioCom(A, { ...SST, acoes: ['APROVAR_SOLICITACAO', 'REPROVAR_SOLICITACAO'] });
    u.encerradorSemVinculo = await env.usuarioCom(A, { perfil: 'ADMINISTRADOR', acoes: ['ENCERRAR_SOLICITACAO'] });
    u.semNada = await env.usuarioCom(A);
    u.pedinte = await env.usuarioCom(A, { recursos: { request: ['visualizar', 'criar', 'editar'] } });
    u.encerradorB = await env.usuarioCom(B, { ...SST, acoes: ['ENCERRAR_SOLICITACAO'] });

    const m = await f.material();
    const loteId = await f.estoque(m, 20);
    const tSuspenso = await d.novoTrabalhador(A, { gheId: d.gheA });

    // Ordem de aprovação: a1 (mais antiga), parcial, a2, suspensa; e as que não são encerráveis.
    S.a1 = await criar(A, d.solicitante, d.trabalhador, m, 3);
    await aprovar(A, S.a1, d.sst1);
    S.parcial = await criar(A, d.solicitante, d.trabalhador2, m, 4);
    await aprovar(A, S.parcial, d.sst1, 2);
    S.a2 = await criar(A, d.solicitante, d.trabalhador3, m, 2);
    await aprovar(A, S.a2, d.sst1);
    await entregaSvc.registrarEntregaPorSolicitacao(pool, {
      empresaId: A, atorId: d.master, solicitacaoId: S.a2.solicitacao.id, itens: [{ solicitacaoItemId: S.a2.itens[0].id, loteId, quantidade: 1 }], confirmacao: ACEITE, chaveIdempotencia: chaveNova(),
    });
    S.suspensa = await criar(A, d.solicitante, tSuspenso, m, 1);
    await aprovar(A, S.suspensa, d.sst1);
    await pool.query('UPDATE funcionarios SET ativo = false WHERE id = $1', [tSuspenso]);

    S.pendente = await criar(A, d.solicitante, d.trabalhador, m, 1);
    S.reprovada = await criar(A, d.solicitante, d.trabalhador, m, 1);
    await decidir(A, S.reprovada, d.sst1, [{ itemId: S.reprovada.itens[0].id, decisao: 'REPROVADO', justificativa: 'Sem necessidade' }]);
    S.cancelada = await criar(A, d.solicitante, d.trabalhador, m, 1);
    await solicitacaoSvc.cancelarSolicitacao(pool, { empresaId: A, atorId: d.solicitante, solicitacaoId: S.cancelada.solicitacao.id, hoje: f.HOJE });
    S.entregue = await criar(A, d.solicitante, d.trabalhador, m, 1);
    await aprovar(A, S.entregue, d.sst1);
    await entregaSvc.registrarEntregaPorSolicitacao(pool, {
      empresaId: A, atorId: d.master, solicitacaoId: S.entregue.solicitacao.id, itens: [{ solicitacaoItemId: S.entregue.itens[0].id, loteId, quantidade: 1 }], confirmacao: ACEITE, chaveIdempotencia: chaveNova(),
    });
    S.encerrada = await criar(A, d.solicitante, d.trabalhador, m, 1);
    await aprovar(A, S.encerrada, d.sst1);
    await solicitacaoSvc.encerrarSolicitacao(pool, {
      empresaId: A, atorId: d.sst1, solicitacaoId: S.encerrada.solicitacao.id, justificativa: 'Sem necessidade', hoje: f.HOJE,
    });

    await vincularMaterialAoGhe(pool, B, d.gheB, d.botinaB);
    S.daB = await criar(B, d.usuarioB, d.trabalhadorB, d.botinaB, 1);
    await aprovar(B, S.daB, d.sstB);
  });

  after(async () => { if (env) await env.encerrar(); });

  const ENCERRAVEIS_DE_A = () => [S.a1, S.parcial, S.a2, S.suspensa].map((x) => x.solicitacao.id);

  test('exige ENCERRAR_SOLICITACAO: quem só entrega, quem só aprova e reprova, sem vínculo SST, só com o recurso request, sem nada e o MASTER provisionado recebem o mesmo 403; sem sessão, 401', async () => {
    const respostas = [];
    for (const usuario of [u.entregador, u.aprovador, u.encerradorSemVinculo, u.pedinte, u.semNada, d.master]) respostas.push(resposta(await como(usuario).get(URL)));
    assert.deepEqual([respostas[0].status, respostas[0].corpo.codigo], [403, 'PERMISSAO_NEGADA']);
    for (const r of respostas) assert.deepEqual(r, respostas[0]);
    assert.equal((await env.anonimo.get(URL)).status, 401);
  });

  test('200: só APROVADA e APROVADA_PARCIAL da empresa (inclusive a suspensa), da aprovação mais antiga para a mais nova', async () => {
    const r = await como(u.encerrador).get(URL);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(idsDe(r), ENCERRAVEIS_DE_A());
    assert.ok(r.body.solicitacoes.every((s) => ['APROVADA', 'APROVADA_PARCIAL'].includes(s.status)));
    assert.deepEqual([r.body.status, r.body.total, r.body.pagina, r.body.limite], ['ok', 4, 1, 20]);
  });

  test('mínimo: só identificação, trabalhador sem CPF, quantidades da solicitação e carimbos; nada de situação, cobertura, posição, lote, saldo ou texto livre', async () => {
    const r = await como(u.encerrador).get(URL);
    for (const s of r.body.solicitacoes) {
      assert.deepEqual(Object.keys(s).sort(), CAMPOS);
      assert.deepEqual(Object.keys(s.funcionario).sort(), ['ativo', 'id', 'matricula', 'nome']);
      assert.deepEqual(Object.keys(s.quantidades).sort(), ['aprovada', 'entregue', 'restante', 'solicitada']);
    }
    const texto = JSON.stringify(r.body);
    assert.equal(/situacao|cobertura|posicao|lote|saldo|fisico|comprometid|cpf|observacao|justificativa/i.test(texto), false);
    const suspensa = r.body.solicitacoes.find((s) => s.id === S.suspensa.solicitacao.id);
    assert.equal(suspensa.funcionario.ativo, false, 'a suspensa por trabalhador inativo aparece para ser encerrada');
  });

  test('quantidades da solicitação: aprovada, entregue (derivada das entregas) e restante', async () => {
    const r = await como(u.encerrador).get(URL);
    const porId = new Map(r.body.solicitacoes.map((s) => [s.id, s.quantidades]));
    assert.deepEqual(porId.get(S.a2.solicitacao.id), {
      solicitada: 2, aprovada: 2, entregue: 1, restante: 1,
    });
    assert.deepEqual(porId.get(S.parcial.solicitacao.id), {
      solicitada: 4, aprovada: 2, entregue: 0, restante: 2,
    });
  });

  test('isolamento: a outra empresa vê só as dela; filtro por trabalhador da outra empresa não traz nada', async () => {
    const b = await como(u.encerradorB).get(URL);
    assert.deepEqual(idsDe(b), [S.daB.solicitacao.id]);
    const cruzado = await como(u.encerrador).get(`${URL}?funcionarioId=${d.trabalhadorB}`);
    assert.deepEqual([idsDe(cruzado), cruzado.body.total], [[], 0]);
  });

  test('filtro por trabalhador e paginação: páginas reconstroem a lista em ordem determinística; além da última vem vazia com o total; limite fora de 1 a 100 é 400', async () => {
    assert.deepEqual(idsDe(await como(u.encerrador).get(`${URL}?funcionarioId=${d.trabalhador2}`)), [S.parcial.solicitacao.id]);
    const p1 = await como(u.encerrador).get(`${URL}?pagina=1&limite=3`);
    const p2 = await como(u.encerrador).get(`${URL}?pagina=2&limite=3`);
    const p9 = await como(u.encerrador).get(`${URL}?pagina=9&limite=3`);
    assert.deepEqual([...idsDe(p1), ...idsDe(p2)], ENCERRAVEIS_DE_A());
    assert.deepEqual([p9.body.solicitacoes, p9.body.total], [[], 4]);
    assert.deepEqual(idsDe(await como(u.encerrador).get(URL)), idsDe(await como(u.encerrador).get(URL)), 'mesma ordem a cada leitura');
    for (const consulta of ['limite=0', 'limite=101', 'pagina=0', 'status=APROVADA', 'funcionarioId=abc']) {
      const r = await como(u.encerrador).get(`${URL}?${consulta}`);
      assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], consulta);
    }
  });

  test('menor privilégio: ENCERRAR_SOLICITACAO não abre /entregaveis; REALIZAR_ENTREGA não abre /encerraveis; quem tem as duas acessa as duas', async () => {
    const entregaveisDoEncerrador = await como(u.encerrador).get('/api/solicitacoes-epi/entregaveis');
    assert.deepEqual([entregaveisDoEncerrador.status, entregaveisDoEncerrador.body.codigo], [403, 'PERMISSAO_NEGADA']);
    const encerraveisDoEntregador = await como(u.entregador).get(URL);
    assert.deepEqual([encerraveisDoEntregador.status, encerraveisDoEntregador.body.codigo], [403, 'PERMISSAO_NEGADA']);
    assert.equal((await como(u.ambos).get('/api/solicitacoes-epi/entregaveis')).status, 200);
    assert.deepEqual(idsDe(await como(u.ambos).get(URL)), ENCERRAVEIS_DE_A());
  });

  test('encerrar tira a solicitação da lista', async () => {
    const r = await como(u.encerrador).post(`/api/solicitacoes-epi/${S.a1.solicitacao.id}/encerramento`, { justificativa: 'Trabalhador transferido' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(idsDe(await como(u.encerrador).get(URL)), ENCERRAVEIS_DE_A().filter((id) => id !== S.a1.solicitacao.id));
  });
});
