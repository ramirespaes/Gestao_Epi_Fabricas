'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { criarEmpresa } = require('./helpers/entrega-epi');
const { todasAsMigrations } = require('./helpers/recuperacao-senha');
const { fabricaPortal } = require('./helpers/troca-senha');
const { criarAppTeste } = require('../helpers/app-teste');
const { criarLimitador } = require('../../src/middleware/rate-limit');
const { criarExigirSessao } = require('../../src/middleware/autenticacao');
const { criarAuthRoutes } = require('../../src/routes/auth.routes');
const { criarAuthController } = require('../../src/controllers/auth.controller');
const { criarSolicitacaoEpiRoutes } = require('../../src/routes/solicitacao-epi.routes');
const { criarSolicitacaoEpiController } = require('../../src/controllers/solicitacao-epi.controller');
const provisionamento = require('../../src/services/provisionamento-permissoes.service');
const { ESCOPO_PROVISIONAMENTO_MASTER } = require('../../src/rbac/recursos');
const password = require('../../src/security/password');
const { authConfig } = require('../../src/config/auth');

/**
 * Decisão de 05/10/2026: o MASTER tem autoridade máxima na empresa e recebe o
 * Pedido de EPI (request: visualizar, criar, editar) pelo PROVISIONAMENTO do
 * perfil — o mesmo ponto usado no cadastro da empresa pelo Painel Privado e
 * pelo script db:provisionar:master. Nada aqui olha o nome do perfil: a
 * autoridade é a linha de permissoes_recurso que o provisionamento grava, e
 * sem ela até um MASTER recebe 403. Os demais perfis não recebem request por
 * esta decisão.
 */

const { cookieNomeGlobal: NOME_GLOBAL, cookieNome: NOME_EMPRESA } = authConfig.sessao;
const PERMISSOES = '/api/auth/permissoes';
const MINHAS = '/api/solicitacoes-epi/minhas';
const CONTEXTO = '/api/solicitacoes-epi/contexto/funcionarios';
const NEGADO = { visualizar: false, criar: false, editar: false, excluir: false };

describe('Pedido de EPI para o MASTER pelo provisionamento do perfil (PostgreSQL real)', () => {
  let contexto;
  let pool;
  let app;
  let portal;
  const empresas = {};

  const cookie = (c) => `${NOME_GLOBAL}=${c.global.token}; ${NOME_EMPRESA}=${c.empresarial.token}`;
  async function conta(empresaId, perfil) {
    const identidade = await portal.novaIdentidade();
    const usuarioId = await portal.vincular(identidade, empresaId, perfil);
    const global = await portal.entrar(identidade);
    const empresarial = await portal.selecionar(identidade, global, empresaId);
    return { identidade, usuarioId, global, empresarial };
  }
  const permissoes = async (c) => {
    const r = await request(app).get(PERMISSOES).set('Cookie', cookie(c));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };
  const status = async (c, rota) => (await request(app).get(rota).set('Cookie', cookie(c))).status;

  before(async () => {
    contexto = await abrirPoolTemporario(todasAsMigrations());
    pool = contexto.pool;
    portal = fabricaPortal({ pool, hashSenha: await password.gerarHashSenha('planeta-nebulosa-ozonio-42') });
    empresas.A = await criarEmpresa(pool, '11222333000181', 'Empresa Alfa');
    empresas.B = await criarEmpresa(pool, '11444777000161', 'Empresa Beta');
    // A é provisionada (como o Painel Privado faz ao cadastrar a empresa); B fica sem provisionamento.
    await provisionamento.provisionar(pool, { empresaId: empresas.A, dryRun: false });
    const exigirSessao = criarExigirSessao({ pool });
    app = criarAppTeste((a) => {
      a.use(
        '/api',
        criarAuthRoutes({ controller: criarAuthController({ pool }), limitador: criarLimitador({ limite: 100000, janelaSegundos: 60 }), exigirSessao }),
        criarSolicitacaoEpiRoutes({ controller: criarSolicitacaoEpiController({ pool }), exigirSessao, pool }),
      );
    });
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  test('MASTER provisionado: request visualizar/criar/editar efetivos em /auth/permissoes; "minhas" e o contexto da criação respondem 200; o que o banco tem é exatamente o escopo (todo MASTER futuro recebe o mesmo)', async () => {
    const master = await conta(empresas.A, 'MASTER');
    const p = await permissoes(master);
    assert.deepEqual(p.recursos.request, { visualizar: true, criar: true, editar: true, excluir: false });
    assert.equal(await status(master, MINHAS), 200);
    assert.equal(await status(master, CONTEXTO), 200);

    const { rows } = await pool.query(
      "SELECT recurso, pode_visualizar, pode_criar, pode_editar, pode_excluir FROM permissoes_recurso WHERE empresa_id = $1 AND perfil = 'MASTER' ORDER BY recurso",
      [empresas.A],
    );
    assert.deepEqual(rows.map((r) => r.recurso), ESCOPO_PROVISIONAMENTO_MASTER.recursos.map((r) => r.recurso).sort());
    assert.deepEqual(rows.find((r) => r.recurso === 'request'), { recurso: 'request', pode_visualizar: true, pode_criar: true, pode_editar: true, pode_excluir: false });
    const { rows: outros } = await pool.query("SELECT count(*)::int AS n FROM permissoes_recurso WHERE empresa_id = $1 AND perfil <> 'MASTER'", [empresas.A]);
    assert.equal(outros[0].n, 0, 'o provisionamento só escreve o perfil MASTER');
  });

  test('ADMINISTRADOR, SUPERVISOR e USUARIO da mesma empresa não recebem request por esta decisão: tudo negado e 403 nas rotas', async () => {
    for (const perfil of ['ADMINISTRADOR', 'SUPERVISOR', 'USUARIO']) {
      const c = await conta(empresas.A, perfil);
      assert.deepEqual((await permissoes(c)).recursos.request, NEGADO, perfil);
      assert.equal(await status(c, MINHAS), 403, perfil);
      assert.equal(await status(c, CONTEXTO), 403, perfil);
    }
  });

  test('a autoridade é a permissão, não o nome do perfil: o MASTER de uma empresa ainda não provisionada recebe 403 até o provisionamento, que insere request e resolve', async () => {
    const masterB = await conta(empresas.B, 'MASTER');
    assert.deepEqual((await permissoes(masterB)).recursos.request, NEGADO);
    assert.equal(await status(masterB, MINHAS), 403);
    assert.equal(await status(masterB, CONTEXTO), 403);

    const r = await provisionamento.provisionar(pool, { empresaId: empresas.B, dryRun: false });
    assert.ok(r.inseridos.recursos.includes('request'), JSON.stringify(r.inseridos));
    assert.deepEqual((await permissoes(masterB)).recursos.request, { visualizar: true, criar: true, editar: true, excluir: false });
    assert.equal(await status(masterB, MINHAS), 200);
    assert.equal(await status(masterB, CONTEXTO), 200);

    const segunda = await provisionamento.provisionar(pool, { empresaId: empresas.B, dryRun: false });
    assert.deepEqual(segunda.inseridos, { recursos: [], acoes: [] }, 'reprovisionar é idempotente: nada é apagado nem recriado');
  });
});
