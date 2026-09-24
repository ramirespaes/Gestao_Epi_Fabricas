'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');

const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { criarAuthPlataformaController } = require('../../src/controllers/auth-plataforma.controller');
const { criarAuthPlataformaRoutes } = require('../../src/routes/auth-plataforma.routes');
const { criarEmpresaCadastroController } = require('../../src/controllers/empresa-cadastro.controller');
const { criarEmpresaCadastroRoutes } = require('../../src/routes/empresa-cadastro.routes');
const { criarConviteMasterController } = require('../../src/controllers/convite-master.controller');
const { criarConviteMasterRoutes } = require('../../src/routes/convite-master.routes');
const { criarAuthController } = require('../../src/controllers/auth.controller');
const { criarAuthRoutes } = require('../../src/routes/auth.routes');
const { criarAuthGlobalController } = require('../../src/controllers/auth-global.controller');
const { criarAuthGlobalRoutes } = require('../../src/routes/auth-global.routes');
const { criarGrupoAcessoController } = require('../../src/controllers/grupo-acesso.controller');
const { criarGrupoAcessoRoutes } = require('../../src/routes/grupo-acesso.routes');
const { criarExigirSessao } = require('../../src/middleware/autenticacao');
const { criarExigirSessaoGlobal } = require('../../src/middleware/autenticacao-global');
const { criarExigirSessaoPlataforma } = require('../../src/middleware/autenticacao-plataforma');
const { criarLimitador } = require('../../src/middleware/rate-limit');
const { corsApi, corsPlataforma } = require('../../src/middleware/cors');
const { semCache } = require('../../src/middleware/cabecalhos');
const { verificarOrigem, verificarOrigemPlataforma } = require('../../src/middleware/origem');
const { exigirJson, parserJson } = require('../../src/middleware/conteudo');
const { notFoundHandler, errorHandler } = require('../../src/middleware/errorHandler');
const { criarInicial } = require('../../src/services/administrador-plataforma.service');
const { httpConfig } = require('../../src/config/http');
const { authConfig } = require('../../src/config/auth');

const EpiHttp = require('../../../frontend/js/api-http');
const EpiPortal = require('../../../frontend/js/portal-cliente');

/**
 * META FINAL do Pacote 4, ponta a ponta, com o MÓDULO REAL do Portal do
 * Cliente (frontend/js/portal-cliente.js) contra o backend REAL:
 *
 *   1. administrador da plataforma entra (origem do Painel Privado);
 *   2. cadastra uma empresa (provisionamento MASTER automático, Pacote 3);
 *   3. convida o primeiro MASTER;
 *   4. o convite é aceito (senha definida);
 *   5. o MASTER entra no Portal do Cliente só com e-mail e senha (origem do
 *      Portal) e, com UMA empresa, entra direto no ambiente;
 *   6/8. com uma SEGUNDA empresa (novo convite, identidade existente), o
 *      login passa a pedir a seleção; troca de empresa sem nova senha;
 *   7. o ambiente empresarial responde com a empresa e o perfil certos, e o
 *      RBAC existente decide (MASTER lista grupos).
 *
 * Servidor HTTP de verdade numa porta efêmera, com as DUAS cadeias de
 * produção montadas como em app.js (CORS/Origin por namespace, allowlists
 * disjuntas), e PostgreSQL real em schema temporário exclusivo com todas as
 * migrations (000-038). O `fetch` injetado faz o papel do navegador: envia
 * o Origin da página e guarda os cookies HttpOnly num único "jar" (como um
 * navegador real faz para localhost, entre as portas 5500 e 5501).
 */

const TODAS_AS_MIGRATIONS = Array.from({ length: 39 }, (_, i) => String(i).padStart(3, '0'));
const SENHA_ADMIN = 'planeta-nebulosa-ozonio-42';
const SENHA_MASTER = 'quasar-boreal-91-nebula';
const EMAIL_MASTER = 'master.teste@exemplo-cliente.com.br';

