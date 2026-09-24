'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');

const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { criarAuthController } = require('../../src/controllers/auth.controller');
const { criarAuthRoutes } = require('../../src/routes/auth.routes');
const { criarAuthGlobalController } = require('../../src/controllers/auth-global.controller');
const { criarAuthGlobalRoutes } = require('../../src/routes/auth-global.routes');
const { criarGrupoAcessoController } = require('../../src/controllers/grupo-acesso.controller');
const { criarGrupoAcessoRoutes } = require('../../src/routes/grupo-acesso.routes');
const { criarExigirSessao } = require('../../src/middleware/autenticacao');
const { criarExigirSessaoGlobal } = require('../../src/middleware/autenticacao-global');
const { criarLimitador } = require('../../src/middleware/rate-limit');
const { corsApi } = require('../../src/middleware/cors');
const { semCache } = require('../../src/middleware/cabecalhos');
const { verificarOrigem } = require('../../src/middleware/origem');
const { exigirJson, parserJson } = require('../../src/middleware/conteudo');
const { notFoundHandler, errorHandler } = require('../../src/middleware/errorHandler');
const { gerarHashSenha } = require('../../src/security/password');
const { httpConfig } = require('../../src/config/http');
const { authConfig } = require('../../src/config/auth');
const provisionamento = require('../../src/services/provisionamento-permissoes.service');

const EpiHttp = require('../../../frontend/js/api-http');
const EpiPortal = require('../../../frontend/js/portal-cliente');
const EpiSessaoEmpresarial = require('../../../frontend/js/sessao-empresarial');
const EpiGrupos = require('../../../frontend/js/grupos-acesso');

/**
 * Bloco 9, Etapa C, Parte C0 — sessão empresarial REAL nas páginas de
 * frontend/pages/, ponta a ponta:
 *
 *   Portal do Cliente (frontend/js/portal-cliente.js) faz o login global e
 *   seleciona a empresa -> as páginas integradas confirmam a sessão com o
 *   módulo comum (frontend/js/sessao-empresarial.js) -> operam com o módulo
 *   de domínio real (frontend/js/grupos-acesso.js) sob o RBAC do servidor.
 *
 * Servidor HTTP de verdade com a cadeia /api de produção (CORS e Origin do
 * cliente), PostgreSQL real em schema temporário exclusivo com TODAS as
 * migrations (000-038). O `fetch` injetado faz o papel do navegador
 * (Origin da página + jar de cookies HttpOnly); a `janela` injetada
 * registra redirecionamentos, reescritas de URL e o uso de armazenamento.
 */

const TODAS_AS_MIGRATIONS = Array.from({ length: 39 }, (_, i) => String(i).padStart(3, '0'));
const SENHA = 'senha-forte-da-etapa-c-2026';
const ANA = 'ana.c0@exemplo-cliente.com.br';   // MASTER em A, USUARIO em B
const BIA = 'bia.c0@exemplo-cliente.com.br';   // MASTER só em A
const LEGADO = JSON.stringify({ id: 1, nome: 'Luis Freitas', perfil: 'MASTER' });

