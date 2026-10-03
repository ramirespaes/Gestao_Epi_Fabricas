'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { montarAmbiente12f } = require('./helpers/ambiente-http-12f');
const { vincularMaterialAoGhe, chaveNova } = require('./helpers/solicitacao-epi-servico');
const { ACEITE } = require('./helpers/reserva-estoque');
const solicitacaoSvc = require('../../src/services/solicitacao-epi.service');
const entregaSvc = require('../../src/services/entrega-solicitacao.service');

/**
 * Consultas HTTP da solicitação de EPI (12F-1) contra PostgreSQL real, com as
 * rotas, autorizações, schemas e serviços de produção:
 *   GET /api/solicitacoes-epi/minhas       recurso `request` visualizar;
 *   GET /api/solicitacoes-epi/fila         ação APROVAR_SOLICITACAO (exige SST);
 *   GET /api/solicitacoes-epi/entregaveis  ação REALIZAR_ENTREGA;
 *   GET /api/solicitacoes-epi/:id          o serviço decide: autoridade funcional
 *                                          vê qualquer da empresa; só o recurso
 *                                          `request` vê só as próprias.
 * Isolamento entre empresas, anti-enumeração (o "não encontrada" é igual para a
 * inexistente, a de outra empresa e a de outro solicitante), nenhum CPF, e a
 * justificativa do encerramento só no detalhe.
 */

const JUSTIFICATIVA = 'Trabalhador transferido para a unidade de outra cidade';
const TEXTO_LIVRE = 'Observação livre que nenhuma lista devolve';
const ID_INEXISTENTE = 2147483000;