function completarCnpj(base12) {
  const valor = (c) => c.charCodeAt(0) - 48;
  const dv = (texto, pesos) => {
    const resto = [...texto].reduce((acc, c, i) => acc + valor(c) * pesos[i], 0) % 11;
    return resto < 2 ? 0 : 11 - resto;
  };
  const d1 = dv(base12, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = dv(`${base12}${d1}`, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return `${base12}${d1}${d2}`;
}

/** Um "navegador": um jar de cookies para o host da API, Origin por página. */
function criarNavegador() {
  const jar = new Map();
  const fetchDaOrigem = (origem) => async (url, opcoes = {}) => {
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
  return { jar, fetchDaOrigem };
}

describe('Portal do Cliente (frontend real) contra o backend real — META FINAL do Pacote 4', () => {
  let contexto;
  let servidor;
  let base;
  let origemCliente;
  let origemPlataforma;
  let navegador;
  const empresas = {};

  /** Requisição "do Painel Privado" (origem 5501) usando o mesmo jar. */
  async function plataforma(metodo, caminho, corpo) {
    const r = await navegador.fetchDaOrigem(origemPlataforma)(`${base}/api/plataforma${caminho}`, {
      method: metodo,
      credentials: 'include',
      headers: corpo === undefined ? {} : { 'Content-Type': 'application/json' },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
    return { status: r.status, corpo: await r.json() };
  }

  /** Portal do Cliente: o módulo real, com o fetch do "navegador" na origem 5500. */
  function usarPortal() {
    EpiHttp.configurar({ baseUrl: `${base}/api`, fetch: navegador.fetchDaOrigem(origemCliente) });
  }

  async function cadastrarEmpresaEConvidar(base12, razaoSocial) {
    const criada = await plataforma('POST', '/empresas', { razaoSocial, cnpj: completarCnpj(base12) });
    assert.equal(criada.status, 201, JSON.stringify(criada.corpo));
    assert.equal(criada.corpo.provisionamento.prontaParaMaster, true, 'provisionamento MASTER automático (Pacote 3)');
    const convite = await plataforma('POST', `/empresas/${criada.corpo.empresa.id}/convites-master`, { email: EMAIL_MASTER });
    assert.equal(convite.status, 201, JSON.stringify(convite.corpo));
    const token = new URLSearchParams(new URL(convite.corpo.entrega.linkAceite).hash.slice(1)).get('token');
    return { empresaId: criada.corpo.empresa.id, token };
  }

  before(async () => {
    contexto = await abrirPoolTemporario(TODAS_AS_MIGRATIONS);
    const { pool } = contexto;
    const semLimite = () => criarLimitador({ limite: 100000, janelaSegundos: 60 });
    const exigirSessaoPlataforma = criarExigirSessaoPlataforma({ pool });
    const exigirSessao = criarExigirSessao({ pool });
    const exigirSessaoGlobal = criarExigirSessaoGlobal({ pool });

    const app = express();
    app.disable('x-powered-by');
    app.use(
      '/api/plataforma',
      corsPlataforma, semCache, verificarOrigemPlataforma, exigirJson, parserJson,
      criarAuthPlataformaRoutes({ controller: criarAuthPlataformaController({ pool }), limitador: semLimite(), exigirSessaoPlataforma }),
      criarEmpresaCadastroRoutes({ controller: criarEmpresaCadastroController({ pool }), exigirSessaoPlataforma }),
      criarConviteMasterRoutes({ controller: criarConviteMasterController({ pool }), exigirSessaoPlataforma, limitador: semLimite() }),
      notFoundHandler,
    );
    app.use(
      '/api',
      corsApi, semCache, verificarOrigem, exigirJson, parserJson,
      criarAuthRoutes({ controller: criarAuthController({ pool }), limitador: semLimite(), exigirSessao }),
      criarAuthGlobalRoutes({ controller: criarAuthGlobalController({ pool }), limitador: semLimite(), exigirSessaoGlobal }),
      criarGrupoAcessoRoutes({ controller: criarGrupoAcessoController({ pool }), exigirSessao }),
    );
    app.use(notFoundHandler);
    app.use(errorHandler);

    servidor = http.createServer(app);
    await new Promise((resolve) => { servidor.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${servidor.address().port}`;
    [origemCliente] = httpConfig.cors.origens;
    [origemPlataforma] = httpConfig.plataforma.corsOrigens;
    assert.notEqual(origemCliente, origemPlataforma);

    await criarInicial(pool, { email: 'admin@safework.com.br', senha: SENHA_ADMIN });
    navegador = criarNavegador();
  });

  after(async () => {
    EpiHttp.configurar({ fetch: null });
    if (servidor) await new Promise((resolve) => { servidor.close(resolve); });
    if (contexto) await contexto.encerrar();
  });

  test('1-5, 7: admin cadastra e convida; convite aceito; MASTER entra só com e-mail e senha e cai direto no ambiente da única empresa', async () => {
    const adm = await plataforma('POST', '/auth/login', { email: 'admin@safework.com.br', senha: SENHA_ADMIN });
    assert.equal(adm.status, 200);
    assert.ok(navegador.jar.has(authConfig.sessao.cookieNomeAdmin));

    const a = await cadastrarEmpresaEConvidar('555666770001', 'Empresa Alfa');
    empresas.A = a.empresaId;
    const aceite = await plataforma('POST', '/convite-master/aceitar', { token: a.token, nome: 'Master Teste', senha: SENHA_MASTER });
    assert.equal(aceite.status, 201, JSON.stringify(aceite.corpo));

    usarPortal();
    const login = await EpiPortal.acoes.entrar({ email: EMAIL_MASTER, senha: SENHA_MASTER });
    assert.equal(login.ok, true, JSON.stringify(login));
    assert.equal(EpiPortal.decisao.destino(login.dados), 'inicio', 'uma empresa: seleção automática');
    assert.ok(navegador.jar.has(authConfig.sessao.cookieNomeGlobal));
    assert.ok(navegador.jar.has(authConfig.sessao.cookieNome));

    const sessao = await EpiPortal.acoes.sessao();
    assert.equal(sessao.ok, true);
    assert.deepEqual(
      [sessao.dados.contexto.empresa.id, sessao.dados.contexto.usuario.perfil, sessao.dados.contexto.usuario.email],
      [empresas.A, 'MASTER', EMAIL_MASTER],
    );
    assert.equal(EpiPortal.decisao.podeTrocar(sessao.dados), false);

    const grupos = await EpiHttp.requisitar('GET', '/grupos-acesso');
    assert.equal(grupos.ok, true, 'o MASTER opera no ambiente empresarial com o RBAC existente');
  });

  test('6, 8: segunda empresa para a MESMA pessoa -> login pede seleção; seleção e TROCA de empresa sem nova senha; sessão anterior deixa de valer', async () => {
    const b = await cadastrarEmpresaEConvidar('555666880001', 'Empresa Beta');
    empresas.B = b.empresaId;
    // Identidade já existe: o aceite exige a senha ATUAL (Pacote 3) — e só cria o vínculo.
    const aceite = await plataforma('POST', '/convite-master/aceitar', { token: b.token, nome: 'Master Teste', senha: SENHA_MASTER });
    assert.equal(aceite.status, 201, JSON.stringify(aceite.corpo));

    usarPortal();
    const login = await EpiPortal.acoes.entrar({ email: EMAIL_MASTER, senha: SENHA_MASTER });
    assert.equal(login.ok, true);
    assert.equal(EpiPortal.decisao.destino(login.dados), 'selecionar');
    assert.deepEqual(login.dados.empresas.map((e) => e.id).sort(), [empresas.A, empresas.B].sort());
    assert.equal(navegador.jar.has(authConfig.sessao.cookieNome), false, 'sem contexto: nenhum cookie empresarial');
    assert.equal((await EpiHttp.requisitar('GET', '/grupos-acesso')).status, 401, 'sessão global não dá acesso operacional');

    const emA = await EpiPortal.acoes.selecionar(empresas.A);
    assert.equal(emA.ok, true);
    const cookieEmA = navegador.jar.get(authConfig.sessao.cookieNome);
    assert.equal((await EpiPortal.acoes.sessao()).dados.contexto.empresa.id, empresas.A);
    assert.equal(EpiPortal.decisao.podeTrocar((await EpiPortal.acoes.sessao()).dados), true);

    const emB = await EpiPortal.acoes.selecionar(empresas.B);
    assert.equal(emB.ok, true);
    assert.equal(emB.dados.empresa.id, empresas.B);
    assert.notEqual(navegador.jar.get(authConfig.sessao.cookieNome), cookieEmA);

    // O cookie da empresa A, reapresentado, não vale mais.
    const antiga = await fetch(`${base}/api/auth/me`, { headers: { Cookie: `${authConfig.sessao.cookieNome}=${cookieEmA}` } });
    assert.equal(antiga.status, 401);
    assert.equal((await EpiPortal.acoes.sessao()).dados.contexto.empresa.id, empresas.B);
  });

  test('sair da empresa mantém o login global (reseleção sem senha); sair completamente exige novo login', async () => {
    usarPortal();
    const sairEmpresa = await EpiPortal.acoes.sairDaEmpresa();
    assert.equal(sairEmpresa.ok, true);
    const semContexto = await EpiPortal.acoes.sessao();
    assert.deepEqual([semContexto.ok, EpiPortal.decisao.destinoDaSessao(semContexto)], [true, 'selecionar']);
    assert.equal((await EpiPortal.acoes.selecionar(empresas.A)).ok, true, 'sem digitar a senha');

    const sairTudo = await EpiPortal.acoes.sairCompletamente();
    assert.equal(sairTudo.ok, true);
    assert.equal(navegador.jar.has(authConfig.sessao.cookieNomeGlobal), false);
    assert.equal(navegador.jar.has(authConfig.sessao.cookieNome), false);
    const depois = await EpiPortal.acoes.sessao();
    assert.equal(EpiPortal.decisao.destinoDaSessao(depois), 'login');
    assert.equal(navegador.jar.has(authConfig.sessao.cookieNomeAdmin), true, 'o Painel Privado não é afetado pelo Portal');
  });

  test('isolamento de origens: o Portal (origem do cliente) não alcança /api/plataforma, e a origem do Painel não alcança o login do Portal', async () => {
    const doPortalNaPlataforma = await navegador.fetchDaOrigem(origemCliente)(`${base}/api/plataforma/auth/logout`, { method: 'POST', credentials: 'include' });
    assert.equal(doPortalNaPlataforma.status, 403);
    const doPainelNoPortal = await navegador.fetchDaOrigem(origemPlataforma)(`${base}/api/auth/global/login`, {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL_MASTER, senha: SENHA_MASTER }),
    });
    assert.equal(doPainelNoPortal.status, 403);
    assert.equal(navegador.jar.has(authConfig.sessao.cookieNomeGlobal), false, 'nenhuma sessão global nasceu da origem errada');
  });
});
