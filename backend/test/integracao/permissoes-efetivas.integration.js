'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const request = require('supertest');

const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { criarAppTeste } = require('../helpers/app-teste');
const { criarAuthController } = require('../../src/controllers/auth.controller');
const { criarAuthRoutes } = require('../../src/routes/auth.routes');
const { criarAuthGlobalController } = require('../../src/controllers/auth-global.controller');
const { criarAuthGlobalRoutes } = require('../../src/routes/auth-global.routes');
const { criarGrupoAcessoController } = require('../../src/controllers/grupo-acesso.controller');
const { criarGrupoAcessoRoutes } = require('../../src/routes/grupo-acesso.routes');
const { criarGrupoPermissaoController } = require('../../src/controllers/grupo-permissao.controller');
const { criarGrupoPermissaoRoutes } = require('../../src/routes/grupo-permissao.routes');
const { criarMaterialController } = require('../../src/controllers/material.controller');
const { criarMaterialRoutes } = require('../../src/routes/material.routes');
const { criarEstoqueController } = require('../../src/controllers/estoque.controller');
const { criarEstoqueRoutes } = require('../../src/routes/estoque.routes');
const { criarExigirSessao } = require('../../src/middleware/autenticacao');
const { criarExigirSessaoGlobal } = require('../../src/middleware/autenticacao-global');
const { criarLimitador } = require('../../src/middleware/rate-limit');
const { gerarHashSenha } = require('../../src/security/password');
const { authConfig } = require('../../src/config/auth');
const { RECURSOS_CONHECIDOS } = require('../../src/rbac/recursos');
const provisionamento = require('../../src/services/provisionamento-permissoes.service');
const permissaoRepo = require('../../src/repositories/permissao.repository');

const EpiHttp = require('../../../frontend/js/api-http');
const EpiPermissoes = require('../../../frontend/js/permissoes-efetivas');

/**
 * Bloco 9, Etapa C, Parte C1 — GET /api/auth/permissoes contra PostgreSQL
 * real (schema temporário exclusivo, migrations 000-038).
 *
 * A prova central é de EQUIVALÊNCIA: para cada pessoa, o que o endpoint
 * diz ("pode visualizar/criar materiais", "pode movimentar estoque", "pode
 * administrar grupos") é conferido contra o que as ROTAS REAIS decidem
 * (200/201 ou 403) — o mesmo middleware e os mesmos serviços. O endpoint
 * não é uma segunda interpretação do RBAC; se fosse, estes testes
 * divergiriam.
 *
 * Cenários: MASTER, ADMINISTRADOR (com e sem autoridade administrativa),
 * SUPERVISOR, USUARIO; permissão de perfil; grupo ativo (concede) e inativo
 * (só restringe); exceção individual positiva e negativa; ausência de
 * configuração; empresa A x B; troca de empresa; alteração durante a
 * sessão; chamada direta proibida (403); sessão expirada; falha na
 * consulta; e o módulo real do frontend (falha fechada, empresa divergente).
 */

const TODAS_AS_MIGRATIONS = Array.from({ length: 40 }, (_, i) => String(i).padStart(3, '0'));
const SENHA = 'senha-forte-da-parte-c1-2026';
const { cookieNome: C_EMPRESA, cookieNomeGlobal: C_GLOBAL } = authConfig.sessao;

const EMAILS = {
  master: 'master.c1@exemplo-cliente.com.br',
  adminGrupos: 'admin.grupos.c1@exemplo-cliente.com.br',
  adminSem: 'admin.sem.c1@exemplo-cliente.com.br',
  supervisor: 'supervisor.c1@exemplo-cliente.com.br',
  usuario: 'usuario.c1@exemplo-cliente.com.br',
  multi: 'multi.c1@exemplo-cliente.com.br', // USUARIO em A, MASTER em B
};

function cookiesDe(resposta) {
  const saida = {};
  for (const bruto of resposta.headers['set-cookie'] || []) {
    const [par] = bruto.split(';');
    const i = par.indexOf('=');
    saida[par.slice(0, i)] = par.slice(i + 1);
  }
  return saida;
}