function criarNavegador(origem) {
  const jar = new Map();
  const chamadas = [];
  const fn = async (url, opcoes = {}) => {
    chamadas.push(`${opcoes.method} ${new URL(url).pathname}${new URL(url).search}`);
    const cabecalhos = { ...(opcoes.headers || {}), Origin: origem };
    if (opcoes.credentials === 'include' && jar.size > 0) {
      cabecalhos.Cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    const resposta = await fetch(url, { ...opcoes, headers: cabecalhos });
    for (const bruto of resposta.headers.getSetCookie()) {
      const [par, ...atributos] = bruto.split(';');
      const i = par.indexOf('=');
      const nome = par.slice(0, i).trim();
      if (atributos.some((a) => /^\s*max-age=0\s*$/i.test(a))) jar.delete(nome); else jar.set(nome, par.slice(i + 1).trim());
    }
    return resposta;
  };
  fn.jar = jar;
  fn.chamadas = chamadas;
  return fn;
}

function armazenamento(inicial = {}) {
  const dados = new Map(Object.entries(inicial));
  const operacoes = [];
  return {
    dados, operacoes,
    getItem(k) { operacoes.push(['get', k]); return dados.has(k) ? dados.get(k) : null; },
    setItem(k, v) { operacoes.push(['set', k]); dados.set(k, v); },
    removeItem(k) { operacoes.push(['remove', k]); dados.delete(k); },
  };
}

/** Uma página de frontend/pages/ aberta no navegador. */
function pagina(nome, { search = '', local = {}, sessao = {} } = {}) {
  const j = {
    redirecionamentos: [],
    urlsSubstituidas: [],
    location: { pathname: `/pages/${nome}.html`, search, hash: '', replace: (d) => j.redirecionamentos.push(d) },
    history: { replaceState: (_e, _t, u) => j.urlsSubstituidas.push(u) },
    localStorage: armazenamento(local),
    sessionStorage: armazenamento(sessao),
    document: { set cookie(_v) { /* cookie legível do protótipo: só remoção */ } },
  };
  return j;
}

describe('C0 — páginas originais com a sessão empresarial real (PostgreSQL real)', () => {
  let contexto;
  let pool;
  let servidor;
  let base;
  let origem;
  const empresa = {};
  const usuario = {};

  /** Navegador novo, sem cookie nenhum, apontado para a API do cliente. */
  function navegadorNovo() {
    const nav = criarNavegador(origem);
    EpiHttp.configurar({ baseUrl: `${base}/api`, fetch: nav });
    return nav;
  }

  async function entrarPeloPortal(email) {
    const r = await EpiPortal.acoes.entrar({ email, senha: SENHA });
    assert.equal(r.ok, true, JSON.stringify(r));
    return r.dados;
  }

  before(async () => {
    contexto = await abrirPoolTemporario(TODAS_AS_MIGRATIONS);
    pool = contexto.pool;
    const hash = await gerarHashSenha(SENHA);

    for (const [chave, nome, cnpj] of [['A', 'Empresa Alfa', '11222333000181'], ['B', 'Empresa Beta', '22333444000100']]) {
      const { rows } = await pool.query('INSERT INTO empresas (nome, cnpj) VALUES ($1, $2) RETURNING id', [nome, cnpj]);
      empresa[chave] = rows[0].id;
      await provisionamento.provisionar(pool, { empresaId: empresa[chave], dryRun: false });
    }
    const identidade = async (email) => (await pool.query('INSERT INTO identidades (email, senha_hash) VALUES ($1, $2) RETURNING id', [email, hash])).rows[0].id;
    const vinculo = async (chave, empresaId, identidadeId, perfil, nome) => {
      usuario[chave] = (await pool.query('INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, identidade_id) VALUES ($1, $2, NULL, NULL, $3, $4) RETURNING id', [empresaId, nome, perfil, identidadeId])).rows[0].id;
    };
    const ana = await identidade(ANA);
    const bia = await identidade(BIA);
    await vinculo('anaA', empresa.A, ana, 'MASTER', 'Ana Master');
    await vinculo('anaB', empresa.B, ana, 'USUARIO', 'Ana Usuária');
    await vinculo('biaA', empresa.A, bia, 'MASTER', 'Bia Master');

    const semLimite = () => criarLimitador({ limite: 100000, janelaSegundos: 60 });
    const exigirSessao = criarExigirSessao({ pool });
    const app = express();
    app.disable('x-powered-by');
    app.use(
      '/api',
      corsApi, semCache, verificarOrigem, exigirJson, parserJson,
      criarAuthRoutes({ controller: criarAuthController({ pool }), limitador: semLimite(), exigirSessao }),
      criarAuthGlobalRoutes({ controller: criarAuthGlobalController({ pool }), limitador: semLimite(), exigirSessaoGlobal: criarExigirSessaoGlobal({ pool }) }),
      criarGrupoAcessoRoutes({ controller: criarGrupoAcessoController({ pool }), exigirSessao }),
    );
    app.use(notFoundHandler);
    app.use(errorHandler);
    servidor = http.createServer(app);
    await new Promise((resolve) => { servidor.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${servidor.address().port}`;
    [origem] = httpConfig.cors.origens;
  });

  after(async () => {
    EpiHttp.configurar({ fetch: null });
    if (servidor) await new Promise((resolve) => { servidor.close(resolve); });
    if (contexto) await contexto.encerrar();
  });

  test('MASTER autenticado pelo Portal: a página recebe usuário, empresa e perfil do servidor, e opera sob o RBAC (lista grupos)', async () => {
    const nav = navegadorNovo();
    const login = await entrarPeloPortal(BIA);
    assert.equal(EpiPortal.decisao.destino(login), 'inicio', 'uma empresa: seleção automática');

    const j = pagina('grupos-acesso');
    const r = await EpiSessaoEmpresarial.iniciar({ janela: j });
    assert.equal(r.autenticado, true);
    assert.deepEqual(r.contexto.usuario, { id: usuario.biaA, nome: 'Bia Master', email: BIA, perfil: 'MASTER' });
    assert.deepEqual([r.contexto.empresa.id, r.contexto.empresa.nome], [empresa.A, 'Empresa Alfa']);
    assert.equal(r.podeTrocar, false);
    assert.deepEqual(j.redirecionamentos, []);
    assert.equal((await EpiGrupos.acoes.listar({})).ok, true);
    assert.ok(nav.jar.has(authConfig.sessao.cookieNome), 'a sessão empresarial é o cookie HttpOnly do servidor');
  });

  test('navegação entre as quatro páginas integradas: cada uma confirma a MESMA sessão no servidor, sem novo login e sem ?_s=', async () => {
    const nav = navegadorNovo();
    await entrarPeloPortal(BIA);
    const cookieAntes = nav.jar.get(authConfig.sessao.cookieNome);
    for (const nome of ['grupos-acesso', 'grupo-permissoes', 'grupo-usuarios', 'autorizacoes-individuais']) {
      const j = pagina(nome);
      const r = await EpiSessaoEmpresarial.iniciar({ janela: j });
      assert.deepEqual([nome, r.autenticado, r.contexto.empresa.id], [nome, true, empresa.A]);
      assert.deepEqual(j.redirecionamentos, []);
      assert.deepEqual(j.urlsSubstituidas, [], 'nenhuma URL com sessão para limpar');
    }
    assert.equal(nav.jar.get(authConfig.sessao.cookieNome), cookieAntes, 'a mesma sessão, nenhum login novo');
    assert.equal(nav.chamadas.some((c) => /[?&]_s=/.test(c)), false, 'nenhuma requisição carrega ?_s=');
    assert.equal(nav.chamadas.some((c) => c.startsWith('POST /api/auth/login')), false, 'o login por CNPJ nunca é chamado');
  });

  test('acesso direto sem login: vai ao Portal; nenhum dado é pedido; uma "sessão" antiga do protótipo no navegador não autentica e é removida', async () => {
    const nav = navegadorNovo();
    const j = pagina('grupos-acesso', {
      search: '?_s=' + encodeURIComponent(Buffer.from(LEGADO).toString('base64')),
      local: { 'epi-session-user': LEGADO, epi_db_v2: '{"simulado":true}' },
      sessao: { 'epi-session-user': LEGADO },
    });

    const r = await EpiSessaoEmpresarial.iniciar({ janela: j });

    assert.deepEqual(r, { autenticado: false, motivo: 'SEM_SESSAO' });
    assert.deepEqual(j.redirecionamentos, ['../portal/index.html']);
    assert.deepEqual(nav.chamadas, ['GET /api/auth/me'], 'só a verificação de sessão; nenhum dado de negócio');
    assert.deepEqual(j.urlsSubstituidas, ['/pages/grupos-acesso.html'], '?_s= retirado da barra de endereço');
    assert.equal(j.localStorage.dados.has('epi-session-user'), false);
    assert.equal(j.sessionStorage.dados.has('epi-session-user'), false);
    assert.equal(j.localStorage.operacoes.some(([op]) => op === 'set' || op === 'get'), false, 'nada lido nem gravado');
  });

  test('sessão empresarial expirada: a página volta ao Portal', async () => {
    navegadorNovo();
    await entrarPeloPortal(BIA);
    await pool.query("UPDATE sessoes SET criado_em = now() - interval '2 hours', expira_em = now() - interval '1 minute' WHERE usuario_id = $1 AND revogada_em IS NULL", [usuario.biaA]);
    const j = pagina('grupo-usuarios');
    assert.equal((await EpiSessaoEmpresarial.iniciar({ janela: j })).motivo, 'SEM_SESSAO');
    assert.deepEqual(j.redirecionamentos, ['../portal/index.html']);
  });

  test('empresa inativada e vínculo inativado: a página deixa de abrir (Portal) e reativar não restaura a sessão', async () => {
    navegadorNovo();
    await entrarPeloPortal(BIA);
    await pool.query('UPDATE empresas SET ativo = false WHERE id = $1', [empresa.A]);
    try {
      const j = pagina('grupos-acesso');
      assert.equal((await EpiSessaoEmpresarial.iniciar({ janela: j })).motivo, 'SEM_SESSAO');
      assert.deepEqual(j.redirecionamentos, ['../portal/index.html']);
    } finally {
      await pool.query('UPDATE empresas SET ativo = true WHERE id = $1', [empresa.A]);
    }
    assert.equal((await EpiSessaoEmpresarial.iniciar({ janela: pagina('grupos-acesso') })).autenticado, false, 'reativar a empresa não restaura');

    navegadorNovo();
    await entrarPeloPortal(BIA);
    await pool.query('UPDATE usuarios SET ativo = false WHERE id = $1', [usuario.biaA]);
    try {
      const j = pagina('autorizacoes-individuais');
      assert.equal((await EpiSessaoEmpresarial.iniciar({ janela: j })).motivo, 'SEM_SESSAO');
    } finally {
      await pool.query('UPDATE usuarios SET ativo = true WHERE id = $1', [usuario.biaA]);
    }
    assert.equal((await EpiSessaoEmpresarial.iniciar({ janela: pagina('grupos-acesso') })).autenticado, false, 'reativar o vínculo não restaura');
  });

  test('troca de empresa e isolamento multiempresa: dado criado em A não aparece em B; em B vale o perfil de B (USUARIO -> 403); a sessão de A deixa de valer', async () => {
    const nav = navegadorNovo();
    const login = await entrarPeloPortal(ANA);
    assert.equal(EpiPortal.decisao.destino(login), 'selecionar');
    assert.equal((await EpiPortal.acoes.selecionar(empresa.A)).ok, true);

    const emA = await EpiSessaoEmpresarial.iniciar({ janela: pagina('grupos-acesso') });
    assert.deepEqual([emA.contexto.empresa.id, emA.contexto.usuario.perfil, emA.podeTrocar], [empresa.A, 'MASTER', true]);
    const criado = await EpiGrupos.acoes.criar({ nome: 'Somente Alfa C0', descricao: 'isolamento' });
    assert.equal(criado.ok, true, JSON.stringify(criado));
    const cookieA = nav.jar.get(authConfig.sessao.cookieNome);

    // "Trocar de empresa" leva à seleção do Portal; a escolha é revalidada no servidor.
    const j = pagina('grupos-acesso');
    await EpiSessaoEmpresarial.iniciar({ janela: j });
    EpiSessaoEmpresarial.trocarEmpresa();
    assert.deepEqual(j.redirecionamentos, ['../portal/empresas.html']);
    assert.equal((await EpiPortal.acoes.selecionar(empresa.B)).ok, true);

    const emB = await EpiSessaoEmpresarial.iniciar({ janela: pagina('grupos-acesso') });
    assert.deepEqual([emB.contexto.empresa.id, emB.contexto.usuario.perfil], [empresa.B, 'USUARIO']);
    const listaB = await EpiGrupos.acoes.listar({});
    assert.equal(listaB.status, 403, 'USUARIO em B: o RBAC do servidor recusa — o MASTER de A não leva autoridade');
    const direto = await EpiGrupos.acoes.buscar(criado.dados.grupo.id);
    assert.notEqual(direto.status, 200, 'o grupo de A nunca aparece com a sessão de B');

    const antiga = await fetch(`${base}/api/auth/me`, { headers: { Cookie: `${authConfig.sessao.cookieNome}=${cookieA}` } });
    assert.equal(antiga.status, 401, 'a sessão da empresa anterior não pode ser reutilizada');
  });

  test('sair: encerra sessão global e empresarial no servidor, remove os cookies e leva ao Portal; a página seguinte exige novo login', async () => {
    const nav = navegadorNovo();
    await entrarPeloPortal(BIA);
    const j = pagina('grupo-permissoes');
    assert.equal((await EpiSessaoEmpresarial.iniciar({ janela: j })).autenticado, true);

    await EpiSessaoEmpresarial.sair();

    assert.deepEqual(j.redirecionamentos, ['../portal/index.html']);
    assert.equal(nav.jar.has(authConfig.sessao.cookieNome), false);
    assert.equal(nav.jar.has(authConfig.sessao.cookieNomeGlobal), false);
    const seguinte = pagina('grupos-acesso');
    assert.equal((await EpiSessaoEmpresarial.iniciar({ janela: seguinte })).motivo, 'SEM_SESSAO');
    const { rows } = await pool.query("SELECT count(*)::int AS vivas FROM sessoes WHERE usuario_id = $1 AND revogada_em IS NULL AND expira_em > now()", [usuario.biaA]);
    assert.equal(rows[0].vivas, 0, 'nenhuma sessão empresarial viva no banco');
  });

  test('sair SEM confirmação do servidor (falha de rede; erro HTTP real 403 de origem): nada é dado como encerrado — sessões vivas no banco, cookies mantidos, sem Portal; a nova tentativa confirmada conclui', async () => {
    const nav = navegadorNovo();
    await entrarPeloPortal(BIA);
    const j = pagina('grupos-acesso');
    assert.equal((await EpiSessaoEmpresarial.iniciar({ janela: j })).autenticado, true);
    const vivas = async () => (await pool.query('SELECT count(*)::int AS n FROM sessoes WHERE usuario_id = $1 AND revogada_em IS NULL AND expira_em > now()', [usuario.biaA])).rows[0].n;
    assert.equal(await vivas(), 1);

    // (a) Falha de rede só no logout.
    EpiHttp.configurar({
      fetch: async (url, opcoes) => {
        if (opcoes.method === 'POST' && url.endsWith('/auth/global/logout')) throw new TypeError('Failed to fetch');
        return nav(url, opcoes);
      },
    });
    const semRede = await EpiSessaoEmpresarial.sair();
    assert.deepEqual([semRede.ok, semRede.motivo], [false, 'REDE']);

    // (b) Erro HTTP de verdade: o backend recusa o logout vindo de origem não permitida (403).
    const origemErrada = criarNavegador('http://origem-nao-permitida.test');
    for (const [k, v] of nav.jar) origemErrada.jar.set(k, v);
    EpiHttp.configurar({ fetch: origemErrada });
    const http403 = await EpiSessaoEmpresarial.sair();
    assert.deepEqual([http403.ok, http403.motivo, http403.status], [false, 'HTTP', 403]);

    assert.deepEqual(j.redirecionamentos, [], 'nenhuma das falhas levou ao Portal');
    assert.equal(await vivas(), 1, 'a sessão empresarial continua ativa no servidor');
    assert.ok(nav.jar.has(authConfig.sessao.cookieNome) && nav.jar.has(authConfig.sessao.cookieNomeGlobal), 'nenhum cookie foi removido');
    EpiHttp.configurar({ fetch: nav });
    assert.equal((await EpiSessaoEmpresarial.iniciar({ janela: pagina('grupos-acesso') })).autenticado, true, 'a sessão segue válida');

    // (c) Nova tentativa, agora confirmada pelo servidor.
    const j2 = pagina('grupos-acesso');
    await EpiSessaoEmpresarial.iniciar({ janela: j2 });
    assert.deepEqual(await EpiSessaoEmpresarial.sair(), { ok: true });
    assert.deepEqual(j2.redirecionamentos, ['../portal/index.html']);
    assert.equal(await vivas(), 0);
    assert.equal(nav.jar.has(authConfig.sessao.cookieNome), false);
  });

  test('sessão encerrada no servidor durante o uso: a próxima operação recebe 401 e a página volta ao Portal', async () => {
    navegadorNovo();
    await entrarPeloPortal(BIA);
    const j = pagina('grupos-acesso');
    assert.equal((await EpiSessaoEmpresarial.iniciar({ janela: j })).autenticado, true);
    await pool.query("UPDATE sessoes SET revogada_em = now(), motivo_revogacao = 'LOGOUT' WHERE usuario_id = $1 AND revogada_em IS NULL", [usuario.biaA]);

    const r = await EpiGrupos.acoes.listar({});
    assert.equal(EpiGrupos.mensagens.exigeNovoLogin(r), true);
    EpiSessaoEmpresarial.sessaoEncerrada(); // o que a página faz ao receber o 401
    assert.deepEqual(j.redirecionamentos, ['../portal/index.html']);
  });
});