describe('consultas HTTP da solicitação de EPI (PostgreSQL real)', () => {
  let env;
  let pool;
  let d;
  let f;
  let como;
  const u = {};
  const R = {};

  const corpoSemData = (r) => ({ status: r.status, corpo: r.body });
  const cpfs = async () => (await pool.query('SELECT cpf FROM funcionarios')).rows.map((l) => l.cpf);
  const semCpf = async (texto, rotulo) => { for (const cpf of await cpfs()) assert.equal(texto.includes(cpf), false, `CPF em ${rotulo}`); };

  before(async () => {
    env = await montarAmbiente12f();
    ({ pool, d, f, como } = env);
    const A = d.empresaA;
    const B = d.empresaB;
    u.eu = await env.usuarioCom(A, { recursos: { request: ['visualizar'] } });
    u.outro = await env.usuarioCom(A, { recursos: { request: ['visualizar'] } });
    u.sst = await env.usuarioCom(A, { perfil: 'ADMINISTRADOR', acoes: ['APROVAR_SOLICITACAO'], sst: true });
    u.sstSemVinculo = await env.usuarioCom(A, { perfil: 'ADMINISTRADOR', acoes: ['APROVAR_SOLICITACAO'] });
    u.entregador = await env.usuarioCom(A, { acoes: ['REALIZAR_ENTREGA'] });
    u.semNada = await env.usuarioCom(A);
    u.euB = await env.usuarioCom(B, { recursos: { request: ['visualizar'] } });
    u.sstB = await env.usuarioCom(B, { perfil: 'ADMINISTRADOR', acoes: ['APROVAR_SOLICITACAO', 'REALIZAR_ENTREGA'], sst: true });

    const criar = (atorId, funcionarioId, materialId, quantidade, extra = {}) => solicitacaoSvc.criarSolicitacao(pool, {
      empresaId: A, atorId, funcionarioId, itens: [{ materialId, tamanho: '40', quantidade, motivo: 'ADMISSAO' }], chaveIdempotencia: chaveNova(), ...extra,
    });
    const aprovar = (criada, empresaId = A, decisor = d.sst1) => solicitacaoSvc.decidirSolicitacao(pool, {
      empresaId, atorId: decisor, solicitacaoId: criada.solicitacao.id, decisoes: [{ itemId: criada.itens[0].id, decisao: 'APROVADO' }], hoje: f.HOJE,
    });
    const entregar = (criada, loteId, quantidade) => entregaSvc.registrarEntregaPorSolicitacao(pool, {
      empresaId: A, atorId: d.master, solicitacaoId: criada.solicitacao.id, itens: [{ solicitacaoItemId: criada.itens[0].id, loteId, quantidade }], confirmacao: ACEITE, chaveIdempotencia: chaveNova(),
    });
    const t3 = await d.novoTrabalhador(A, { gheId: d.gheA });
    const tInativo = await d.novoTrabalhador(A, { gheId: d.gheA });

    R.pendente = await criar(u.eu, d.trabalhador, await f.material(), 2, { observacao: TEXTO_LIVRE });
    R.pronta = await criar(u.eu, d.trabalhador2, await f.material(), 2);
    await aprovar(R.pronta);
    await f.estoque(R.pronta.itens[0].materialId, 2);
    R.parcial = await criar(u.eu, t3, await f.material(), 3);
    await aprovar(R.parcial);
    await entregar(R.parcial, await f.estoque(R.parcial.itens[0].materialId, 3), 1);
    R.encerrada = await criar(u.eu, d.trabalhador, await f.material(), 2);
    await aprovar(R.encerrada);
    await entregar(R.encerrada, await f.estoque(R.encerrada.itens[0].materialId, 2), 1);
    await solicitacaoSvc.encerrarSolicitacao(pool, {
      empresaId: A, atorId: d.sst1, solicitacaoId: R.encerrada.solicitacao.id, justificativa: JUSTIFICATIVA, hoje: f.HOJE,
    });
    R.suspensa = await criar(u.eu, tInativo, await f.material(), 1);
    await aprovar(R.suspensa);
    await pool.query('UPDATE funcionarios SET ativo = false WHERE id = $1', [tInativo]);
    R.reprovada = await criar(u.eu, d.trabalhador2, await f.material(), 1);
    await solicitacaoSvc.decidirSolicitacao(pool, {
      empresaId: A, atorId: d.sst1, solicitacaoId: R.reprovada.solicitacao.id, decisoes: [{ itemId: R.reprovada.itens[0].id, decisao: 'REPROVADO', justificativa: 'Sem necessidade comprovada' }], hoje: f.HOJE,
    });
    R.deOutro = await criar(u.outro, d.trabalhador, await f.material(), 1);
    R.doSst = await criar(u.sst, d.trabalhador2, await f.material(), 1);

    await vincularMaterialAoGhe(pool, B, d.gheB, d.botinaB);
    const criarB = (quantidade) => solicitacaoSvc.criarSolicitacao(pool, {
      empresaId: B, atorId: u.euB, funcionarioId: d.trabalhadorB, itens: [{ materialId: d.botinaB, tamanho: '40', quantidade, motivo: 'ADMISSAO' }], chaveIdempotencia: chaveNova(),
    });
    R.pendenteB = await criarB(1);
    R.aprovadaB = await criarB(2);
    await aprovar(R.aprovadaB, B, d.sstB);
  });

  after(async () => { if (env) await env.encerrar(); });

  const idsDe = (r) => r.body.solicitacoes.map((s) => s.id);

  describe('GET /solicitacoes-epi/minhas — recurso request', () => {
    test('200: só as do próprio usuário, das mais recentes para as antigas; nada de outro usuário nem de outra empresa', async () => {
      const r = await como(u.eu).get('/api/solicitacoes-epi/minhas');
      assert.equal(r.status, 200);
      const minhas = [R.pendente, R.pronta, R.parcial, R.encerrada, R.suspensa, R.reprovada].map((x) => x.solicitacao.id).reverse();
      assert.deepEqual(idsDe(r), minhas);
      assert.deepEqual([r.body.status, r.body.total, r.body.pagina, r.body.limite], ['ok', 6, 1, 20]);
      assert.ok(r.body.solicitacoes.every((s) => s.solicitanteUsuarioId === u.eu));
      const doOutro = await como(u.outro).get('/api/solicitacoes-epi/minhas');
      assert.deepEqual(idsDe(doOutro), [R.deOutro.solicitacao.id]);
      const daB = await como(u.euB).get('/api/solicitacoes-epi/minhas');
      assert.deepEqual(idsDe(daB).sort((a, b) => a - b), [R.pendenteB.solicitacao.id, R.aprovadaB.solicitacao.id].sort((a, b) => a - b));
    });

    test('paginação: páginas consecutivas reconstroem a lista; além da última vem vazia com o total; limite 0 e 101 são 400', async () => {
      const inteira = idsDe(await como(u.eu).get('/api/solicitacoes-epi/minhas'));
      const p1 = await como(u.eu).get('/api/solicitacoes-epi/minhas?pagina=1&limite=4');
      const p2 = await como(u.eu).get('/api/solicitacoes-epi/minhas?pagina=2&limite=4');
      assert.deepEqual([...idsDe(p1), ...idsDe(p2)], inteira);
      const alem = await como(u.eu).get('/api/solicitacoes-epi/minhas?pagina=9&limite=4');
      assert.deepEqual([alem.status, alem.body.solicitacoes, alem.body.total], [200, [], 6]);
      for (const consulta of ['limite=0', 'limite=101', 'pagina=0', 'pagina=abc']) {
        const r = await como(u.eu).get(`/api/solicitacoes-epi/minhas?${consulta}`);
        assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], consulta);
      }
    });

    test('filtro de status: só aquele status; status fora do conjunto é 400', async () => {
      const aprovadas = await como(u.eu).get('/api/solicitacoes-epi/minhas?status=APROVADA');
      assert.deepEqual(idsDe(aprovadas).sort((a, b) => a - b), [R.pronta, R.parcial, R.suspensa].map((x) => x.solicitacao.id).sort((a, b) => a - b));
      const invalido = await como(u.eu).get('/api/solicitacoes-epi/minhas?status=ABERTA');
      assert.deepEqual([invalido.status, invalido.body.codigo], [400, 'VALIDACAO']);
    });

    test('ENCERRADA traz encerradaEm (data do encerramento) e restante 0; nenhuma linha traz a justificativa', async () => {
      const r = await como(u.eu).get('/api/solicitacoes-epi/minhas?status=ENCERRADA');
      assert.equal(r.status, 200);
      assert.deepEqual(idsDe(r), [R.encerrada.solicitacao.id]);
      const [linha] = r.body.solicitacoes;
      assert.equal(linha.status, 'ENCERRADA');
      assert.match(linha.encerradaEm, /^\d{4}-\d{2}-\d{2}T/);
      assert.deepEqual([linha.situacaoOperacional, linha.quantidades], [null, { solicitada: 2, aprovada: 2, entregue: 1, restante: 0 }]);
      const todas = await como(u.eu).get('/api/solicitacoes-epi/minhas');
      for (const s of todas.body.solicitacoes) {
        assert.ok('encerradaEm' in s, `id ${s.id}`);
        if (s.status !== 'ENCERRADA') assert.equal(s.encerradaEm, null, `id ${s.id}`);
      }
      const texto = JSON.stringify(todas.body);
      assert.equal(texto.includes(JUSTIFICATIVA), false);
      assert.equal(texto.includes('justificativa'), false);
      assert.equal(texto.includes(TEXTO_LIVRE), false);
      await semCpf(texto, 'minhas');
    });

    test('a suspensa por trabalhador inativo aparece como SUSPENSA com o status gravado APROVADA', async () => {
      const r = await como(u.eu).get('/api/solicitacoes-epi/minhas?status=APROVADA');
      const suspensa = r.body.solicitacoes.find((s) => s.id === R.suspensa.solicitacao.id);
      assert.deepEqual([suspensa.status, suspensa.situacaoOperacional, suspensa.funcionario.ativo], ['APROVADA', 'SUSPENSA', false]);
    });

    test('sem o recurso: 403 PERMISSAO_NEGADA (também para quem tem só as ações da SST ou de entrega); sem sessão: 401', async () => {
      for (const usuario of [u.semNada, u.sst, u.entregador]) {
        const r = await como(usuario).get('/api/solicitacoes-epi/minhas');
        assert.deepEqual([r.status, r.body.codigo], [403, 'PERMISSAO_NEGADA'], String(usuario));
      }
      const anonima = await env.anonimo.get('/api/solicitacoes-epi/minhas');
      assert.equal(anonima.status, 401);
    });

    test('a empresa e o usuário nunca vêm do cliente: empresaId, usuarioId ou solicitanteUsuarioId na query são 400, sem dados', async () => {
      for (const consulta of [`empresaId=${d.empresaB}`, `usuarioId=${u.outro}`, `solicitanteUsuarioId=${u.outro}`]) {
        const r = await como(u.eu).get(`/api/solicitacoes-epi/minhas?${consulta}`);
        assert.deepEqual([r.status, r.body.codigo, 'solicitacoes' in r.body], [400, 'VALIDACAO', false], consulta);
      }
    });
  });

  describe('GET /solicitacoes-epi/fila — ação APROVAR_SOLICITACAO', () => {
    test('200 para quem tem a ação e o vínculo SST: só PENDENTE da empresa, da mais antiga para a mais nova; a criada pelo próprio SST continua visível', async () => {
      const r = await como(u.sst).get('/api/solicitacoes-epi/fila');
      assert.equal(r.status, 200);
      assert.deepEqual(idsDe(r), [R.pendente, R.deOutro, R.doSst].map((x) => x.solicitacao.id));
      assert.ok(r.body.solicitacoes.every((s) => s.status === 'PENDENTE'));
      const propria = r.body.solicitacoes.find((s) => s.id === R.doSst.solicitacao.id);
      assert.equal(propria.solicitanteUsuarioId, u.sst);
    });

    test('dados mínimos: sem encerradaEm, sem situação operacional, sem CPF e sem texto livre', async () => {
      const r = await como(u.sst).get('/api/solicitacoes-epi/fila');
      for (const s of r.body.solicitacoes) {
        assert.equal('encerradaEm' in s, false);
        assert.equal(s.situacaoOperacional, null);
      }
      const texto = JSON.stringify(r.body);
      assert.equal(texto.includes(TEXTO_LIVRE), false);
      assert.equal(texto.includes('justificativa'), false);
      await semCpf(texto, 'fila');
    });

    test('403 sem a ação, sem o vínculo SST (exige_sst da regra central), e para quem só entrega ou só vê as próprias', async () => {
      for (const usuario of [u.semNada, u.sstSemVinculo, u.entregador, u.eu]) {
        const r = await como(usuario).get('/api/solicitacoes-epi/fila');
        assert.deepEqual([r.status, r.body.codigo], [403, 'PERMISSAO_NEGADA'], String(usuario));
      }
    });

    test('isolamento: o SST de outra empresa vê só a fila da empresa dele', async () => {
      const r = await como(u.sstB).get('/api/solicitacoes-epi/fila');
      assert.deepEqual(idsDe(r), [R.pendenteB.solicitacao.id]);
    });

    test('a fila não aceita status, trabalhador nem empresa (400)', async () => {
      for (const consulta of ['status=APROVADA', 'funcionarioId=1', `empresaId=${d.empresaB}`]) {
        const r = await como(u.sst).get(`/api/solicitacoes-epi/fila?${consulta}`);
        assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], consulta);
      }
    });
  });

  describe('GET /solicitacoes-epi/entregaveis — ação REALIZAR_ENTREGA', () => {
    test('200: só APROVADA e APROVADA_PARCIAL, na ordem da fila de cobertura; a suspensa aparece SUSPENSA com o status gravado intacto', async () => {
      const r = await como(u.entregador).get('/api/solicitacoes-epi/entregaveis');
      assert.equal(r.status, 200);
      assert.deepEqual(idsDe(r), [R.pronta, R.parcial, R.suspensa].map((x) => x.solicitacao.id));
      assert.ok(r.body.solicitacoes.every((s) => ['APROVADA', 'APROVADA_PARCIAL'].includes(s.status)));
      const porId = new Map(r.body.solicitacoes.map((s) => [s.id, s]));
      assert.deepEqual([porId.get(R.pronta.solicitacao.id).situacaoOperacional, porId.get(R.parcial.solicitacao.id).situacaoOperacional], ['PRONTA_PARA_ENTREGA', 'PARCIALMENTE_ENTREGUE']);
      assert.deepEqual([porId.get(R.suspensa.solicitacao.id).status, porId.get(R.suspensa.solicitacao.id).situacaoOperacional], ['APROVADA', 'SUSPENSA']);
      assert.deepEqual(porId.get(R.parcial.solicitacao.id).quantidades, { solicitada: 3, aprovada: 3, entregue: 1, restante: 2 });
      for (const s of r.body.solicitacoes) assert.equal('encerradaEm' in s, false);
      await semCpf(JSON.stringify(r.body), 'entregáveis');
    });

    test('filtro de trabalhador (funcionarioId, nome do contrato existente); trabalhador de outra empresa não devolve nada; inválido é 400', async () => {
      const r = await como(u.entregador).get(`/api/solicitacoes-epi/entregaveis?funcionarioId=${d.trabalhador2}`);
      assert.deepEqual([idsDe(r), r.body.total], [[R.pronta.solicitacao.id], 1]);
      const deOutraEmpresa = await como(u.entregador).get(`/api/solicitacoes-epi/entregaveis?funcionarioId=${d.trabalhadorB}`);
      assert.deepEqual([deOutraEmpresa.status, deOutraEmpresa.body.solicitacoes, deOutraEmpresa.body.total], [200, [], 0]);
      for (const consulta of ['funcionarioId=0', 'funcionarioId=abc', 'trabalhadorId=1', 'status=APROVADA']) {
        const invalida = await como(u.entregador).get(`/api/solicitacoes-epi/entregaveis?${consulta}`);
        assert.deepEqual([invalida.status, invalida.body.codigo], [400, 'VALIDACAO'], consulta);
      }
    });

    test('403 sem REALIZAR_ENTREGA, inclusive para o SST que só decide e para quem só vê as próprias', async () => {
      for (const usuario of [u.semNada, u.sst, u.eu]) {
        const r = await como(usuario).get('/api/solicitacoes-epi/entregaveis');
        assert.deepEqual([r.status, r.body.codigo], [403, 'PERMISSAO_NEGADA'], String(usuario));
      }
    });

    test('isolamento: quem entrega na outra empresa vê só as aprovadas dela', async () => {
      const r = await como(u.sstB).get('/api/solicitacoes-epi/entregaveis');
      assert.deepEqual(idsDe(r), [R.aprovadaB.solicitacao.id]);
    });
  });

  describe('GET /solicitacoes-epi/:id — detalhe', () => {
    const detalhe = (usuario, id) => como(usuario).get(`/api/solicitacoes-epi/${id}`);

    test('o solicitante vê a própria, com as quantidades da solicitação e sem cobertura nem posição do estoque', async () => {
      const r = await detalhe(u.eu, R.parcial.solicitacao.id);
      assert.equal(r.status, 200);
      assert.deepEqual([r.body.status, r.body.solicitacao.id, r.body.solicitacao.situacaoOperacional], ['ok', R.parcial.solicitacao.id, 'PARCIALMENTE_ENTREGUE']);
      assert.deepEqual(r.body.solicitacao.quantidades, { solicitada: 3, aprovada: 3, entregue: 1, restante: 2 });
      assert.deepEqual(r.body.itens.map((i) => [i.quantidade, i.quantidadeAprovada, i.quantidadeEntregue, i.quantidadePendente]), [[3, 3, 1, 2]]);
      for (const item of r.body.itens) assert.deepEqual(['cobertura' in item, 'posicao' in item], [false, false]);
      await semCpf(JSON.stringify(r.body), 'detalhe do solicitante');
    });

    test('quem tem autoridade funcional (APROVAR_SOLICITACAO ou REALIZAR_ENTREGA) vê qualquer solicitação da empresa, com cobertura e posição', async () => {
      for (const usuario of [u.sst, u.entregador]) {
        const r = await detalhe(usuario, R.pronta.solicitacao.id);
        assert.equal(r.status, 200, String(usuario));
        assert.deepEqual(r.body.itens[0].cobertura.coberta, 2);
        assert.deepEqual(r.body.itens[0].posicao.fisicoUtilizavel, 2);
        const deOutro = await detalhe(usuario, R.deOutro.solicitacao.id);
        assert.equal(deOutro.status, 200, `outro solicitante, para ${usuario}`);
      }
    });

    test('ENCERRADA: encerradaEm e a justificativa no detalhe, para o solicitante e para a SST; a entrega preservada e o pendente zero', async () => {
      for (const usuario of [u.eu, u.sst]) {
        const r = await detalhe(usuario, R.encerrada.solicitacao.id);
        assert.equal(r.status, 200);
        assert.equal(r.body.solicitacao.status, 'ENCERRADA');
        assert.match(r.body.solicitacao.encerramento.encerradaEm, /^\d{4}-\d{2}-\d{2}T/);
        assert.deepEqual([r.body.solicitacao.encerramento.encerradaPor, r.body.solicitacao.encerramento.justificativa], [d.sst1, JUSTIFICATIVA]);
        assert.deepEqual(r.body.solicitacao.quantidades, { solicitada: 2, aprovada: 2, entregue: 1, restante: 0 });
        assert.deepEqual(r.body.itens.map((i) => [i.quantidadeEntregue, i.quantidadePendente, i.situacao]), [[1, 0, null]]);
      }
    });

    test('as quantidades do detalhe batem com as da lista "minhas" para cada solicitação do usuário', async () => {
      const lista = await como(u.eu).get('/api/solicitacoes-epi/minhas');
      for (const s of lista.body.solicitacoes) {
        const r = await detalhe(u.eu, s.id);
        assert.deepEqual(r.body.solicitacao.quantidades, s.quantidades, `id ${s.id}`);
        assert.equal(r.body.solicitacao.situacaoOperacional, s.situacaoOperacional, `id ${s.id}`);
      }
    });

    test('anti-enumeração: a solicitação de outro solicitante, a de outra empresa e a inexistente dão o MESMO 404 para quem só vê as próprias', async () => {
      const inexistente = corpoSemData(await detalhe(u.eu, ID_INEXISTENTE));
      assert.deepEqual([inexistente.status, inexistente.corpo.codigo], [404, 'SOLICITACAO_NAO_ENCONTRADA']);
      assert.deepEqual(corpoSemData(await detalhe(u.eu, R.deOutro.solicitacao.id)), inexistente, 'de outro solicitante da mesma empresa');
      assert.deepEqual(corpoSemData(await detalhe(u.eu, R.pendenteB.solicitacao.id)), inexistente, 'de outra empresa');
      assert.deepEqual(corpoSemData(await detalhe(u.euB, R.pendente.solicitacao.id)), inexistente, 'de outra empresa, vista da B');
    });

    test('isolamento também para a autoridade funcional: a de outra empresa é o mesmo 404 da inexistente', async () => {
      const inexistente = corpoSemData(await detalhe(u.sst, ID_INEXISTENTE));
      assert.deepEqual(corpoSemData(await detalhe(u.sst, R.aprovadaB.solicitacao.id)), inexistente);
      assert.deepEqual(corpoSemData(await detalhe(u.sstB, R.pronta.solicitacao.id)), inexistente);
    });

    test('sem autoridade nenhuma: o mesmo 403 genérico do middleware, exista ou não a solicitação', async () => {
      const doMiddleware = corpoSemData(await como(u.semNada).get('/api/solicitacoes-epi/fila'));
      assert.deepEqual([doMiddleware.status, doMiddleware.corpo.codigo], [403, 'PERMISSAO_NEGADA']);
      for (const id of [R.pendente.solicitacao.id, ID_INEXISTENTE, R.pendenteB.solicitacao.id]) {
        assert.deepEqual(corpoSemData(await detalhe(u.semNada, id)), doMiddleware, `id ${id}`);
      }
    });

    test('id inválido é 400; query com empresa ou usuário é 400; sem sessão é 401', async () => {
      for (const id of ['0', 'abc', '1.5', '017']) {
        const r = await detalhe(u.eu, id);
        assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], id);
      }
      const comEmpresa = await como(u.sst).get(`/api/solicitacoes-epi/${R.pronta.solicitacao.id}?empresaId=${d.empresaB}`);
      assert.deepEqual([comEmpresa.status, comEmpresa.body.codigo], [400, 'VALIDACAO']);
      assert.equal((await env.anonimo.get(`/api/solicitacoes-epi/${R.pronta.solicitacao.id}`)).status, 401);
    });

    test('nenhuma resposta de consulta traz CPF; a justificativa do encerramento só aparece no detalhe', async () => {
      const respostas = [
        await como(u.eu).get('/api/solicitacoes-epi/minhas'),
        await como(u.sst).get('/api/solicitacoes-epi/fila'),
        await como(u.entregador).get('/api/solicitacoes-epi/entregaveis'),
      ];
      for (const r of respostas) {
        assert.equal(JSON.stringify(r.body).includes(JUSTIFICATIVA), false);
        await semCpf(JSON.stringify(r.body), 'lista');
      }
      const r = await detalhe(u.sst, R.encerrada.solicitacao.id);
      assert.equal(JSON.stringify(r.body).includes(JUSTIFICATIVA), true);
      await semCpf(JSON.stringify(r.body), 'detalhe');
    });

    test('HEAD do detalhe segue as mesmas regras sem corpo', async () => {
      assert.equal((await como(u.eu).head(`/api/solicitacoes-epi/${R.parcial.solicitacao.id}`)).status, 200);
      assert.equal((await como(u.eu).head(`/api/solicitacoes-epi/${R.deOutro.solicitacao.id}`)).status, 404);
      assert.equal((await como(u.semNada).head(`/api/solicitacoes-epi/${R.parcial.solicitacao.id}`)).status, 403);
    });
  });

  test('nas listas a autorização vem antes da validação: sem autoridade, até a query inválida recebe o 403 genérico', async () => {
    for (const rota of ['/api/solicitacoes-epi/minhas?limite=0', '/api/solicitacoes-epi/fila?status=X', '/api/solicitacoes-epi/entregaveis?funcionarioId=abc']) {
      const r = await como(u.semNada).get(rota);
      assert.deepEqual([r.status, r.body.codigo], [403, 'PERMISSAO_NEGADA'], rota);
    }
  });

  test('as consultas não escrevem: nenhuma tabela muda, nem a auditoria', async () => {
    const foto = async () => (await pool.query(
      `SELECT (SELECT count(*)::int FROM solicitacoes_epi) AS s, (SELECT count(*)::int FROM logs_auditoria) AS a,
              (SELECT count(*)::int FROM entregas_epi) AS e, (SELECT count(*)::int FROM estoque_operacoes) AS o`,
    )).rows[0];
    const antes = await foto();
    await como(u.eu).get('/api/solicitacoes-epi/minhas');
    await como(u.sst).get('/api/solicitacoes-epi/fila');
    await como(u.entregador).get('/api/solicitacoes-epi/entregaveis');
    await como(u.eu).get(`/api/solicitacoes-epi/${R.parcial.solicitacao.id}`);
    assert.deepEqual(await foto(), antes);
  });
});