describe('C1 — permissões efetivas (PostgreSQL real)', () => {
  let contexto;
  let pool;
  let app;
  let servidor;
  let base;
  const empresa = {};
  const u = {};
  const grupo = {};

  /** Login global + seleção da empresa: devolve o cabeçalho Cookie da sessão empresarial. */
  async function sessao(email, empresaId) {
    const login = await request(app).post('/api/auth/global/login').send({ email, senha: SENHA });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    const c = cookiesDe(login);
    const global = `${C_GLOBAL}=${c[C_GLOBAL]}`;
    if (login.body.contexto && login.body.contexto.empresa.id === empresaId) {
      return `${global}; ${C_EMPRESA}=${c[C_EMPRESA]}`;
    }
    const sel = await request(app).post(`/api/auth/global/empresas/${empresaId}/selecionar`).set('Cookie', global);
    assert.equal(sel.status, 200, JSON.stringify(sel.body));
    return `${global}; ${C_EMPRESA}=${cookiesDe(sel)[C_EMPRESA]}`;
  }

  const permissoes = async (cookie) => {
    const r = await request(app).get('/api/auth/permissoes').set('Cookie', cookie);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };

  /** O que as rotas REAIS decidem para esta pessoa. 403 = negado; qualquer outro status = passou pela autorização. */
  async function decisaoReal(cookie) {
    const passou = (r) => r.status !== 403;
    const visualizar = passou(await request(app).get('/api/materiais').set('Cookie', cookie));
    const criar = passou(await request(app).post('/api/materiais').set('Cookie', cookie).send({ nome: `Material ${Math.random()}` }));
    const movimentar = passou(await request(app).post(`/api/materiais/${u.materialA}/estoque/movimentar`).set('Cookie', cookie)
      .send({ tamanho: 'M', tipo: 'ENTRADA', quantidade: 1 }));
    const grupos = passou(await request(app).get('/api/grupos-acesso').set('Cookie', cookie));
    const permissoesGrupo = passou(await request(app).get(`/api/grupos-acesso/${grupo.ativo}/permissoes/recursos`).set('Cookie', cookie));
    return { visualizar, criar, movimentar, grupos, permissoesGrupo };
  }

  function previsao(p) {
    return {
      visualizar: p.recursos.materials.visualizar,
      criar: p.recursos.materials.criar,
      movimentar: p.acoes.MOVIMENTAR_ESTOQUE,
      grupos: p.administracao.gruposAcesso.consultar,
      permissoesGrupo: p.administracao.permissoesGrupo.consultar,
    };
  }

  before(async () => {
    contexto = await abrirPoolTemporario(TODAS_AS_MIGRATIONS);
    pool = contexto.pool;
    const hash = await gerarHashSenha(SENHA);

    for (const [chave, nome, cnpj] of [['A', 'Empresa Alfa C1', '11222333000181'], ['B', 'Empresa Beta C1', '22333444000100']]) {
      empresa[chave] = (await pool.query('INSERT INTO empresas (nome, cnpj) VALUES ($1, $2) RETURNING id', [nome, cnpj])).rows[0].id;
      await provisionamento.provisionar(pool, { empresaId: empresa[chave], dryRun: false });
    }
    const identidade = {};
    for (const [k, email] of Object.entries(EMAILS)) {
      identidade[k] = (await pool.query('INSERT INTO identidades (email, senha_hash) VALUES ($1, $2) RETURNING id', [email, hash])).rows[0].id;
    }
    const vinculo = async (chave, empresaId, idIdentidade, perfil) => {
      u[chave] = (await pool.query("INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, identidade_id) VALUES ($1, $2, NULL, NULL, $3, $4) RETURNING id", [empresaId, chave, perfil, idIdentidade])).rows[0].id;
    };
    await vinculo('master', empresa.A, identidade.master, 'MASTER');
    await vinculo('adminGrupos', empresa.A, identidade.adminGrupos, 'ADMINISTRADOR');
    await vinculo('adminSem', empresa.A, identidade.adminSem, 'ADMINISTRADOR');
    await vinculo('supervisor', empresa.A, identidade.supervisor, 'SUPERVISOR');
    await vinculo('usuario', empresa.A, identidade.usuario, 'USUARIO');
    await vinculo('multiA', empresa.A, identidade.multi, 'USUARIO');
    await vinculo('multiB', empresa.B, identidade.multi, 'MASTER');

    const q = (sql, params) => pool.query(sql, params);
    // Permissão de PERFIL (base): SUPERVISOR vê materiais; ADMINISTRADOR vê materiais. USUARIO: nada configurado.
    await q("INSERT INTO permissoes_recurso (empresa_id, perfil, recurso, pode_visualizar, pode_criar) VALUES ($1, 'SUPERVISOR', 'materials', true, false), ($1, 'ADMINISTRADOR', 'materials', true, false)", [empresa.A]);
    // Grupo ATIVO concede criar materiais; grupo INATIVO nega visualizar materiais e "concede" relatórios (inativo não concede).
    grupo.ativo = (await q("INSERT INTO grupos_acesso (empresa_id, nome, ativo, criado_por) VALUES ($1, 'Almoxarifado C1', true, $2) RETURNING id", [empresa.A, u.master])).rows[0].id;
    grupo.inativo = (await q("INSERT INTO grupos_acesso (empresa_id, nome, ativo, criado_por) VALUES ($1, 'Antigo C1', false, $2) RETURNING id", [empresa.A, u.master])).rows[0].id;
    await q('INSERT INTO grupo_permissoes_recurso (empresa_id, grupo_acesso_id, recurso, pode_criar) VALUES ($1, $2, \'materials\', true)', [empresa.A, grupo.ativo]);
    await q('INSERT INTO grupo_permissoes_recurso (empresa_id, grupo_acesso_id, recurso, pode_visualizar) VALUES ($1, $2, \'materials\', false), ($1, $2, \'reports\', true)', [empresa.A, grupo.inativo]);
    await q('UPDATE usuarios SET grupo_acesso_id = $2 WHERE id = $1', [u.supervisor, grupo.ativo]);
    await q('UPDATE usuarios SET grupo_acesso_id = $2 WHERE id = $1', [u.adminSem, grupo.inativo]);
    // Exceções INDIVIDUAIS: positiva (USUARIO vê o dashboard) e negativa (SUPERVISOR não vê materiais, apesar do perfil).
    await q("INSERT INTO usuario_permissoes_recurso (empresa_id, usuario_id, recurso, pode_visualizar, concedido_por) VALUES ($1, $2, 'dashboard', true, $3)", [empresa.A, u.usuario, u.master]);
    await q("INSERT INTO usuario_permissoes_recurso (empresa_id, usuario_id, recurso, pode_visualizar, concedido_por) VALUES ($1, $2, 'materials', false, $3)", [empresa.A, u.supervisor, u.master]);
    // Autoridade administrativa: ADMINISTRADOR com ADMINISTRAR_GRUPOS_ACESSO (só essa).
    await q("INSERT INTO usuario_autorizacoes (empresa_id, usuario_id, acao_codigo, autorizado_por) VALUES ($1, $2, 'ADMINISTRAR_GRUPOS_ACESSO', $3)", [empresa.A, u.adminGrupos, u.master]);
    // Delegação: USUARIO com MOVIMENTAR_ESTOQUE repassável (ALTERNATIVA) — pode movimentar e delegar.
    await q("INSERT INTO usuario_autorizacoes (empresa_id, usuario_id, acao_codigo, autorizado_por, pode_delegar) VALUES ($1, $2, 'MOVIMENTAR_ESTOQUE', $3, true)", [empresa.A, u.usuario, u.master]);

    const materialA = await pool.query("INSERT INTO materiais (empresa_id, nome) VALUES ($1, 'Luva C1') RETURNING id", [empresa.A]);
    u.materialA = materialA.rows[0].id;

    const semLimite = () => criarLimitador({ limite: 100000, janelaSegundos: 60 });
    const exigirSessao = criarExigirSessao({ pool });
    app = criarAppTeste((a) => {
      a.use(
        '/api',
        criarAuthRoutes({ controller: criarAuthController({ pool }), limitador: semLimite(), exigirSessao }),
        criarAuthGlobalRoutes({ controller: criarAuthGlobalController({ pool }), limitador: semLimite(), exigirSessaoGlobal: criarExigirSessaoGlobal({ pool }) }),
        criarGrupoAcessoRoutes({ controller: criarGrupoAcessoController({ pool }), exigirSessao }),
        criarGrupoPermissaoRoutes({ controller: criarGrupoPermissaoController({ pool }), exigirSessao }),
        criarMaterialRoutes({ controller: criarMaterialController({ pool }), exigirSessao, pool }),
        criarEstoqueRoutes({ controller: criarEstoqueController({ pool }), exigirSessao, pool }),
      );
    });
    servidor = http.createServer(app);
    await new Promise((resolve) => { servidor.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${servidor.address().port}/api`;
  });

  after(async () => {
    EpiHttp.configurar({ fetch: null });
    if (servidor) await new Promise((resolve) => { servidor.close(resolve); });
    if (contexto) await contexto.encerrar();
  });

  test('formato: empresa/usuário/perfil da sessão, todos os recursos conhecidos, as ações do catálogo e as quatro áreas administrativas — só booleanos', async () => {
    const p = await permissoes(await sessao(EMAILS.master, empresa.A));
    assert.deepEqual([p.empresaId, p.usuarioId, p.perfil], [empresa.A, u.master, 'MASTER']);
    assert.deepEqual(Object.keys(p.recursos).sort(), [...RECURSOS_CONHECIDOS].sort());
    const catalogo = (await permissaoRepo.listarAcoes(pool)).map((a) => a.codigo).sort();
    assert.deepEqual(Object.keys(p.acoes).sort(), catalogo);
    for (const r of Object.values(p.recursos)) assert.deepEqual(Object.keys(r).sort(), ['criar', 'editar', 'excluir', 'visualizar']);
    assert.deepEqual(Object.keys(p.administracao).sort(), ['autorizacoesIndividuais', 'gruposAcesso', 'permissoesGrupo', 'vinculosGrupo']);
    const valores = JSON.stringify(p.recursos) + JSON.stringify(p.acoes) + JSON.stringify(p.administracao);
    assert.equal(/"[a-zA-Z]+":(?!true|false|\{)/.test(valores), false, 'só booleanos');
  });

  test('EQUIVALÊNCIA com as rotas reais, para cada perfil: o que o endpoint prevê é exatamente o que o middleware e os serviços decidem', async () => {
    for (const [chave, email] of Object.entries({ master: EMAILS.master, adminGrupos: EMAILS.adminGrupos, adminSem: EMAILS.adminSem, supervisor: EMAILS.supervisor, usuario: EMAILS.usuario })) {
      const cookie = await sessao(email, empresa.A);
      const p = await permissoes(cookie);
      assert.deepEqual(previsao(p), await decisaoReal(cookie), `divergência para ${chave}`);
    }
  });

  test('MASTER: recursos provisionados, ação provisionada, autoridade administrativa plena, concede direto, não delega', async () => {
    const p = await permissoes(await sessao(EMAILS.master, empresa.A));
    assert.deepEqual(p.recursos.materials, { visualizar: true, criar: true, editar: true, excluir: false });
    assert.equal(p.recursos.reports.visualizar, false, 'MASTER só tem o que foi provisionado — nada "de graça"');
    assert.equal(p.acoes.MOVIMENTAR_ESTOQUE, true);
    for (const area of ['gruposAcesso', 'permissoesGrupo', 'vinculosGrupo']) {
      assert.deepEqual(p.administracao[area], { consultar: true, alterar: true }, area);
    }
    assert.deepEqual(p.administracao.autorizacoesIndividuais, { consultar: true, concederDireta: true, delegar: false });
  });

  test('ADMINISTRADOR: autoridade administrativa só com autorização individual efetiva, e só daquela área; sem ela, nada', async () => {
    const com = await permissoes(await sessao(EMAILS.adminGrupos, empresa.A));
    assert.deepEqual(com.administracao.gruposAcesso, { consultar: true, alterar: true });
    assert.deepEqual([com.administracao.permissoesGrupo.consultar, com.administracao.vinculosGrupo.consultar], [false, false]);
    assert.equal(com.recursos.materials.visualizar, true, 'permissão de perfil');
    const sem = await permissoes(await sessao(EMAILS.adminSem, empresa.A));
    for (const area of ['gruposAcesso', 'permissoesGrupo', 'vinculosGrupo']) {
      assert.equal(sem.administracao[area].consultar, false, area);
    }
    assert.equal(sem.administracao.autorizacoesIndividuais.concederDireta, false);
  });

  test('grupo INATIVO só restringe: nega visualizar materiais (que o perfil concedia) e NÃO concede relatórios', async () => {
    const p = await permissoes(await sessao(EMAILS.adminSem, empresa.A));
    assert.equal(p.recursos.materials.visualizar, false, 'FALSE do grupo inativo continua negando');
    assert.equal(p.recursos.reports.visualizar, false, 'TRUE do grupo inativo não concede');
  });

  test('SUPERVISOR: grupo ATIVO concede criar; exceção individual NEGATIVA tira visualizar — e visualizar não implica criar (nem o contrário)', async () => {
    const p = await permissoes(await sessao(EMAILS.supervisor, empresa.A));
    assert.deepEqual([p.recursos.materials.visualizar, p.recursos.materials.criar, p.recursos.materials.editar], [false, true, false]);
    assert.equal(p.administracao.gruposAcesso.consultar, false);
  });

  test('USUARIO: ausência de configuração nega tudo; exceção individual POSITIVA concede o dashboard; autorização individual concede e permite delegar', async () => {
    const p = await permissoes(await sessao(EMAILS.usuario, empresa.A));
    assert.deepEqual(p.recursos.materials, { visualizar: false, criar: false, editar: false, excluir: false });
    assert.equal(p.recursos.dashboard.visualizar, true);
    assert.equal(p.acoes.MOVIMENTAR_ESTOQUE, true, 'ALTERNATIVA: a autorização individual concede');
    assert.deepEqual(p.administracao.autorizacoesIndividuais, { consultar: true, concederDireta: false, delegar: true });
    for (const area of ['gruposAcesso', 'permissoesGrupo', 'vinculosGrupo']) assert.equal(p.administracao[area].consultar, false);
  });

  test('chamada direta sem autoridade continua 403 (o menu é só apresentação)', async () => {
    const cookie = await sessao(EMAILS.usuario, empresa.A);
    const p = await permissoes(cookie);
    assert.equal(p.administracao.gruposAcesso.consultar, false);
    assert.equal((await request(app).get('/api/grupos-acesso').set('Cookie', cookie)).status, 403);
    assert.equal((await request(app).post('/api/grupos-acesso').set('Cookie', cookie).send({ nome: 'Tentativa direta' })).status, 403);
    assert.equal((await request(app).post('/api/materiais').set('Cookie', cookie).send({ nome: 'Direto' })).status, 403);
  });

  test('empresa A x B e TROCA de empresa: a mesma pessoa tem permissões de B depois de trocar; nada da empresa anterior sobrevive; a sessão de A não consulta mais nada', async () => {
    const login = await request(app).post('/api/auth/global/login').send({ email: EMAILS.multi, senha: SENHA });
    const global = `${C_GLOBAL}=${cookiesDe(login)[C_GLOBAL]}`;
    const selA = await request(app).post(`/api/auth/global/empresas/${empresa.A}/selecionar`).set('Cookie', global);
    const cookieA = `${global}; ${C_EMPRESA}=${cookiesDe(selA)[C_EMPRESA]}`;
    const emA = await permissoes(cookieA);
    assert.deepEqual([emA.empresaId, emA.perfil, emA.administracao.gruposAcesso.consultar, emA.recursos.materials.visualizar], [empresa.A, 'USUARIO', false, false]);

    const selB = await request(app).post(`/api/auth/global/empresas/${empresa.B}/selecionar`).set('Cookie', cookieA);
    const cookieB = `${global}; ${C_EMPRESA}=${cookiesDe(selB)[C_EMPRESA]}`;
    const emB = await permissoes(cookieB);
    assert.deepEqual([emB.empresaId, emB.perfil, emB.administracao.gruposAcesso.consultar, emB.recursos.materials.visualizar], [empresa.B, 'MASTER', true, true]);

    assert.equal((await request(app).get('/api/auth/permissoes').set('Cookie', cookieA)).status, 401, 'a sessão de A foi revogada na troca');
  });

  test('isolamento: parâmetros do navegador não escolhem empresa nem usuário', async () => {
    const cookie = await sessao(EMAILS.usuario, empresa.A);
    const r = await request(app).get(`/api/auth/permissoes?empresaId=${empresa.B}&usuarioId=${u.master}`).set('Cookie', cookie);
    assert.deepEqual([r.status, r.body.empresaId, r.body.usuarioId, r.body.perfil], [200, empresa.A, u.usuario, 'USUARIO']);
  });

  test('alteração DURANTE a sessão (exceção removida, grupo inativado, autorização revogada): a consulta seguinte já reflete — nada fica em cache', async () => {
    const cookie = await sessao(EMAILS.supervisor, empresa.A);
    assert.deepEqual(previsao(await permissoes(cookie)).visualizar, false);

    await pool.query("DELETE FROM usuario_permissoes_recurso WHERE usuario_id = $1 AND recurso = 'materials'", [u.supervisor]);
    const depoisExcecao = await permissoes(cookie);
    assert.equal(depoisExcecao.recursos.materials.visualizar, true);
    assert.equal((await request(app).get('/api/materiais').set('Cookie', cookie)).status, 200);

    await pool.query('UPDATE grupos_acesso SET ativo = false WHERE id = $1', [grupo.ativo]);
    const depoisGrupo = await permissoes(cookie);
    assert.equal(depoisGrupo.recursos.materials.criar, false, 'grupo inativado deixa de conceder');
    assert.equal((await request(app).post('/api/materiais').set('Cookie', cookie).send({ nome: 'Após inativar' })).status, 403);
    await pool.query('UPDATE grupos_acesso SET ativo = true WHERE id = $1', [grupo.ativo]);

    const admin = await sessao(EMAILS.adminGrupos, empresa.A);
    assert.equal((await permissoes(admin)).administracao.gruposAcesso.consultar, true);
    await pool.query("DELETE FROM usuario_autorizacoes WHERE usuario_id = $1 AND acao_codigo = 'ADMINISTRAR_GRUPOS_ACESSO'", [u.adminGrupos]);
    assert.equal((await permissoes(admin)).administracao.gruposAcesso.consultar, false);
    assert.equal((await request(app).get('/api/grupos-acesso').set('Cookie', admin)).status, 403);
  });

  test('sem sessão e sessão expirada: 401, nenhuma permissão devolvida', async () => {
    assert.equal((await request(app).get('/api/auth/permissoes')).status, 401);
    const cookie = await sessao(EMAILS.usuario, empresa.A);
    await pool.query("UPDATE sessoes SET criado_em = now() - interval '2 hours', expira_em = now() - interval '1 minute' WHERE usuario_id = $1 AND revogada_em IS NULL", [u.usuario]);
    const r = await request(app).get('/api/auth/permissoes').set('Cookie', cookie);
    assert.deepEqual([r.status, r.body.codigo, 'recursos' in r.body], [401, 'SESSAO_INVALIDA', false]);
  });

  test('falha na consulta (banco): 500 genérico sem permissão nenhuma no corpo', async (t) => {
    const cookie = await sessao(EMAILS.master, empresa.A);
    t.mock.method(console, 'error', () => {});
    t.mock.method(permissaoRepo, 'listarAcoes', async () => { throw Object.assign(new Error('conexão perdida'), { code: '57P01' }); });
    const r = await request(app).get('/api/auth/permissoes').set('Cookie', cookie);
    assert.deepEqual([r.status, r.body.codigo, 'administracao' in r.body], [500, 'ERRO_INTERNO', false]);
  });

  describe('módulo real do frontend (js/permissoes-efetivas.js) contra o servidor', () => {
    function navegador(cookie) {
      EpiHttp.configurar({ baseUrl: base, fetch: (url, opcoes) => fetch(url, { ...opcoes, headers: { ...(opcoes.headers || {}), Cookie: cookie } }) });
    }

    // O que a página exibe para cada pessoa (o contexto de EpiSessaoEmpresarial).
    const exibido = (chave, perfil, empresaId = empresa.A) => ({ empresaId, usuarioId: u[chave], perfil });

    test('MASTER: carrega, abre as quatro páginas e pode alterar as três administrativas', async () => {
      navegador(await sessao(EMAILS.master, empresa.A));
      const r = await EpiPermissoes.carregar(exibido('master', 'MASTER'));
      assert.equal(r.ok, true);
      for (const pagina of ['grupos-acesso', 'grupo-permissoes', 'grupo-usuarios', 'autorizacoes-individuais']) {
        assert.equal(EpiPermissoes.podeAbrir(r.permissoes, pagina), true, pagina);
      }
      assert.equal(EpiPermissoes.podeAlterar(r.permissoes, 'grupos-acesso'), true);
    });

    test('USUARIO: só "Autorizações Individuais"; nenhuma página administrativa', async () => {
      navegador(await sessao(EMAILS.usuario, empresa.A));
      const r = await EpiPermissoes.carregar(exibido('usuario', 'USUARIO'));
      assert.deepEqual(['grupos-acesso', 'grupo-permissoes', 'grupo-usuarios', 'autorizacoes-individuais'].map((p) => EpiPermissoes.podeAbrir(r.permissoes, p)), [false, false, false, true]);
    });

    test('empresa divergente (troca em outra aba) e falha no servidor: falha fechada — nada abre', async (t) => {
      navegador(await sessao(EMAILS.master, empresa.A));
      const divergente = await EpiPermissoes.carregar(exibido('master', 'MASTER', empresa.B));
      assert.deepEqual(divergente, { ok: false, motivo: 'CONTEXTO_DIVERGENTE' });

      t.mock.method(console, 'error', () => {});
      t.mock.method(permissaoRepo, 'listarAcoes', async () => { throw new Error('falha simulada'); });
      const falha = await EpiPermissoes.carregar(exibido('master', 'MASTER'));
      assert.deepEqual(falha, { ok: false, motivo: 'FALHA' });
      assert.equal(EpiPermissoes.podeAbrir(null, 'grupos-acesso'), false);
    });

    test('MESMA empresa, OUTRO usuário (outra aba entrou com outra pessoa): a página exibe o MASTER, o cookie agora é do USUARIO — falha fechada, nada abre', async () => {
      navegador(await sessao(EMAILS.usuario, empresa.A)); // cookie do navegador: USUARIO
      const r = await EpiPermissoes.carregar(exibido('master', 'MASTER')); // página ainda exibe o MASTER
      assert.deepEqual(r, { ok: false, motivo: 'CONTEXTO_DIVERGENTE' });
      assert.equal(EpiPermissoes.podeAbrir(null, 'grupos-acesso'), false);
    });

    test('MESMO usuário com PERFIL ALTERADO no servidor durante a sessão: a página exibe o perfil antigo — falha fechada; com o perfil atual, volta a valer', async () => {
      navegador(await sessao(EMAILS.adminSem, empresa.A));
      assert.equal((await EpiPermissoes.carregar(exibido('adminSem', 'ADMINISTRADOR'))).ok, true);
      await pool.query("UPDATE usuarios SET perfil = 'SUPERVISOR' WHERE id = $1", [u.adminSem]);
      try {
        const antigo = await EpiPermissoes.carregar(exibido('adminSem', 'ADMINISTRADOR'));
        assert.deepEqual(antigo, { ok: false, motivo: 'CONTEXTO_DIVERGENTE' });
        const atual = await EpiPermissoes.carregar(exibido('adminSem', 'SUPERVISOR'));
        assert.equal(atual.ok, true, 'recarregar a página (novo contexto) resolve');
        assert.equal(atual.permissoes.perfil, 'SUPERVISOR');
      } finally {
        await pool.query("UPDATE usuarios SET perfil = 'ADMINISTRADOR' WHERE id = $1", [u.adminSem]);
      }
    });

    test('contexto esperado incompleto: falha fechada sem consultar o servidor', async () => {
      let consultas = 0;
      EpiHttp.configurar({ baseUrl: base, fetch: async (...a) => { consultas += 1; return fetch(...a); } });
      for (const esperado of [{ empresaId: empresa.A }, { empresaId: empresa.A, usuarioId: u.master }, {}]) {
        assert.deepEqual(await EpiPermissoes.carregar(esperado), { ok: false, motivo: 'CONTEXTO_DIVERGENTE' });
      }
      assert.equal(consultas, 0);
    });
  });
});
