'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { montarAmbiente12f } = require('./helpers/ambiente-http-12f');
const { sessaoDeTeste } = require('./helpers/ambiente-http-12d2');
const { chaveNova } = require('./helpers/solicitacao-epi-servico');
const { criarAppTeste } = require('../helpers/app-teste');
const { criarAuthController } = require('../../src/controllers/auth.controller');
const { criarAuthRoutes } = require('../../src/routes/auth.routes');
const { criarLimitador } = require('../../src/middleware/rate-limit');
const { criarSolicitacaoEpiRoutes } = require('../../src/routes/solicitacao-epi.routes');
const { criarSolicitacaoEpiController } = require('../../src/controllers/solicitacao-epi.controller');
const solicitacaoSvc = require('../../src/services/solicitacao-epi.service');

const EpiHttp = require('../../../frontend/js/api-http');
const EpiPermissoes = require('../../../frontend/js/permissoes-efetivas');
const EpiSolicitacoesEpi = require('../../../frontend/js/solicitacoes-epi');

/**
 * 12G-1 — contrato dos módulos REAIS do frontend da solicitação de EPI com o
 * servidor HTTP real e o PostgreSQL real (schema temporário com todas as
 * migrations): GET /auth/permissoes (com vinculosSst, 12G-0) validado pelo
 * frontend, as capacidades e o mapa de páginas a partir dele, e cada caminho e
 * consulta de js/solicitacoes-epi.js aceitos pelas rotas, schemas estritos e
 * autorizações de produção. A única peça de teste é a sessão (x-teste-usuario).
 * Se o backend mudar um caminho, um parâmetro ou o formato das permissões,
 * este arquivo reprova.
 */

const S = EpiSolicitacoesEpi;
const ID_INEXISTENTE = 2147483000;

describe('12G-1 — módulos do frontend da solicitação contra servidor e PostgreSQL reais', () => {
  let env;
  let servidor;
  let base;
  const u = {};
  let minha;
  let deOutro;
  let aprovada;

  before(async () => {
    env = await montarAmbiente12f();
    const { pool, d } = env;
    const app = criarAppTeste((a) => {
      const exigirSessao = sessaoDeTeste(pool);
      a.use(
        '/api',
        criarAuthRoutes({ controller: criarAuthController({ pool }), limitador: criarLimitador({ limite: 100000, janelaSegundos: 60 }), exigirSessao }),
        criarSolicitacaoEpiRoutes({ controller: criarSolicitacaoEpiController({ pool, relogio: () => new Date() }), exigirSessao, pool }),
      );
    });
    servidor = http.createServer(app);
    await new Promise((resolve) => { servidor.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${servidor.address().port}`;

    u.solicitante = await env.usuarioCom(d.empresaA, { recursos: { request: ['visualizar', 'criar', 'editar'] } });
    u.outro = await env.usuarioCom(d.empresaA, { recursos: { request: ['visualizar', 'criar'] } });
    u.sst = await env.usuarioCom(d.empresaA, { perfil: 'ADMINISTRADOR', acoes: ['APROVAR_SOLICITACAO', 'REPROVAR_SOLICITACAO', 'ENCERRAR_SOLICITACAO'], sst: true });
    u.entregador = await env.usuarioCom(d.empresaA, { acoes: ['REALIZAR_ENTREGA'] });
    u.sstB = await env.usuarioCom(d.empresaB, { perfil: 'ADMINISTRADOR', acoes: ['APROVAR_SOLICITACAO'], sst: true });

    const criar = (atorId) => solicitacaoSvc.criarSolicitacao(pool, {
      empresaId: d.empresaA, atorId, funcionarioId: d.trabalhador, itens: [{ materialId: d.capacete, tamanho: null, quantidade: 1, motivo: 'ADMISSAO' }], chaveIdempotencia: chaveNova(),
    });
    minha = (await criar(u.solicitante)).solicitacao.id;
    deOutro = (await criar(u.outro)).solicitacao.id;
    const paraAprovar = await criar(u.solicitante);
    await solicitacaoSvc.decidirSolicitacao(pool, {
      empresaId: d.empresaA, atorId: d.sst1, solicitacaoId: paraAprovar.solicitacao.id, hoje: env.f.HOJE,
      decisoes: [{ itemId: paraAprovar.itens[0].id, decisao: 'APROVADO' }],
    });
    aprovada = paraAprovar.solicitacao.id;
  });

  after(async () => {
    EpiHttp.configurar({ fetch: null });
    if (servidor) await new Promise((resolve) => { servidor.close(resolve); });
    if (env) await env.encerrar();
  });

  const comoUsuario = (usuarioId) => {
    EpiHttp.configurar({
      baseUrl: `${base}/api`,
      fetch: (url, opcoes = {}) => fetch(url, { ...opcoes, headers: { ...(opcoes.headers || {}), ...(usuarioId === null ? {} : { 'x-teste-usuario': String(usuarioId) }) } }),
    });
  };
  const perfilDe = async (id) => (await env.pool.query('SELECT perfil FROM usuarios WHERE id = $1', [id])).rows[0].perfil;
  const permissoesDe = async (id, empresaId = env.d.empresaA) => {
    comoUsuario(id);
    const r = await EpiPermissoes.carregar({ empresaId, usuarioId: id, perfil: await perfilDe(id) });
    assert.equal(r.ok, true, JSON.stringify(r));
    return r.permissoes;
  };
  const PAGINAS = ['request', 'supervisorApproval', 'stockRequests'];

  describe('permissões reais lidas pelo frontend', () => {
    test('a resposta real (com vínculos SST) passa na validação estrita; o MASTER provisionado administra vínculos, não pede nem decide, e só abre Entregas pela REALIZAR_ENTREGA provisionada', async () => {
      const p = await permissoesDe(env.d.master);
      assert.deepEqual(p.administracao.vinculosSst, { consultar: true, alterar: true });
      const c = S.capacidades(p);
      for (const k of ['verMinhas', 'criar', 'cancelar', 'aprovar', 'reprovar', 'entregar', 'encerrar']) {
        assert.equal(c[k], k === 'entregar', `MASTER ${k}: só o que o provisionamento dá (REALIZAR_ENTREGA)`);
      }
      assert.deepEqual(PAGINAS.map((pg) => EpiPermissoes.podeAbrir(p, pg)), [false, false, true], 'Entregas abre pela REALIZAR_ENTREGA provisionada, nunca pelo nome do perfil');
    });

    test('cada perfil de uso abre só a sua tela, pelas concessões reais', async () => {
      const casos = [
        [u.solicitante, [true, false, false], { verMinhas: true, criar: true, cancelar: true, aprovar: false, encerrar: false }],
        [u.sst, [false, true, true], { verMinhas: false, aprovar: true, reprovar: true, encerrar: true, entregar: false }],
        [u.entregador, [false, false, true], { verMinhas: false, entregar: true, encerrar: false }],
      ];
      for (const [id, abre, capacidades] of casos) {
        const p = await permissoesDe(id);
        assert.deepEqual(PAGINAS.map((pg) => EpiPermissoes.podeAbrir(p, pg)), abre, String(id));
        const c = S.capacidades(p);
        for (const [k, v] of Object.entries(capacidades)) assert.equal(c[k], v, `${id} ${k}`);
        assert.deepEqual([c.consultarVinculosSst, c.alterarVinculosSst], [false, false], `${id}: vínculos SST só para o MASTER ativo`);
      }
    });
  });

  describe('consultas: caminhos e parâmetros aceitos pelas rotas de produção', () => {
    test('minhas (com status e paginação), contexto de trabalhadores e de materiais (com busca e previsto no GHE)', async () => {
      comoUsuario(u.solicitante);
      const minhas = await S.acoes.minhas({ status: 'PENDENTE', pagina: 1, limite: 5 });
      assert.equal(minhas.ok, true, JSON.stringify(minhas));
      assert.ok(minhas.dados.solicitacoes.some((s) => s.id === minha));
      assert.deepEqual([minhas.dados.pagina, minhas.dados.limite], [1, 5]);
      const trabalhadores = await S.acoes.contextoFuncionarios({ busca: '  T-  ', limite: 100 });
      assert.equal(trabalhadores.ok, true, JSON.stringify(trabalhadores));
      assert.ok(trabalhadores.dados.funcionarios.some((f) => f.id === env.d.trabalhador));
      for (const f of trabalhadores.dados.funcionarios) assert.equal('cpf' in f, false);
      const materiais = await S.acoes.contextoMateriais(env.d.trabalhador, { busca: 'Capacete', previstoNoGhe: true });
      assert.equal(materiais.ok, true, JSON.stringify(materiais));
      assert.deepEqual(materiais.dados.materiais.map((m) => m.id), [env.d.capacete]);
    });

    test('fila, encerráveis (com filtro por trabalhador) e entregáveis, cada uma com a sua autoridade', async () => {
      comoUsuario(u.sst);
      const fila = await S.acoes.fila({ limite: 100 });
      assert.equal(fila.ok, true, JSON.stringify(fila));
      assert.ok(fila.dados.solicitacoes.some((s) => s.id === minha));
      const encerraveis = await S.acoes.encerraveis({ funcionarioId: env.d.trabalhador, limite: 100 });
      assert.equal(encerraveis.ok, true, JSON.stringify(encerraveis));
      assert.ok(encerraveis.dados.solicitacoes.some((s) => s.id === aprovada));
      comoUsuario(u.entregador);
      const entregaveis = await S.acoes.entregaveis({ funcionarioId: env.d.trabalhador });
      assert.equal(entregaveis.ok, true, JSON.stringify(entregaveis));
      assert.ok(entregaveis.dados.solicitacoes.some((s) => s.id === aprovada));
      const negado = await S.acoes.encerraveis();
      assert.deepEqual([negado.status, S.mensagens.deErro(negado)], [403, 'Você não tem permissão para esta operação.']);
    });

    test('detalhe: a própria abre; a de outro solicitante, a inexistente e a de outra empresa têm o mesmo texto na tela', async () => {
      comoUsuario(u.solicitante);
      const propria = await S.acoes.detalhe(minha);
      assert.equal(propria.ok, true, JSON.stringify(propria));
      assert.equal(propria.dados.solicitacao.id, minha);
      const alheia = await S.acoes.detalhe(deOutro);
      const inexistente = await S.acoes.detalhe(ID_INEXISTENTE);
      comoUsuario(u.sstB);
      const outraEmpresa = await S.acoes.detalhe(minha);
      for (const r of [alheia, inexistente, outraEmpresa]) {
        assert.deepEqual([r.status, r.codigo, S.mensagens.deErro(r)], [404, 'SOLICITACAO_NAO_ENCONTRADA', 'Solicitação não encontrada.']);
      }
    });

    test('sem sessão: 401 e a tela manda ao Portal', async () => {
      comoUsuario(null);
      const r = await S.acoes.minhas();
      assert.deepEqual([r.status, S.mensagens.exigeNovoLogin(r)], [401, true]);
    });
  });

  describe('escrita: os caminhos existem e chegam ao domínio (o corpo é de cada fluxo)', () => {
    test('cancelar, decidir e encerrar uma inexistente dão o 404 do domínio; criar e entregar com corpo vazio dão 400 de validação, nunca rota inexistente', async () => {
      comoUsuario(u.solicitante);
      const cancelar = await S.acoes.cancelar(ID_INEXISTENTE, {});
      assert.deepEqual([cancelar.status, cancelar.codigo], [404, 'SOLICITACAO_NAO_ENCONTRADA']);
      const criar = await S.acoes.criar({});
      assert.deepEqual([criar.status, criar.codigo], [400, 'VALIDACAO']);
      comoUsuario(u.sst);
      const decidir = await S.acoes.decidir(ID_INEXISTENTE, { decisoes: [{ itemId: 1, decisao: 'APROVADO' }] });
      assert.deepEqual([decidir.status, decidir.codigo], [404, 'SOLICITACAO_NAO_ENCONTRADA']);
      const encerrar = await S.acoes.encerrar(ID_INEXISTENTE, { justificativa: 'Não será entregue' });
      assert.deepEqual([encerrar.status, encerrar.codigo], [404, 'SOLICITACAO_NAO_ENCONTRADA']);
      comoUsuario(u.entregador);
      const entregar = await S.acoes.entregar(aprovada, {});
      assert.deepEqual([entregar.status, entregar.codigo], [400, 'VALIDACAO']);
    });
  });
});
